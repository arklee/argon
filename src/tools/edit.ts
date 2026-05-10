import { readFile, writeFile } from "node:fs/promises";
import { Type } from "@mariozechner/pi-ai";
import type { ToolRuntime } from "../types.js";
import { createToolResult, requireString, resolveWorkspacePath } from "./utils.js";

export function createEditTool(): ToolRuntime {
  return {
    definition: {
      name: "edit",
      description: "Replace one exact text occurrence in a UTF-8 file.",
      parameters: Type.Object({
        path: Type.String({ description: "File path, relative to the workspace unless absolute." }),
        oldText: Type.String({ description: "Exact text to replace. Must occur exactly once." }),
        newText: Type.String({ description: "Replacement text." })
      })
    },
    guideline: "Use exact replacement and read the file first when possible.",
    async execute(call, ctx) {
      const filePath = resolveWorkspacePath(ctx.cwd, requireString(call.arguments.path, "path"));
      const oldText = requireString(call.arguments.oldText, "oldText");
      const newText = typeof call.arguments.newText === "string" ? call.arguments.newText : "";
      const content = await readFile(filePath, "utf8");
      const occurrences = content.split(oldText).length - 1;
      if (occurrences === 0) {
        throw new Error(`oldText was not found in ${filePath}`);
      }
      if (occurrences > 1) {
        throw new Error(`oldText matched ${occurrences} times in ${filePath}; edit requires exactly one match`);
      }
      const next = content.replace(oldText, newText);
      await writeFile(filePath, next, "utf8");
      return createToolResult(call, `Edited ${filePath}`);
    }
  };
}
