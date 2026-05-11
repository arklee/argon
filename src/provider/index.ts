import { streamSimple, type Context, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { toProviderReasoning, type ArgonThinkingLevel } from "../thinking.js";
import type { ApiKeyResolver, RequestAuthResolver, StreamProvider } from "../types.js";
import { configureGlobalProxyFromEnv } from "./proxy.js";

export async function resolveApiKey(resolver: ApiKeyResolver | undefined, provider: string): Promise<string | undefined> {
  if (!resolver) return undefined;
  if (typeof resolver === "string") return resolver;
  return resolver(provider);
}

export async function streamWithProvider(options: {
  model: Model<any>;
  context: Context;
  apiKey?: ApiKeyResolver | undefined;
  requestAuth?: RequestAuthResolver | undefined;
  stream?: StreamProvider | undefined;
  signal?: AbortSignal | undefined;
  reasoning?: ArgonThinkingLevel;
  sessionId?: string | undefined;
}) {
  configureGlobalProxyFromEnv();
  const resolvedAuth = await options.requestAuth?.(options.model);
  const apiKey = resolvedAuth?.apiKey ?? (await resolveApiKey(options.apiKey, options.model.provider));
  const stream = options.stream ?? streamSimple;
  const streamOptions: SimpleStreamOptions = {};
  if (apiKey !== undefined) streamOptions.apiKey = apiKey;
  if (resolvedAuth?.headers !== undefined) streamOptions.headers = resolvedAuth.headers;
  if (options.signal !== undefined) streamOptions.signal = options.signal;
  const providerReasoning = toProviderReasoning(options.reasoning);
  if (providerReasoning !== undefined) streamOptions.reasoning = providerReasoning;
  if (options.sessionId !== undefined) streamOptions.sessionId = options.sessionId;
  return stream(options.model, options.context, streamOptions);
}
