import { Type } from "@earendil-works/pi-ai";
import type { ToolRuntime } from "../types.js";
import { formatProcessResult, runProcess } from "./process.js";
import { createToolResult, optionalNumber, requireString } from "./utils.js";

export function createGrepTool(): ToolRuntime {
  return {
    definition: {
      name: "grep",
      description: "Search files with ripgrep.",
      parameters: Type.Object({
        pattern: Type.String({ description: "Ripgrep search pattern." }),
        path: Type.Optional(Type.String({ description: "Path to search. Default: current workspace." })),
        maxBytes: Type.Optional(Type.Number({ description: "Maximum bytes to return. Default: 65536." }))
      })
    },
    guideline: "Search text with rg; respects ripgrep defaults.",
    canRunInParallel: true,
    async execute(call, ctx) {
      const pattern = requireString(call.arguments.pattern, "pattern");
      const searchPath = typeof call.arguments.path === "string" ? call.arguments.path : ".";
      const maxBytes = optionalNumber(call.arguments.maxBytes, 65536);
      const result = await runProcess({
        command: "rg",
        args: ["--line-number", "--no-heading", pattern, searchPath],
        cwd: ctx.cwd,
        timeoutMs: 30000,
        maxBytes,
        signal: ctx.signal,
        missingCommandMessage: "rg is required for the grep tool but was not found on PATH."
      });
      const isError = result.exitCode !== 0 && result.exitCode !== 1;
      const output = result.exitCode === 1 && !result.stdout ? "(no matches)" : formatProcessResult(result);
      return createToolResult(call, output, isError);
    }
  };
}
