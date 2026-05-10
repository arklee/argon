import type { ToolResultMessage } from "@mariozechner/pi-ai";
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
      case "message_delta":
        if (event.kind === "text") {
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
        this.line(`  ${cyan("tool", this.color)} ${event.toolCall.name} ${dim(formatArgs(event.toolCall.arguments), this.color)}`);
        break;
      case "tool_result":
        this.line(renderToolResult(event.result, this.color));
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
  const label = result.isError ? red("failed", color) : green("done", color);
  const text = firstText(result);
  const preview = text ? ` ${dim(compact(text), color)}` : "";
  return `  ${label} ${result.toolName}${preview}`;
}

export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function firstText(result: ToolResultMessage): string {
  const block = result.content.find((candidate) => candidate.type === "text");
  return block?.type === "text" ? block.text : "";
}

function compact(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= 140) return singleLine;
  return `${singleLine.slice(0, 137)}...`;
}

function formatArgs(args: Record<string, unknown>): string {
  const text = JSON.stringify(args);
  if (!text) return "{}";
  if (text.length <= 120) return text;
  return `${text.slice(0, 117)}...`;
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
