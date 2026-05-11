import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type ModelThinkingLevel,
  type SimpleStreamOptions
} from "@earendil-works/pi-ai";

export type ArgonThinkingLevel = ModelThinkingLevel;

export const THINKING_LEVELS: readonly ArgonThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export const THINKING_LEVEL_DESCRIPTIONS: Record<ArgonThinkingLevel, string> = {
  off: "No reasoning",
  minimal: "Very brief reasoning",
  low: "Light reasoning",
  medium: "Balanced reasoning",
  high: "Deep reasoning",
  xhigh: "Maximum reasoning"
};

export function isThinkingLevel(value: unknown): value is ArgonThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.includes(value as ArgonThinkingLevel);
}

export function currentThinkingLevel(level: ArgonThinkingLevel | undefined): ArgonThinkingLevel {
  return level ?? "off";
}

export function toProviderReasoning(level: ArgonThinkingLevel | undefined): SimpleStreamOptions["reasoning"] | undefined {
  return level === undefined || level === "off" ? undefined : level;
}

export function supportedThinkingLevels(model: Model<Api>): ArgonThinkingLevel[] {
  return getSupportedThinkingLevels(model) as ArgonThinkingLevel[];
}

export function clampArgonThinkingLevel(model: Model<Api>, level: ArgonThinkingLevel | undefined): ArgonThinkingLevel {
  return clampThinkingLevel(model, currentThinkingLevel(level)) as ArgonThinkingLevel;
}
