import { resolve } from "node:path";
import type { SimpleStreamOptions } from "@mariozechner/pi-ai";
import { loadTuiConfig, type TuiConfig } from "./config.js";

const DEFAULT_PROVIDER = "openai";
const DEFAULT_MODEL = "gpt-5.2-codex";
const DEFAULT_MAX_ITERATIONS = 12;

export interface TuiOptions {
  cwd: string;
  provider: string;
  modelId: string;
  baseUrl?: string;
  maxIterations: number;
  showThinking: boolean;
  color: boolean;
  configPath?: string;
  once?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  eventLogPath?: string;
  sessionId?: string;
  reasoning?: SimpleStreamOptions["reasoning"];
}

export interface ParsedTuiOptions {
  options?: TuiOptions;
  help?: string;
  error?: string;
}

export function parseTuiArgs(args: string[], env: NodeJS.ProcessEnv = process.env): ParsedTuiOptions {
  const prelude = readCliPrelude(args, env);
  if (prelude.error) return { error: prelude.error };

  const options: TuiOptions = {
    cwd: prelude.cwd,
    provider: DEFAULT_PROVIDER,
    modelId: DEFAULT_MODEL,
    maxIterations: DEFAULT_MAX_ITERATIONS,
    showThinking: false,
    color: env.NO_COLOR === undefined
  };

  try {
    const loaded = loadTuiConfig(prelude.cwd, prelude.configPath);
    if (loaded) {
      applyConfig(options, loaded.config);
      options.configPath = loaded.path;
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  applyEnv(options, env);

  let providerExplicit = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;

    if (arg === "--help" || arg === "-h") {
      return { help: renderHelp() };
    }

    if (arg === "--no-color") {
      options.color = false;
      continue;
    }

    if (arg === "--show-thinking") {
      options.showThinking = true;
      continue;
    }

    if (arg === "--config") {
      const value = readValue(args, ++index, arg);
      if ("error" in value) return value;
      options.configPath = resolve(value.value);
      continue;
    }

    if (arg === "--once") {
      const value = readValue(args, ++index, arg);
      if ("error" in value) return value;
      options.once = value.value;
      continue;
    }

    if (arg === "--cwd" || arg === "-C") {
      const value = readValue(args, ++index, arg);
      if ("error" in value) return value;
      options.cwd = resolve(value.value);
      continue;
    }

    if (arg === "--provider") {
      const value = readValue(args, ++index, arg);
      if ("error" in value) return value;
      options.provider = value.value;
      providerExplicit = true;
      continue;
    }

    if (arg === "--model" || arg === "-m") {
      const value = readValue(args, ++index, arg);
      if ("error" in value) return value;
      applyModelValue(options, value.value, providerExplicit);
      continue;
    }

    if (arg === "--base-url") {
      const value = readValue(args, ++index, arg);
      if ("error" in value) return value;
      options.baseUrl = value.value;
      continue;
    }

    if (arg === "--api-key") {
      const value = readValue(args, ++index, arg);
      if ("error" in value) return value;
      options.apiKey = value.value;
      continue;
    }

    if (arg === "--api-key-env") {
      const value = readValue(args, ++index, arg);
      if ("error" in value) return value;
      options.apiKeyEnv = value.value;
      continue;
    }

    if (arg === "--event-log") {
      const value = readValue(args, ++index, arg);
      if ("error" in value) return value;
      options.eventLogPath = resolve(value.value);
      continue;
    }

    if (arg === "--session-id") {
      const value = readValue(args, ++index, arg);
      if ("error" in value) return value;
      options.sessionId = value.value;
      continue;
    }

    if (arg === "--reasoning") {
      const value = readValue(args, ++index, arg);
      if ("error" in value) return value;
      if (!isReasoningLevel(value.value)) {
        return { error: `Invalid --reasoning value: ${value.value}` };
      }
      options.reasoning = value.value;
      continue;
    }

    if (arg === "--max-iterations") {
      const value = readValue(args, ++index, arg);
      if ("error" in value) return value;
      const parsed = Number.parseInt(value.value, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        return { error: "--max-iterations must be a positive integer" };
      }
      options.maxIterations = parsed;
      continue;
    }

    return { error: `Unknown argument: ${arg}` };
  }

  return { options };
}

export function renderHelp(): string {
  return `Usage: argon [options]

Options:
      --config <path>            Config file path; defaults to argon.config.json discovery
  -m, --model <id|provider/id>   Model id, or provider/model shortcut
      --provider <provider>      Provider for --model when not embedded
      --base-url <url>           Override the selected model base URL
  -C, --cwd <path>               Workspace directory
      --api-key <key>            API key override; config apiKey and env lookup are fallback
      --api-key-env <name>       Read API key from this environment variable
      --reasoning <level>        Reasoning level: low, medium, high, xhigh
      --max-iterations <n>       Max agent loop iterations per prompt
      --event-log <path>         JSONL runtime event log path
      --session-id <id>          Provider session id
      --show-thinking            Print streamed thinking deltas
      --once <prompt>            Run one prompt and exit
      --no-color                 Disable ANSI color
  -h, --help                     Show this help

Environment:
  ARGON_PROVIDER, ARGON_MODEL, ARGON_BASE_URL, ARGON_CWD, ARGON_MAX_ITERATIONS, ARGON_SHOW_THINKING

Config:
  argon.config.json, .argon/settings.json, or .argon/model.json in cwd or a parent directory.

Interactive commands:
  /help, /status, /clear, /exit
`;
}

function applyConfig(options: TuiOptions, config: TuiConfig): void {
  if (config.cwd !== undefined) options.cwd = config.cwd;
  if (config.provider !== undefined) options.provider = config.provider;
  if (config.model !== undefined) applyModelValue(options, config.model, config.provider !== undefined);
  if (config.modelId !== undefined) options.modelId = config.modelId;
  if (config.baseUrl !== undefined) options.baseUrl = config.baseUrl;
  if (config.maxIterations !== undefined) options.maxIterations = config.maxIterations;
  if (config.showThinking !== undefined) options.showThinking = config.showThinking;
  if (config.color !== undefined) options.color = config.color;
  if (config.apiKey !== undefined) options.apiKey = config.apiKey;
  if (config.apiKeyEnv !== undefined) options.apiKeyEnv = config.apiKeyEnv;
  if (config.eventLogPath !== undefined) options.eventLogPath = config.eventLogPath;
  if (config.sessionId !== undefined) options.sessionId = config.sessionId;
  if (config.reasoning !== undefined) options.reasoning = config.reasoning;
}

function applyEnv(options: TuiOptions, env: NodeJS.ProcessEnv): void {
  if (env.ARGON_CWD) options.cwd = resolve(env.ARGON_CWD);
  if (env.ARGON_PROVIDER) options.provider = env.ARGON_PROVIDER;
  if (env.ARGON_MODEL) options.modelId = env.ARGON_MODEL;
  if (env.ARGON_BASE_URL) options.baseUrl = env.ARGON_BASE_URL;
  if (env.ARGON_MAX_ITERATIONS) options.maxIterations = parsePositiveInt(env.ARGON_MAX_ITERATIONS, options.maxIterations);
  if (env.ARGON_SHOW_THINKING === "1" || env.ARGON_SHOW_THINKING === "true") options.showThinking = true;
}

function readCliPrelude(args: string[], env: NodeJS.ProcessEnv): { cwd: string; configPath?: string; error?: string } {
  let cwd = resolve(env.ARGON_CWD || process.cwd());
  let configPath: string | undefined;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--cwd" || arg === "-C") {
      const value = readValue(args, ++index, arg);
      if ("error" in value) return { cwd, error: value.error };
      cwd = resolve(value.value);
    } else if (arg === "--config") {
      const value = readValue(args, ++index, arg);
      if ("error" in value) return { cwd, error: value.error };
      configPath = resolve(value.value);
    }
  }

  return configPath ? { cwd, configPath } : { cwd };
}

function applyModelValue(options: TuiOptions, value: string, providerExplicit: boolean): void {
  const slash = value.indexOf("/");
  const hasSingleSlash = slash > 0 && value.indexOf("/", slash + 1) === -1;
  if (!providerExplicit && hasSingleSlash) {
    options.provider = value.slice(0, slash);
    options.modelId = value.slice(slash + 1);
    return;
  }

  options.modelId = value;
}

function readValue(args: string[], index: number, flag: string): { value: string; error?: never } | { error: string } {
  const value = args[index];
  if (!value || value.startsWith("-")) {
    return { error: `Missing value for ${flag}` };
  }
  return { value };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isReasoningLevel(value: string): value is NonNullable<SimpleStreamOptions["reasoning"]> {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh";
}
