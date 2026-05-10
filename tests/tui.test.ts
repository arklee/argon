import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { renderToolResult, stripAnsi } from "../src/tui/events.js";
import { parseTuiArgs } from "../src/tui/options.js";

describe("TUI options", () => {
  it("parses provider/model shortcuts and run controls", () => {
    const parsed = parseTuiArgs(
      ["--model", "anthropic/claude-sonnet-4-5", "--max-iterations", "3", "--reasoning", "high", "--once", "hi"],
      { NO_COLOR: "1" }
    );

    expect(parsed.options).toMatchObject({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
      maxIterations: 3,
      reasoning: "high",
      once: "hi",
      color: false
    });
  });

  it("reports missing flag values", () => {
    const parsed = parseTuiArgs(["--model"], {});
    expect(parsed.error).toContain("Missing value");
  });

  it("keeps slashful model ids when provider is explicit", () => {
    const parsed = parseTuiArgs(["--provider", "openrouter", "--model", "openai/gpt-5.2-codex"], {});

    expect(parsed.options).toMatchObject({
      provider: "openrouter",
      modelId: "openai/gpt-5.2-codex"
    });
  });

  it("loads project config and lets cli args override it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "argon-config-"));
    await writeFile(
      join(dir, "argon.config.json"),
      JSON.stringify({
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        baseUrl: "https://example.test/v1",
        reasoning: "medium",
        maxIterations: 5,
        apiKey: "config-key",
        apiKeyEnv: "ANTHROPIC_API_KEY",
        eventLogPath: ".argon/events.jsonl"
      }),
      "utf8"
    );

    const parsed = parseTuiArgs(["--cwd", dir, "--model", "openai/gpt-5.2-codex"], {});

    expect(parsed.options).toMatchObject({
      provider: "openai",
      modelId: "gpt-5.2-codex",
      baseUrl: "https://example.test/v1",
      reasoning: "medium",
      maxIterations: 5,
      apiKey: "config-key",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      eventLogPath: join(dir, ".argon/events.jsonl")
    });
  });

  it("lets cli api keys override configured api keys", async () => {
    const dir = await mkdtemp(join(tmpdir(), "argon-api-key-"));
    await writeFile(
      join(dir, "argon.config.json"),
      JSON.stringify({ provider: "openai", model: "gpt-5.2-codex", apiKey: "config-key" }),
      "utf8"
    );

    const parsed = parseTuiArgs(["--cwd", dir, "--api-key", "cli-key"], {});

    expect(parsed.options).toMatchObject({
      apiKey: "cli-key"
    });
  });

  it("discovers nested .argon settings files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "argon-settings-"));
    await mkdir(join(dir, ".argon"));
    await writeFile(
      join(dir, ".argon", "settings.json"),
      JSON.stringify({ provider: "google", model: "gemini-3-flash-preview", showThinking: true }),
      "utf8"
    );

    const parsed = parseTuiArgs(["--cwd", dir], {});

    expect(parsed.options).toMatchObject({
      provider: "google",
      modelId: "gemini-3-flash-preview",
      showThinking: true
    });
  });

  it("lets env and cli override configured baseUrl", async () => {
    const dir = await mkdtemp(join(tmpdir(), "argon-base-url-"));
    await writeFile(
      join(dir, "argon.config.json"),
      JSON.stringify({ provider: "openai", model: "gpt-5.2-codex", baseUrl: "https://config.test/v1" }),
      "utf8"
    );

    const fromEnv = parseTuiArgs(["--cwd", dir], { ARGON_BASE_URL: "https://env.test/v1" });
    expect(fromEnv.options).toMatchObject({ baseUrl: "https://env.test/v1" });

    const fromCli = parseTuiArgs(["--cwd", dir, "--base-url", "https://cli.test/v1"], {
      ARGON_BASE_URL: "https://env.test/v1"
    });
    expect(fromCli.options).toMatchObject({ baseUrl: "https://cli.test/v1" });
  });
});

describe("TUI event rendering", () => {
  it("renders compact tool result status", () => {
    const result: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "call-read",
      toolName: "read",
      content: [{ type: "text", text: "hello\nworld" }],
      isError: false,
      timestamp: Date.now()
    };

    expect(stripAnsi(renderToolResult(result, true))).toContain("done read hello world");
  });
});
