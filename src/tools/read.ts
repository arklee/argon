import { readFile } from "node:fs/promises";
import { Type } from "@earendil-works/pi-ai";
import type { ToolRuntime } from "../types.js";
import { createToolResult, optionalNumber, requireString, resolveWorkspacePath, truncateText } from "./utils.js";

export function createReadTool(): ToolRuntime {
  return {
    definition: {
      name: "read",
      description: "Read a UTF-8 text file.",
      parameters: Type.Object({
        path: Type.String({ description: "File path, relative to the workspace unless absolute." }),
        maxBytes: Type.Optional(Type.Number({ description: "Maximum bytes to return. Default: 65536." }))
      })
    },
    guideline: "Read UTF-8 files before editing them.",
    async execute(call, ctx) {
      const filePath = resolveWorkspacePath(ctx.cwd, requireString(call.arguments.path, "path"));
      const maxBytes = optionalNumber(call.arguments.maxBytes, 65536);
      const content = await readFile(filePath, "utf8");
      return createToolResult(call, truncateText(content, maxBytes));
    }
  };
}
