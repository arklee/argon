import type { Model } from "@earendil-works/pi-ai";
import type { AuthStatus } from "../auth/storage.js";
import type { SessionInfo, SessionTreeNode } from "../session/manager.js";
import type { AgentEvent, AgentMessage, CompactionSettings, RunOptions, UserInput } from "../types.js";

export const ARGON_RPC_PROTOCOL_VERSION = 1;

export const ARGON_RPC_METHODS = [
  "initialize",
  "turn/start",
  "turn/interrupt",
  "thread/current",
  "thread/messages",
  "thread/list",
  "thread/new",
  "thread/delete",
  "thread/resume",
  "thread/tree",
  "thread/branch",
  "thread/compact",
  "model/list",
  "model/set",
  "shutdown"
] as const;

export type ArgonRpcMethod = (typeof ARGON_RPC_METHODS)[number];

export type ArgonRpcId = string | number;

export interface ArgonRpcRequest {
  id: ArgonRpcId;
  method: ArgonRpcMethod;
  params?: unknown;
}

export interface ArgonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type ArgonRpcResponse =
  | {
      id: ArgonRpcId | null;
      result: unknown;
    }
  | {
      id: ArgonRpcId | null;
      error: ArgonRpcError;
    };

export const ARGON_RPC_ERROR = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  busy: -32001
} as const;

export interface ArgonRpcErrorInfo {
  name?: string;
  message: string;
}

export type ArgonRpcAgentEvent =
  | Exclude<AgentEvent, { type: "error" }>
  | {
      type: "error";
      error: ArgonRpcErrorInfo;
      recoverable: boolean;
    };

export type ArgonRpcNotification =
  | {
      method: "turn/event";
      params: {
        runId: string;
        kind: ArgonRpcRunKind;
        event: ArgonRpcAgentEvent;
      };
    }
  | {
      method: "turn/completed";
      params: {
        runId: string;
        kind: ArgonRpcRunKind;
        reason: "stop" | "max_iterations" | "error" | "aborted";
      };
    }
  | {
      method: "rpc/error";
      params: {
        runId?: string;
        error: ArgonRpcErrorInfo;
      };
    };

export type ArgonRpcRunKind = "turn" | "compaction";

export interface ArgonRpcTurnOptions {
  maxIterations?: number;
  reasoning?: RunOptions["reasoning"];
  compaction?: Partial<CompactionSettings>;
}

export interface ArgonRpcTurnStartParams {
  input: UserInput;
  options?: ArgonRpcTurnOptions;
}

export interface ArgonRpcTurnStartResult {
  accepted: true;
  runId: string;
}

export interface ArgonRpcTurnInterruptParams {
  runId?: string;
}

export interface ArgonRpcTurnInterruptResult {
  interrupted: boolean;
  runId?: string;
}

export interface ArgonRpcThreadCompactParams {
  instructions?: string;
  options?: ArgonRpcTurnOptions;
}

export interface ArgonRpcThreadBranchParams {
  entryId: string | null;
  note?: string;
}

export interface ArgonRpcThreadResumeParams {
  session: string;
}

export interface ArgonRpcThreadDeleteParams {
  session: string;
}

export interface ArgonRpcThreadDeleteResult {
  deleted: true;
  path: string;
  state: ArgonRpcSessionState;
}

export interface ArgonRpcThreadListResult {
  sessions: SessionInfo[];
}

export interface ArgonRpcThreadTreeResult {
  nodes: SessionTreeNode[];
}

export interface ArgonRpcThreadMessagesResult {
  messages: AgentMessage[];
}

export interface ArgonRpcModel {
  provider: string;
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  input?: readonly string[];
  contextWindow?: number;
  maxTokens?: number;
  auth: AuthStatus;
}

export interface ArgonRpcModelListResult {
  models: ArgonRpcModel[];
}

export interface ArgonRpcModelSetParams {
  provider: string;
  modelId: string;
  baseUrl?: string;
}

export interface ArgonRpcModelSetResult {
  model: ArgonRpcModel;
}

export interface ArgonRpcSessionState {
  id?: string;
  path?: string;
  cwd: string;
  leafId?: string | null;
  messageCount: number;
  model: ArgonRpcModel;
  running?: {
    runId: string;
    kind: ArgonRpcRunKind;
  };
}

export interface ArgonRpcInitializeResult {
  protocolVersion: typeof ARGON_RPC_PROTOCOL_VERSION;
  server: {
    name: "argon";
  };
  capabilities: {
    methods: readonly ArgonRpcMethod[];
    notifications: readonly ArgonRpcNotification["method"][];
    transport: "jsonl-stdio";
  };
  state: ArgonRpcSessionState;
}

export interface ArgonRpcShutdownResult {
  ok: true;
}

export function toRpcAgentEvent(event: AgentEvent): ArgonRpcAgentEvent {
  if (event.type !== "error") return event;
  return {
    type: "error",
    error: toRpcErrorInfo(event.error),
    recoverable: event.recoverable
  };
}

export function toRpcErrorInfo(error: unknown): ArgonRpcErrorInfo {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message
    };
  }
  return { message: String(error) };
}

export function toRpcModel(model: Model<any>, auth: AuthStatus): ArgonRpcModel {
  return {
    provider: model.provider,
    id: model.id,
    ...(model.name ? { name: model.name } : {}),
    ...(model.api ? { api: model.api } : {}),
    ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
    ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
    ...(model.input ? { input: [...model.input] } : {}),
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
    auth
  };
}
