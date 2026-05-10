import {
  CombinedAutocompleteProvider,
  Editor,
  Loader,
  Markdown,
  ProcessTerminal,
  Text,
  TUI,
  matchesKey,
  type Component,
  type SlashCommand
} from "@earendil-works/pi-tui";
import { AgentRuntime } from "../runtime.js";
import type { AgentEvent, RunOptions } from "../types.js";
import { compactText, renderToolCall, renderToolResult } from "./events.js";
import { createArgonTuiTheme, type ArgonTuiTheme } from "./theme.js";
import type { TuiOptions } from "./options.js";

const COMMAND_HELP = "Commands: /help, /status, /clear, /exit";

export const TUI_SLASH_COMMANDS: SlashCommand[] = [
  { name: "help", description: "Show available commands" },
  { name: "status", description: "Show model, cwd, and message count" },
  { name: "clear", description: "Clear chat messages" },
  { name: "exit", description: "Exit Argon" },
  { name: "quit", description: "Exit Argon" }
];

export type SlashCommandResult =
  | { handled: false }
  | { handled: true; action: "message"; message: string }
  | { handled: true; action: "clear"; message: string }
  | { handled: true; action: "exit" };

export interface SlashCommandContext {
  provider: string;
  modelId: string;
  cwd: string;
  messageCount: number;
  configPath?: string | undefined;
}

export interface MutableTuiMessage {
  append(delta: string): void;
}

export interface InteractiveTuiView {
  addUserMessage(text: string): void;
  addAssistantMessage(): MutableTuiMessage;
  addThinkingMessage(): MutableTuiMessage;
  addStatusMessage(text: string): void;
  clearMessages(): void;
  setRunning(running: boolean): void;
  requestRender(): void;
}

export class InteractiveEventController {
  private currentAssistant: MutableTuiMessage | undefined;
  private currentThinking: MutableTuiMessage | undefined;

  constructor(
    private readonly view: InteractiveTuiView,
    private readonly options: { color: boolean; showThinking: boolean }
  ) {}

  beginRun(prompt: string): void {
    this.currentAssistant = undefined;
    this.currentThinking = undefined;
    this.view.addUserMessage(prompt);
    this.view.setRunning(true);
  }

  render(event: AgentEvent): void {
    switch (event.type) {
      case "turn_start":
        this.view.setRunning(true);
        break;
      case "message_delta":
        if (event.kind === "text") {
          this.assistantMessage().append(event.delta);
        } else if (event.kind === "thinking" && this.options.showThinking) {
          this.thinkingMessage().append(event.delta);
        }
        break;
      case "message_end":
        this.closeStreamingBlocks();
        break;
      case "tool_call_start":
        this.closeStreamingBlocks();
        break;
      case "tool_call_end":
        this.closeStreamingBlocks();
        this.view.addStatusMessage(renderToolCall(event.toolCall.name, event.toolCall.arguments, this.options.color));
        break;
      case "tool_result":
        this.closeStreamingBlocks();
        this.view.addStatusMessage(renderToolResult(event.result, this.options.color));
        break;
      case "turn_end":
        this.closeStreamingBlocks();
        this.view.setRunning(false);
        if (event.reason !== "stop") {
          this.view.addStatusMessage(`  ${event.reason} after ${event.iterations} iteration(s)`);
        }
        break;
      case "error":
        this.closeStreamingBlocks();
        this.view.addStatusMessage(`error ${event.error.message}`);
        break;
      default:
        break;
    }

    this.view.requestRender();
  }

  private assistantMessage(): MutableTuiMessage {
    if (!this.currentAssistant) {
      this.currentAssistant = this.view.addAssistantMessage();
    }
    return this.currentAssistant;
  }

  private thinkingMessage(): MutableTuiMessage {
    if (!this.currentThinking) {
      this.currentThinking = this.view.addThinkingMessage();
    }
    return this.currentThinking;
  }

  private closeStreamingBlocks(): void {
    this.currentAssistant = undefined;
    this.currentThinking = undefined;
  }
}

export async function runInteractiveTui(runtime: AgentRuntime, options: TuiOptions): Promise<void> {
  const app = new ArgonInteractiveTui(runtime, options);
  await app.run();
}

export function resolveSlashCommand(input: string, context: SlashCommandContext): SlashCommandResult {
  const command = input.trim();
  switch (command) {
    case "/help":
      return { handled: true, action: "message", message: COMMAND_HELP };
    case "/status":
      return {
        handled: true,
        action: "message",
        message: `model=${context.provider}/${context.modelId} cwd=${context.cwd} messages=${context.messageCount}${context.configPath ? ` config=${context.configPath}` : ""}`
      };
    case "/clear":
      return { handled: true, action: "clear", message: "Cleared chat messages." };
    case "/exit":
    case "/quit":
      return { handled: true, action: "exit" };
    default:
      if (command.startsWith("/")) {
        return { handled: true, action: "message", message: `Unknown command: ${command}` };
      }
      return { handled: false };
  }
}

export function createInteractiveRunOptions(options: TuiOptions): RunOptions {
  return {
    ...(options.reasoning ? { reasoning: options.reasoning } : {})
  };
}

export function rememberSubmittedPrompt(editor: Pick<Editor, "addToHistory">, prompt: string): string | undefined {
  const trimmed = prompt.trim();
  if (!trimmed) return undefined;
  editor.addToHistory(trimmed);
  return trimmed;
}

class ArgonInteractiveTui {
  private readonly terminal = new ProcessTerminal();
  private readonly tui = new TUI(this.terminal);
  private readonly theme: ArgonTuiTheme;
  private readonly editor: Editor;
  private readonly view: PiTuiConversationView;
  private readonly controller: InteractiveEventController;
  private running = false;
  private stopped = false;
  private resolveRun: (() => void) | undefined;

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly options: TuiOptions
  ) {
    this.theme = createArgonTuiTheme(options.color && Boolean(process.stdout.isTTY));
    this.editor = new Editor(this.tui, this.theme.editor, { paddingX: 0, autocompleteMaxVisible: 8 });
    this.view = new PiTuiConversationView(this.tui, this.editor, this.theme, options);
    this.controller = new InteractiveEventController(this.view, {
      color: options.color && Boolean(process.stdout.isTTY),
      showThinking: options.showThinking
    });
  }

  async run(): Promise<void> {
    this.mount();

    return await new Promise<void>((resolve) => {
      this.resolveRun = resolve;
      this.tui.start();
    });
  }

  private mount(): void {
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(TUI_SLASH_COMMANDS, this.options.cwd));
    this.editor.onSubmit = (text) => {
      void this.submit(text);
    };

    this.tui.addInputListener((data) => {
      if (!matchesKey(data, "ctrl+c")) return undefined;

      if (this.running) {
        this.runtime.abort();
        this.view.addStatusMessage(this.theme.ansi.yellow("Interrupted current run."));
        this.view.requestRender();
        return { consume: true };
      }

      void this.shutdown();
      return { consume: true };
    });

    this.tui.setFocus(this.editor);
    this.view.showWelcome();
  }

  private async submit(text: string): Promise<void> {
    if (this.running || this.stopped) return;

    const trimmed = text.trim();
    if (!trimmed) return;

    const command = resolveSlashCommand(trimmed, {
      provider: this.options.provider,
      modelId: this.options.modelId,
      cwd: this.options.cwd,
      messageCount: this.runtime.messages().length,
      configPath: this.options.configPath
    });

    if (command.handled) {
      if (command.action === "exit") {
        await this.shutdown();
      } else if (command.action === "clear") {
        this.view.clearMessages();
        this.view.addStatusMessage(this.theme.ansi.dim(command.message));
      } else {
        this.view.addStatusMessage(this.theme.ansi.dim(command.message));
      }
      this.view.requestRender();
      return;
    }

    const prompt = rememberSubmittedPrompt(this.editor, trimmed);
    if (!prompt) return;

    this.running = true;
    this.editor.disableSubmit = true;
    this.controller.beginRun(prompt);

    try {
      for await (const event of this.runtime.run(prompt, createInteractiveRunOptions(this.options))) {
        this.controller.render(event);
      }
    } catch (error) {
      this.view.addStatusMessage(`error ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
      this.editor.disableSubmit = false;
      this.view.setRunning(false);
      this.tui.setFocus(this.editor);
      this.view.requestRender();
    }
  }

  private async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.running) this.runtime.abort();
    this.editor.disableSubmit = true;
    this.view.dispose();
    await this.terminal.drainInput(250, 20);
    this.tui.stop();
    this.resolveRun?.();
  }
}

class PiTuiConversationView implements InteractiveTuiView {
  private readonly status: Text;
  private readonly hint: Text;
  private readonly messageComponents: Component[] = [];
  private loader: Loader | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly editor: Editor,
    private readonly theme: ArgonTuiTheme,
    private readonly options: TuiOptions
  ) {
    this.status = new Text("", 0, 0);
    this.hint = new Text(this.theme.ansi.dim("Type /help for commands. Enter submits; Shift+Enter inserts a newline."), 0, 0);
    this.tui.addChild(this.status);
    this.tui.addChild(this.hint);
    this.tui.addChild(this.editor);
    this.setRunning(false);
  }

  showWelcome(): void {
    this.addStatusMessage(this.theme.ansi.dim("Argon TUI ready."));
  }

  addUserMessage(text: string): void {
    this.addMarkdown(`**you**\n\n${text}`);
  }

  addAssistantMessage(): MutableTuiMessage {
    return this.addMutableMarkdown("**assistant**\n\n");
  }

  addThinkingMessage(): MutableTuiMessage {
    return this.addMutableMarkdown("**thinking**\n\n", { dim: true });
  }

  addStatusMessage(text: string): void {
    this.removeLoader();
    this.addComponent(new Text(text, 1, 0));
  }

  clearMessages(): void {
    for (const component of this.messageComponents) {
      this.tui.removeChild(component);
    }
    this.messageComponents.length = 0;
    this.removeLoader();
    this.tui.requestRender(true);
  }

  setRunning(running: boolean): void {
    this.editor.disableSubmit = running;
    this.status.setText(this.statusText(running));
    if (running) {
      this.ensureLoader();
    } else {
      this.removeLoader();
    }
    this.requestRender();
  }

  requestRender(): void {
    this.tui.requestRender();
  }

  dispose(): void {
    this.removeLoader();
  }

  private addMarkdown(text: string): Markdown {
    const markdown = new Markdown(text, 1, 1, this.theme.markdown);
    this.addComponent(markdown);
    return markdown;
  }

  private addMutableMarkdown(prefix: string, options: { dim?: boolean } = {}): MutableTuiMessage {
    this.removeLoader();
    let content = "";
    const style = options.dim ? { color: this.theme.ansi.dim } : undefined;
    const markdown = new Markdown(prefix, 1, 1, this.theme.markdown, style);
    this.addComponent(markdown);
    return {
      append: (delta: string) => {
        content += delta;
        markdown.setText(prefix + content);
      }
    };
  }

  private addComponent(component: Component): void {
    const editorIndex = this.tui.children.indexOf(this.editor);
    const insertAt = editorIndex === -1 ? this.tui.children.length : editorIndex;
    this.tui.children.splice(insertAt, 0, component);
    this.messageComponents.push(component);
    this.requestRender();
  }

  private ensureLoader(): void {
    if (this.loader) return;
    this.loader = new Loader(this.tui, this.theme.ansi.cyan, this.theme.ansi.dim, "Thinking...");
    this.addComponent(this.loader);
  }

  private removeLoader(): void {
    if (!this.loader) return;
    this.loader.stop();
    this.tui.removeChild(this.loader);
    const index = this.messageComponents.indexOf(this.loader);
    if (index !== -1) this.messageComponents.splice(index, 1);
    this.loader = undefined;
  }

  private statusText(running: boolean): string {
    const mode = running ? this.theme.ansi.yellow("running") : this.theme.ansi.green("idle");
    const config = this.options.configPath ? ` config=${this.options.configPath}` : "";
    const cwd = compactText(this.options.cwd, 72);
    return `${this.theme.ansi.bold("Argon")} ${mode} ${this.options.provider}/${this.options.modelId} cwd=${cwd}${config}`;
  }
}
