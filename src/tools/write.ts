import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ToolRuntime } from "../types.js";
import { createToolResult, requireString, resolveWorkspacePath } from "./utils.js";

export function createWriteTool(): ToolRuntime {
  return {
    definition: {
      name: "write",
      description: "Create or replace a UTF-8 text file.",
      parameters: Type.Object({
        path: Type.String({ description: "File path, relative to the workspace unless absolute." }),
        content: Type.String({ description: "Full file content to write." })
      })
    },
    guideline: "Create or replace files with complete UTF-8 content.",
    async execute(call, ctx) {
      const filePath = resolveWorkspacePath(ctx.cwd, requireString(call.arguments.path, "path"));
      if (typeof call.arguments.content !== "string") {
        throw new Error("content must be a string");
      }
      const content = call.arguments.content;
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content, "utf8");
      return createToolResult(call, `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${filePath}`);
    }
  };
}
