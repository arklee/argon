export interface McpServerConfig {
  command: string;
  args?: string[] | undefined;
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
  enabled?: boolean | undefined;
  required?: boolean | undefined;
  startupTimeoutMs?: number | undefined;
  toolTimeoutMs?: number | undefined;
  supportsParallelToolCalls?: boolean | undefined;
  enabledTools?: string[] | undefined;
  disabledTools?: string[] | undefined;
}

export interface McpRuntimeConfig {
  enabled?: boolean | undefined;
  servers?: Record<string, McpServerConfig> | undefined;
  startupTimeoutMs?: number | undefined;
  toolTimeoutMs?: number | undefined;
}

export const DEFAULT_MCP_STARTUP_TIMEOUT_MS = 10_000;
export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 60_000;

export function normalizeMcpRuntimeConfig(config: McpRuntimeConfig | undefined): Required<Pick<McpRuntimeConfig, "enabled">> & McpRuntimeConfig {
  return {
    ...config,
    enabled: config?.enabled !== false
  };
}

export function serverEnabled(config: McpServerConfig): boolean {
  return config.enabled !== false;
}

export function serverStartupTimeout(config: McpServerConfig, runtime: McpRuntimeConfig | undefined): number {
  return positiveTimeout(config.startupTimeoutMs) ?? positiveTimeout(runtime?.startupTimeoutMs) ?? DEFAULT_MCP_STARTUP_TIMEOUT_MS;
}

export function serverToolTimeout(config: McpServerConfig, runtime: McpRuntimeConfig | undefined): number {
  return positiveTimeout(config.toolTimeoutMs) ?? positiveTimeout(runtime?.toolTimeoutMs) ?? DEFAULT_MCP_TOOL_TIMEOUT_MS;
}

function positiveTimeout(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}
