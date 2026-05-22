import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isThinkingLevel, type ArgonThinkingLevel } from "../thinking.js";
import type { CompactionSettings } from "../types.js";
import type { McpRuntimeConfig, McpServerConfig } from "../mcp/config.js";
import type { SkillRuntimeConfig } from "../skills/model.js";

export const DEFAULT_CONFIG_FILES = ["argon.config.json", ".argon/settings.json", ".argon/model.json"] as const;

export interface TuiConfig {
  provider?: string;
  model?: string;
  modelId?: string;
  baseUrl?: string;
  cwd?: string;
  showThinking?: boolean;
  color?: boolean;
  apiKey?: string;
  apiKeyEnv?: string;
  eventLogPath?: string;
  sessionId?: string;
  reasoning?: ArgonThinkingLevel;
  compaction?: Partial<CompactionSettings>;
  mcp?: McpRuntimeConfig;
  skills?: SkillRuntimeConfig;
}

export interface LoadedTuiConfig {
  path: string;
  config: TuiConfig;
}

export function loadTuiConfig(cwd: string, explicitPath?: string): LoadedTuiConfig | undefined {
  const configPath = explicitPath ? resolve(explicitPath) : discoverTuiConfig(cwd);
  if (!configPath) return undefined;
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${configPath}: ${message}`);
  }

  const config = normalizeConfig(parsed, dirname(configPath));
  return { path: configPath, config };
}

export function discoverTuiConfig(cwd: string): string | undefined {
  let current = resolve(cwd);

  while (true) {
    for (const name of DEFAULT_CONFIG_FILES) {
      const candidate = join(current, name);
      if (existsSync(candidate)) return candidate;
    }

    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function normalizeConfig(value: unknown, baseDir: string): TuiConfig {
  if (!isRecord(value)) {
    throw new Error("Config root must be a JSON object");
  }

  const config: TuiConfig = {};

  const provider = optionalString(value, "provider");
  if (provider !== undefined) config.provider = provider;

  const model = optionalString(value, "model");
  if (model !== undefined) config.model = model;

  const modelId = optionalString(value, "modelId");
  if (modelId !== undefined) config.modelId = modelId;

  const baseUrl = optionalString(value, "baseUrl");
  if (baseUrl !== undefined) config.baseUrl = baseUrl;

  const cwd = optionalString(value, "cwd");
  if (cwd !== undefined) config.cwd = resolvePath(baseDir, cwd);

  const showThinking = optionalBoolean(value, "showThinking");
  if (showThinking !== undefined) config.showThinking = showThinking;

  const color = optionalBoolean(value, "color");
  if (color !== undefined) config.color = color;

  const apiKey = optionalString(value, "apiKey");
  if (apiKey !== undefined) config.apiKey = apiKey;

  const apiKeyEnv = optionalString(value, "apiKeyEnv");
  if (apiKeyEnv !== undefined) config.apiKeyEnv = apiKeyEnv;

  const eventLogPath = optionalString(value, "eventLogPath");
  if (eventLogPath !== undefined) config.eventLogPath = resolvePath(baseDir, eventLogPath);

  const sessionId = optionalString(value, "sessionId");
  if (sessionId !== undefined) config.sessionId = sessionId;

  const reasoning = optionalString(value, "reasoning");
  if (reasoning !== undefined) {
    if (!isThinkingLevel(reasoning)) {
      throw new Error("reasoning must be one of: off, minimal, low, medium, high, xhigh");
    }
    config.reasoning = reasoning;
  }

  const compaction = optionalCompaction(value, "compaction");
  if (compaction !== undefined) config.compaction = compaction;

  const mcp = optionalMcpConfig(value, "mcp", baseDir);
  if (mcp !== undefined) config.mcp = mcp;

  const skills = optionalSkillConfig(value, "skills", baseDir);
  if (skills !== undefined) config.skills = skills;

  return config;
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return candidate;
}

function optionalBoolean(value: Record<string, unknown>, key: string): boolean | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return candidate;
}

function optionalCompaction(value: Record<string, unknown>, key: string): Partial<CompactionSettings> | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (!isRecord(candidate)) throw new Error(`${key} must be an object`);
  const settings: Partial<CompactionSettings> = {};
  const enabled = optionalBoolean(candidate, "enabled");
  if (enabled !== undefined) settings.enabled = enabled;
  const reserveTokens = optionalPositiveInteger(candidate, "reserveTokens");
  if (reserveTokens !== undefined) settings.reserveTokens = reserveTokens;
  const keepRecentTokens = optionalPositiveInteger(candidate, "keepRecentTokens");
  if (keepRecentTokens !== undefined) settings.keepRecentTokens = keepRecentTokens;
  return settings;
}

function optionalPositiveInteger(value: Record<string, unknown>, key: string): number | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate <= 0) {
    throw new Error(`${key} must be a positive number`);
  }
  return Math.floor(candidate);
}

function optionalMcpConfig(value: Record<string, unknown>, key: string, baseDir: string): McpRuntimeConfig | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (!isRecord(candidate)) throw new Error(`${key} must be an object`);
  const config: McpRuntimeConfig = {};
  const enabled = optionalBoolean(candidate, "enabled");
  if (enabled !== undefined) config.enabled = enabled;
  const startupTimeoutMs = optionalPositiveInteger(candidate, "startupTimeoutMs");
  if (startupTimeoutMs !== undefined) config.startupTimeoutMs = startupTimeoutMs;
  const toolTimeoutMs = optionalPositiveInteger(candidate, "toolTimeoutMs");
  if (toolTimeoutMs !== undefined) config.toolTimeoutMs = toolTimeoutMs;
  const servers = candidate.servers;
  if (servers !== undefined) {
    if (!isRecord(servers)) throw new Error("mcp.servers must be an object");
    const parsedServers: Record<string, McpServerConfig> = {};
    for (const [name, rawServer] of Object.entries(servers)) {
      parsedServers[name] = normalizeMcpServerConfig(rawServer, `mcp.servers.${name}`, baseDir);
    }
    config.servers = parsedServers;
  }
  return config;
}

function normalizeMcpServerConfig(value: unknown, key: string, baseDir: string): McpServerConfig {
  if (!isRecord(value)) throw new Error(`${key} must be an object`);
  const command = optionalString(value, "command");
  if (!command) throw new Error(`${key}.command must be a non-empty string`);
  const config: McpServerConfig = { command };
  if (Array.isArray(value.args) && value.args.every((arg) => typeof arg === "string")) config.args = value.args;
  else if (value.args !== undefined) throw new Error(`${key}.args must be an array of strings`);
  const cwd = optionalString(value, "cwd");
  if (cwd !== undefined) config.cwd = resolvePath(baseDir, cwd);
  if (value.env !== undefined) {
    if (!isRecord(value.env)) throw new Error(`${key}.env must be an object`);
    const env: Record<string, string> = {};
    for (const [envKey, envValue] of Object.entries(value.env)) {
      if (typeof envValue !== "string") throw new Error(`${key}.env.${envKey} must be a string`);
      env[envKey] = envValue;
    }
    config.env = env;
  }
  const enabled = optionalBoolean(value, "enabled");
  if (enabled !== undefined) config.enabled = enabled;
  const required = optionalBoolean(value, "required");
  if (required !== undefined) config.required = required;
  const supportsParallelToolCalls = optionalBoolean(value, "supportsParallelToolCalls");
  if (supportsParallelToolCalls !== undefined) config.supportsParallelToolCalls = supportsParallelToolCalls;
  const startupTimeoutMs = optionalPositiveInteger(value, "startupTimeoutMs");
  if (startupTimeoutMs !== undefined) config.startupTimeoutMs = startupTimeoutMs;
  const toolTimeoutMs = optionalPositiveInteger(value, "toolTimeoutMs");
  if (toolTimeoutMs !== undefined) config.toolTimeoutMs = toolTimeoutMs;
  config.enabledTools = optionalStringArray(value, "enabledTools");
  config.disabledTools = optionalStringArray(value, "disabledTools");
  return config;
}

function optionalSkillConfig(value: Record<string, unknown>, key: string, baseDir: string): SkillRuntimeConfig | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (Array.isArray(candidate)) {
    if (!candidate.every((entry) => typeof entry === "string")) throw new Error(`${key} must be an array of strings or an object`);
    return { roots: candidate.map((entry) => resolvePath(baseDir, entry)) };
  }
  if (!isRecord(candidate)) throw new Error(`${key} must be an array of strings or an object`);
  const config: SkillRuntimeConfig = {};
  const enabled = optionalBoolean(candidate, "enabled");
  if (enabled !== undefined) config.enabled = enabled;
  const roots = optionalStringArray(candidate, "roots");
  if (roots !== undefined) config.roots = roots.map((root) => resolvePath(baseDir, root));
  const disabled = optionalStringArray(candidate, "disabled");
  if (disabled !== undefined) config.disabled = disabled;
  const maxPromptBytes = optionalPositiveInteger(candidate, "maxPromptBytes");
  if (maxPromptBytes !== undefined) config.maxPromptBytes = maxPromptBytes;
  return config;
}

function optionalStringArray(value: Record<string, unknown>, key: string): string[] | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (!Array.isArray(candidate) || !candidate.every((entry) => typeof entry === "string")) {
    throw new Error(`${key} must be an array of strings`);
  }
  return candidate;
}

function resolvePath(baseDir: string, value: string): string {
  return isAbsolute(value) ? value : resolve(baseDir, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
