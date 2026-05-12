import { readdir } from "node:fs/promises";
import { Type } from "@earendil-works/pi-ai";
import type { ToolRuntime } from "../types.js";
import { createToolResult, requireString, resolveWorkspacePath } from "./utils.js";

export function createLsTool(): ToolRuntime {
  return {
    definition: {
      name: "ls",
      description: "List directory entries.",
      parameters: Type.Object({
        path: Type.Optional(Type.String({ description: "Directory path. Default: current workspace." }))
      })
    },
    guideline: "List directory contents without invoking a shell.",
    canRunInParallel: true,
    async execute(call, ctx) {
      const requestedPath = typeof call.arguments.path === "string" ? call.arguments.path : ".";
      const dirPath = resolveWorkspacePath(ctx.cwd, requireString(requestedPath, "path"));
      const entries = await readdir(dirPath, { withFileTypes: true });
      const lines = entries
        .map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`)
        .sort();
      return createToolResult(call, lines.join("\n") || "(empty)");
    }
  };
}
