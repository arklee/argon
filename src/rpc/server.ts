import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "../model/registry.js";
import { AgentRuntime } from "../runtime.js";
import { SessionManager } from "../session/manager.js";
import type { AgentEvent, RunOptions, UserInput } from "../types.js";
import {
  ARGON_RPC_ERROR,
  ARGON_RPC_METHODS,
  ARGON_RPC_PROTOCOL_VERSION,
  type ArgonRpcError,
  type ArgonRpcId,
  type ArgonRpcInitializeResult,
  type ArgonRpcMethod,
  type ArgonRpcModel,
  type ArgonRpcModelSetParams,
  type ArgonRpcNotification,
  type ArgonRpcRequest,
  type ArgonRpcResponse,
  type ArgonRpcRunKind,
  type ArgonRpcSessionState,
  type ArgonRpcShutdownResult,
  type ArgonRpcThreadBranchParams,
  type ArgonRpcThreadCompactParams,
  type ArgonRpcThreadResumeParams,
  type ArgonRpcTurnInterruptParams,
  type ArgonRpcTurnOptions,
  type ArgonRpcTurnStartParams,
  toRpcAgentEvent,
  toRpcErrorInfo,
  toRpcModel
} from "./protocol.js";

export interface ArgonRpcServerOptions {
  runtime: AgentRuntime;
  cwd: string;
  modelRegistry?: ModelRegistry | undefined;
  sessionDir?: string | undefined;
  defaultRunOptions?: ArgonRpcTurnOptions | undefined;
}

interface ActiveRun {
  runId: string;
  kind: ArgonRpcRunKind;
}

export class ArgonRpcServer {
  private activeRun: ActiveRun | undefined;
  private output: Writable | undefined;
  private closeRequested = false;

  constructor(private readonly options: ArgonRpcServerOptions) {}

  async serve(input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
    this.output = output;
    const lines = createInterface({ input, crlfDelay: Infinity });

    try {
      for await (const line of lines) {
        if (line.trim().length === 0) continue;
        await this.handleLine(line);
        if (this.closeRequested) break;
      }
    } finally {
      this.options.runtime.shutdown();
      this.output = undefined;
      lines.close();
    }
  }

  private async handleLine(line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      this.writeResponse({
        id: null,
        error: {
          code: ARGON_RPC_ERROR.parseError,
          message: "Parse error",
          data: error instanceof Error ? error.message : String(error)
        }
      });
      return;
    }

    const request = parseRequest(parsed);
    if ("error" in request) {
      this.writeResponse({ id: request.id, error: request.error });
      return;
    }

    await this.handleRequest(request.value);
  }

  private async handleRequest(request: ArgonRpcRequest): Promise<void> {
    try {
      const result = await this.dispatch(request.method, request.params);
      this.writeResponse({ id: request.id, result });
    } catch (error) {
      this.writeResponse({ id: request.id, error: normalizeRpcError(error) });
    }
  }

  private async dispatch(method: ArgonRpcMethod, params: unknown): Promise<unknown> {
    switch (method) {
      case "initialize":
        return this.initialize();
      case "turn/start":
        return this.startTurn(parseTurnStartParams(params));
      case "turn/interrupt":
        return this.interruptTurn(parseTurnInterruptParams(params));
      case "thread/current":
        return this.currentState();
      case "thread/messages":
        return { messages: this.options.runtime.messages() };
      case "thread/list":
        return { sessions: SessionManager.list(this.options.cwd, this.options.sessionDir) };
      case "thread/new":
        return this.newThread();
      case "thread/resume":
        return this.resumeThread(parseThreadResumeParams(params));
      case "thread/tree":
        return { nodes: this.options.runtime.getSession()?.tree() ?? [] };
      case "thread/branch":
        return this.branchThread(parseThreadBranchParams(params));
      case "thread/compact":
        return this.startCompaction(parseThreadCompactParams(params));
      case "model/list":
        return { models: this.listModels() };
      case "model/set":
        return this.setModel(parseModelSetParams(params));
      case "shutdown":
        this.closeRequested = true;
        this.options.runtime.shutdown();
        return { ok: true } satisfies ArgonRpcShutdownResult;
      default:
        throw rpcError(ARGON_RPC_ERROR.methodNotFound, `Method not found: ${method}`);
    }
  }

  private initialize(): ArgonRpcInitializeResult {
    return {
      protocolVersion: ARGON_RPC_PROTOCOL_VERSION,
      server: { name: "argon" },
      capabilities: {
        methods: ARGON_RPC_METHODS,
        notifications: ["turn/event", "turn/completed", "rpc/error"],
        transport: "jsonl-stdio"
      },
      state: this.currentState()
    };
  }

  private startTurn(params: ArgonRpcTurnStartParams): { accepted: true; runId: string } {
    if (this.activeRun) {
      throw rpcError(ARGON_RPC_ERROR.busy, "Argon is already running", this.activeRun);
    }

    const runId = randomUUID();
    this.activeRun = { runId, kind: "turn" };
    void this.streamRun(runId, "turn", this.options.runtime.run(params.input, this.mergeRunOptions(params.options)));
    return { accepted: true, runId };
  }

  private startCompaction(params: ArgonRpcThreadCompactParams): { accepted: true; runId: string } {
    if (this.activeRun) {
      throw rpcError(ARGON_RPC_ERROR.busy, "Argon is already running", this.activeRun);
    }

    const runId = randomUUID();
    this.activeRun = { runId, kind: "compaction" };
    void this.streamRun(
      runId,
      "compaction",
      this.options.runtime.compact(params.instructions, this.mergeRunOptions(params.options))
    );
    return { accepted: true, runId };
  }

  private interruptTurn(params: ArgonRpcTurnInterruptParams): { interrupted: boolean; runId?: string } {
    const active = this.activeRun;
    if (!active || (params.runId && params.runId !== active.runId)) return { interrupted: false };
    this.options.runtime.abort();
    return { interrupted: true, runId: active.runId };
  }

  private newThread(): ArgonRpcSessionState {
    if (this.activeRun) {
      throw rpcError(ARGON_RPC_ERROR.busy, "Argon is already running", this.activeRun);
    }
    const session = SessionManager.create(this.options.cwd, this.options.sessionDir);
    this.options.runtime.switchSession(session);
    return this.currentState();
  }

  private resumeThread(params: ArgonRpcThreadResumeParams): ArgonRpcSessionState {
    if (this.activeRun) {
      throw rpcError(ARGON_RPC_ERROR.busy, "Argon is already running", this.activeRun);
    }
    const session = SessionManager.openResolved(this.options.cwd, params.session, this.options.sessionDir);
    this.options.runtime.switchSession(session);
    return this.currentState();
  }

  private branchThread(params: ArgonRpcThreadBranchParams): ArgonRpcSessionState {
    if (this.activeRun) {
      throw rpcError(ARGON_RPC_ERROR.busy, "Argon is already running", this.activeRun);
    }
    const session = this.options.runtime.getSession();
    if (!session) throw rpcError(ARGON_RPC_ERROR.invalidRequest, "No active session");
    session.branchTo(params.entryId, params.note);
    this.options.runtime.switchSession(session);
    return this.currentState();
  }

  private setModel(params: ArgonRpcModelSetParams): { model: ArgonRpcModel } {
    const registry = this.requireModelRegistry();
    const model = registry.find(params.provider, params.modelId);
    if (!model) {
      throw rpcError(ARGON_RPC_ERROR.invalidParams, `Unknown model for ${params.provider}: ${params.modelId}`);
    }

    const nextModel = params.baseUrl ? ({ ...model, baseUrl: params.baseUrl } as Model<any>) : model;
    try {
      this.options.runtime.switchModel(nextModel);
    } catch (error) {
      throw rpcError(ARGON_RPC_ERROR.busy, error instanceof Error ? error.message : String(error), this.activeRun);
    }
    return { model: this.toRpcModel(nextModel) };
  }

  private listModels(): ArgonRpcModel[] {
    const registry = this.requireModelRegistry();
    return registry.getAll().map((model) => this.toRpcModel(model));
  }

  private currentState(): ArgonRpcSessionState {
    const session = this.options.runtime.getSession();
    const base = {
      cwd: session?.getCwd() ?? this.options.cwd,
      messageCount: this.options.runtime.messages().length,
      model: this.toRpcModel(this.options.runtime.getModel()),
      ...(this.activeRun ? { running: { ...this.activeRun } } : {})
    };
    if (!session) return base;
    return {
      ...base,
      id: session.getSessionId(),
      path: session.getSessionFile(),
      leafId: session.getLeafId()
    };
  }

  private async streamRun(runId: string, kind: ArgonRpcRunKind, iterable: AsyncIterable<AgentEvent>): Promise<void> {
    let reason: "stop" | "max_iterations" | "error" | "aborted" = "stop";
    try {
      for await (const event of iterable) {
        if (event.type === "turn_end") reason = event.reason;
        if (event.type === "error") reason = "error";
        this.writeNotification({
          method: "turn/event",
          params: {
            runId,
            kind,
            event: toRpcAgentEvent(event)
          }
        });
      }
    } catch (error) {
      reason = "error";
      this.writeNotification({
        method: "rpc/error",
        params: {
          runId,
          error: toRpcErrorInfo(error)
        }
      });
    } finally {
      if (this.activeRun?.runId === runId) this.activeRun = undefined;
      this.writeNotification({
        method: "turn/completed",
        params: { runId, kind, reason }
      });
    }
  }

  private mergeRunOptions(options: ArgonRpcTurnOptions | undefined): RunOptions {
    return {
      ...this.options.defaultRunOptions,
      ...options
    };
  }

  private toRpcModel(model: Model<any>): ArgonRpcModel {
    const auth = this.options.modelRegistry?.authStorage.getAuthStatus(model.provider) ?? { configured: false };
    return toRpcModel(model, auth);
  }

  private requireModelRegistry(): ModelRegistry {
    if (!this.options.modelRegistry) {
      throw rpcError(ARGON_RPC_ERROR.invalidRequest, "Model registry is not available");
    }
    return this.options.modelRegistry;
  }

  private writeResponse(response: ArgonRpcResponse): void {
    this.writeJson(response);
  }

  private writeNotification(notification: ArgonRpcNotification): void {
    this.writeJson(notification);
  }

  private writeJson(value: unknown): void {
    const line = `${JSON.stringify(value)}\n`;
    const output = this.output;
    if (!output) return;
    output.write(line);
  }
}

export async function runArgonRpcServer(options: ArgonRpcServerOptions & { input?: Readable; output?: Writable }): Promise<void> {
  const server = new ArgonRpcServer(options);
  await server.serve(options.input, options.output);
}

function parseRequest(value: unknown): { value: ArgonRpcRequest } | { id: ArgonRpcId | null; error: ArgonRpcError } {
  if (!isRecord(value)) {
    return { id: null, error: rpcError(ARGON_RPC_ERROR.invalidRequest, "Invalid request").error };
  }

  const rawId = value.id;
  const id = typeof rawId === "string" || typeof rawId === "number" ? rawId : null;
  if (id === null) {
    return { id, error: rpcError(ARGON_RPC_ERROR.invalidRequest, "Request id must be a string or number").error };
  }

  if (typeof value.method !== "string") {
    return { id, error: rpcError(ARGON_RPC_ERROR.invalidRequest, "Request method must be a string").error };
  }
  if (!isRpcMethod(value.method)) {
    return { id, error: rpcError(ARGON_RPC_ERROR.methodNotFound, `Method not found: ${value.method}`).error };
  }

  return {
    value: {
      id,
      method: value.method,
      ...(value.params !== undefined ? { params: value.params } : {})
    }
  };
}

function parseTurnStartParams(value: unknown): ArgonRpcTurnStartParams {
  const params = requireParams(value);
  if (!("input" in params)) {
    throw rpcError(ARGON_RPC_ERROR.invalidParams, "turn/start requires input");
  }
  return {
    input: parseUserInput(params.input),
    ...(params.options !== undefined ? { options: parseRunOptions(params.options) } : {})
  };
}

function parseThreadCompactParams(value: unknown): ArgonRpcThreadCompactParams {
  if (value === undefined) return {};
  const params = requireParams(value);
  return {
    ...(params.instructions !== undefined ? { instructions: requireString(params.instructions, "instructions") } : {}),
    ...(params.options !== undefined ? { options: parseRunOptions(params.options) } : {})
  };
}

function parseTurnInterruptParams(value: unknown): ArgonRpcTurnInterruptParams {
  if (value === undefined) return {};
  const params = requireParams(value);
  return {
    ...(params.runId !== undefined ? { runId: requireString(params.runId, "runId") } : {})
  };
}

function parseThreadResumeParams(value: unknown): ArgonRpcThreadResumeParams {
  const params = requireParams(value);
  return { session: requireString(params.session, "session") };
}

function parseThreadBranchParams(value: unknown): ArgonRpcThreadBranchParams {
  const params = requireParams(value);
  const entryId = params.entryId;
  if (entryId !== null && typeof entryId !== "string") {
    throw rpcError(ARGON_RPC_ERROR.invalidParams, "entryId must be a string or null");
  }
  return {
    entryId,
    ...(params.note !== undefined ? { note: requireString(params.note, "note") } : {})
  };
}

function parseModelSetParams(value: unknown): ArgonRpcModelSetParams {
  const params = requireParams(value);
  return {
    provider: requireString(params.provider, "provider"),
    modelId: requireString(params.modelId, "modelId"),
    ...(params.baseUrl !== undefined ? { baseUrl: requireString(params.baseUrl, "baseUrl") } : {})
  };
}

function parseRunOptions(value: unknown): ArgonRpcTurnOptions {
  const params = requireParams(value);
  const options: ArgonRpcTurnOptions = {};
  const maxIterations = params.maxIterations;
  if (maxIterations !== undefined) {
    if (typeof maxIterations !== "number" || !Number.isInteger(maxIterations) || maxIterations < 1) {
      throw rpcError(ARGON_RPC_ERROR.invalidParams, "maxIterations must be a positive integer");
    }
    options.maxIterations = maxIterations;
  }
  if (params.reasoning !== undefined) {
    if (typeof params.reasoning !== "string") {
      throw rpcError(ARGON_RPC_ERROR.invalidParams, "reasoning must be a string");
    }
    options.reasoning = params.reasoning as RunOptions["reasoning"];
  }
  if (params.compaction !== undefined) {
    if (!isRecord(params.compaction)) {
      throw rpcError(ARGON_RPC_ERROR.invalidParams, "compaction must be an object");
    }
    options.compaction = params.compaction as NonNullable<ArgonRpcTurnOptions["compaction"]>;
  }
  return options;
}

function parseUserInput(value: unknown): UserInput {
  if (typeof value === "string") return value;
  if (isRecord(value) && "content" in value) {
    return { content: value.content as UserInput extends { content: infer Content } ? Content : never };
  }
  throw rpcError(ARGON_RPC_ERROR.invalidParams, "input must be a string or an object with content");
}

function requireParams(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw rpcError(ARGON_RPC_ERROR.invalidParams, "params must be an object");
  }
  return value;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw rpcError(ARGON_RPC_ERROR.invalidParams, `${name} must be a non-empty string`);
  }
  return value;
}

function isRpcMethod(value: string): value is ArgonRpcMethod {
  return (ARGON_RPC_METHODS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rpcError(code: number, message: string, data?: unknown): Error & { error: ArgonRpcError } {
  const error = new Error(message) as Error & { error: ArgonRpcError };
  error.error = {
    code,
    message,
    ...(data !== undefined ? { data } : {})
  };
  return error;
}

function normalizeRpcError(error: unknown): ArgonRpcError {
  if (error instanceof Error && "error" in error && isRecord(error.error)) {
    const candidate = error.error;
    if (typeof candidate.code === "number" && typeof candidate.message === "string") {
      return {
        code: candidate.code,
        message: candidate.message,
        ...(candidate.data !== undefined ? { data: candidate.data } : {})
      };
    }
  }
  return {
    code: ARGON_RPC_ERROR.internalError,
    message: error instanceof Error ? error.message : String(error)
  };
}
