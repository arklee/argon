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
    guideline: "Run shell commands; prefer read/ls/grep for simple file inspection. Independent read-only rg, sed, ls, cat, nl, wc, and git inspection commands may run in parallel.",
    canRunInParallel(call) {
      return isReadOnlyShellInspection(requireString(call.arguments.command, "command"));
    },
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

function isReadOnlyShellInspection(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || /[;&|<>`$()\n\r]/.test(trimmed)) return false;

  const [program, ...args] = trimmed.split(/\s+/);
  switch (program) {
    case "rg":
    case "ls":
    case "cat":
    case "nl":
    case "wc":
      return true;
    case "sed":
      return !args.some(
        (arg) =>
          arg === "-i" ||
          arg.startsWith("-i") ||
          /^-[^-].*i/.test(arg) ||
          arg === "--in-place" ||
          arg.startsWith("--in-place=")
      );
    case "git":
      return ["show", "status", "diff", "log", "branch", "grep"].includes(args[0] ?? "");
    default:
      return false;
  }
}
