import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";

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
  reasoning?: SimpleStreamOptions["reasoning"];
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
    if (!isReasoningLevel(reasoning)) {
      throw new Error("reasoning must be one of: low, medium, high, xhigh");
    }
    config.reasoning = reasoning;
  }

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

function resolvePath(baseDir: string, value: string): string {
  return isAbsolute(value) ? value : resolve(baseDir, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReasoningLevel(value: string): value is NonNullable<SimpleStreamOptions["reasoning"]> {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh";
}
