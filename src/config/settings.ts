import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CompactionSettings } from "../types.js";
import type { McpRuntimeConfig, McpServerConfig } from "../mcp/config.js";
import type { SkillRuntimeConfig } from "../skills/model.js";
import { getArgonHome } from "../session/manager.js";
import { isThinkingLevel, type ArgonThinkingLevel } from "../thinking.js";

export interface UserSettings {
  provider?: string;
  model?: string;
  modelId?: string;
  reasoning?: ArgonThinkingLevel;
  compaction?: Partial<CompactionSettings>;
  mcp?: McpRuntimeConfig;
  skills?: SkillRuntimeConfig;
}

export function getUserSettingsPath(): string {
  return join(getArgonHome(), "settings.json");
}

export function loadUserSettings(path = getUserSettingsPath()): UserSettings {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const record = parsed as Record<string, unknown>;
  const settings: UserSettings = {};
  if (typeof record.provider === "string" && record.provider.length > 0) settings.provider = record.provider;
  if (typeof record.model === "string" && record.model.length > 0) settings.model = record.model;
  if (typeof record.modelId === "string" && record.modelId.length > 0) settings.modelId = record.modelId;
  if (isThinkingLevel(record.reasoning)) settings.reasoning = record.reasoning;
  const compaction = parseCompactionSettings(record.compaction);
  if (compaction) settings.compaction = compaction;
  const mcp = parseMcpRuntimeConfig(record.mcp);
  if (mcp) settings.mcp = mcp;
  const skills = parseSkillRuntimeConfig(record.skills);
  if (skills) settings.skills = skills;
  return settings;
}

export function saveDefaultModel(provider: string, modelId: string, path = getUserSettingsPath()): void {
  const current = loadUserSettings(path);
  const next: UserSettings = { ...current, provider, model: modelId, modelId };
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(next, null, 2), "utf8");
}

export function saveDefaultReasoning(reasoning: ArgonThinkingLevel, path = getUserSettingsPath()): void {
  const current = loadUserSettings(path);
  const next: UserSettings = { ...current, reasoning };
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(next, null, 2), "utf8");
}

function parseCompactionSettings(value: unknown): Partial<CompactionSettings> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const settings: Partial<CompactionSettings> = {};
  if (typeof record.enabled === "boolean") settings.enabled = record.enabled;
  if (typeof record.reserveTokens === "number" && Number.isFinite(record.reserveTokens) && record.reserveTokens > 0) {
    settings.reserveTokens = Math.floor(record.reserveTokens);
  }
  if (typeof record.keepRecentTokens === "number" && Number.isFinite(record.keepRecentTokens) && record.keepRecentTokens > 0) {
    settings.keepRecentTokens = Math.floor(record.keepRecentTokens);
  }
  return Object.keys(settings).length > 0 ? settings : undefined;
}

function parseMcpRuntimeConfig(value: unknown): McpRuntimeConfig | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const config: McpRuntimeConfig = {};
  if (typeof record.enabled === "boolean") config.enabled = record.enabled;
  if (typeof record.startupTimeoutMs === "number" && Number.isFinite(record.startupTimeoutMs) && record.startupTimeoutMs > 0) {
    config.startupTimeoutMs = Math.floor(record.startupTimeoutMs);
  }
  if (typeof record.toolTimeoutMs === "number" && Number.isFinite(record.toolTimeoutMs) && record.toolTimeoutMs > 0) {
    config.toolTimeoutMs = Math.floor(record.toolTimeoutMs);
  }
  if (typeof record.servers === "object" && record.servers !== null && !Array.isArray(record.servers)) {
    const servers: Record<string, McpServerConfig> = {};
    for (const [name, raw] of Object.entries(record.servers as Record<string, unknown>)) {
      const server = parseMcpServerConfig(raw);
      if (server) servers[name] = server;
    }
    if (Object.keys(servers).length > 0) config.servers = servers;
  }
  return Object.keys(config).length > 0 ? config : undefined;
}

function parseMcpServerConfig(value: unknown): McpServerConfig | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.command !== "string" || record.command.length === 0) return undefined;
  const config: McpServerConfig = { command: record.command };
  if (Array.isArray(record.args) && record.args.every((arg) => typeof arg === "string")) config.args = record.args;
  if (typeof record.cwd === "string" && record.cwd.length > 0) config.cwd = record.cwd;
  if (typeof record.env === "object" && record.env !== null && !Array.isArray(record.env)) {
    const env = Object.fromEntries(Object.entries(record.env as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    if (Object.keys(env).length > 0) config.env = env;
  }
  if (typeof record.enabled === "boolean") config.enabled = record.enabled;
  if (typeof record.required === "boolean") config.required = record.required;
  if (typeof record.supportsParallelToolCalls === "boolean") config.supportsParallelToolCalls = record.supportsParallelToolCalls;
  if (typeof record.startupTimeoutMs === "number" && Number.isFinite(record.startupTimeoutMs) && record.startupTimeoutMs > 0) {
    config.startupTimeoutMs = Math.floor(record.startupTimeoutMs);
  }
  if (typeof record.toolTimeoutMs === "number" && Number.isFinite(record.toolTimeoutMs) && record.toolTimeoutMs > 0) {
    config.toolTimeoutMs = Math.floor(record.toolTimeoutMs);
  }
  if (Array.isArray(record.enabledTools) && record.enabledTools.every((tool) => typeof tool === "string")) config.enabledTools = record.enabledTools;
  if (Array.isArray(record.disabledTools) && record.disabledTools.every((tool) => typeof tool === "string")) config.disabledTools = record.disabledTools;
  return config;
}

function parseSkillRuntimeConfig(value: unknown): SkillRuntimeConfig | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return { roots: value };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const config: SkillRuntimeConfig = {};
  if (typeof record.enabled === "boolean") config.enabled = record.enabled;
  if (Array.isArray(record.roots) && record.roots.every((root) => typeof root === "string")) config.roots = record.roots;
  if (Array.isArray(record.disabled) && record.disabled.every((entry) => typeof entry === "string")) config.disabled = record.disabled;
  if (typeof record.maxPromptBytes === "number" && Number.isFinite(record.maxPromptBytes) && record.maxPromptBytes > 0) {
    config.maxPromptBytes = Math.floor(record.maxPromptBytes);
  }
  return Object.keys(config).length > 0 ? config : undefined;
}
