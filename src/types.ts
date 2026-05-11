import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Message,
  Model,
  SimpleStreamOptions,
  Tool,
  ToolCall,
  ToolResultMessage,
  UserMessage
} from "@earendil-works/pi-ai";
import type { SessionManager } from "./session/manager.js";
import type { ArgonThinkingLevel } from "./thinking.js";

export type AgentMessage = Message;

export type UserInput =
  | string
  | {
      content: UserMessage["content"];
    };

export type ContinueReason = "tool_results" | "follow_up" | "strategy";

export interface TurnContext {
  readonly turnId: string;
  readonly cwd: string;
  readonly model: Model<any>;
  readonly systemPrompt: string;
  readonly startedAt: number;
  readonly availableTools: readonly string[];
  readonly messageCount: number;
}

export type TurnEndReason = "stop" | "max_iterations" | "error" | "aborted";

export type CompactionReason = "manual" | "threshold" | "overflow";

export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

export interface CompactionResult {
  summary: string;
  firstKeptEntryId?: string | undefined;
  tokensBefore: number;
  messagesBefore: number;
  messagesAfter: number;
}

export type AgentEvent =
  | { type: "turn_start"; context: TurnContext }
  | { type: "compaction_start"; reason: CompactionReason; tokensBefore: number; messagesBefore: number }
  | {
      type: "compaction_end";
      reason: CompactionReason;
      result?: CompactionResult | undefined;
      errorMessage?: string | undefined;
      aborted: boolean;
      willRetry: boolean;
    }
  | { type: "message_start"; message: AgentMessage }
  | {
      type: "message_delta";
      role: "assistant";
      kind: "text" | "thinking" | "tool_call";
      contentIndex: number;
      delta: string;
      partial: AssistantMessage;
    }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_call_start"; contentIndex: number; partial: AssistantMessage }
  | {
      type: "tool_call_delta";
      contentIndex: number;
      delta: string;
      partial: AssistantMessage;
    }
  | { type: "tool_call_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | { type: "tool_result"; toolCall: ToolCall; result: ToolResultMessage }
  | {
      type: "turn_end";
      context: TurnContext;
      reason: TurnEndReason;
      iterations: number;
      continueReason?: ContinueReason;
    }
  | { type: "error"; error: Error; recoverable: boolean };

export interface ToolExecutionContext {
  cwd: string;
  signal?: AbortSignal | undefined;
  turn: TurnContext;
  messages: readonly AgentMessage[];
}

export type ToolExecutionResult = ToolResultMessage & {
  terminate?: boolean | undefined;
};

export interface ToolRuntime {
  definition: Tool<any>;
  execute(call: ToolCall, ctx: ToolExecutionContext): Promise<ToolExecutionResult>;
  guideline?: string;
}

export type ApiKeyResolver = string | ((provider: string) => string | Promise<string | undefined> | undefined);

export type RequestAuthResolver = (
  model: Model<any>
) =>
  | { apiKey?: string | undefined; headers?: Record<string, string> | undefined }
  | Promise<{ apiKey?: string | undefined; headers?: Record<string, string> | undefined }>;

export type StreamProvider = (
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

export interface PromptConfig {
  baseInstructions?: string | undefined;
  behaviorRules?: string[] | undefined;
  projectInstructions?: string | undefined;
  includeProjectInstructions?: boolean | undefined;
  maxProjectInstructionsBytes?: number | undefined;
  now?: Date | undefined;
}

export interface PromptBuildInput {
  cwd: string;
  tools: readonly ToolRuntime[];
  config?: PromptConfig | undefined;
}

export interface LoopState {
  turn: TurnContext;
  messages: readonly AgentMessage[];
  lastAssistant?: AssistantMessage;
  toolResults: readonly ToolResultMessage[];
  iterations: number;
}

export interface LoopStrategy {
  shouldContinue?(state: LoopState): boolean | Promise<boolean>;
}

export interface RunOptions {
  maxIterations?: number | undefined;
  signal?: AbortSignal | undefined;
  reasoning?: ArgonThinkingLevel | undefined;
  sessionId?: string | undefined;
  strategy?: LoopStrategy | undefined;
  followUps?: UserInput[] | undefined;
  compaction?: Partial<CompactionSettings> | undefined;
}

export interface AgentRuntimeConfig {
  model: Model<any>;
  cwd: string;
  apiKey?: ApiKeyResolver | undefined;
  requestAuth?: RequestAuthResolver | undefined;
  tools?: ToolRuntime[] | undefined;
  prompt?: PromptConfig | undefined;
  sessionId?: string | undefined;
  stream?: StreamProvider | undefined;
  eventLogPath?: string | undefined;
  session?: SessionManager | undefined;
  compaction?: Partial<CompactionSettings> | undefined;
}

export interface RunTurnParams {
  input?: UserInput | undefined;
  messages: AgentMessage[];
  model: Model<any>;
  cwd: string;
  promptConfig?: PromptConfig | undefined;
  tools: ToolRuntime[];
  apiKey?: ApiKeyResolver | undefined;
  requestAuth?: RequestAuthResolver | undefined;
  sessionId?: string | undefined;
  stream?: StreamProvider | undefined;
  options?: RunOptions | undefined;
}
