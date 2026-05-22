import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { McpRuntimeConfig, McpServerConfig } from "./config.js";
import { serverStartupTimeout, serverToolTimeout } from "./config.js";

export interface McpTool {
  name: string;
  description?: string | undefined;
  inputSchema?: Record<string, unknown> | undefined;
}

export interface McpCallToolResult {
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: unknown;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class StdioMcpClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private readonly pending = new Map<string, PendingRequest>();
  private tools: McpTool[] | undefined;

  constructor(
    readonly serverName: string,
    private readonly config: McpServerConfig,
    private readonly runtimeConfig: McpRuntimeConfig | undefined
  ) {}

  async start(signal?: AbortSignal): Promise<McpTool[]> {
    if (this.tools) return this.tools;
    if (this.child) return this.listTools(signal);

    this.child = spawn(this.config.command, this.config.args ?? [], {
      cwd: this.config.cwd,
      env: { ...process.env, ...(this.config.env ?? {}) },
      stdio: "pipe"
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk: string) => this.captureStderr(chunk));
    this.child.on("error", (error) => this.rejectAll(error instanceof Error ? error : new Error(String(error))));
    this.child.on("exit", (code, signalName) => {
      this.rejectAll(new Error(`MCP server exited (${signalName ?? code ?? "unknown"})${this.stderrBuffer ? `: ${this.stderrBuffer}` : ""}`));
      this.child = undefined;
    });

    await this.request(
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "argon", version: "0.1.0" }
      },
      serverStartupTimeout(this.config, this.runtimeConfig),
      signal
    );
    this.notify("notifications/initialized");
    this.tools = await this.listTools(signal);
    return this.tools;
  }

  async listTools(signal?: AbortSignal): Promise<McpTool[]> {
    const result = await this.request("tools/list", {}, serverStartupTimeout(this.config, this.runtimeConfig), signal);
    if (!isRecord(result) || !Array.isArray(result.tools)) return [];
    return result.tools.filter(isMcpTool);
  }

  async callTool(name: string, arguments_: Record<string, unknown>, meta: unknown, signal?: AbortSignal): Promise<McpCallToolResult> {
    const params: Record<string, unknown> = { name, arguments: arguments_ };
    if (meta !== undefined) params._meta = meta;
    const result = await this.request("tools/call", params, serverToolTimeout(this.config, this.runtimeConfig), signal);
    if (!isRecord(result)) return { content: [{ type: "text", text: String(result) }] };
    return {
      content: Array.isArray(result.content) ? result.content : [],
      ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
      ...(typeof result.isError === "boolean" ? { isError: result.isError } : {}),
      ...(result._meta !== undefined ? { _meta: result._meta } : {})
    };
  }

  shutdown(): void {
    this.rejectAll(new Error("MCP server shutting down"));
    this.child?.kill();
    this.child = undefined;
  }

  private request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const child = this.child;
    if (!child) return Promise.reject(new Error(`MCP server ${this.serverName} is not running`));
    if (signal?.aborted) return Promise.reject(new Error("MCP request aborted"));

    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: randomUUID(),
      method,
      ...(params === undefined ? {} : { params })
    };

    return new Promise((resolve, reject) => {
      const cleanupAbort = () => signal?.removeEventListener("abort", onAbort);
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        cleanupAbort();
        reject(new Error(`MCP request timed out: ${method}${this.stderrBuffer ? `: ${this.stderrBuffer}` : ""}`));
      }, timeoutMs);
      const onAbort = () => {
        clearTimeout(timer);
        this.pending.delete(request.id);
        cleanupAbort();
        reject(new Error("MCP request aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(request.id, {
        resolve: (value) => {
          clearTimeout(timer);
          cleanupAbort();
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          cleanupAbort();
          reject(error);
        },
        timer
      });
      child.stdin.write(`${JSON.stringify(request)}\n`, "utf8");
    });
  }

  private notify(method: string, params?: unknown): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) })}\n`, "utf8");
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      this.handleMessage(line);
    }
  }

  private handleMessage(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(message) || typeof message.id !== "string") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error !== undefined) {
      pending.reject(new Error(formatRpcError(message.error)));
    } else {
      pending.resolve(message.result);
    }
  }

  private captureStderr(chunk: string): void {
    this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-8192);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function isMcpTool(value: unknown): value is McpTool {
  return isRecord(value) && typeof value.name === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatRpcError(error: unknown): string {
  if (!isRecord(error)) return String(error);
  const message = typeof error.message === "string" ? error.message : "MCP request failed";
  const code = typeof error.code === "number" || typeof error.code === "string" ? ` (${error.code})` : "";
  return `${message}${code}`;
}
