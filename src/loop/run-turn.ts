import type { AssistantMessage, AssistantMessageEvent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { PromptManager } from "../prompt/manager.js";
import { streamWithProvider } from "../provider/index.js";
import type {
  AgentEvent,
  AgentMessage,
  ContinueReason,
  IterationStartReason,
  LoopState,
  RunTurnParams,
  ToolExecutionResult,
  ToolRuntime,
  TurnContext,
  TurnEndReason,
  UserInput
} from "../types.js";

export interface RunTurnResult {
  reason: TurnEndReason;
  iterations: number;
}

export async function* runTurn(params: RunTurnParams): AsyncGenerator<AgentEvent, RunTurnResult> {
  const promptManager = new PromptManager();
  const systemPrompt = promptManager.buildSystemPrompt({
    cwd: params.cwd,
    tools: params.tools,
    config: params.promptConfig
  });
  const turn: TurnContext = Object.freeze({
    turnId: createTurnId(),
    cwd: params.cwd,
    model: params.model,
    systemPrompt,
    startedAt: Date.now(),
    availableTools: params.tools.map((tool) => tool.definition.name),
    messageCount: params.messages.length
  });

  let iterations = 0;
  let nextIterationReason: IterationStartReason = "initial";
  const maxIterations = params.options?.maxIterations;
  const followUps = [...(params.options?.followUps ?? [])];

  yield { type: "turn_start", context: turn };
  if (params.input !== undefined) {
    appendUserInput(params.messages, params.input);
    const firstUserMessage = params.messages[params.messages.length - 1]!;
    yield { type: "message_start", message: firstUserMessage };
    yield { type: "message_end", message: firstUserMessage };
  }

  while (true) {
    if (maxIterations !== undefined && iterations >= maxIterations) {
      yield { type: "turn_end", context: turn, reason: "max_iterations", iterations };
      return { reason: "max_iterations", iterations };
    }

    iterations++;
    yield { type: "iteration_start", context: turn, iteration: iterations, reason: nextIterationReason };
    nextIterationReason = "tool_results";

    const assistant = yield* streamAssistantMessage(params, turn);
    params.messages.push(assistant);

    if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
      const reason = assistant.stopReason;
      if (reason === "error" && assistant.errorMessage) {
        yield { type: "error", error: new Error(assistant.errorMessage), recoverable: false };
      }
      yield { type: "turn_end", context: turn, reason, iterations };
      return { reason, iterations };
    }

    const toolCalls = assistant.content.filter((block): block is ToolCall => block.type === "toolCall");
    if (toolCalls.length > 0) {
      const { toolResults, terminateResults } = yield* executeToolCalls(toolCalls, params, turn);

      if (terminateResults.every(Boolean)) {
        yield { type: "turn_end", context: turn, reason: "stop", iterations };
        return { reason: "stop", iterations };
      }

      const shouldContinue = await shouldContinueAfterTools(params, {
        turn,
        messages: params.messages,
        lastAssistant: assistant,
        toolResults,
        iterations
      });

      if (shouldContinue) continue;

      yieldTurnEnd({ context: turn, reason: "stop", iterations, continueReason: "strategy" });
      yield { type: "turn_end", context: turn, reason: "stop", iterations, continueReason: "strategy" };
      return { reason: "stop", iterations };
    }

    if (followUps.length > 0) {
      appendUserInput(params.messages, followUps.shift()!);
      const message = params.messages[params.messages.length - 1]!;
      yield { type: "message_start", message };
      yield { type: "message_end", message };
      nextIterationReason = "follow_up";
      continue;
    }

    yield { type: "turn_end", context: turn, reason: "stop", iterations };
    return { reason: "stop", iterations };
  }
}

async function* executeToolCalls(
  toolCalls: ToolCall[],
  params: RunTurnParams,
  turn: TurnContext
): AsyncGenerator<AgentEvent, { toolResults: ToolResultMessage[]; terminateResults: boolean[] }> {
  const toolResults: ToolResultMessage[] = [];
  const terminateResults: boolean[] = [];

  for (let index = 0; index < toolCalls.length;) {
    const toolCall = toolCalls[index]!;

    if (!canRunToolCallInParallel(toolCall, params.tools)) {
      const outcome = await executeToolCall(toolCall, params, turn);
      const normalized = normalizeToolExecutionResult(outcome);
      appendToolResult(toolCall, normalized, params, toolResults, terminateResults);
      yield { type: "tool_result", toolCall, result: normalized.result };
      index++;
      continue;
    }

    const batch: ToolCall[] = [];
    while (index < toolCalls.length && canRunToolCallInParallel(toolCalls[index]!, params.tools)) {
      batch.push(toolCalls[index]!);
      index++;
    }

    const outcomes = await Promise.all(
      batch.map(async (batchCall) => ({
        toolCall: batchCall,
        normalized: normalizeToolExecutionResult(await executeToolCall(batchCall, params, turn))
      }))
    );

    for (const { toolCall: batchCall, normalized } of outcomes) {
      appendToolResult(batchCall, normalized, params, toolResults, terminateResults);
      yield { type: "tool_result", toolCall: batchCall, result: normalized.result };
    }
  }

  return { toolResults, terminateResults };
}

function appendToolResult(
  toolCall: ToolCall,
  normalized: { result: ToolResultMessage; terminate: boolean },
  params: RunTurnParams,
  toolResults: ToolResultMessage[],
  terminateResults: boolean[]
): void {
  params.messages.push(normalized.result);
  toolResults.push(normalized.result);
  terminateResults.push(normalized.terminate);
}

function canRunToolCallInParallel(toolCall: ToolCall, tools: readonly ToolRuntime[]): boolean {
  const tool = tools.find((candidate) => candidate.definition.name === toolCall.name);
  const setting = tool?.canRunInParallel;
  if (typeof setting === "function") {
    try {
      return setting(toolCall);
    } catch {
      return false;
    }
  }
  return setting === true;
}

async function* streamAssistantMessage(
  params: RunTurnParams,
  turn: TurnContext
): AsyncGenerator<AgentEvent, AssistantMessage> {
  let sawStart = false;

  try {
    const stream = await streamWithProvider({
      model: params.model,
      context: {
        systemPrompt: turn.systemPrompt,
        messages: params.messages,
        tools: params.tools.map((tool) => tool.definition)
      },
      apiKey: params.apiKey,
      requestAuth: params.requestAuth,
      stream: params.stream,
      signal: params.options?.signal,
      ...(params.options?.reasoning !== undefined ? { reasoning: params.options.reasoning } : {}),
      sessionId: params.options?.sessionId ?? params.sessionId
    });

    let finalMessage: AssistantMessage | undefined;
    for await (const event of stream) {
      if (event.type === "start") {
        sawStart = true;
        yield { type: "message_start", message: event.partial };
        continue;
      }

      const mapped = mapAssistantStreamEvent(event);
      if (mapped) yield mapped;

      if (event.type === "done") {
        finalMessage = event.message;
        yield { type: "message_end", message: finalMessage };
      } else if (event.type === "error") {
        finalMessage = event.error;
        if (!sawStart) {
          yield { type: "message_start", message: finalMessage };
        }
        yield { type: "message_end", message: finalMessage };
      }
    }

    return finalMessage ?? (await stream.result());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const assistant: AssistantMessage = {
      role: "assistant",
      content: [],
      api: params.model.api,
      provider: params.model.provider,
      model: params.model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: params.options?.signal?.aborted ? "aborted" : "error",
      errorMessage: message,
      timestamp: Date.now()
    };
    yield { type: "message_start", message: assistant };
    yield { type: "message_end", message: assistant };
    return assistant;
  }
}

function mapAssistantStreamEvent(event: AssistantMessageEvent): AgentEvent | undefined {
  switch (event.type) {
    case "text_delta":
      return {
        type: "message_delta",
        role: "assistant",
        kind: "text",
        contentIndex: event.contentIndex,
        delta: event.delta,
        partial: event.partial
      };
    case "thinking_delta":
      return {
        type: "message_delta",
        role: "assistant",
        kind: "thinking",
        contentIndex: event.contentIndex,
        delta: event.delta,
        partial: event.partial
      };
    case "toolcall_start":
      return { type: "tool_call_start", contentIndex: event.contentIndex, partial: event.partial };
    case "toolcall_delta":
      return {
        type: "tool_call_delta",
        contentIndex: event.contentIndex,
        delta: event.delta,
        partial: event.partial
      };
    case "toolcall_end":
      return {
        type: "tool_call_end",
        contentIndex: event.contentIndex,
        toolCall: event.toolCall,
        partial: event.partial
      };
    default:
      return undefined;
  }
}

async function executeToolCall(
  toolCall: ToolCall,
  params: RunTurnParams,
  turn: TurnContext
): Promise<ToolExecutionResult> {
  const tool = params.tools.find((candidate) => candidate.definition.name === toolCall.name);
  if (!tool) {
    return createTextToolResult(toolCall, `Tool not found: ${toolCall.name}`, true);
  }

  try {
    return await tool.execute(toolCall, {
      cwd: params.cwd,
      signal: params.options?.signal,
      turn,
      messages: params.messages
    });
  } catch (error) {
    return createTextToolResult(toolCall, error instanceof Error ? error.message : String(error), true);
  }
}

function normalizeToolExecutionResult(outcome: ToolExecutionResult): { result: ToolResultMessage; terminate: boolean } {
  const { terminate, ...result } = outcome;
  return { result, terminate: terminate === true };
}

async function shouldContinueAfterTools(params: RunTurnParams, state: LoopState): Promise<boolean> {
  if (!params.options?.strategy?.shouldContinue) return true;
  return params.options.strategy.shouldContinue(state);
}

function appendUserInput(messages: AgentMessage[], input: UserInput): void {
  messages.push({
    role: "user",
    content: typeof input === "string" ? input : input.content,
    timestamp: Date.now()
  });
}

function createTextToolResult(toolCall: ToolCall, text: string, isError: boolean): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text }],
    isError,
    timestamp: Date.now()
  };
}

function createTurnId(): string {
  return `turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function yieldTurnEnd(_event: {
  context: TurnContext;
  reason: TurnEndReason;
  iterations: number;
  continueReason?: ContinueReason;
}): void {
  // Keeps ContinueReason imported as part of the public loop surface.
}
