import { isContextOverflow, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  generateCompaction,
  prepareCompactionFromBranch,
  prepareCompactionFromMessages,
  resolveCompactionSettings,
  shouldCompact,
  createCompactionSummaryMessage
} from "./compaction/index.js";
import type { AgentRuntimeConfig, AgentEvent, AgentMessage, CompactionReason, CompactionSettings, RunOptions, TurnEndReason, UserInput } from "./types.js";
import { runTurn } from "./loop/run-turn.js";
import { JsonlSessionEventLog, type SessionEventLog } from "./session/event-log.js";
import type { SessionManager } from "./session/manager.js";
import { Transcript } from "./session/transcript.js";
import { createDefaultTools } from "./tools/index.js";
import { completeWithProvider } from "./provider/index.js";

export class AgentRuntime {
  private readonly transcript = new Transcript();
  private readonly eventLog: SessionEventLog | undefined;
  private readonly tools;
  private session: SessionManager | undefined;
  private activeAbortController: AbortController | undefined;
  private pendingSessionTurn:
    | {
        context: Extract<AgentEvent, { type: "turn_start" }>["context"];
        reasoning: RunOptions["reasoning"] | undefined;
      }
    | undefined;

  constructor(private readonly config: AgentRuntimeConfig) {
    this.tools = config.tools ?? createDefaultTools(config.cwd);
    this.eventLog = config.eventLogPath ? new JsonlSessionEventLog(config.eventLogPath) : undefined;
    this.session = config.session;
    this.hydrateFromSession();
  }

  async *run(input: UserInput, options: RunOptions = {}): AsyncIterable<AgentEvent> {
    if (this.activeAbortController) {
      throw new Error("AgentRuntime is already running");
    }

    const controller = new AbortController();
    this.activeAbortController = controller;
    const signal = combineSignals(controller.signal, options.signal);

    try {
      const runOptions: RunOptions = { ...options, signal };
      let nextInput: UserInput | undefined = input;
      let overflowRetryAttempted = false;

      while (true) {
        const result = yield* this.runTurnAndStream(nextInput, runOptions);
        nextInput = undefined;

        if (
          result.lastAssistant &&
          isContextOverflow(result.lastAssistant, this.config.model.contextWindow) &&
          !overflowRetryAttempted &&
          this.compactionSettings(runOptions).enabled
        ) {
          overflowRetryAttempted = true;
          this.removeTrailingAssistant(result.lastAssistant);
          const compacted = yield* this.performCompaction("overflow", undefined, runOptions, true);
          if (compacted) continue;
        }

        if (result.reason === "stop" && shouldCompact(this.transcript.messages, this.config.model.contextWindow, this.compactionSettings(runOptions))) {
          yield* this.performCompaction("threshold", undefined, runOptions, false);
        }
        break;
      }
    } finally {
      this.activeAbortController = undefined;
    }
  }

  async *compact(customInstructions?: string, options: RunOptions = {}): AsyncIterable<AgentEvent> {
    if (this.activeAbortController) {
      throw new Error("AgentRuntime is already running");
    }

    const controller = new AbortController();
    this.activeAbortController = controller;
    const signal = combineSignals(controller.signal, options.signal);

    try {
      yield* this.performCompaction("manual", customInstructions, { ...options, signal }, false);
    } finally {
      this.activeAbortController = undefined;
    }
  }

  messages(): AgentMessage[] {
    return this.transcript.snapshot();
  }

  getSession(): SessionManager | undefined {
    return this.session;
  }

  getModel(): AgentRuntimeConfig["model"] {
    return this.config.model;
  }

  switchModel(model: AgentRuntimeConfig["model"]): void {
    if (this.activeAbortController) {
      throw new Error("Cannot switch model while Argon is running");
    }
    this.config.model = model;
  }

  switchSession(session: SessionManager): void {
    if (this.activeAbortController) {
      throw new Error("Cannot switch sessions while Argon is running");
    }
    this.session = session;
    this.hydrateFromSession();
  }

  abort(): void {
    this.activeAbortController?.abort();
  }

  private hydrateFromSession(): void {
    if (!this.session) return;
    this.transcript.replace(this.session.buildContext().messages);
  }

  private async *runTurnAndStream(
    input: UserInput | undefined,
    runOptions: RunOptions
  ): AsyncGenerator<AgentEvent, { reason: TurnEndReason | undefined; lastAssistant: AssistantMessage | undefined }> {
    let reason: TurnEndReason | undefined;
    let lastAssistant: AssistantMessage | undefined;
    for await (const event of runTurn({
      ...(input !== undefined ? { input } : {}),
      messages: this.transcript.messages,
      model: this.config.model,
      cwd: this.config.cwd,
      promptConfig: this.config.prompt,
      tools: this.tools,
      apiKey: this.config.apiKey,
      requestAuth: this.config.requestAuth,
      sessionId: this.config.sessionId,
      stream: this.config.stream,
      options: runOptions
    })) {
      if (event.type === "message_end" && event.message.role === "assistant") lastAssistant = event.message;
      if (event.type === "turn_end") reason = event.reason;
      this.persistSessionEvent(event, runOptions);
      await this.eventLog?.append(event);
      yield event;
    }
    return { reason, lastAssistant };
  }

  private async *performCompaction(
    reason: CompactionReason,
    customInstructions: string | undefined,
    options: RunOptions,
    willRetry: boolean
  ): AsyncGenerator<AgentEvent, boolean> {
    const settings = this.compactionSettings(options);
    if (!settings.enabled) return false;

    const preparation = this.session
      ? prepareCompactionFromBranch(this.session.buildBranch(), settings)
      : prepareCompactionFromMessages(this.transcript.messages, settings);

    if (!preparation) {
      const event: AgentEvent = {
        type: "compaction_end",
        reason,
        aborted: false,
        willRetry: false,
        errorMessage: "Nothing to compact"
      };
      await this.eventLog?.append(event);
      yield event;
      return false;
    }

    const startEvent: AgentEvent = {
      type: "compaction_start",
      reason,
      tokensBefore: preparation.tokensBefore,
      messagesBefore: preparation.messagesBefore
    };
    await this.eventLog?.append(startEvent);
    yield startEvent;

    try {
      const result = await generateCompaction({
        preparation,
        model: this.config.model,
        reason,
        customInstructions,
        complete: async (context, maxTokens) =>
          completeWithProvider({
            model: this.config.model,
            context,
            maxTokens,
            ...(this.config.apiKey !== undefined ? { apiKey: this.config.apiKey } : {}),
            ...(this.config.requestAuth !== undefined ? { requestAuth: this.config.requestAuth } : {}),
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
            ...(options.reasoning !== undefined ? { reasoning: options.reasoning } : {}),
            ...(this.config.sessionId !== undefined ? { sessionId: this.config.sessionId } : {})
          })
      });

      if (this.session && result.firstKeptEntryId) {
        this.session.appendCompaction(result.summary, result.firstKeptEntryId, result.tokensBefore, reason);
        this.hydrateFromSession();
      } else {
        this.transcript.replace([createCompactionSummaryMessage(result.summary), ...preparation.keptMessages]);
      }

      const endEvent: AgentEvent = { type: "compaction_end", reason, result, aborted: false, willRetry };
      await this.eventLog?.append(endEvent);
      yield endEvent;
      return true;
    } catch (error) {
      const endEvent: AgentEvent = {
        type: "compaction_end",
        reason,
        aborted: options.signal?.aborted ?? false,
        willRetry: false,
        errorMessage: error instanceof Error ? error.message : String(error)
      };
      await this.eventLog?.append(endEvent);
      yield endEvent;
      return false;
    }
  }

  private compactionSettings(options: RunOptions): CompactionSettings {
    return resolveCompactionSettings(this.config.compaction, options.compaction);
  }

  private removeTrailingAssistant(message: AssistantMessage): void {
    const messages = this.transcript.messages;
    if (messages.at(-1) === message) {
      this.transcript.replace(messages.slice(0, -1));
    }
  }

  private persistSessionEvent(event: AgentEvent, options: RunOptions): void {
    if (!this.session) return;
    if (event.type === "turn_start") {
      this.pendingSessionTurn = { context: event.context, reasoning: options.reasoning };
    } else if (event.type === "message_end") {
      if (event.message.role === "user") {
        this.flushPendingSessionTurn();
        this.session.appendMessage(event.message);
      } else if (event.message.role === "assistant") {
        if (this.compactionSettings(options).enabled && isContextOverflow(event.message, this.config.model.contextWindow)) {
          return;
        }
        this.session.appendMessage(event.message);
      }
    } else if (event.type === "tool_result") {
      this.session.appendMessage(event.result);
    }
  }

  private flushPendingSessionTurn(): void {
    if (!this.session || !this.pendingSessionTurn) return;
    const { context, reasoning } = this.pendingSessionTurn;
    this.session.appendModelChange(context.model.provider, context.model.id);
    this.session.appendTurnContext(context, reasoning);
    this.pendingSessionTurn = undefined;
  }
}

function combineSignals(primary: AbortSignal, secondary?: AbortSignal): AbortSignal {
  if (!secondary) return primary;
  if (primary.aborted || secondary.aborted) {
    return AbortSignal.abort();
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  primary.addEventListener("abort", abort, { once: true });
  secondary.addEventListener("abort", abort, { once: true });
  return controller.signal;
}
