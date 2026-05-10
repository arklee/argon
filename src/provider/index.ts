import { streamSimple, type Context, type Model, type SimpleStreamOptions } from "@mariozechner/pi-ai";
import type { ApiKeyResolver, StreamProvider } from "../types.js";

export async function resolveApiKey(resolver: ApiKeyResolver | undefined, provider: string): Promise<string | undefined> {
  if (!resolver) return undefined;
  if (typeof resolver === "string") return resolver;
  return resolver(provider);
}

export async function streamWithProvider(options: {
  model: Model<any>;
  context: Context;
  apiKey?: ApiKeyResolver | undefined;
  stream?: StreamProvider | undefined;
  signal?: AbortSignal | undefined;
  reasoning?: SimpleStreamOptions["reasoning"];
  sessionId?: string | undefined;
}) {
  const apiKey = await resolveApiKey(options.apiKey, options.model.provider);
  const stream = options.stream ?? streamSimple;
  const streamOptions: SimpleStreamOptions = {};
  if (apiKey !== undefined) streamOptions.apiKey = apiKey;
  if (options.signal !== undefined) streamOptions.signal = options.signal;
  if (options.reasoning !== undefined) streamOptions.reasoning = options.reasoning;
  if (options.sessionId !== undefined) streamOptions.sessionId = options.sessionId;
  return stream(options.model, options.context, streamOptions);
}
