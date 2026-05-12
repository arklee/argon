import {
  CombinedAutocompleteProvider,
  Editor,
  Input,
  Loader,
  Markdown,
  ProcessTerminal,
  Text,
  TUI,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type SlashCommand
} from "@earendil-works/pi-tui";
import type { Model, OAuthPrompt, ToolCall } from "@earendil-works/pi-ai";
import { exec } from "node:child_process";
import { saveDefaultModel, saveDefaultReasoning } from "../config/settings.js";
import type { ModelRegistry } from "../model/registry.js";
import { AgentRuntime } from "../runtime.js";
import { SessionManager, type SessionInfo, type SessionTreeNode } from "../session/manager.js";
import {
  THINKING_LEVEL_DESCRIPTIONS,
  clampArgonThinkingLevel,
  currentThinkingLevel,
  supportedThinkingLevels,
  type ArgonThinkingLevel
} from "../thinking.js";
import type { AgentEvent, AgentMessage, RunOptions, TurnEndReason, UserInput } from "../types.js";
import { compactText, renderToolResult, renderToolStatus } from "./events.js";
import { createArgonTuiTheme, type ArgonTuiTheme } from "./theme.js";
import type { TuiOptions } from "./options.js";
import { PickerComponent, type SelectionItem } from "./selectors.js";
import {
  currentModelSupportsImages,
  displayImageAttachment,
  maybeCreateAttachmentFromPastedPath,
  pasteClipboardImageToTempFile,
  prepareImageInput,
  type LocalImageAttachment
} from "./image-paste.js";

const COMMAND_HELP = "Commands: /help, /status, /model, /thinking, /reasoning, /login, /session, /resume, /tree, /compact, /clear, /exit";

export const TUI_SLASH_COMMANDS: SlashCommand[] = [
  { name: "help", description: "Show available commands" },
  { name: "status", description: "Show model, cwd, and message count" },
  { name: "model", description: "Select model" },
  { name: "thinking", description: "Select thinking level" },
  { name: "reasoning", description: "Select thinking level" },
  { name: "login", description: "Configure provider authentication" },
  { name: "session", description: "Show current session details" },
  { name: "resume", description: "Resume a previous session" },
  { name: "tree", description: "Navigate the current session tree" },
  { name: "compact", description: "Compact conversation context" },
  { name: "clear", description: "Clear chat messages" },
  { name: "exit", description: "Exit Argon" },
  { name: "quit", description: "Exit Argon" }
];

export type SlashCommandResult =
  | { handled: false }
  | { handled: true; action: "message"; message: string }
  | { handled: true; action: "clear"; message: string }
  | { handled: true; action: "exit" }
  | { handled: true; action: "resume" }
  | { handled: true; action: "tree" }
  | { handled: true; action: "compact"; instructions?: string | undefined }
  | { handled: true; action: "model" }
  | { handled: true; action: "thinking" }
  | { handled: true; action: "login" };

export interface SlashCommandContext {
  provider: string;
  modelId: string;
  cwd: string;
  messageCount: number;
  thinkingLevel: ArgonThinkingLevel;
  sessionFile?: string | undefined;
  sessionId?: string | undefined;
  configPath?: string | undefined;
}

export interface MutableTuiMessage {
  append(delta: string): void;
  finalize?(): void;
}

export interface MutableStatusMessage {
  setText(text: string): void;
}

export interface InteractiveTuiView {
  addUserMessage(text: string): void;
  addAssistantMessage(): MutableTuiMessage;
  addThinkingMessage(): MutableTuiMessage;
  addStatusMessage(text: string): void;
  addMutableStatusMessage(text: string): MutableStatusMessage;
  renderMessages?(messages: AgentMessage[]): void;
  clearMessages(): void;
  setRunning(running: boolean): void;
  finishRun(reason: TurnEndReason): void;
  requestRender(): void;
}

export class InteractiveEventController {
  private currentAssistant: MutableTuiMessage | undefined;
  private currentThinking: MutableTuiMessage | undefined;
  private readonly pendingToolStatuses = new Map<string, { toolCall: ToolCall; message: MutableStatusMessage }>();

  constructor(
    private readonly view: InteractiveTuiView,
    private readonly options: { color: boolean; showThinking: boolean }
  ) {}

  beginRun(prompt: string): void {
    this.currentAssistant = undefined;
    this.currentThinking = undefined;
    this.pendingToolStatuses.clear();
    this.view.addUserMessage(prompt);
    this.view.setRunning(true);
  }

  render(event: AgentEvent): void {
    switch (event.type) {
      case "turn_start":
        this.view.setRunning(true);
        break;
      case "compaction_start":
        this.closeStreamingBlocks();
        this.view.setRunning(true);
        this.view.addStatusMessage(`  compacting ${event.messagesBefore} message(s), ${event.tokensBefore} token(s)`);
        break;
      case "compaction_end":
        this.closeStreamingBlocks();
        this.view.setRunning(false);
        this.view.addStatusMessage(
          event.result
            ? `  compacted ${event.result.messagesBefore} -> ${event.result.messagesAfter} message(s)`
            : `  compact failed${event.errorMessage ? `: ${event.errorMessage}` : ""}`
        );
        break;
      case "message_delta":
        if (event.kind === "text" && event.delta.length > 0) {
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
        this.pendingToolStatuses.set(event.toolCall.id, {
          toolCall: event.toolCall,
          message: this.view.addMutableStatusMessage(renderToolStatus(event.toolCall, undefined, this.options.color))
        });
        break;
      case "tool_result":
        this.closeStreamingBlocks();
        {
          const pending = this.pendingToolStatuses.get(event.result.toolCallId);
          if (pending) {
            pending.message.setText(renderToolStatus(pending.toolCall, event.result, this.options.color));
            this.pendingToolStatuses.delete(event.result.toolCallId);
          } else {
            this.view.addStatusMessage(renderToolStatus(event.toolCall, event.result, this.options.color));
          }
        }
        break;
      case "iteration_start":
        break;
      case "turn_end":
        this.closeStreamingBlocks();
        this.pendingToolStatuses.clear();
        this.view.finishRun(event.reason);
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
    this.currentAssistant?.finalize?.();
    this.currentThinking?.finalize?.();
    this.currentAssistant = undefined;
    this.currentThinking = undefined;
  }
}

export async function runInteractiveTui(runtime: AgentRuntime, options: TuiOptions, modelRegistry: ModelRegistry): Promise<void> {
  const app = new ArgonInteractiveTui(runtime, options, modelRegistry);
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
        message: `model=${context.provider}/${context.modelId} thinking=${context.thinkingLevel} cwd=${context.cwd} messages=${context.messageCount}${context.sessionId ? ` session=${context.sessionId}` : ""}${context.configPath ? ` config=${context.configPath}` : ""}`
      };
    case "/session":
      return {
        handled: true,
        action: "message",
        message: context.sessionFile
          ? `session=${context.sessionId ?? "(unknown)"} file=${context.sessionFile} messages=${context.messageCount}`
          : "session persistence is disabled"
      };
    case "/resume":
      return { handled: true, action: "resume" };
    case "/tree":
      return { handled: true, action: "tree" };
    case "/compact":
      return { handled: true, action: "compact" };
    case "/model":
      return { handled: true, action: "model" };
    case "/thinking":
    case "/reasoning":
      return { handled: true, action: "thinking" };
    case "/login":
      return { handled: true, action: "login" };
    case "/clear":
      return { handled: true, action: "clear", message: "Cleared chat messages." };
    case "/exit":
    case "/quit":
      return { handled: true, action: "exit" };
    default:
      if (command.startsWith("/compact ")) {
        return { handled: true, action: "compact", instructions: command.slice("/compact ".length).trim() };
      }
      if (command.startsWith("/")) {
        return { handled: true, action: "message", message: `Unknown command: ${command}` };
      }
      return { handled: false };
  }
}

export function createInteractiveRunOptions(options: TuiOptions): RunOptions {
  return {
    ...(options.reasoning ? { reasoning: options.reasoning } : {}),
    ...(options.compaction ? { compaction: options.compaction } : {})
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
  private readonly editor: ImagePasteEditor;
  private readonly view: PiTuiConversationView;
  private readonly controller: InteractiveEventController;
  private imageAttachments: LocalImageAttachment[] = [];
  private running = false;
  private stopped = false;
  private resolveRun: (() => void) | undefined;

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly options: TuiOptions,
    private readonly modelRegistry: ModelRegistry
  ) {
    this.theme = createArgonTuiTheme(options.color && Boolean(process.stdout.isTTY));
    this.editor = new ImagePasteEditor(this.tui, this.theme.editor, { paddingX: 1, autocompleteMaxVisible: 8 });
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
    this.editor.onPasteImage = () => {
      void this.attachClipboardImage();
    };
    this.editor.onPasteText = async (text) => await this.attachPastedImagePath(text);

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
    if (this.runtime.messages().length > 0) {
      this.view.renderMessages(this.runtime.messages());
    }
  }

  private async submit(text: string): Promise<void> {
    if (this.running || this.stopped) return;

    const trimmed = text.trim();
    if (!trimmed) return;

    const activeSession = this.runtime.getSession();
    const activeModel = this.runtime.getModel();
    const command = resolveSlashCommand(trimmed, {
      provider: activeModel.provider,
      modelId: activeModel.id,
      cwd: this.options.cwd,
      messageCount: this.runtime.messages().length,
      thinkingLevel: currentThinkingLevel(this.options.reasoning),
      ...(activeSession ? { sessionFile: activeSession.getSessionFile(), sessionId: activeSession.getSessionId() } : {}),
      ...(this.options.configPath ? { configPath: this.options.configPath } : {})
    });

    if (command.handled) {
      if (command.action === "exit") {
        await this.shutdown();
      } else if (command.action === "clear") {
        this.view.clearMessages();
        this.view.addStatusMessage(this.theme.ansi.dim(command.message));
      } else if (command.action === "resume") {
        await this.handleResumeCommand();
      } else if (command.action === "tree") {
        await this.handleTreeCommand();
      } else if (command.action === "compact") {
        await this.handleCompactCommand(command.instructions);
      } else if (command.action === "model") {
        await this.handleModelCommand();
      } else if (command.action === "thinking") {
        await this.handleThinkingCommand();
      } else if (command.action === "login") {
        await this.handleLoginCommand();
      } else {
        this.view.addStatusMessage(this.theme.ansi.dim(command.message));
      }
      this.view.requestRender();
      return;
    }

    let runInput: UserInput = trimmed;
    let prompt = rememberSubmittedPrompt(this.editor, trimmed);
    if (!prompt) return;

    if (this.imageAttachments.length > 0) {
      if (!currentModelSupportsImages(activeModel)) {
        this.editor.setText(trimmed);
        this.view.addStatusMessage(this.theme.ansi.yellow(`Model ${activeModel.id} does not support image inputs.`));
        this.view.requestRender();
        return;
      }

      try {
        const prepared = await prepareImageInput(trimmed, this.imageAttachments);
        this.imageAttachments = prepared.attachments;
        runInput = { content: prepared.content };
        prompt = prepared.text;
      } catch (error) {
        this.editor.setText(trimmed);
        this.view.addStatusMessage(`error ${error instanceof Error ? error.message : String(error)}`);
        this.view.requestRender();
        return;
      }
    }

    this.running = true;
    this.editor.disableSubmit = true;
    this.controller.beginRun(prompt);

    try {
      for await (const event of this.runtime.run(runInput, createInteractiveRunOptions(this.options))) {
        this.controller.render(event);
      }
      this.imageAttachments = [];
    } catch (error) {
      this.view.finishRun("error");
      this.view.addStatusMessage(`error ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
      this.editor.disableSubmit = false;
      this.view.setRunning(false);
      this.tui.setFocus(this.editor);
      this.view.requestRender();
    }
  }

  private async handleCompactCommand(instructions?: string): Promise<void> {
    this.running = true;
    this.editor.disableSubmit = true;
    this.view.setRunning(true);
    try {
      for await (const event of this.runtime.compact(instructions, createInteractiveRunOptions(this.options))) {
        this.controller.render(event);
      }
      this.view.clearMessages();
      this.view.renderMessages?.(this.runtime.messages());
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

  private async attachClipboardImage(): Promise<void> {
    if (this.running || this.stopped) return;
    const model = this.runtime.getModel();
    if (!currentModelSupportsImages(model)) {
      this.view.addStatusMessage(this.theme.ansi.yellow(`Model ${model.id} does not support image inputs.`));
      this.view.requestRender();
      return;
    }

    try {
      const attachment = await pasteClipboardImageToTempFile(this.imageAttachments);
      if (!attachment) {
        this.view.addStatusMessage(this.theme.ansi.dim("No image found on clipboard."));
        this.view.requestRender();
        return;
      }
      this.addImageAttachment(attachment, { trailingSpace: false });
    } catch (error) {
      this.view.addStatusMessage(`error Failed to paste image: ${error instanceof Error ? error.message : String(error)}`);
      this.view.requestRender();
    }
  }

  private async attachPastedImagePath(text: string): Promise<boolean> {
    if (this.running || this.stopped || !currentModelSupportsImages(this.runtime.getModel())) return false;
    const attachment = await maybeCreateAttachmentFromPastedPath(text, this.imageAttachments);
    if (!attachment) return false;
    this.addImageAttachment(attachment, { trailingSpace: true });
    return true;
  }

  private addImageAttachment(attachment: LocalImageAttachment, options: { trailingSpace: boolean }): void {
    this.imageAttachments.push(attachment);
    this.editor.insertTextAtCursor(`${attachment.placeholder}${options.trailingSpace ? " " : ""}`);
    this.view.addStatusMessage(this.theme.ansi.dim(`Attached ${displayImageAttachment(attachment)}`));
    this.view.requestRender();
  }

  private async handleResumeCommand(): Promise<void> {
    const sessions = SessionManager.list(this.options.cwd);
    if (sessions.length === 0) {
      this.view.addStatusMessage(this.theme.ansi.dim("No sessions found for this cwd."));
      return;
    }
    const selected = await this.pick("Resume Session", sessionItems(sessions));
    if (!selected) {
      this.view.addStatusMessage(this.theme.ansi.dim("Resume cancelled."));
      return;
    }
    try {
      this.runtime.switchSession(SessionManager.open(selected));
      this.view.renderMessages(this.runtime.messages());
      this.view.addStatusMessage(this.theme.ansi.dim(`Resumed ${this.runtime.getSession()?.getSessionId() ?? selected}`));
    } catch (error) {
      this.view.addStatusMessage(`error ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handleTreeCommand(): Promise<void> {
    const session = this.runtime.getSession();
    if (!session) {
      this.view.addStatusMessage(this.theme.ansi.dim("Session persistence is disabled."));
      return;
    }
    const rows = session.tree();
    if (rows.length === 0) {
      this.view.addStatusMessage(this.theme.ansi.dim("Session tree is empty."));
      return;
    }
    const selected = await this.pick("Session Tree", treeItems(rows));
    if (!selected) {
      this.view.addStatusMessage(this.theme.ansi.dim("Tree navigation cancelled."));
      return;
    }
    try {
      session.branchTo(selected, "selected from /tree");
      this.runtime.switchSession(session);
      this.view.renderMessages(this.runtime.messages());
      this.view.addStatusMessage(this.theme.ansi.dim("Moved to selected session point."));
    } catch (error) {
      this.view.addStatusMessage(`error ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handleModelCommand(): Promise<void> {
    this.modelRegistry.refresh();
    if (this.modelRegistry.getError()) {
      this.view.addStatusMessage(`warning ${this.modelRegistry.getError()}`);
    }

    const models = this.modelRegistry.getAvailable();
    if (models.length === 0) {
      this.view.addStatusMessage(this.theme.ansi.dim("No authenticated models. Use /login first."));
      return;
    }

    const selected = await this.pick("Select Model", modelItems(models, this.modelRegistry));
    if (!selected) {
      this.view.addStatusMessage(this.theme.ansi.dim("Model selection cancelled."));
      return;
    }

    const slash = selected.indexOf("/");
    const provider = selected.slice(0, slash);
    const modelId = selected.slice(slash + 1);
    const model = this.modelRegistry.find(provider, modelId);
    if (!model) {
      this.view.addStatusMessage(`error Unknown model: ${selected}`);
      return;
    }

    try {
      this.runtime.switchModel(model);
      this.options.provider = model.provider;
      this.options.modelId = model.id;
      const previousThinking = currentThinkingLevel(this.options.reasoning);
      const clampedThinking = clampArgonThinkingLevel(model, previousThinking);
      if (clampedThinking !== previousThinking) {
        this.options.reasoning = clampedThinking;
        saveDefaultReasoning(clampedThinking);
      }
      saveDefaultModel(model.provider, model.id);
      const thinkingNote = clampedThinking !== previousThinking ? ` thinking=${clampedThinking}` : "";
      this.view.addStatusMessage(this.theme.ansi.dim(`Selected ${model.provider}/${model.id}${thinkingNote}. Saved as default.`));
      this.view.setRunning(false);
    } catch (error) {
      this.view.addStatusMessage(`error ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handleThinkingCommand(): Promise<void> {
    const model = this.runtime.getModel();
    const current = currentThinkingLevel(this.options.reasoning);
    const levels = supportedThinkingLevels(model);
    const selected = await this.pick("Select Thinking Level", thinkingItems(levels, current));
    if (!selected) {
      this.view.addStatusMessage(this.theme.ansi.dim("Thinking level selection cancelled."));
      return;
    }

    const reasoning = selected as ArgonThinkingLevel;
    this.options.reasoning = reasoning;
    saveDefaultReasoning(reasoning);
    this.view.addStatusMessage(this.theme.ansi.dim(`Selected thinking=${reasoning}. Saved as default.`));
  }

  private async handleLoginCommand(): Promise<void> {
    const authType = await this.pick("Authentication Method", [
      { value: "oauth", label: "Use a subscription", description: "Open browser OAuth login for supported providers." },
      { value: "api_key", label: "Use an API key", description: "Store a provider API key in auth.json." }
    ]);
    if (authType === "oauth") {
      await this.handleOAuthLogin();
    } else if (authType === "api_key") {
      await this.handleApiKeyLogin();
    }
  }

  private async handleOAuthLogin(): Promise<void> {
    const providers = this.modelRegistry.authStorage.getOAuthProviders();
    const selected = await this.pick(
      "Subscription Provider",
      providers.map((provider) => ({ value: provider.id, label: provider.name, description: provider.id }))
    );
    if (!selected) return;

    const provider = providers.find((candidate) => candidate.id === selected);
    try {
      await this.modelRegistry.authStorage.login(selected, {
        onAuth: (info) => {
          this.view.addStatusMessage(this.theme.ansi.dim(`Open this URL to login: ${info.url}`));
          if (info.instructions) this.view.addStatusMessage(this.theme.ansi.dim(info.instructions));
          openExternal(info.url);
        },
        onPrompt: (prompt: OAuthPrompt) => this.promptText(prompt.message, prompt.placeholder),
        onProgress: (message) => this.view.addStatusMessage(this.theme.ansi.dim(message))
      });
      this.modelRegistry.refresh();
      this.view.addStatusMessage(this.theme.ansi.dim(`Logged in to ${provider?.name ?? selected}.`));
    } catch (error) {
      this.view.addStatusMessage(`error ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handleApiKeyLogin(): Promise<void> {
    const oauthProviderIds = new Set(this.modelRegistry.authStorage.getOAuthProviders().map((provider) => provider.id));
    const providers = Array.from(new Set(this.modelRegistry.getAll().map((model) => model.provider)))
      .filter((provider) => provider !== "openai-codex" && provider !== "github-copilot")
      .sort();
    const selected = await this.pick(
      "API Key Provider",
      providers.map((provider) => ({
        value: provider,
        label: this.modelRegistry.getProviderDisplayName(provider),
        description: oauthProviderIds.has(provider) ? `${provider} (also supports subscription)` : provider
      }))
    );
    if (!selected) return;

    try {
      const key = (await this.promptText(`Enter API key for ${selected}:`)).trim();
      if (!key) throw new Error("API key cannot be empty");
      this.modelRegistry.authStorage.set(selected, { type: "api_key", key });
      this.modelRegistry.refresh();
      this.view.addStatusMessage(this.theme.ansi.dim(`Saved API key for ${selected}.`));
    } catch (error) {
      this.view.addStatusMessage(`error ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async pick(title: string, items: SelectionItem[]): Promise<string | undefined> {
    return new Promise((resolve) => {
      const picker = new PickerComponent(title, items, this.theme.editor.selectList, (value) => {
        handle.hide();
        this.tui.setFocus(this.editor);
        resolve(value);
      });
      const handle = this.tui.showOverlay(picker, {
        anchor: "center",
        width: "90%",
        margin: 1
      });
      handle.focus();
      this.view.requestRender();
    });
  }

  private async promptText(prompt: string, placeholder?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const input = new TextInputComponent(
        prompt,
        placeholder,
        (value) => {
          handle.hide();
          this.tui.setFocus(this.editor);
          resolve(value);
        },
        () => {
          handle.hide();
          this.tui.setFocus(this.editor);
          reject(new Error("Input cancelled"));
        }
      );
      const handle = this.tui.showOverlay(input, {
        anchor: "center",
        width: "90%",
        margin: 1
      });
      handle.focus();
      this.view.requestRender();
    });
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

class ImagePasteEditor extends Editor {
  onPasteImage?: () => void;
  onPasteText?: (text: string) => boolean | Promise<boolean>;
  private imagePasteBuffer = "";
  private capturingPaste = false;

  override render(width: number): string[] {
    const prompt = "❯";
    const promptWidth = visibleWidth(prompt);
    if (width <= 2 + promptWidth) return super.render(width);

    const innerWidth = Math.max(1, width - 2);
    const editorWidth = Math.max(1, innerWidth - promptWidth);
    const editorLines = super.render(editorWidth);
    const topRuleIndex = 0;
    const bottomRuleIndex = findLastEditorRule(editorLines, editorWidth);
    const contentLines = editorLines.filter((_, index) => index !== topRuleIndex && index !== bottomRuleIndex);
    const body = contentLines.map((line, index) => `${index === 0 ? prompt : " ".repeat(promptWidth)}${padEditorLine(line, editorWidth)}`);

    return [
      this.borderColor(`╭${"─".repeat(innerWidth)}╮`),
      ...body.map((line) => `${this.borderColor("│")}${line}${this.borderColor("│")}`),
      this.borderColor(`╰${"─".repeat(innerWidth)}╯`)
    ];
  }

  override handleInput(data: string): void {
    if (matchesKey(data, "ctrl+v") || matchesKey(data, "alt+v")) {
      this.onPasteImage?.();
      return;
    }

    const start = "\x1b[200~";
    const end = "\x1b[201~";
    if (data.includes(start) || this.capturingPaste) {
      this.capturePasteChunk(data, start, end);
      return;
    }

    super.handleInput(data);
  }

  private capturePasteChunk(data: string, start: string, end: string): void {
    if (data.includes(start)) {
      this.capturingPaste = true;
      this.imagePasteBuffer = "";
      data = data.replace(start, "");
    }

    this.imagePasteBuffer += data;
    const endIndex = this.imagePasteBuffer.indexOf(end);
    if (endIndex === -1) return;

    const pasted = this.imagePasteBuffer.slice(0, endIndex);
    const remaining = this.imagePasteBuffer.slice(endIndex + end.length);
    const rawPaste = `${start}${pasted}${end}`;
    this.capturingPaste = false;
    this.imagePasteBuffer = "";

    void Promise.resolve(this.onPasteText?.(pasted) ?? false)
      .catch(() => false)
      .then((handled) => {
        if (!handled) super.handleInput(rawPaste);
        if (remaining) this.handleInput(remaining);
      });
  }
}

function findLastEditorRule(lines: string[], width: number): number {
  for (let index = lines.length - 1; index > 0; index--) {
    if (isEditorRule(lines[index] ?? "", width)) return index;
  }
  return lines.length - 1;
}

function isEditorRule(line: string, width: number): boolean {
  const plain = stripAnsi(line);
  return visibleWidth(line) === width && (/^─+$/.test(plain) || /^─── [↑↓] \d+ more ─*$/.test(plain));
}

function padEditorLine(line: string, width: number): string {
  const visible = visibleWidth(line);
  if (visible > width) return truncateToWidth(line, width, "", true);
  return `${line}${" ".repeat(width - visible)}`;
}

function renderInputBox(text: string, width: number, borderColor: (text: string) => string): string[] {
  if (width <= 4) return [truncateToWidth(text, width, "", true)];

  const prompt = "❯";
  const promptWidth = visibleWidth(prompt);
  const innerWidth = Math.max(1, width - 2);
  const showPrompt = innerWidth > promptWidth + 1;
  const firstPrefix = showPrompt ? `${prompt} ` : "";
  const continuationPrefix = " ".repeat(visibleWidth(firstPrefix));
  const textWidth = Math.max(1, innerWidth - visibleWidth(firstPrefix));
  const normalizedText = text.replace(/\t/g, "   ");
  const wrappedLines = wrapTextWithAnsi(normalizedText, textWidth);
  const contentLines = wrappedLines.length > 0 ? wrappedLines : [""];
  const body = contentLines.map((line, index) => `${index === 0 ? firstPrefix : continuationPrefix}${padEditorLine(line, textWidth)}`);

  return [
    borderColor(`╭${"─".repeat(innerWidth)}╮`),
    ...body.map((line) => `${borderColor("│")}${line}${borderColor("│")}`),
    borderColor(`╰${"─".repeat(innerWidth)}╯`)
  ];
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

class TextInputComponent implements Component {
  private readonly input = new Input();

  constructor(
    private readonly prompt: string,
    placeholder: string | undefined,
    private readonly onDone: (value: string) => void,
    private readonly onCancel: () => void
  ) {
    if (placeholder) this.input.setValue(placeholder);
    this.input.onSubmit = () => this.onDone(this.input.getValue());
    this.input.onEscape = () => this.onCancel();
  }

  render(width: number): string[] {
    return [
      ...new Text(this.prompt, 0, 0).render(width),
      ...this.input.render(width),
      ...new Text("enter to submit, esc to cancel", 0, 0).render(width)
    ];
  }

  handleInput(data: string): void {
    this.input.handleInput(data);
  }

  invalidate(): void {
    this.input.invalidate();
  }
}

class SubmittedInputComponent implements Component {
  constructor(
    private readonly text: string,
    private readonly borderColor: (text: string) => string
  ) {}

  render(width: number): string[] {
    return renderInputBox(this.text, width, this.borderColor);
  }

  invalidate(): void {}
}

export class PiTuiConversationView implements InteractiveTuiView {
  private readonly footer: TuiFooterComponent;
  private readonly messageComponents: Component[] = [];
  private turnStatus: Loader | undefined;
  private turnStatusTimer: NodeJS.Timeout | undefined;
  private turnStartedAt = 0;
  private runFinished = true;

  constructor(
    private readonly tui: TUI,
    private readonly editor: Editor,
    private readonly theme: ArgonTuiTheme,
    private readonly options: TuiOptions
  ) {
    this.footer = new TuiFooterComponent(this.theme, this.options);
    this.tui.addChild(this.editor);
    this.tui.addChild(this.footer);
    this.setRunning(false);
  }

  showWelcome(): void {
    this.addStatusMessage(this.theme.ansi.dim("Argon TUI ready."));
  }

  addUserMessage(text: string): void {
    this.addComponent(new SubmittedInputComponent(text, this.theme.editor.borderColor));
  }

  addAssistantMessage(): MutableTuiMessage {
    return this.addMutableMarkdown("");
  }

  addThinkingMessage(): MutableTuiMessage {
    return this.addMutableMarkdown(`${this.theme.ansi.dim("thinking")}\n\n`, { dim: true });
  }

  addStatusMessage(text: string): void {
    this.addComponent(new StatusText(text, 1, 0));
  }

  addMutableStatusMessage(text: string): MutableStatusMessage {
    const component = new StatusText(text, 1, 0);
    this.addComponent(component);
    return {
      setText: (next: string) => {
        component.setText(next);
        this.requestRender();
      }
    };
  }

  renderMessages(messages: AgentMessage[]): void {
    this.clearMessages();
    const pendingToolStatuses = new Map<string, { toolCall: ToolCall; message: MutableStatusMessage }>();
    for (const message of messages) {
      if (message.role === "user") {
        this.addUserMessage(messageText(message));
      } else if (message.role === "assistant") {
        const text = normalizeFinalMarkdown(messageText(message));
        if (text) this.addMarkdown(text);
        for (const toolCall of messageToolCalls(message)) {
          pendingToolStatuses.set(
            toolCall.id,
            {
              toolCall,
              message: this.addMutableStatusMessage(renderToolStatus(toolCall, undefined, this.options.color && Boolean(process.stdout.isTTY)))
            }
          );
        }
      } else if (message.role === "toolResult") {
        const pending = pendingToolStatuses.get(message.toolCallId);
        if (pending) {
          pending.message.setText(renderToolStatus(pending.toolCall, message, this.options.color && Boolean(process.stdout.isTTY)));
          pendingToolStatuses.delete(message.toolCallId);
        } else {
          this.addStatusMessage(renderToolResult(message, this.options.color && Boolean(process.stdout.isTTY)));
        }
      }
    }
  }

  clearMessages(): void {
    for (const component of this.messageComponents) {
      this.tui.removeChild(component);
    }
    this.messageComponents.length = 0;
    this.removeTurnStatus();
    this.tui.requestRender(true);
  }

  setRunning(running: boolean): void {
    this.editor.disableSubmit = running;
    if (running) {
      this.turnStartedAt = Date.now();
      this.runFinished = false;
      this.ensureTurnStatus();
      this.turnStatus?.setIndicator();
      this.updateWorkingText();
      this.startTurnStatusTimer();
    } else if (!this.runFinished) {
      this.finishRun("stop");
    }
    this.requestRender();
  }

  finishRun(reason: TurnEndReason): void {
    this.editor.disableSubmit = false;
    this.runFinished = true;
    this.stopTurnStatusTimer();
    this.ensureTurnStatus();
    this.turnStatus?.stop();
    this.turnStatus?.setIndicator({ frames: [] });
    this.turnStatus?.setMessage(this.finishText(reason));
    this.requestRender();
  }

  requestRender(): void {
    this.tui.requestRender();
  }

  dispose(): void {
    this.removeTurnStatus();
  }

  private addMarkdown(text: string): Markdown {
    const markdown = new Markdown(text, 2, 0, this.theme.markdown);
    this.addComponent(markdown);
    return markdown;
  }

  private addMutableMarkdown(prefix: string, options: { dim?: boolean } = {}): MutableTuiMessage {
    let content = "";
    let finalized = false;
    const style = options.dim ? { color: this.theme.ansi.dim } : undefined;
    const markdown = new Markdown(prefix, 2, 0, this.theme.markdown, style);
    this.addComponent(markdown);
    const setText = () => {
      const text = prefix + content;
      markdown.setText(finalized ? normalizeFinalMarkdown(text) : text);
    };
    return {
      append: (delta: string) => {
        finalized = false;
        content += delta;
        setText();
      },
      finalize: () => {
        finalized = true;
        setText();
      }
    };
  }

  private addComponent(component: Component): void {
    const insertAt = this.messageInsertIndex();
    this.tui.children.splice(insertAt, 0, component);
    this.messageComponents.push(component);
    this.requestRender();
  }

  private ensureTurnStatus(): void {
    if (this.turnStatus) return;
    this.turnStatus = new Loader(this.tui, this.theme.ansi.cyan, this.theme.ansi.dim, "Working...");
    this.addBeforeEditor(this.turnStatus);
  }

  private removeTurnStatus(): void {
    this.stopTurnStatusTimer();
    if (!this.turnStatus) return;
    this.turnStatus.stop();
    this.tui.removeChild(this.turnStatus);
    this.turnStatus = undefined;
  }

  private addBeforeEditor(component: Component): void {
    const editorIndex = this.tui.children.indexOf(this.editor);
    const insertAt = editorIndex === -1 ? this.tui.children.length : editorIndex;
    this.tui.children.splice(insertAt, 0, component);
    this.requestRender();
  }

  private messageInsertIndex(): number {
    if (this.turnStatus) {
      const turnStatusIndex = this.tui.children.indexOf(this.turnStatus);
      if (turnStatusIndex !== -1) return turnStatusIndex;
    }
    const editorIndex = this.tui.children.indexOf(this.editor);
    return editorIndex === -1 ? this.tui.children.length : editorIndex;
  }

  private finishText(reason: TurnEndReason): string {
    const elapsed = formatElapsedSeconds(Math.max(0, Math.floor((Date.now() - this.turnStartedAt) / 1000)));
    if (reason === "stop") return `Worked for ${elapsed}`;
    if (reason === "aborted") return `Interrupted after ${elapsed}`;
    return `Failed after ${elapsed} (${reason})`;
  }

  private startTurnStatusTimer(): void {
    this.stopTurnStatusTimer();
    this.turnStatusTimer = setInterval(() => {
      if (!this.runFinished) this.updateWorkingText();
    }, 1000);
  }

  private stopTurnStatusTimer(): void {
    if (!this.turnStatusTimer) return;
    clearInterval(this.turnStatusTimer);
    this.turnStatusTimer = undefined;
  }

  private updateWorkingText(): void {
    const elapsed = formatElapsedSeconds(Math.max(0, Math.floor((Date.now() - this.turnStartedAt) / 1000)));
    this.turnStatus?.setMessage(`Working (${elapsed} - Ctrl+C to interrupt)`);
  }
}

class TuiFooterComponent implements Component {
  constructor(
    private readonly theme: ArgonTuiTheme,
    private readonly options: TuiOptions
  ) {}

  render(width: number): string[] {
    const dimText = this.theme.ansi.dim;
    const cyanText = this.theme.ansi.cyan;

    const leftPart = ` ${dimText("Type /help for commands.")}`;
    const thinkingLabel = currentThinkingLevel(this.options.reasoning);
    const rightPart = cyanText(
      `${this.options.provider} ${this.options.modelId} thinking=${thinkingLabel}`
    );

    const leftWidth = visibleWidth(leftPart);
    const rightWidth = visibleWidth(rightPart);
    const rightMargin = 3;
    const availableWidth = Math.max(0, width - rightMargin);
    const padding = " ".repeat(Math.max(0, availableWidth - leftWidth - rightWidth));
    const fullText = leftPart + padding + rightPart;
    return [fullText];
  }

  invalidate(): void {}
}

class StatusText implements Component {
  private cachedText: string | undefined;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(
    private text: string,
    private readonly paddingX: number,
    private readonly paddingY: number,
    private readonly continuationIndent = 4
  ) {}

  setText(text: string): void {
    this.text = text;
    this.invalidate();
  }

  invalidate(): void {
    this.cachedText = undefined;
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
      return this.cachedLines;
    }

    if (!this.text || this.text.trim() === "") {
      this.cachedText = this.text;
      this.cachedWidth = width;
      this.cachedLines = [];
      return [];
    }

    const contentWidth = Math.max(1, width - this.paddingX * 2);
    const contentLines = wrapStatusText(this.text.replace(/\t/g, "   "), contentWidth, this.continuationIndent);
    const left = " ".repeat(this.paddingX);
    const right = " ".repeat(this.paddingX);
    const rendered = contentLines.map((line) => {
      const withMargins = left + line + right;
      return withMargins + " ".repeat(Math.max(0, width - visibleWidth(withMargins)));
    });
    const empty = " ".repeat(width);
    const padding = Array.from({ length: this.paddingY }, () => empty);
    const result = [...padding, ...rendered, ...padding];

    this.cachedText = this.text;
    this.cachedWidth = width;
    this.cachedLines = result;
    return result;
  }
}

function wrapStatusText(text: string, width: number, continuationIndent: number): string[] {
  const indent = " ".repeat(Math.min(Math.max(0, continuationIndent), Math.max(0, width - 1)));
  const wrapWidth = Math.max(1, width - visibleWidth(indent));
  const lines: string[] = [];
  for (const rawLine of text.split("\n")) {
    for (const line of wrapTextWithAnsi(rawLine, wrapWidth)) {
      lines.push(lines.length === 0 ? line : indent + line);
    }
  }
  return lines.length > 0 ? lines : [""];
}

function sessionItems(sessions: SessionInfo[]): SelectionItem[] {
  return sessions.map((session) => ({
    value: session.path,
    label: session.id.slice(0, 8),
    description: `${session.messageCount} messages  ${compactText(session.firstMessage, 90)}`
  }));
}

function treeItems(rows: SessionTreeNode[]): SelectionItem[] {
  return rows.map((row) => ({
    value: row.entry.id,
    label: `${row.current ? "*" : " "} ${"  ".repeat(row.depth)}${row.entry.type}`,
    description: compactText(row.preview, 100)
  }));
}

function modelItems(models: Model<any>[], registry: ModelRegistry): SelectionItem[] {
  return models
    .map((model) => ({
      value: `${model.provider}/${model.id}`,
      label: model.id,
      description: `${registry.getProviderDisplayName(model.provider)}  ${model.contextWindow ?? "?"} ctx`
    }))
    .sort((a, b) => `${a.description} ${a.label}`.localeCompare(`${b.description} ${b.label}`));
}

function thinkingItems(levels: ArgonThinkingLevel[], current: ArgonThinkingLevel): SelectionItem[] {
  return levels.map((level) => ({
    value: level,
    label: level === current ? `${level} (current)` : level,
    description: THINKING_LEVEL_DESCRIPTIONS[level]
  }));
}

function openExternal(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  exec(`${command} "${url.replace(/"/g, '\\"')}"`, () => {});
}

function messageText(message: AgentMessage): string {
  const content = "content" in message ? message.content : undefined;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function messageToolCalls(message: AgentMessage): ToolCall[] {
  const content = "content" in message ? message.content : undefined;
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is ToolCall => typeof block === "object" && block !== null && "type" in block && block.type === "toolCall");
}

function normalizeFinalMarkdown(text: string): string {
  const trimmed = text.replace(/[ \t\r\n]+$/u, "");
  return trimmed ? `${trimmed}\n\n` : "";
}

function formatElapsedSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  const minuteRemainder = minutes % 60;
  return `${hours}h ${String(minuteRemainder).padStart(2, "0")}m ${String(remainder).padStart(2, "0")}s`;
}
