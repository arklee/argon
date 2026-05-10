#!/usr/bin/env node

import {
  getEnvApiKey,
  getModels,
  getProviders,
  type Api,
  type KnownProvider,
  type Model
} from "@mariozechner/pi-ai";
import { AgentRuntime } from "../runtime.js";
import type { AgentEvent, AgentRuntimeConfig } from "../types.js";
import { runInteractiveTui } from "./app.js";
import { TuiEventRenderer } from "./events.js";
import { parseTuiArgs, renderHelp, type TuiOptions } from "./options.js";

interface RunState {
  running: boolean;
  abort: () => void;
}

async function main(): Promise<void> {
  const parsed = parseTuiArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(parsed.help);
    return;
  }
  if (parsed.error || !parsed.options) {
    process.stderr.write(`${parsed.error ?? "Invalid arguments"}\n\n${renderHelp()}`);
    process.exitCode = 2;
    return;
  }

  const options = parsed.options;
  const model = resolveModel(options);
  const renderer = new TuiEventRenderer({
    color: options.color && Boolean(process.stdout.isTTY),
    showThinking: options.showThinking
  });
  const runtime = createRuntime(options, model);
  const state: RunState = {
    running: false,
    abort: () => runtime.abort()
  };

  if (options.once !== undefined) {
    process.exitCode = await runPrompt(runtime, renderer, options.once, options, state);
    return;
  }

  if (!process.stdin.isTTY) {
    const prompt = await readStdin();
    if (prompt.length === 0) return;
    process.exitCode = await runPrompt(runtime, renderer, prompt, options, state);
    return;
  }

  await runInteractiveTui(runtime, options);
}

function createRuntime(options: TuiOptions, model: Model<Api>): AgentRuntime {
  const config: AgentRuntimeConfig = {
    model,
    cwd: options.cwd,
    apiKey: options.apiKey ?? ((provider) => resolveApiKey(provider, options)),
    ...(options.eventLogPath ? { eventLogPath: options.eventLogPath } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {})
  };
  return new AgentRuntime(config);
}

function resolveApiKey(provider: string, options: TuiOptions): string | undefined {
  if (options.apiKeyEnv) return process.env[options.apiKeyEnv];
  return getEnvApiKey(provider);
}

async function runPrompt(
  runtime: AgentRuntime,
  renderer: TuiEventRenderer,
  prompt: string,
  options: TuiOptions,
  state: RunState
): Promise<number> {
  state.running = true;
  let exitCode = 0;

  try {
    const runOptions = {
      maxIterations: options.maxIterations,
      ...(options.reasoning ? { reasoning: options.reasoning } : {})
    };

    for await (const event of runtime.run(prompt, runOptions)) {
      renderer.render(event);
      if (isFailure(event)) exitCode = event.type === "turn_end" && event.reason === "aborted" ? 130 : 1;
    }
  } finally {
    state.running = false;
  }

  return exitCode;
}

function resolveModel(options: TuiOptions): Model<Api> {
  const providerId = options.provider;
  const modelId = options.modelId;
  const provider = getProviders().find((candidate) => candidate === providerId);
  if (!provider) {
    throw new Error(`Unknown provider: ${providerId}`);
  }

  const model = getModels(provider as KnownProvider).find((candidate) => candidate.id === modelId);
  if (!model) {
    throw new Error(`Unknown model for ${providerId}: ${modelId}`);
  }

  return options.baseUrl ? ({ ...model, baseUrl: options.baseUrl } as Model<Api>) : (model as Model<Api>);
}

function isFailure(event: AgentEvent): boolean {
  if (event.type === "error") return true;
  return event.type === "turn_end" && (event.reason === "error" || event.reason === "aborted");
}

async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(String(chunk));
  }
  return chunks.join("").trim();
}

main().catch((error) => {
  process.stderr.write(`argon: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
