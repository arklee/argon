import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentEvent } from "../types.js";

export interface EventRendererOptions {
  color: boolean;
  showThinking: boolean;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
}

type ToolDisplayState = "running" | "success" | "error";

interface ToolDisplay {
  state: ToolDisplayState;
  header: string;
  detail?: string | undefined;
  detailPlacement: "inline" | "tree" | "none";
  output?: string | undefined;
}

export interface ToolStatusItem {
  toolCall: ToolCall;
  result?: ToolResultMessage | undefined;
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
      case "mcp_server_status":
        this.closeStreamingBlocks();
        if (event.status === "failed") {
          this.line(`${yellow("mcp", this.color)} ${event.server} failed: ${event.errorMessage ?? "unknown error"}`);
        } else {
          this.line(dim(`mcp ${event.server} ${event.status}`, this.color));
        }
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
  if (isExplorationToolCall(toolCall)) {
    return renderExplorationToolGroupStatus([{ toolCall, ...(result ? { result } : {}) }], color);
  }

  const display = describeToolDisplay(toolCall, result);
  const lines: string[] = [];
  const marker = stateMarker(display.state, color);
  const header = stateHeader(display.header, display.state, color);
  const inlineDetail = display.detail && display.detailPlacement === "inline" ? ` ${display.detail}` : "";
  lines.push(` ${marker} ${header}${inlineDetail}`);

  if (display.detail && display.detailPlacement === "tree") {
    lines.push(`   ${dim("└", color)} ${display.detail}`);
  }
  if (display.output) {
    lines.push(`   ${dim("└", color)} ${dim(display.output, color)}`);
  }
  return lines.join("\n");
}

export function renderExplorationToolGroupStatus(items: readonly ToolStatusItem[], color: boolean): string {
  if (items.length === 0) return "";

  const displays = items.map((item) => describeToolDisplay(item.toolCall, item.result));
  const state = displays.some((display) => display.state === "error")
    ? "error"
    : displays.some((display) => display.state === "running")
      ? "running"
      : "success";
  const header = state === "running" ? "Exploring" : state === "error" ? "Explore failed" : "Explored";
  const lines = [` ${stateMarker(state, color)} ${stateHeader(header, state, color)}`];

  let firstDetail = true;
  for (const display of displays) {
    const detailLines = [display.detail, display.output ? dim(display.output, color) : undefined].filter(
      (line): line is string => typeof line === "string" && line.length > 0
    );
    for (const detail of detailLines) {
      const prefix = firstDetail ? `   ${dim("└", color)} ` : "     ";
      lines.push(`${prefix}${detail}`);
      firstDetail = false;
    }
  }

  return lines.join("\n");
}

export function isExplorationToolCall(toolCall: ToolCall): boolean {
  return toolCall.name === "read" || toolCall.name === "ls" || toolCall.name === "grep";
}

export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

export function compactText(text: string, maxLength = 140): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxLength - 3))}...`;
}

function describeToolDisplay(toolCall: ToolCall, result: ToolResultMessage | undefined): ToolDisplay {
  const state: ToolDisplayState = result?.isError ? "error" : result ? "success" : "running";
  const args = asRecord(toolCall.arguments);
  const errorOutput = result?.isError ? summarizeGenericResult(result) : undefined;

  switch (toolCall.name) {
    case "bash": {
      const command = quoteIfEmpty(summaryValue(args.command)) || "(empty command)";
      const output = result ? summarizeProcessResult(firstText(result), { includeOk: true }) ?? summarizeGenericResult(result) : undefined;
      return {
        state,
        header: state === "running" ? "Running" : state === "error" ? "Failed" : "Ran",
        detail: command,
        detailPlacement: "inline",
        ...(output ? { output } : {})
      };
    }
    case "read": {
      const detail = withSuccessSummary(`Read ${summaryValue(args.path) || "(missing path)"}`, result, summarizeTextResult);
      return {
        state,
        header: state === "running" ? "Exploring" : state === "error" ? "Explore failed" : "Explored",
        detail,
        detailPlacement: "tree",
        ...(errorOutput ? { output: errorOutput } : {})
      };
    }
    case "ls": {
      const detail = withSuccessSummary(`List ${summaryValue(args.path) || "."}`, result, summarizeListResult);
      return {
        state,
        header: state === "running" ? "Exploring" : state === "error" ? "Explore failed" : "Explored",
        detail,
        detailPlacement: "tree",
        ...(errorOutput ? { output: errorOutput } : {})
      };
    }
    case "grep": {
      const pattern = quote(summaryValue(args.pattern) || "(missing pattern)");
      const path = summaryValue(args.path);
      const target = `${pattern}${path ? ` in ${path}` : ""}`;
      const detail = withSuccessSummary(`Search ${target}`, result, summarizeGrepResult);
      return {
        state,
        header: state === "running" ? "Exploring" : state === "error" ? "Explore failed" : "Explored",
        detail,
        detailPlacement: "tree",
        ...(errorOutput ? { output: errorOutput } : {})
      };
    }
    case "write": {
      return {
        state,
        header: state === "running" ? "Writing" : state === "error" ? "Write failed" : "Wrote",
        detail: summaryValue(args.path) || "(missing path)",
        detailPlacement: "inline",
        ...(errorOutput ? { output: errorOutput } : {})
      };
    }
    case "edit": {
      return {
        state,
        header: state === "running" ? "Editing" : state === "error" ? "Edit failed" : "Edited",
        detail: summaryValue(args.path) || "(missing path)",
        detailPlacement: "inline",
        ...(errorOutput ? { output: errorOutput } : {})
      };
    }
    default:
      return describeExternalTool(toolCall, state, result);
  }
}

function describeExternalTool(toolCall: ToolCall, state: ToolDisplayState, result: ToolResultMessage | undefined): ToolDisplay {
  const args = asRecord(toolCall.arguments);
  const mcp = parseMcpToolName(toolCall.name);
  const detail = mcp ? formatMcpInvocation(mcp.server, mcp.tool, args) : formatGenericInvocation(toolCall.name, args);
  const output = result ? summarizeGenericResult(result) : undefined;
  return {
    state,
    header: state === "running" ? "Calling" : state === "error" ? "Call failed" : "Called",
    detail,
    detailPlacement: "inline",
    ...(output ? { output } : {})
  };
}

function withSuccessSummary(
  detail: string,
  result: ToolResultMessage | undefined,
  summarize: (result: ToolResultMessage) => string | undefined
): string {
  if (!result || result.isError) return detail;
  const summary = summarize(result);
  return summary ? `${detail} - ${summary}` : detail;
}

function firstText(result: ToolResultMessage): string {
  const block = result.content.find((candidate) => candidate.type === "text");
  return block?.type === "text" ? block.text : "";
}

function summarizeGenericResult(result: ToolResultMessage): string | undefined {
  const text = firstText(result);
  if (!text) return undefined;
  const processSummary = summarizeProcessResult(text, { includeOk: false });
  return compactText(processSummary ?? text, 120);
}

function summarizeTextResult(result: ToolResultMessage): string | undefined {
  const text = firstText(result).trimEnd();
  if (!text) return "empty";
  const lines = text.split(/\r\n|\r|\n/).length;
  if (lines > 1) return `${lines} lines`;
  return `${text.length} chars`;
}

function summarizeListResult(result: ToolResultMessage): string | undefined {
  const text = firstText(result).trim();
  if (!text || text === "(empty)") return "empty";
  const count = text.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0).length;
  return count === 1 ? "1 entry" : `${count} entries`;
}

function summarizeGrepResult(result: ToolResultMessage): string | undefined {
  const text = firstText(result);
  const stdout = section(text, "Stdout:");
  const stderr = section(text, "Stderr:");
  const exit = text.match(/^Exit code: (.+)$/m)?.[1];
  if (exit === "1" && !stdout && !stderr) return "no matches";
  if (stdout) {
    const count = stdout.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0).length;
    return count === 1 ? "1 match" : `${count} matches`;
  }
  return summarizeProcessResult(text, { includeOk: false });
}

function summarizeProcessResult(text: string, options: { includeOk: boolean }): string | undefined {
  const exit = text.match(/^Exit code: (.+)$/m)?.[1];
  const signal = text.match(/^Signal: (.+)$/m)?.[1];
  const timedOut = text.match(/^Timed out: (.+)$/m)?.[1];
  const stdout = section(text, "Stdout:");
  const stderr = section(text, "Stderr:");
  if (!exit && !signal && !timedOut && !stderr && !stdout) return undefined;

  const parts: string[] = [];
  if (exit && exit !== "0") parts.push(`exit ${exit}`);
  if (signal && signal !== "none") parts.push(`signal ${signal}`);
  if (timedOut === "yes") parts.push("timed out");
  const body = exit && exit !== "0" ? stderr || stdout : stdout || stderr;
  if (body) parts.push(compactText(body, 90));
  if (parts.length > 0) return parts.join(" | ");
  return options.includeOk ? "(no output)" : "ok";
}

function section(text: string, header: string): string | undefined {
  const start = text.indexOf(header);
  if (start === -1) return undefined;
  const after = text.slice(start + header.length).trim();
  const nextHeader = after.search(/\n(?:Stdout|Stderr):\n/);
  return (nextHeader === -1 ? after : after.slice(0, nextHeader)).trim();
}

function formatMcpInvocation(server: string, tool: string, args: Record<string, unknown>): string {
  const argsText = compactJsonArgs(args);
  return `${server}.${tool}(${argsText})`;
}

function formatGenericInvocation(name: string, args: Record<string, unknown>): string {
  const summary = formatCompactArgs(args);
  return summary ? `${name} ${summary}` : name;
}

function compactJsonArgs(args: Record<string, unknown>): string {
  const sanitized = sanitizeArgs(args);
  if (Object.keys(sanitized).length === 0) return "";
  return compactText(safeJsonStringify(sanitized), 120);
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

function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const hidden = new Set(["content", "oldText", "newText"]);
  const entries = Object.entries(args)
    .filter(([, value]) => value !== undefined)
    .slice(0, 8)
    .map(([key, value]) => [key, hidden.has(key) ? "[omitted]" : value] as const);
  return Object.fromEntries(entries);
}

function summaryValue(value: unknown): string {
  if (typeof value === "string") return compactText(value, 90);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return compactText(value.map(summaryValue).join(", "), 90);
  return compactText(safeJsonStringify(value), 90);
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseMcpToolName(name: string): { server: string; tool: string } | undefined {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!match) return undefined;
  return { server: match[1]!, tool: match[2]! };
}

function quote(text: string): string {
  if (!text) return "\"\"";
  return /[\s"'`]/.test(text) ? JSON.stringify(text) : text;
}

function quoteIfEmpty(text: string): string {
  return text || "\"\"";
}

function stateMarker(state: ToolDisplayState, color: boolean): string {
  if (state === "error") return red("•", color);
  if (state === "success") return green("•", color);
  return cyan("•", color);
}

function stateHeader(text: string, state: ToolDisplayState, color: boolean): string {
  if (state === "error") return red(text, color);
  if (state === "success") return green(text, color);
  return cyan(text, color);
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
