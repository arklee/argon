import type { AgentEvent, ToolRuntime } from "../types.js";
import { StdioMcpClient, type McpTool } from "./client.js";
import { normalizeMcpRuntimeConfig, serverEnabled, type McpRuntimeConfig, type McpServerConfig } from "./config.js";
import { createMcpToolRuntime, qualifiedMcpToolName } from "./tool-adapter.js";

export interface McpStartupStatus {
  server: string;
  status: "starting" | "ready" | "failed";
  errorMessage?: string | undefined;
}

interface ConnectedServer {
  config: McpServerConfig;
  client: StdioMcpClient;
  tools: McpTool[];
}

export class McpConnectionManager {
  private readonly connected = new Map<string, ConnectedServer>();
  private toolRuntimes: ToolRuntime[] = [];
  private startupKey: string | undefined;

  constructor(private readonly config: McpRuntimeConfig | undefined) {}

  hasConfiguredServers(): boolean {
    const normalized = normalizeMcpRuntimeConfig(this.config);
    return normalized.enabled === true && Object.values(normalized.servers ?? {}).some((server) => serverEnabled(server));
  }

  async ensureConnected(signal?: AbortSignal): Promise<{ events: AgentEvent[]; tools: ToolRuntime[] }> {
    const normalized = normalizeMcpRuntimeConfig(this.config);
    if (!normalized.enabled || !normalized.servers || Object.keys(normalized.servers).length === 0) {
      return { events: [], tools: [] };
    }

    const key = JSON.stringify(normalized.servers);
    if (this.startupKey === key && this.toolRuntimes.length > 0) {
      return { events: [], tools: this.toolRuntimes };
    }

    this.shutdown();
    this.startupKey = key;
    const events: AgentEvent[] = [];
    const tools: ToolRuntime[] = [];

    for (const [serverName, serverConfig] of Object.entries(normalized.servers)) {
      if (!serverEnabled(serverConfig)) continue;
      events.push({ type: "mcp_server_status", server: serverName, status: "starting" });
      const client = new StdioMcpClient(serverName, serverConfig, normalized);
      try {
        const listedTools = await client.start(signal);
        const filteredTools = filterTools(listedTools, serverConfig);
        this.connected.set(serverName, { config: serverConfig, client, tools: filteredTools });
        for (const tool of filteredTools) {
          tools.push(createMcpToolRuntime(this, serverName, serverConfig, tool));
        }
        events.push({ type: "mcp_server_status", server: serverName, status: "ready" });
      } catch (error) {
        client.shutdown();
        const errorMessage = error instanceof Error ? error.message : String(error);
        events.push({ type: "mcp_server_status", server: serverName, status: "failed", errorMessage });
        if (serverConfig.required === true) {
          throw new Error(`Required MCP server ${serverName} failed to start: ${errorMessage}`);
        }
      }
    }

    this.toolRuntimes = dedupeTools(tools);
    return { events, tools: this.toolRuntimes };
  }

  async callTool(serverName: string, toolName: string, args: Record<string, unknown>, meta?: unknown, signal?: AbortSignal) {
    const server = this.connected.get(serverName);
    if (!server) throw new Error(`MCP server not connected: ${serverName}`);
    if (!server.tools.some((tool) => tool.name === toolName)) throw new Error(`MCP tool is not enabled: ${serverName}/${toolName}`);
    return server.client.callTool(toolName, args, meta, signal);
  }

  shutdown(): void {
    for (const server of this.connected.values()) {
      server.client.shutdown();
    }
    this.connected.clear();
    this.toolRuntimes = [];
  }
}

function filterTools(tools: McpTool[], config: McpServerConfig): McpTool[] {
  const enabled = config.enabledTools ? new Set(config.enabledTools) : undefined;
  const disabled = new Set(config.disabledTools ?? []);
  return tools.filter((tool) => (!enabled || enabled.has(tool.name)) && !disabled.has(tool.name));
}

function dedupeTools(tools: ToolRuntime[]): ToolRuntime[] {
  const seen = new Set<string>();
  const result: ToolRuntime[] = [];
  for (const tool of tools) {
    if (seen.has(tool.definition.name)) continue;
    seen.add(tool.definition.name);
    result.push(tool);
  }
  return result;
}

export { qualifiedMcpToolName };
