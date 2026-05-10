import { spawn } from "node:child_process";
import { truncateText } from "./utils.js";

export interface RunProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runProcess(options: {
  command: string;
  args?: string[];
  cwd: string;
  shell?: boolean;
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal | undefined;
  missingCommandMessage?: string | undefined;
}): Promise<RunProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      shell: options.shell ?? false,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const finish = (result: RunProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolve({
        ...result,
        stdout: truncateText(result.stdout, options.maxBytes),
        stderr: truncateText(result.stderr, options.maxBytes)
      });
    };

    const abort = () => {
      child.kill("SIGTERM");
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);

    if (options.signal?.aborted) {
      abort();
    } else {
      options.signal?.addEventListener("abort", abort, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({
        exitCode: error.code === "ENOENT" ? 127 : 1,
        signal: null,
        stdout,
        stderr: options.missingCommandMessage && error.code === "ENOENT" ? options.missingCommandMessage : error.message,
        timedOut
      });
    });
    child.on("close", (exitCode, signal) => {
      finish({ exitCode, signal, stdout, stderr, timedOut });
    });
  });
}

export function formatProcessResult(result: RunProcessResult): string {
  const status = [
    `Exit code: ${result.exitCode ?? "null"}`,
    `Signal: ${result.signal ?? "none"}`,
    `Timed out: ${result.timedOut ? "yes" : "no"}`
  ];
  if (result.stdout.trim().length > 0) {
    status.push(`Stdout:\n${result.stdout.trimEnd()}`);
  }
  if (result.stderr.trim().length > 0) {
    status.push(`Stderr:\n${result.stderr.trimEnd()}`);
  }
  return status.join("\n");
}
