import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type {
  ArgonRpcId,
  ArgonRpcInitializeResult,
  ArgonRpcMethod,
  ArgonRpcModelListResult,
  ArgonRpcModelSetParams,
  ArgonRpcModelSetResult,
  ArgonRpcNotification,
  ArgonRpcRequest,
  ArgonRpcResponse,
  ArgonRpcSessionState,
  ArgonRpcShutdownResult,
  ArgonRpcThreadBranchParams,
  ArgonRpcThreadCompactParams,
  ArgonRpcThreadListResult,
  ArgonRpcThreadMessagesResult,
  ArgonRpcThreadResumeParams,
  ArgonRpcThreadTreeResult,
  ArgonRpcTurnInterruptParams,
  ArgonRpcTurnInterruptResult,
  ArgonRpcTurnStartParams,
  ArgonRpcTurnStartResult
} from "./protocol.js";

export interface ArgonRpcClientOptions {
  input: Readable;
  output: Writable;
}

export type ArgonRpcNotificationListener = (notification: ArgonRpcNotification) => void;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class ArgonRpcClient {
  private nextId = 1;
  private readonly pending = new Map<ArgonRpcId, PendingRequest>();
  private readonly listeners = new Set<ArgonRpcNotificationListener>();
  private started = false;

  constructor(private readonly options: ArgonRpcClientOptions) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.readLoop();
  }

  onNotification(listener: ArgonRpcNotificationListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  initialize(): Promise<ArgonRpcInitializeResult> {
    return this.request("initialize") as Promise<ArgonRpcInitializeResult>;
  }

  startTurn(params: ArgonRpcTurnStartParams): Promise<ArgonRpcTurnStartResult> {
    return this.request("turn/start", params) as Promise<ArgonRpcTurnStartResult>;
  }

  interruptTurn(params: ArgonRpcTurnInterruptParams = {}): Promise<ArgonRpcTurnInterruptResult> {
    return this.request("turn/interrupt", params) as Promise<ArgonRpcTurnInterruptResult>;
  }

  currentThread(): Promise<ArgonRpcSessionState> {
    return this.request("thread/current") as Promise<ArgonRpcSessionState>;
  }

  messages(): Promise<ArgonRpcThreadMessagesResult> {
    return this.request("thread/messages") as Promise<ArgonRpcThreadMessagesResult>;
  }

  listThreads(): Promise<ArgonRpcThreadListResult> {
    return this.request("thread/list") as Promise<ArgonRpcThreadListResult>;
  }

  newThread(): Promise<ArgonRpcSessionState> {
    return this.request("thread/new") as Promise<ArgonRpcSessionState>;
  }

  resumeThread(params: ArgonRpcThreadResumeParams): Promise<ArgonRpcSessionState> {
    return this.request("thread/resume", params) as Promise<ArgonRpcSessionState>;
  }

  threadTree(): Promise<ArgonRpcThreadTreeResult> {
    return this.request("thread/tree") as Promise<ArgonRpcThreadTreeResult>;
  }

  branchThread(params: ArgonRpcThreadBranchParams): Promise<ArgonRpcSessionState> {
    return this.request("thread/branch", params) as Promise<ArgonRpcSessionState>;
  }

  compactThread(params: ArgonRpcThreadCompactParams = {}): Promise<ArgonRpcTurnStartResult> {
    return this.request("thread/compact", params) as Promise<ArgonRpcTurnStartResult>;
  }

  listModels(): Promise<ArgonRpcModelListResult> {
    return this.request("model/list") as Promise<ArgonRpcModelListResult>;
  }

  setModel(params: ArgonRpcModelSetParams): Promise<ArgonRpcModelSetResult> {
    return this.request("model/set", params) as Promise<ArgonRpcModelSetResult>;
  }

  shutdown(): Promise<ArgonRpcShutdownResult> {
    return this.request("shutdown") as Promise<ArgonRpcShutdownResult>;
  }

  request(method: ArgonRpcMethod, params?: unknown): Promise<unknown> {
    this.start();
    const id = this.nextId++;
    const request: ArgonRpcRequest = {
      id,
      method,
      ...(params !== undefined ? { params } : {})
    };
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.options.output.write(`${JSON.stringify(request)}\n`);
    return promise;
  }

  close(): void {
    for (const { reject } of this.pending.values()) {
      reject(new Error("RPC client closed"));
    }
    this.pending.clear();
    this.options.input.destroy();
    this.options.output.end();
  }

  private async readLoop(): Promise<void> {
    const lines = createInterface({ input: this.options.input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (line.trim().length === 0) continue;
        this.handleMessage(JSON.parse(line) as unknown);
      }
    } catch (error) {
      for (const { reject } of this.pending.values()) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
      this.pending.clear();
    }
  }

  private handleMessage(message: unknown): void {
    if (!isRecord(message)) return;
    if ("id" in message) {
      this.handleResponse(message as ArgonRpcResponse);
      return;
    }
    if (typeof message.method === "string" && "params" in message) {
      const notification = message as ArgonRpcNotification;
      for (const listener of this.listeners) listener(notification);
    }
  }

  private handleResponse(response: ArgonRpcResponse): void {
    const pending = this.pending.get(response.id ?? "");
    if (!pending) return;
    this.pending.delete(response.id ?? "");
    if ("error" in response) {
      const error = new Error(response.error.message) as Error & { code?: number; data?: unknown };
      error.code = response.error.code;
      error.data = response.error.data;
      pending.reject(error);
      return;
    }
    pending.resolve(response.result);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
