import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
  Type,
  type FauxProviderRegistration
} from "@earendil-works/pi-ai";
import { AgentRuntime, SessionManager, createReadTool, type AgentEvent, type ToolRuntime } from "../src/index.js";

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

async function tempDir(): Promise<string> {
  const dir = join(tmpdir(), `argon-loop-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function firstText(message: { content: Array<{ type: string; text?: string }> }): string {
  const block = message.content[0];
  return block?.type === "text" ? (block.text ?? "") : "";
}

function withTotalTokens(message: ReturnType<typeof fauxAssistantMessage>, totalTokens: number): ReturnType<typeof fauxAssistantMessage> {
  message.usage = {
    ...message.usage,
    input: totalTokens,
    totalTokens
  };
  return message;
}

describe("AgentRuntime loop", () => {
  let faux: FauxProviderRegistration | undefined;

  afterEach(() => {
    faux?.unregister();
    faux = undefined;
  });

  it("runs a one-turn plain answer", async () => {
    faux = registerFauxProvider({ tokensPerSecond: 0, tokenSize: { min: 1000, max: 1000 } });
    faux.setResponses([fauxAssistantMessage("hello")]);

    const runtime = new AgentRuntime({
      model: faux.getModel(),
      cwd: await tempDir(),
      tools: [],
      apiKey: "test"
    });

    const events = await collect(runtime.run("hi"));
    expect(events.at(-1)).toMatchObject({ type: "turn_end", reason: "stop", iterations: 1 });
    expect(events.filter((event) => event.type === "iteration_start")).toEqual([
      expect.objectContaining({ type: "iteration_start", iteration: 1, reason: "initial" })
    ]);
    expect(runtime.messages().map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("injects mentioned skill instructions before provider invocation", async () => {
    const cwd = await tempDir();
    await mkdir(join(cwd, ".git"));
    const skillDir = join(cwd, ".agents", "skills", "review-helper");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: review-helper\ndescription: Use when reviewing code changes.\n---\n\n# Review Helper\nFollow the checklist.",
      "utf8"
    );
    faux = registerFauxProvider({ tokensPerSecond: 0, tokenSize: { min: 1000, max: 1000 } });
    faux.setResponses([
      (context) => {
        const first = context.messages[0];
        expect(first?.role).toBe("user");
        expect(first?.role === "user" ? first.content : "").toContain("<skill>");
        expect(first?.role === "user" ? first.content : "").toContain("Follow the checklist.");
        return fauxAssistantMessage("done");
      }
    ]);

    const runtime = new AgentRuntime({
      model: faux.getModel(),
      cwd,
      tools: [],
      apiKey: "test"
    });

    await collect(runtime.run("Use $review-helper here"));
  });

  it("switches the runtime model for the next turn", async () => {
    faux = registerFauxProvider({ tokensPerSecond: 0, tokenSize: { min: 1000, max: 1000 } });
    faux.setResponses([fauxAssistantMessage("hello")]);

    const runtime = new AgentRuntime({
      model: faux.getModel(),
      cwd: await tempDir(),
      tools: [],
      apiKey: "test"
    });
    const nextModel = { ...faux.getModel(), id: "next-model" };

    runtime.switchModel(nextModel);
    const events = await collect(runtime.run("hi"));

    expect(runtime.getModel().id).toBe("next-model");
    expect(events.find((event) => event.type === "turn_start")).toMatchObject({
      type: "turn_start",
      context: { model: { id: "next-model" } }
    });
  });

  it("does not pass off thinking to the provider stream", async () => {
    faux = registerFauxProvider({ tokensPerSecond: 0, tokenSize: { min: 1000, max: 1000 } });
    const streamOptions: Array<{ reasoning: string | undefined }> = [];
    const runtime = new AgentRuntime({
      model: faux.getModel(),
      cwd: await tempDir(),
      tools: [],
      apiKey: "test",
      stream: (_model, _context, options) => {
        streamOptions.push({ reasoning: options?.reasoning });
        const message = fauxAssistantMessage("hello");
        return (async function* () {
          yield { type: "start", partial: message };
          yield { type: "done", reason: "stop", message };
        })() as any;
      }
    });

    await collect(runtime.run("hi", { reasoning: "off" }));
    expect(streamOptions).toEqual([{ reasoning: undefined }]);
  });

  it("passes enabled thinking levels to the provider stream", async () => {
    faux = registerFauxProvider({ tokensPerSecond: 0, tokenSize: { min: 1000, max: 1000 } });
    const streamOptions: Array<{ reasoning: string | undefined }> = [];
    const runtime = new AgentRuntime({
      model: faux.getModel(),
      cwd: await tempDir(),
      tools: [],
      apiKey: "test",
      stream: (_model, _context, options) => {
        streamOptions.push({ reasoning: options?.reasoning });
        const message = fauxAssistantMessage("hello");
        return (async function* () {
          yield { type: "start", partial: message };
          yield { type: "done", reason: "stop", message };
        })() as any;
      }
    });

    await collect(runtime.run("hi", { reasoning: "minimal" }));
    expect(streamOptions).toEqual([{ reasoning: "minimal" }]);
  });

  it("persists a new session and resumes previous messages", async () => {
    const cwd = await tempDir();
    const sessionDir = join(cwd, ".sessions");
    const session = SessionManager.create(cwd, sessionDir);
    faux = registerFauxProvider({ tokensPerSecond: 0, tokenSize: { min: 1000, max: 1000 } });
    faux.setResponses([fauxAssistantMessage("hello")]);

    const runtime = new AgentRuntime({
      model: faux.getModel(),
      cwd,
      tools: [],
      apiKey: "test",
      session
    });

    expect(existsSync(session.getSessionFile())).toBe(false);
    await collect(runtime.run("hi"));
    expect(existsSync(session.getSessionFile())).toBe(true);
    const reopened = SessionManager.open(session.getSessionFile(), sessionDir);
    expect(reopened.buildContext().messages.map((message) => message.role)).toEqual(["user", "assistant"]);

    faux.setResponses([
      (context) => {
        expect(context.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
        return fauxAssistantMessage("again");
      }
    ]);
    const resumed = new AgentRuntime({
      model: faux.getModel(),
      cwd,
      tools: [],
      apiKey: "test",
      session: reopened
    });
    await collect(resumed.run("continue"));
  });

  it("manually compacts persisted session context", async () => {
    const cwd = await tempDir();
    const session = SessionManager.create(cwd, join(cwd, ".sessions"));
    session.appendMessage({ role: "user", content: "old request", timestamp: Date.now() });
    session.appendMessage(fauxAssistantMessage("old answer"));
    session.appendMessage({ role: "user", content: "recent request", timestamp: Date.now() });
    session.appendMessage(fauxAssistantMessage("recent answer"));
    faux = registerFauxProvider({ tokensPerSecond: 0, tokenSize: { min: 1000, max: 1000 } });
    faux.setResponses([fauxAssistantMessage("summary of old work")]);

    const runtime = new AgentRuntime({
      model: faux.getModel(),
      cwd,
      tools: [],
      apiKey: "test",
      session
    });

    const events = await collect(runtime.compact(undefined, { compaction: { keepRecentTokens: 1 } }));
    expect(events.map((event) => event.type)).toContain("compaction_start");
    expect(events.at(-1)).toMatchObject({ type: "compaction_end", result: { summary: "summary of old work" } });
    const compactedFirst = runtime.messages()[0];
    expect(compactedFirst?.role === "user" ? compactedFirst.content : "").toContain("summary of old work");
    expect(SessionManager.open(session.getSessionFile()).buildContext().messages[0]?.role).toBe("user");
  });

  it("auto-compacts after a turn crosses the configured threshold", async () => {
    const cwd = await tempDir();
    const session = SessionManager.create(cwd, join(cwd, ".sessions"));
    session.appendMessage({ role: "user", content: "old request", timestamp: Date.now() });
    session.appendMessage(fauxAssistantMessage("old answer"));
    faux = registerFauxProvider({
      tokensPerSecond: 0,
      tokenSize: { min: 1, max: 1 },
      models: [{ id: "tiny", contextWindow: 1_000_000 }]
    });
    faux.setResponses([
      withTotalTokens(fauxAssistantMessage("large answer"), 25),
      fauxAssistantMessage("compact summary")
    ]);

    const runtime = new AgentRuntime({
      model: faux.getModel(),
      cwd,
      tools: [],
      apiKey: "test",
      session
    });

    const events = await collect(runtime.run("new request", { compaction: { reserveTokens: 999_999, keepRecentTokens: 1 } }));
    expect(events.some((event) => event.type === "compaction_start" && event.reason === "threshold")).toBe(true);
    const compactedFirst = runtime.messages()[0];
    expect(compactedFirst?.role === "user" ? compactedFirst.content : "").toContain("compact summary");
  });

  it("compacts and retries once after context overflow", async () => {
    const cwd = await tempDir();
    const session = SessionManager.create(cwd, join(cwd, ".sessions"));
    session.appendMessage({ role: "user", content: "old request", timestamp: Date.now() });
    session.appendMessage(fauxAssistantMessage("old answer"));
    faux = registerFauxProvider({
      tokensPerSecond: 0,
      tokenSize: { min: 1000, max: 1000 },
      models: [{ id: "tiny", contextWindow: 20 }]
    });
    faux.setResponses([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "This model's maximum context length is 20 tokens." }),
      fauxAssistantMessage("overflow summary"),
      (context) => {
        expect(context.messages.filter((message) => message.role === "user" && message.content === "continue")).toHaveLength(1);
        expect(context.messages[0]?.role === "user" ? context.messages[0].content : "").toContain("overflow summary");
        return fauxAssistantMessage("recovered");
      }
    ]);

    const runtime = new AgentRuntime({
      model: faux.getModel(),
      cwd,
      tools: [],
      apiKey: "test",
      session
    });

    const events = await collect(runtime.run("continue", { compaction: { keepRecentTokens: 1 } }));
    expect(events.some((event) => event.type === "compaction_start" && event.reason === "overflow")).toBe(true);
    expect(runtime.messages().at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
    expect(SessionManager.open(session.getSessionFile()).buildContext().messages.some((message) => message.role === "assistant" && message.stopReason === "error")).toBe(
      false
    );
  });

  it("executes a tool call and continues with the tool result in context", async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, "note.txt"), "from tool", "utf8");
    faux = registerFauxProvider({ tokensPerSecond: 0, tokenSize: { min: 1000, max: 1000 } });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: "note.txt" }, { id: "call-read" })),
      (context) => {
        const last = context.messages.at(-1);
        expect(last?.role).toBe("toolResult");
        expect(last?.role === "toolResult" ? firstText(last) : "").toContain("from tool");
        return fauxAssistantMessage("done");
      }
    ]);

    const runtime = new AgentRuntime({
      model: faux.getModel(),
      cwd,
      tools: [createReadTool()],
      apiKey: "test"
    });

    const events = await collect(runtime.run("read it"));
    expect(events.some((event) => event.type === "tool_result")).toBe(true);
    expect(events.filter((event) => event.type === "iteration_start")).toEqual([
      expect.objectContaining({ type: "iteration_start", iteration: 1, reason: "initial" }),
      expect.objectContaining({ type: "iteration_start", iteration: 2, reason: "tool_results" })
    ]);
    expect(runtime.messages().map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant"
    ]);
  });

  it("runs adjacent parallel-safe tool calls concurrently and preserves result order", async () => {
    const cwd = await tempDir();
    faux = registerFauxProvider({ tokensPerSecond: 0, tokenSize: { min: 1000, max: 1000 } });
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("inspect", { value: "first" }, { id: "call-first" }),
        fauxToolCall("inspect", { value: "second" }, { id: "call-second" })
      ]),
      (context) => {
        const resultTexts = context.messages
          .filter((message) => message.role === "toolResult")
          .map((message) => (message.role === "toolResult" ? firstText(message) : ""));
        expect(resultTexts).toEqual(["first", "second"]);
        return fauxAssistantMessage("done");
      }
    ]);

    let active = 0;
    let maxActive = 0;
    const inspectTool: ToolRuntime = {
      definition: {
        name: "inspect",
        description: "Inspectable parallel tool.",
        parameters: Type.Object({})
      },
      canRunInParallel: true,
      async execute(call) {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, call.id === "call-first" ? 40 : 10));
        active--;
        return {
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: String(call.arguments.value) }],
          isError: false,
          timestamp: Date.now()
        };
      }
    };

    const runtime = new AgentRuntime({
      model: faux.getModel(),
      cwd,
      tools: [inspectTool],
      apiKey: "test"
    });

    await collect(runtime.run("inspect both"));
    expect(maxActive).toBe(2);
    expect(
      runtime.messages()
        .filter((message) => message.role === "toolResult")
        .map((message) => (message.role === "toolResult" ? firstText(message) : ""))
    ).toEqual(["first", "second"]);
  });

  it("persists tool call continuation records", async () => {
    const cwd = await tempDir();
    const session = SessionManager.create(cwd, join(cwd, ".sessions"));
    await writeFile(join(cwd, "note.txt"), "from tool", "utf8");
    faux = registerFauxProvider({ tokensPerSecond: 0, tokenSize: { min: 1000, max: 1000 } });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: "note.txt" }, { id: "call-read" })),
      fauxAssistantMessage("done")
    ]);

    const runtime = new AgentRuntime({
      model: faux.getModel(),
      cwd,
      tools: [createReadTool()],
      apiKey: "test",
      session
    });
    await collect(runtime.run("read it"));

    expect(SessionManager.open(session.getSessionFile()).buildContext().messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant"
    ]);
  });

  it("returns missing tool failures as tool results", async () => {
    faux = registerFauxProvider({ tokensPerSecond: 0, tokenSize: { min: 1000, max: 1000 } });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("missing", {}, { id: "call-missing" })),
      fauxAssistantMessage("handled")
    ]);
    const runtime = new AgentRuntime({
      model: faux.getModel(),
      cwd: await tempDir(),
      tools: [],
      apiKey: "test"
    });

    const events = await collect(runtime.run("use missing"));
    const result = events.find((event) => event.type === "tool_result");
    expect(result).toMatchObject({ type: "tool_result", result: { isError: true } });
  });

  it("stops at maxIterations", async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, "note.txt"), "loop", "utf8");
    faux = registerFauxProvider({ tokensPerSecond: 0, tokenSize: { min: 1000, max: 1000 } });
    faux.setResponses([fauxAssistantMessage(fauxToolCall("read", { path: "note.txt" }, { id: "call-read" }))]);

    const runtime = new AgentRuntime({
      model: faux.getModel(),
      cwd,
      tools: [createReadTool()],
      apiKey: "test"
    });

    const events = await collect(runtime.run("loop", { maxIterations: 1 }));
    expect(events.at(-1)).toMatchObject({ type: "turn_end", reason: "max_iterations", iterations: 1 });
    expect(events.filter((event) => event.type === "iteration_start")).toEqual([
      expect.objectContaining({ type: "iteration_start", iteration: 1, reason: "initial" })
    ]);
  });

  it("does not apply a default maxIterations limit", async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, "note.txt"), "loop", "utf8");
    faux = registerFauxProvider({ tokensPerSecond: 0, tokenSize: { min: 1000, max: 1000 } });
    faux.setResponses([
      ...Array.from({ length: 13 }, (_, index) =>
        fauxAssistantMessage(fauxToolCall("read", { path: "note.txt" }, { id: `call-read-${index}` }))
      ),
      fauxAssistantMessage("done")
    ]);

    const runtime = new AgentRuntime({
      model: faux.getModel(),
      cwd,
      tools: [createReadTool()],
      apiKey: "test"
    });

    const events = await collect(runtime.run("loop"));
    expect(events.at(-1)).toMatchObject({ type: "turn_end", reason: "stop", iterations: 14 });
  });

  it("stops after terminating tool results", async () => {
    faux = registerFauxProvider({ tokensPerSecond: 0, tokenSize: { min: 1000, max: 1000 } });
    faux.setResponses([fauxAssistantMessage(fauxToolCall("finish", {}, { id: "call-finish" }))]);
    const terminatingTool: ToolRuntime = {
      definition: {
        name: "finish",
        description: "Return a final tool result.",
        parameters: Type.Object({})
      },
      async execute(call) {
        return {
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: "finished" }],
          isError: false,
          timestamp: Date.now(),
          terminate: true
        };
      }
    };

    const runtime = new AgentRuntime({
      model: faux.getModel(),
      cwd: await tempDir(),
      tools: [terminatingTool],
      apiKey: "test"
    });

    const events = await collect(runtime.run("finish"));
    expect(events.at(-1)).toMatchObject({ type: "turn_end", reason: "stop", iterations: 1 });
    expect(runtime.messages().map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
    expect(runtime.messages().at(-1)).not.toHaveProperty("terminate");
  });

  it("marks an already-aborted run as aborted", async () => {
    faux = registerFauxProvider({ tokensPerSecond: 0 });
    faux.setResponses([fauxAssistantMessage("this will not stream")]);
    const runtime = new AgentRuntime({
      model: faux.getModel(),
      cwd: await tempDir(),
      tools: [],
      apiKey: "test"
    });
    const controller = new AbortController();
    controller.abort();

    const events = await collect(runtime.run("hi", { signal: controller.signal }));
    expect(events.at(-1)).toMatchObject({ type: "turn_end", reason: "aborted" });
    expect(events.some((event) => event.type === "error")).toBe(false);
  });
});
