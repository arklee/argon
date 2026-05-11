import {
  getModels,
  getProviders,
  type Api,
  type KnownProvider,
  type Model,
  type ModelThinkingLevel
} from "@earendil-works/pi-ai";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AuthStorage, resolveConfigValueOrThrow, resolveHeaders } from "../auth/storage.js";
import { getArgonHome } from "../session/manager.js";

type ConfigValue = string;

export interface ModelDefinition {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
  input?: ("text" | "image")[];
  cost?: Model<Api>["cost"];
  contextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, ConfigValue>;
  compat?: Model<Api>["compat"];
}

export interface ModelOverride {
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
  input?: ("text" | "image")[];
  cost?: Partial<Model<Api>["cost"]>;
  contextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, ConfigValue>;
  compat?: Model<Api>["compat"];
}

export interface ProviderModelConfig {
  name?: string;
  baseUrl?: string;
  api?: string;
  apiKey?: ConfigValue;
  headers?: Record<string, ConfigValue>;
  authHeader?: boolean;
  compat?: Model<Api>["compat"];
  models?: ModelDefinition[];
  modelOverrides?: Record<string, ModelOverride>;
}

export interface ModelsConfig {
  providers: Record<string, ProviderModelConfig>;
}

export type ResolvedRequestAuth =
  | { ok: true; apiKey?: string; headers?: Record<string, string> }
  | { ok: false; error: string };

interface ProviderRequestConfig {
  apiKey?: ConfigValue;
  headers?: Record<string, ConfigValue>;
  authHeader?: boolean;
}

interface ProviderOverride {
  baseUrl?: string;
  compat?: Model<Api>["compat"];
}

export class ModelRegistry {
  private models: Model<Api>[] = [];
  private providerNames = new Map<string, string>();
  private providerRequestConfigs = new Map<string, ProviderRequestConfig>();
  private modelRequestHeaders = new Map<string, Record<string, ConfigValue>>();
  private loadError: string | undefined;

  private constructor(
    readonly authStorage: AuthStorage,
    private readonly modelsPath: string | undefined
  ) {
    this.refresh();
  }

  static create(authStorage: AuthStorage, modelsPath = getDefaultModelsPath()): ModelRegistry {
    return new ModelRegistry(authStorage, modelsPath);
  }

  static inMemory(authStorage: AuthStorage): ModelRegistry {
    return new ModelRegistry(authStorage, undefined);
  }

  refresh(): void {
    this.providerNames.clear();
    this.providerRequestConfigs.clear();
    this.modelRequestHeaders.clear();
    this.loadError = undefined;

    const { models: customModels, providerOverrides, modelOverrides, error } = this.loadCustomModels();
    if (error) this.loadError = error;

    const builtInModels = this.loadBuiltInModels(providerOverrides, modelOverrides);
    this.models = mergeCustomModels(builtInModels, customModels);

    for (const [provider, config] of this.providerRequestConfigs) {
      this.authStorage.setModelApiKeyStatus(provider, config.apiKey);
    }
  }

  getError(): string | undefined {
    return this.loadError;
  }

  getAll(): Model<Api>[] {
    return [...this.models];
  }

  getAvailable(): Model<Api>[] {
    return this.models.filter((model) => this.authStorage.hasAuth(model.provider));
  }

  find(provider: string, modelId: string): Model<Api> | undefined {
    return this.models.find((model) => model.provider === provider && model.id === modelId);
  }

  getProviderDisplayName(provider: string): string {
    return this.providerNames.get(provider) ?? provider;
  }

  async getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth> {
    try {
      const providerConfig = this.providerRequestConfigs.get(model.provider);
      const apiKey =
        (await this.authStorage.getApiKey(model.provider)) ??
        (providerConfig?.apiKey ? resolveConfigValueOrThrow(providerConfig.apiKey, `API key for ${model.provider}`) : undefined);
      const providerHeaders = resolveHeaders(providerConfig?.headers);
      const modelHeaders = resolveHeaders(this.modelRequestHeaders.get(modelKey(model.provider, model.id)));
      let headers = model.headers || providerHeaders || modelHeaders ? { ...model.headers, ...providerHeaders, ...modelHeaders } : undefined;

      if (providerConfig?.authHeader) {
        if (!apiKey) return { ok: false, error: `No API key found for ${model.provider}` };
        headers = { ...headers, Authorization: `Bearer ${apiKey}` };
      }

      return { ok: true, ...(apiKey ? { apiKey } : {}), ...(headers ? { headers } : {}) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private loadBuiltInModels(
    providerOverrides: Map<string, ProviderOverride>,
    modelOverrides: Map<string, Map<string, ModelOverride>>
  ): Model<Api>[] {
    return getProviders().flatMap((provider) => {
      const models = getModels(provider as KnownProvider) as Model<Api>[];
      const providerOverride = providerOverrides.get(provider);
      const perModelOverrides = modelOverrides.get(provider);

      return models.map((baseModel) => {
        let model = baseModel;
        if (providerOverride) {
          const compat = mergeCompat(model.compat, providerOverride.compat);
          model = {
            ...model,
            baseUrl: providerOverride.baseUrl ?? model.baseUrl,
            ...(compat ? { compat } : {})
          };
        }
        const modelOverride = perModelOverrides?.get(baseModel.id);
        if (modelOverride) model = applyModelOverride(model, modelOverride);
        return model;
      });
    });
  }

  private loadCustomModels(): {
    models: Model<Api>[];
    providerOverrides: Map<string, ProviderOverride>;
    modelOverrides: Map<string, Map<string, ModelOverride>>;
    error?: string;
  } {
    const providerOverrides = new Map<string, ProviderOverride>();
    const modelOverrides = new Map<string, Map<string, ModelOverride>>();
    if (!this.modelsPath || !existsSync(this.modelsPath)) return { models: [], providerOverrides, modelOverrides };

    try {
      const parsed = JSON.parse(stripJsonComments(readFileSync(this.modelsPath, "utf8"))) as unknown;
      const config = normalizeModelsConfig(parsed);
      const models: Model<Api>[] = [];
      const builtInProviders = new Set<string>(getProviders());

      for (const [provider, providerConfig] of Object.entries(config.providers)) {
        if (providerConfig.name) this.providerNames.set(provider, providerConfig.name);
        this.storeProviderRequestConfig(provider, providerConfig);

        if (providerConfig.baseUrl || providerConfig.compat) {
          providerOverrides.set(provider, {
            ...(providerConfig.baseUrl ? { baseUrl: providerConfig.baseUrl } : {}),
            ...(providerConfig.compat ? { compat: providerConfig.compat } : {})
          });
        }

        if (providerConfig.modelOverrides) {
          modelOverrides.set(provider, new Map(Object.entries(providerConfig.modelOverrides)));
          for (const [modelId, modelOverride] of Object.entries(providerConfig.modelOverrides)) {
            this.storeModelHeaders(provider, modelId, modelOverride.headers);
          }
        }

        const customDefinitions = providerConfig.models ?? [];
        if (customDefinitions.length === 0) continue;

        const defaults = builtInProviders.has(provider) ? firstBuiltInDefaults(provider as KnownProvider) : undefined;
        if (!providerConfig.baseUrl && !defaults?.baseUrl) throw new Error(`Provider ${provider}: baseUrl is required`);
        if (!providerConfig.api && !defaults?.api && customDefinitions.some((model) => !model.api)) {
          throw new Error(`Provider ${provider}: api is required`);
        }

        for (const modelDef of customDefinitions) {
          const api = modelDef.api ?? providerConfig.api ?? defaults?.api;
          const baseUrl = modelDef.baseUrl ?? providerConfig.baseUrl ?? defaults?.baseUrl;
          if (!api || !baseUrl) continue;
          this.storeModelHeaders(provider, modelDef.id, modelDef.headers);
          const compat = mergeCompat(providerConfig.compat, modelDef.compat);
          models.push({
            id: modelDef.id,
            name: modelDef.name ?? modelDef.id,
            api: api as Api,
            provider,
            baseUrl,
            reasoning: modelDef.reasoning ?? false,
            ...(modelDef.thinkingLevelMap ? { thinkingLevelMap: modelDef.thinkingLevelMap } : {}),
            input: modelDef.input ?? ["text"],
            cost: modelDef.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: modelDef.contextWindow ?? 128000,
            maxTokens: modelDef.maxTokens ?? 16384,
            ...(compat ? { compat } : {})
          });
        }
      }

      return { models, providerOverrides, modelOverrides };
    } catch (error) {
      return {
        models: [],
        providerOverrides,
        modelOverrides,
        error: `Failed to load models.json: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  private storeProviderRequestConfig(provider: string, config: ProviderModelConfig): void {
    if (!config.apiKey && !config.headers && !config.authHeader) return;
    this.providerRequestConfigs.set(provider, {
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      ...(config.headers ? { headers: config.headers } : {}),
      ...(config.authHeader !== undefined ? { authHeader: config.authHeader } : {})
    });
  }

  private storeModelHeaders(provider: string, modelId: string, headers: Record<string, ConfigValue> | undefined): void {
    if (!headers || Object.keys(headers).length === 0) return;
    this.modelRequestHeaders.set(modelKey(provider, modelId), headers);
  }
}

export function getDefaultModelsPath(): string {
  return join(getArgonHome(), "models.json");
}

export function parseModelSpecifier(value: string, fallbackProvider: string): { provider: string; modelId: string } {
  const slash = value.indexOf("/");
  const hasSingleSlash = slash > 0 && value.indexOf("/", slash + 1) === -1;
  return hasSingleSlash ? { provider: value.slice(0, slash), modelId: value.slice(slash + 1) } : { provider: fallbackProvider, modelId: value };
}

function normalizeModelsConfig(value: unknown): ModelsConfig {
  if (!isRecord(value) || !isRecord(value.providers)) throw new Error("models.json root must contain a providers object");
  const providers: Record<string, ProviderModelConfig> = {};
  for (const [provider, rawConfig] of Object.entries(value.providers)) {
    if (!isRecord(rawConfig)) throw new Error(`Provider ${provider} must be an object`);
    const config = rawConfig as ProviderModelConfig;
    if (config.models && !Array.isArray(config.models)) throw new Error(`Provider ${provider} models must be an array`);
    if (config.models) {
      for (const model of config.models) {
        if (!isRecord(model) || typeof model.id !== "string" || model.id.length === 0) {
          throw new Error(`Provider ${provider} has a model without a non-empty id`);
        }
      }
    }
    providers[provider] = config;
  }
  return { providers };
}

function applyModelOverride(model: Model<Api>, override: ModelOverride): Model<Api> {
  const compat = mergeCompat(model.compat, override.compat);
  return {
    ...model,
    ...(override.name !== undefined ? { name: override.name } : {}),
    ...(override.reasoning !== undefined ? { reasoning: override.reasoning } : {}),
    ...(override.thinkingLevelMap !== undefined ? { thinkingLevelMap: { ...model.thinkingLevelMap, ...override.thinkingLevelMap } } : {}),
    ...(override.input !== undefined ? { input: override.input } : {}),
    ...(override.contextWindow !== undefined ? { contextWindow: override.contextWindow } : {}),
    ...(override.maxTokens !== undefined ? { maxTokens: override.maxTokens } : {}),
    ...(override.cost
      ? {
          cost: {
            input: override.cost.input ?? model.cost.input,
            output: override.cost.output ?? model.cost.output,
            cacheRead: override.cost.cacheRead ?? model.cost.cacheRead,
            cacheWrite: override.cost.cacheWrite ?? model.cost.cacheWrite
          }
        }
      : {}),
    ...(compat ? { compat } : {})
  };
}

function mergeCustomModels(builtInModels: Model<Api>[], customModels: Model<Api>[]): Model<Api>[] {
  const merged = [...builtInModels];
  for (const customModel of customModels) {
    const index = merged.findIndex((model) => model.provider === customModel.provider && model.id === customModel.id);
    if (index === -1) merged.push(customModel);
    else merged[index] = customModel;
  }
  return merged;
}

function mergeCompat(base: Model<Api>["compat"], override: Model<Api>["compat"]): Model<Api>["compat"] | undefined {
  if (!override) return base;
  return { ...(base as Record<string, unknown> | undefined), ...(override as Record<string, unknown>) } as Model<Api>["compat"];
}

function firstBuiltInDefaults(provider: KnownProvider): { api: string; baseUrl: string } | undefined {
  const model = (getModels(provider) as Model<Api>[])[0];
  return model ? { api: model.api, baseUrl: model.baseUrl } : undefined;
}

function modelKey(provider: string, modelId: string): string {
  return `${provider}:${modelId}`;
}

function stripJsonComments(input: string): string {
  return input
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ""))
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail) => tail ?? (match[0] === '"' ? match : ""));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type ModelReasoning = ModelThinkingLevel;
