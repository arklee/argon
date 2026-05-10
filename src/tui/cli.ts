#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
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

  await runInteractive(runtime, renderer, options, state);
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

async function runInteractive(
  runtime: AgentRuntime,
  renderer: TuiEventRenderer,
  options: TuiOptions,
  state: RunState
): Promise<void> {
  const rl = createInterface({ input, output });
  let closing = false;

  rl.on("SIGINT", () => {
    if (state.running) {
      state.abort();
      renderer.status("Interrupted current run.");
      return;
    }

    closing = true;
    rl.close();
  });

  const configLabel = options.configPath ? ` config=${options.configPath}` : "";
  renderer.status(`Argon TUI. ${options.provider}/${options.modelId} in ${options.cwd}${configLabel}`);
  renderer.status("Type /help for commands, /exit to quit. End a line with \\ to continue input.");

  while (!closing) {
    const text = await readPrompt(rl);
    if (text === undefined) break;

    const trimmed = text.trim();
    if (!trimmed) continue;
    if (await handleCommand(trimmed, runtime, renderer, options)) {
      if (trimmed === "/exit" || trimmed === "/quit") break;
      continue;
    }

    await runPrompt(runtime, renderer, text, options, state);
  }

  rl.close();
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

async function readPrompt(rl: ReturnType<typeof createInterface>): Promise<string | undefined> {
  const lines: string[] = [];
  let label = "> ";

  while (true) {
    let line: string;
    try {
      line = await rl.question(label);
    } catch {
      return undefined;
    }

    if (line.endsWith("\\")) {
      lines.push(line.slice(0, -1));
      label = ". ";
      continue;
    }

    lines.push(line);
    return lines.join("\n");
  }
}

async function handleCommand(
  command: string,
  runtime: AgentRuntime,
  renderer: TuiEventRenderer,
  options: TuiOptions
): Promise<boolean> {
  switch (command) {
    case "/help":
      renderer.status("Commands: /help, /status, /clear, /exit");
      return true;
    case "/status":
      renderer.status(
        `model=${options.provider}/${options.modelId} cwd=${options.cwd} messages=${runtime.messages().length}${options.configPath ? ` config=${options.configPath}` : ""}`
      );
      return true;
    case "/clear":
      process.stdout.write("\u001b[2J\u001b[H");
      return true;
    case "/exit":
    case "/quit":
      return true;
    default:
      if (command.startsWith("/")) {
        renderer.status(`Unknown command: ${command}`);
        return true;
      }
      return false;
  }
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
