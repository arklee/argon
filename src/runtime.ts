import type { AgentRuntimeConfig, AgentEvent, AgentMessage, RunOptions, UserInput } from "./types.js";
import { runTurn } from "./loop/run-turn.js";
import { JsonlSessionEventLog, type SessionEventLog } from "./session/event-log.js";
import type { SessionManager } from "./session/manager.js";
import { Transcript } from "./session/transcript.js";
import { createDefaultTools } from "./tools/index.js";

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
      for await (const event of runTurn({
        input,
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
        this.persistSessionEvent(event, runOptions);
        await this.eventLog?.append(event);
        yield event;
      }
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

  private persistSessionEvent(event: AgentEvent, options: RunOptions): void {
    if (!this.session) return;
    if (event.type === "turn_start") {
      this.pendingSessionTurn = { context: event.context, reasoning: options.reasoning };
    } else if (event.type === "message_end") {
      if (event.message.role === "user") {
        this.flushPendingSessionTurn();
        this.session.appendMessage(event.message);
      } else if (event.message.role === "assistant") {
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
