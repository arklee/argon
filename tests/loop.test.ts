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
    expect(runtime.messages().map((message) => message.role)).toEqual(["user", "assistant"]);
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
    expect(runtime.messages().map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant"
    ]);
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
  });
});
