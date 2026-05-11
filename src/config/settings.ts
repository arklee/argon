import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CompactionSettings } from "../types.js";
import { getArgonHome } from "../session/manager.js";
import { isThinkingLevel, type ArgonThinkingLevel } from "../thinking.js";

export interface UserSettings {
  provider?: string;
  model?: string;
  modelId?: string;
  reasoning?: ArgonThinkingLevel;
  compaction?: Partial<CompactionSettings>;
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
