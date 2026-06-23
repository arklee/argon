import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type AgentRole = "system" | "user" | "assistant" | "tool";

export interface AgentMessage {
  role: AgentRole;
  content?: unknown;
}

export interface RpcModel {
  provider: string;
  id: string;
  name?: string;
  auth?: {
    configured: boolean;
    source?: string;
    label?: string;
  };
}

export interface RpcSessionState {
  id?: string;
  path?: string;
  cwd: string;
  leafId?: string | null;
  messageCount: number;
  model: RpcModel;
  running?: {
    runId: string;
    kind: "turn" | "compaction";
  };
}

export interface RpcInitializeResult {
  protocolVersion: number;
  state: RpcSessionState;
}

export interface RpcSessionInfo {
  path: string;
  id: string;
  cwd: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
}

export interface RpcThreadListResult {
  sessions: RpcSessionInfo[];
}

export interface RpcThreadMessagesResult {
  messages: AgentMessage[];
}

export interface RpcTurnStartResult {
  accepted: true;
  runId: string;
}

export interface RpcThreadDeleteResult {
  deleted: true;
  path: string;
  state: RpcSessionState;
}

export interface RpcModelListResult {
  models: RpcModel[];
}

export interface RpcModelSetResult {
  model: RpcModel;
}

export interface RpcNotification {
  method: "turn/event" | "turn/completed" | "rpc/error";
  params: Record<string, unknown>;
}

export interface RpcLogEvent {
  stream: string;
  line: string;
}

export interface RpcStartResult {
  cwd: string;
  command: string;
  alreadyRunning: boolean;
}

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function startRpc(cwd?: string): Promise<RpcStartResult> {
  return invoke<RpcStartResult>("rpc_start", { params: cwd ? { cwd } : null });
}

export async function rpcRequest<T>(method: string, params?: unknown): Promise<T> {
  return invoke<T>("rpc_request", {
    params: {
      method,
      ...(params !== undefined ? { params } : {})
    }
  });
}

export function stopRpc(): Promise<void> {
  return invoke("rpc_stop");
}

export function initializeRpc(): Promise<RpcInitializeResult> {
  return rpcRequest<RpcInitializeResult>("initialize");
}

export function listThreads(): Promise<RpcThreadListResult> {
  return rpcRequest<RpcThreadListResult>("thread/list");
}

export function getMessages(): Promise<RpcThreadMessagesResult> {
  return rpcRequest<RpcThreadMessagesResult>("thread/messages");
}

export function newThread(): Promise<RpcSessionState> {
  return rpcRequest<RpcSessionState>("thread/new");
}

export function deleteThread(session: string): Promise<RpcThreadDeleteResult> {
  return rpcRequest<RpcThreadDeleteResult>("thread/delete", { session });
}

export function resumeThread(session: string): Promise<RpcSessionState> {
  return rpcRequest<RpcSessionState>("thread/resume", { session });
}

export function startTurn(input: string): Promise<RpcTurnStartResult> {
  return rpcRequest<RpcTurnStartResult>("turn/start", { input });
}

export function interruptTurn(runId?: string): Promise<{ interrupted: boolean; runId?: string }> {
  return rpcRequest("turn/interrupt", runId ? { runId } : {});
}

export function listModels(): Promise<RpcModelListResult> {
  return rpcRequest<RpcModelListResult>("model/list");
}

export function setModel(provider: string, modelId: string): Promise<RpcModelSetResult> {
  return rpcRequest<RpcModelSetResult>("model/set", { provider, modelId });
}

export async function onRpcNotification(listener: (notification: RpcNotification) => void): Promise<UnlistenFn> {
  return listen<RpcNotification>("argon-rpc-notification", (event) => listener(event.payload));
}

export async function onRpcLog(listener: (log: RpcLogEvent) => void): Promise<UnlistenFn> {
  return listen<RpcLogEvent>("argon-rpc-log", (event) => listener(event.payload));
}

export async function onRpcError(listener: (error: { message: string }) => void): Promise<UnlistenFn> {
  return listen<{ message: string }>("argon-rpc-error", (event) => listener(event.payload));
}
