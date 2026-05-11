import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getArgonHome } from "../session/manager.js";
import { isThinkingLevel, type ArgonThinkingLevel } from "../thinking.js";

export interface UserSettings {
  provider?: string;
  model?: string;
  modelId?: string;
  reasoning?: ArgonThinkingLevel;
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
