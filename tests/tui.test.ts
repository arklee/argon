import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  InteractiveEventController,
  TUI_SLASH_COMMANDS,
  createInteractiveRunOptions,
  rememberSubmittedPrompt,
  resolveSlashCommand,
  type InteractiveTuiView,
  type MutableTuiMessage,
  type SlashCommandContext
} from "../src/tui/app.js";
import { renderToolResult, stripAnsi } from "../src/tui/events.js";
import {
  currentModelSupportsImages,
  maybeCreateAttachmentFromPastedPath,
  normalizePastedPath,
  pasteClipboardImageToTempFile,
  prepareImageInput,
  retainReferencedAttachments
} from "../src/tui/image-paste.js";
import { parseTuiArgs } from "../src/tui/options.js";
import type { TurnContext } from "../src/types.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);

describe("TUI options", () => {
  it("parses provider/model shortcuts and run controls", () => {
    const parsed = parseTuiArgs(
      ["--model", "anthropic/claude-sonnet-4-5", "--reasoning", "minimal", "--once", "hi"],
      { NO_COLOR: "1" }
    );

    expect(parsed.options).toMatchObject({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
      reasoning: "minimal",
      once: "hi",
      color: false
    });
  });

  it("accepts off as a reasoning level", () => {
    const parsed = parseTuiArgs(["--reasoning", "off"], {});
    expect(parsed.options).toMatchObject({ reasoning: "off" });
  });

  it("does not expose max iterations as a TUI option", () => {
    const parsed = parseTuiArgs(["--max-iterations", "3"], {});
    expect(parsed.error).toBe("Unknown argument: --max-iterations");
  });

  it("parses session resume flags", () => {
    expect(parseTuiArgs(["--continue"], {}).options).toMatchObject({ continueSession: true });
    expect(parseTuiArgs(["-r"], {}).options).toMatchObject({ resume: true });
    expect(parseTuiArgs(["--session", "abc123"], {}).options).toMatchObject({ session: "abc123" });
    expect(parseTuiArgs(["--no-session"], {}).options).toMatchObject({ noSession: true });
  });

  it("reports missing flag values", () => {
    const parsed = parseTuiArgs(["--model"], {});
    expect(parsed.error).toContain("Missing value");
  });

  it("rejects invalid reasoning levels", () => {
    const parsed = parseTuiArgs(["--reasoning", "extreme"], {});
    expect(parsed.error).toBe("Invalid --reasoning value: extreme");
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
        reasoning: "off",
        compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 500 },
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
      reasoning: "off",
      compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 500 },
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

  it("builds run options with complete thinking levels", () => {
    expect(createInteractiveRunOptions({ reasoning: "off" } as any)).toEqual({ reasoning: "off" });
    expect(createInteractiveRunOptions({ reasoning: "high" } as any)).toEqual({ reasoning: "high" });
    expect(createInteractiveRunOptions({} as any)).toEqual({});
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

describe("Interactive TUI commands", () => {
  const context: SlashCommandContext = {
    provider: "openai",
    modelId: "gpt-5.2-codex",
    cwd: "/tmp/project",
    messageCount: 4,
    thinkingLevel: "high",
    configPath: "/tmp/project/argon.config.json"
  };

  it("resolves built-in slash commands", () => {
    expect(resolveSlashCommand("/help", context)).toMatchObject({
      handled: true,
      action: "message",
      message: expect.stringContaining("/status")
    });
    expect(resolveSlashCommand("/status", context)).toMatchObject({
      handled: true,
      action: "message",
      message: expect.stringContaining("messages=4")
    });
    expect(resolveSlashCommand("/session", context)).toMatchObject({ handled: true, action: "message" });
    expect(resolveSlashCommand("/model", context)).toMatchObject({ handled: true, action: "model" });
    expect(resolveSlashCommand("/thinking", context)).toMatchObject({ handled: true, action: "thinking" });
    expect(resolveSlashCommand("/reasoning", context)).toMatchObject({ handled: true, action: "thinking" });
    expect(resolveSlashCommand("/login", context)).toMatchObject({ handled: true, action: "login" });
    expect(resolveSlashCommand("/resume", context)).toMatchObject({ handled: true, action: "resume" });
    expect(resolveSlashCommand("/tree", context)).toMatchObject({ handled: true, action: "tree" });
    expect(resolveSlashCommand("/compact", context)).toMatchObject({ handled: true, action: "compact" });
    expect(resolveSlashCommand("/compact focus files", context)).toMatchObject({
      handled: true,
      action: "compact",
      instructions: "focus files"
    });
    expect(resolveSlashCommand("/clear", context)).toMatchObject({ handled: true, action: "clear" });
    expect(resolveSlashCommand("/exit", context)).toMatchObject({ handled: true, action: "exit" });
    expect(resolveSlashCommand("hello", context)).toEqual({ handled: false });
  });

  it("reports unknown slash commands and exposes completion commands", () => {
    expect(resolveSlashCommand("/bogus", context)).toMatchObject({
      handled: true,
      action: "message",
      message: "Unknown command: /bogus"
    });
    expect(TUI_SLASH_COMMANDS.map((command) => command.name)).toEqual([
      "help",
      "status",
      "model",
      "thinking",
      "reasoning",
      "login",
      "session",
      "resume",
      "tree",
      "compact",
      "clear",
      "exit",
      "quit"
    ]);
  });
});

describe("Interactive TUI image paste", () => {
  it("normalizes pasted image paths and creates placeholders", async () => {
    const dir = await mkdtemp(join(tmpdir(), "argon-image-path-"));
    const imagePath = join(dir, "screen shot.png");
    await writeFile(imagePath, PNG_1X1);

    expect(normalizePastedPath(`"${imagePath}"`)).toBe(imagePath);
    expect(normalizePastedPath(`file://${imagePath.replaceAll(" ", "%20")}`)).toBe(imagePath);

    const attachment = await maybeCreateAttachmentFromPastedPath(`"${imagePath}"`, []);
    expect(attachment).toEqual({ placeholder: "[Image #1]", path: imagePath });
  });

  it("writes clipboard images to temp files with numbered placeholders", async () => {
    const attachment = await pasteClipboardImageToTempFile([{ placeholder: "[Image #1]", path: "/tmp/one.png" }], {
      hasImage: () => true,
      getImageBinary: async () => PNG_1X1
    });

    expect(attachment?.placeholder).toBe("[Image #2]");
    expect(attachment?.path).toContain("argon-clipboard-");
  });

  it("prepares only referenced image attachments for provider input", async () => {
    const dir = await mkdtemp(join(tmpdir(), "argon-image-input-"));
    const firstPath = join(dir, "one.png");
    const secondPath = join(dir, "two.png");
    await writeFile(firstPath, PNG_1X1);
    await writeFile(secondPath, PNG_1X1);

    const attachments = [
      { placeholder: "[Image #1]", path: firstPath },
      { placeholder: "[Image #2]", path: secondPath }
    ];

    expect(retainReferencedAttachments("describe [Image #2]", attachments)).toEqual([attachments[1]]);

    const prepared = await prepareImageInput("describe [Image #2]", attachments);
    expect(prepared.attachments).toEqual([attachments[1]]);
    expect(prepared.content).toEqual([
      { type: "text", text: "describe [Image #2]" },
      { type: "image", mimeType: "image/png", data: PNG_1X1.toString("base64") }
    ]);
  });

  it("gates image paste on model input modalities", () => {
    expect(currentModelSupportsImages({ input: ["text", "image"] } as any)).toBe(true);
    expect(currentModelSupportsImages({ input: ["text"] } as any)).toBe(false);
    expect(currentModelSupportsImages({} as any)).toBe(true);
  });
});

describe("Interactive TUI event controller", () => {
  it("streams assistant text and toggles running state", () => {
    const view = new FakeInteractiveView();
    const controller = new InteractiveEventController(view, { color: false, showThinking: false });

    controller.beginRun("hello");
    controller.render({
      type: "message_delta",
      role: "assistant",
      kind: "text",
      contentIndex: 0,
      delta: "hi",
      partial: fakeAssistant()
    });
    controller.render({
      type: "message_delta",
      role: "assistant",
      kind: "text",
      contentIndex: 0,
      delta: " there",
      partial: fakeAssistant()
    });
    controller.render({ type: "turn_end", context: fakeTurnContext(), reason: "stop", iterations: 1 });

    expect(view.users).toEqual(["hello"]);
    expect(view.assistants.map((message) => message.text)).toEqual(["hi there"]);
    expect(view.runningStates).toEqual([true, false]);
  });

  it("hides thinking by default and renders it when enabled", () => {
    const hidden = new FakeInteractiveView();
    new InteractiveEventController(hidden, { color: false, showThinking: false }).render({
      type: "message_delta",
      role: "assistant",
      kind: "thinking",
      contentIndex: 0,
      delta: "secret",
      partial: fakeAssistant()
    });
    expect(hidden.thinking).toEqual([]);

    const shown = new FakeInteractiveView();
    new InteractiveEventController(shown, { color: false, showThinking: true }).render({
      type: "message_delta",
      role: "assistant",
      kind: "thinking",
      contentIndex: 0,
      delta: "visible",
      partial: fakeAssistant()
    });
    expect(shown.thinking.map((message) => message.text)).toEqual(["visible"]);
  });

  it("renders compact tool and failure statuses", () => {
    const view = new FakeInteractiveView();
    const controller = new InteractiveEventController(view, { color: false, showThinking: false });
    const toolCall = fakeToolCall("read", { path: "note.txt" });

    controller.render({ type: "tool_call_end", contentIndex: 0, toolCall, partial: fakeAssistant() });
    controller.render({ type: "tool_result", toolCall, result: fakeToolResult(toolCall, "hello\nworld", false) });
    controller.render({ type: "turn_end", context: fakeTurnContext(), reason: "max_iterations", iterations: 3 });

    expect(view.statuses.join("\n")).toContain("tool read");
    expect(view.statuses.join("\n")).toContain("done read hello world");
    expect(view.statuses.join("\n")).toContain("max_iterations after 3 iteration(s)");
  });

  it("keeps streamed tool calls between surrounding assistant text", () => {
    const view = new FakeInteractiveView();
    const controller = new InteractiveEventController(view, { color: false, showThinking: false });
    const toolCall = fakeToolCall("read", { path: "note.txt" });

    controller.render({
      type: "message_delta",
      role: "assistant",
      kind: "text",
      contentIndex: 0,
      delta: "before ",
      partial: fakeAssistant()
    });
    controller.render({ type: "tool_call_end", contentIndex: 1, toolCall, partial: fakeAssistant() });
    controller.render({
      type: "message_delta",
      role: "assistant",
      kind: "text",
      contentIndex: 2,
      delta: "after",
      partial: fakeAssistant()
    });

    expect(view.assistants.map((message) => message.text)).toEqual(["before ", "after"]);
    expect(view.components).toEqual(["assistant:0", "status:  tool read {\"path\":\"note.txt\"}", "assistant:1"]);
  });

  it("starts a fresh assistant component after message end", () => {
    const view = new FakeInteractiveView();
    const controller = new InteractiveEventController(view, { color: false, showThinking: false });

    controller.render({
      type: "message_delta",
      role: "assistant",
      kind: "text",
      contentIndex: 0,
      delta: "first",
      partial: fakeAssistant()
    });
    controller.render({ type: "message_end", message: fakeAssistant() });
    controller.render({
      type: "message_delta",
      role: "assistant",
      kind: "text",
      contentIndex: 0,
      delta: "second",
      partial: fakeAssistant()
    });

    expect(view.assistants.map((message) => message.text)).toEqual(["first", "second"]);
  });

  it("renders error and aborted statuses", () => {
    const view = new FakeInteractiveView();
    const controller = new InteractiveEventController(view, { color: false, showThinking: false });

    controller.render({ type: "error", error: new Error("network down"), recoverable: false });
    controller.render({ type: "turn_end", context: fakeTurnContext(), reason: "aborted", iterations: 1 });

    expect(view.statuses.join("\n")).toContain("error network down");
    expect(view.statuses.join("\n")).toContain("aborted after 1 iteration(s)");
    expect(view.runningStates).toEqual([false]);
  });

  it("records submitted prompts in editor history", () => {
    const history: string[] = [];

    expect(rememberSubmittedPrompt({ addToHistory: (text) => history.push(text) }, "  hello  ")).toBe("hello");
    expect(rememberSubmittedPrompt({ addToHistory: (text) => history.push(text) }, "   ")).toBeUndefined();
    expect(history).toEqual(["hello"]);
  });
});

class FakeMutableMessage implements MutableTuiMessage {
  text = "";

  append(delta: string): void {
    this.text += delta;
  }
}

class FakeInteractiveView implements InteractiveTuiView {
  users: string[] = [];
  assistants: FakeMutableMessage[] = [];
  thinking: FakeMutableMessage[] = [];
  statuses: string[] = [];
  components: string[] = [];
  runningStates: boolean[] = [];
  renderRequests = 0;
  clears = 0;

  addUserMessage(text: string): void {
    this.users.push(text);
    this.components.push(`user:${text}`);
  }

  addAssistantMessage(): MutableTuiMessage {
    const message = new FakeMutableMessage();
    this.assistants.push(message);
    this.components.push(`assistant:${this.assistants.length - 1}`);
    return message;
  }

  addThinkingMessage(): MutableTuiMessage {
    const message = new FakeMutableMessage();
    this.thinking.push(message);
    this.components.push(`thinking:${this.thinking.length - 1}`);
    return message;
  }

  addStatusMessage(text: string): void {
    const status = stripAnsi(text);
    this.statuses.push(status);
    this.components.push(`status:${status}`);
  }

  clearMessages(): void {
    this.clears++;
    this.components.length = 0;
  }

  setRunning(running: boolean): void {
    this.runningStates.push(running);
  }

  requestRender(): void {
    this.renderRequests++;
  }
}

function fakeAssistant(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "faux",
    provider: "faux",
    model: "faux",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: "stop",
    timestamp: Date.now()
  } as AssistantMessage;
}

function fakeTurnContext(): TurnContext {
  return {
    turnId: "turn-test",
    cwd: "/tmp/project",
    model: { provider: "faux", id: "faux" } as TurnContext["model"],
    systemPrompt: "",
    startedAt: Date.now(),
    availableTools: [],
    messageCount: 0
  };
}

function fakeToolCall(name: string, args: Record<string, unknown>): ToolCall {
  return {
    type: "toolCall",
    id: `call-${name}`,
    name,
    arguments: args
  } as ToolCall;
}

function fakeToolResult(toolCall: ToolCall, text: string, isError: boolean): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text }],
    isError,
    timestamp: Date.now()
  };
}
