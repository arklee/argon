import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "../model/registry.js";
import { DEFAULT_TUI_MODEL, DEFAULT_TUI_PROVIDER, type TuiOptions } from "./options.js";

export interface TuiModelFallback {
  fromProvider: string;
  fromModelId: string;
  toProvider: string;
  toModelId: string;
}

export interface ResolvedTuiModel {
  model: Model<Api>;
  fallback?: TuiModelFallback;
}

export function resolveTuiModel(options: TuiOptions, modelRegistry: ModelRegistry): ResolvedTuiModel {
  const model = modelRegistry.find(options.provider, options.modelId);
  if (model) return { model: withBaseUrl(model, options.baseUrl) };

  if (!canFallbackFromMissingModel(options)) {
    throw new Error(`Unknown model for ${options.provider}: ${options.modelId}`);
  }

  const fallback = modelRegistry.find(DEFAULT_TUI_PROVIDER, DEFAULT_TUI_MODEL) ?? modelRegistry.getAll()[0];
  if (!fallback) {
    throw new Error(`Unknown model for ${options.provider}: ${options.modelId}`);
  }

  return {
    model: withBaseUrl(fallback, options.baseUrl),
    fallback: {
      fromProvider: options.provider,
      fromModelId: options.modelId,
      toProvider: fallback.provider,
      toModelId: fallback.id
    }
  };
}

function canFallbackFromMissingModel(options: TuiOptions): boolean {
  return options.modelSource === "user-settings" || options.modelSource === "project-settings";
}

function withBaseUrl(model: Model<Api>, baseUrl: string | undefined): Model<Api> {
  return baseUrl ? ({ ...model, baseUrl } as Model<Api>) : (model as Model<Api>);
}
