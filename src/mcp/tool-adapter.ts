import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ToolRuntime } from "../types.js";
import type { McpTool } from "./client.js";
import type { McpConnectionManager } from "./connection-manager.js";
import type { McpServerConfig } from "./config.js";

export interface McpToolRuntimeInfo {
  serverName: string;
  toolName: string;
  runtimeName: string;
}

export function createMcpToolRuntime(
  manager: McpConnectionManager,
  serverName: string,
  serverConfig: McpServerConfig,
  tool: McpTool
): ToolRuntime {
  const runtimeName = qualifiedMcpToolName(serverName, tool.name);
  return {
    definition: {
      name: runtimeName,
      description: tool.description ?? `MCP tool ${tool.name} from ${serverName}.`,
      parameters: normalizeInputSchema(tool.inputSchema) as any
    },
    guideline: `MCP tool from server ${serverName}; call when its description matches the task.`,
    canRunInParallel: serverConfig.supportsParallelToolCalls === true,
    execute: async (call, ctx) => {
      const result = await manager.callTool(serverName, tool.name, call.arguments, undefined, ctx.signal);
      return mcpResultToToolResult(call, result.isError === true, result.content, result);
    }
  };
}

export function qualifiedMcpToolName(serverName: string, toolName: string): string {
  return `${qualifiedMcpToolNamePrefix(serverName)}${sanitizeToolPart(toolName)}`;
}

export function qualifiedMcpToolNamePrefix(serverName: string): string {
  return `mcp__${sanitizeToolPart(serverName)}__`;
}

function sanitizeToolPart(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]/g, "_");
  return sanitized.length > 0 ? sanitized : "tool";
}

function normalizeInputSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!schema) return { type: "object", properties: {}, additionalProperties: false };
  const normalized = { ...schema };
  if (normalized.type === undefined) normalized.type = "object";
  if (normalized.properties === undefined || normalized.properties === null) normalized.properties = {};
  return normalized;
}

function mcpResultToToolResult(call: ToolCall, isError: boolean, content: unknown[], details: unknown): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: content.length > 0 ? content.map(contentBlockToPiContent) : [{ type: "text", text: "" }],
    details,
    isError,
    timestamp: Date.now()
  };
}

function contentBlockToPiContent(block: unknown): { type: "text"; text: string } | { type: "image"; data: string; mimeType: string } {
  if (isRecord(block)) {
    if (block.type === "text" && typeof block.text === "string") return { type: "text", text: block.text };
    if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
      return { type: "image", data: block.data, mimeType: block.mimeType };
    }
  }
  return { type: "text", text: JSON.stringify(block) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
