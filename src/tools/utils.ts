import { resolve } from "node:path";
import type { ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";

export const DEFAULT_MAX_BYTES = 64 * 1024;

export function resolveWorkspacePath(cwd: string, filePath: string): string {
  return resolve(cwd, filePath);
}

export function createToolResult(toolCall: ToolCall, text: string, isError = false): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text }],
    isError,
    timestamp: Date.now()
  };
}

export function truncateText(text: string, maxBytes = DEFAULT_MAX_BYTES): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return text;

  const clipped = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  return `${clipped}\n\n[truncated ${bytes - maxBytes} bytes]`;
}

export function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

export function optionalNumber(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Expected a finite number");
  }
  return value;
}
