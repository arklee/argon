import { Type } from "@earendil-works/pi-ai";
import type { ToolRuntime } from "../types.js";
import { formatProcessResult, runProcess } from "./process.js";
import { createToolResult, optionalNumber, requireString } from "./utils.js";

export function createBashTool(): ToolRuntime {
  return {
    definition: {
      name: "bash",
      description: "Run a shell command in the current workspace.",
      parameters: Type.Object({
        command: Type.String({ description: "Shell command to execute." }),
        timeoutMs: Type.Optional(Type.Number({ description: "Timeout in milliseconds. Default: 30000." })),
        maxBytes: Type.Optional(Type.Number({ description: "Maximum stdout/stderr bytes to return. Default: 65536." }))
      })
    },
    guideline: "Run shell commands; prefer read/ls/grep for simple file inspection.",
    async execute(call, ctx) {
      const command = requireString(call.arguments.command, "command");
      const timeoutMs = optionalNumber(call.arguments.timeoutMs, 30000);
      const maxBytes = optionalNumber(call.arguments.maxBytes, 65536);
      const result = await runProcess({
        command,
        cwd: ctx.cwd,
        shell: true,
        timeoutMs,
        maxBytes,
        signal: ctx.signal
      });
      return createToolResult(call, formatProcessResult(result), result.exitCode !== 0 || result.timedOut);
    }
  };
}
