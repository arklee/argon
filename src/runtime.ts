import type { AgentRuntimeConfig, AgentEvent, AgentMessage, RunOptions, UserInput } from "./types.js";
import { runTurn } from "./loop/run-turn.js";
import { JsonlSessionEventLog, type SessionEventLog } from "./session/event-log.js";
import { Transcript } from "./session/transcript.js";
import { createDefaultTools } from "./tools/index.js";

export class AgentRuntime {
  private readonly transcript = new Transcript();
  private readonly eventLog: SessionEventLog | undefined;
  private readonly tools;
  private activeAbortController: AbortController | undefined;

  constructor(private readonly config: AgentRuntimeConfig) {
    this.tools = config.tools ?? createDefaultTools(config.cwd);
    this.eventLog = config.eventLogPath ? new JsonlSessionEventLog(config.eventLogPath) : undefined;
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
        sessionId: this.config.sessionId,
        stream: this.config.stream,
        options: runOptions
      })) {
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

  abort(): void {
    this.activeAbortController?.abort();
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
