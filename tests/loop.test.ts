import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
  type FauxProviderRegistration
} from "@mariozechner/pi-ai";
import { AgentRuntime, createReadTool, type AgentEvent } from "../src/index.js";

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
