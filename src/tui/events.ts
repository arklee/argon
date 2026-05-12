import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentEvent } from "../types.js";

export interface EventRendererOptions {
  color: boolean;
  showThinking: boolean;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
}

export class TuiEventRenderer {
  private readonly out: NodeJS.WriteStream;
  private readonly err: NodeJS.WriteStream;
  private readonly color: boolean;
  private readonly showThinking: boolean;
  private readonly pendingToolCalls = new Map<string, ToolCall>();
  private assistantOpen = false;
  private thinkingOpen = false;

  constructor(options: EventRendererOptions) {
    this.out = options.stdout ?? process.stdout;
    this.err = options.stderr ?? process.stderr;
    this.color = options.color;
    this.showThinking = options.showThinking;
  }

  render(event: AgentEvent): void {
    switch (event.type) {
      case "turn_start":
        this.line(dim(`\nargon`, this.color) + dim(` ${event.context.model.provider}/${event.context.model.id}`, this.color));
        break;
      case "compaction_start":
        this.closeStreamingBlocks();
        this.line(dim(`compacting ${event.messagesBefore} message(s), ${event.tokensBefore} token(s)`, this.color));
        break;
      case "compaction_end":
        this.closeStreamingBlocks();
        if (event.result) {
          this.line(dim(`compacted ${event.result.messagesBefore} -> ${event.result.messagesAfter} message(s)`, this.color));
        } else if (event.errorMessage) {
          this.line(`${yellow("compact failed", this.color)} ${event.errorMessage}`);
        }
        break;
      case "message_delta":
        if (event.kind === "text" && event.delta.length > 0) {
          this.openAssistant();
          this.out.write(event.delta);
        } else if (event.kind === "thinking" && this.showThinking) {
          this.openThinking();
          this.out.write(dim(event.delta, this.color));
        }
        break;
      case "tool_call_start":
        this.closeStreamingBlocks();
        break;
      case "tool_call_delta":
        break;
      case "tool_call_end":
        this.closeStreamingBlocks();
        this.pendingToolCalls.set(event.toolCall.id, event.toolCall);
        break;
      case "tool_result":
        this.line(renderToolStatus(this.pendingToolCalls.get(event.result.toolCallId) ?? event.toolCall, event.result, this.color));
        this.pendingToolCalls.delete(event.result.toolCallId);
        break;
      case "iteration_start":
        break;
      case "turn_end":
        this.closeStreamingBlocks();
        if (event.reason !== "stop") {
          this.line(`  ${yellow(event.reason, this.color)} after ${event.iterations} iteration(s)`);
        }
        break;
      case "error":
        this.closeStreamingBlocks();
        this.err.write(`${red("error", this.color)} ${event.error.message}\n`);
        break;
      default:
        break;
    }
  }

  status(message: string): void {
    this.closeStreamingBlocks();
    this.line(dim(message, this.color));
  }

  private openAssistant(): void {
    if (this.assistantOpen) return;
    this.closeThinking();
    this.out.write(`${green("assistant", this.color)}\n`);
    this.assistantOpen = true;
  }

  private openThinking(): void {
    if (this.thinkingOpen) return;
    this.closeAssistant();
    this.out.write(`${dim("thinking", this.color)}\n`);
    this.thinkingOpen = true;
  }

  private closeStreamingBlocks(): void {
    this.closeThinking();
    this.closeAssistant();
  }

  private closeAssistant(): void {
    if (!this.assistantOpen) return;
    this.out.write("\n");
    this.assistantOpen = false;
  }

  private closeThinking(): void {
    if (!this.thinkingOpen) return;
    this.out.write("\n");
    this.thinkingOpen = false;
  }

  private line(text: string): void {
    this.out.write(`${text}\n`);
  }

  private outputWidth(): number {
    return typeof this.out.columns === "number" && this.out.columns > 0 ? this.out.columns : 80;
  }
}

export function renderToolResult(result: ToolResultMessage, color: boolean): string {
  const call: ToolCall = { type: "toolCall", id: result.toolCallId, name: result.toolName, arguments: {} };
  return renderToolStatus(call, result, color);
}

export function renderToolCall(name: string, args: Record<string, unknown>, color: boolean): string {
  const call: ToolCall = { type: "toolCall", id: `pending-${name}`, name, arguments: args };
  return renderToolStatus(call, undefined, color);
}

export function renderToolStatus(toolCall: ToolCall, result: ToolResultMessage | undefined, color: boolean): string {
  const label = result?.isError ? red(toolCall.name, color) : result ? green(toolCall.name, color) : cyan(toolCall.name, color);
  const summary = summarizeToolCallArgs(toolCall);
  const summaryPreview = summary ? ` ${summary}` : "";
  const output = result ? summarizeToolResult(result) : "";
  const outputPreview = output ? `\n  ${dim(output, color)}` : "";
  return `  ${bullet(result, color)} ${label}${summaryPreview}${outputPreview}`;
}

export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

export function compactText(text: string, maxLength = 140): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxLength - 3))}...`;
}

function firstText(result: ToolResultMessage): string {
  const block = result.content.find((candidate) => candidate.type === "text");
  return block?.type === "text" ? block.text : "";
}

function summarizeToolResult(result: ToolResultMessage): string {
  const text = firstText(result);
  if (!text) return "";
  const processSummary = summarizeProcessResult(text);
  return compactText(processSummary ?? text, 120);
}

function summarizeProcessResult(text: string): string | undefined {
  const exit = text.match(/^Exit code: (.+)$/m)?.[1];
  const timedOut = text.match(/^Timed out: (.+)$/m)?.[1];
  const stderr = section(text, "Stderr:");
  const stdout = section(text, "Stdout:");
  if (!exit && !timedOut && !stderr && !stdout) return undefined;

  const parts: string[] = [];
  if (exit && exit !== "0") parts.push(`exit ${exit}`);
  if (timedOut === "yes") parts.push("timed out");
  const body = stderr || stdout;
  if (body) parts.push(compactText(body, 90));
  return parts.length > 0 ? parts.join(" | ") : "ok";
}

function section(text: string, header: string): string | undefined {
  const start = text.indexOf(header);
  if (start === -1) return undefined;
  const after = text.slice(start + header.length).trim();
  const nextHeader = after.search(/\n(?:Stdout|Stderr):\n/);
  return (nextHeader === -1 ? after : after.slice(0, nextHeader)).trim();
}

function summarizeToolCallArgs(toolCall: ToolCall): string {
  const args = asRecord(toolCall.arguments);
  switch (toolCall.name) {
    case "bash":
      return quote(summaryValue(args.command) || "(empty)");
    case "read":
    case "write":
    case "edit":
      return summaryValue(args.path) || "(missing path)";
    case "ls":
      return summaryValue(args.path) || ".";
    case "grep": {
      const pattern = summaryValue(args.pattern) || "(missing pattern)";
      const path = summaryValue(args.path);
      return `${quote(pattern)}${path ? ` in ${path}` : ""}`;
    }
    default:
      return formatCompactArgs(args);
  }
}

function formatCompactArgs(args: Record<string, unknown>): string {
  const hidden = new Set(["content", "oldText", "newText"]);
  const parts = Object.entries(args)
    .filter(([key, value]) => value !== undefined && !hidden.has(key))
    .slice(0, 4)
    .map(([key, value]) => `${key}=${quote(summaryValue(value))}`);
  if (Object.keys(args).some((key) => hidden.has(key))) parts.push("...");
  return compactText(parts.join(" "), 120);
}

function summaryValue(value: unknown): string {
  if (typeof value === "string") return compactText(value, 90);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return compactText(value.map(summaryValue).join(", "), 90);
  return compactText(JSON.stringify(value) ?? "", 90);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function quote(text: string): string {
  if (!text) return "\"\"";
  return /[\s"'`]/.test(text) ? JSON.stringify(text) : text;
}

function bullet(result: ToolResultMessage | undefined, color: boolean): string {
  if (!result) return cyan("*", color);
  return result.isError ? red("x", color) : green("*", color);
}

function green(text: string, color: boolean): string {
  return wrap(text, color, 32);
}

function yellow(text: string, color: boolean): string {
  return wrap(text, color, 33);
}

function red(text: string, color: boolean): string {
  return wrap(text, color, 31);
}

function cyan(text: string, color: boolean): string {
  return wrap(text, color, 36);
}

function dim(text: string, color: boolean): string {
  return wrap(text, color, 2);
}

function wrap(text: string, color: boolean, code: number): string {
  return color ? `\u001b[${code}m${text}\u001b[0m` : text;
}
