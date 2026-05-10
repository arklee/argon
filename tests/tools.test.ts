import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  createBashTool,
  createEditTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type ToolExecutionContext,
  type TurnContext
} from "../src/index.js";

function firstText(message: { content: Array<{ type: string; text?: string }> }): string {
  const block = message.content[0];
  return block?.type === "text" ? (block.text ?? "") : "";
}

async function tempDir(): Promise<string> {
  const dir = join(tmpdir(), `argon-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { type: "toolCall", id: `call-${name}`, name, arguments: args };
}

function ctx(cwd: string): ToolExecutionContext {
  return {
    cwd,
    turn: {
      turnId: "turn-test",
      cwd,
      model: {} as TurnContext["model"],
      systemPrompt: "",
      startedAt: Date.now(),
      availableTools: [],
      messageCount: 0
    },
    messages: []
  };
}

describe("built-in tools", () => {
  it("writes, reads, edits, and lists files", async () => {
    const cwd = await tempDir();
    const write = createWriteTool();
    const read = createReadTool();
    const edit = createEditTool();
    const ls = createLsTool();

    await write.execute(call("write", { path: "a.txt", content: "hello world" }), ctx(cwd));
    const readResult = await read.execute(call("read", { path: "a.txt" }), ctx(cwd));
    expect(firstText(readResult)).toBe("hello world");

    await edit.execute(call("edit", { path: "a.txt", oldText: "world", newText: "Argon" }), ctx(cwd));
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("hello Argon");

    const lsResult = await ls.execute(call("ls", { path: "." }), ctx(cwd));
    expect(firstText(lsResult)).toContain("file a.txt");
  });

  it("fails ambiguous edits", async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, "a.txt"), "same same", "utf8");
    const edit = createEditTool();

    await expect(
      edit.execute(call("edit", { path: "a.txt", oldText: "same", newText: "new" }), ctx(cwd))
    ).rejects.toThrow("matched 2 times");
  });

  it("times out bash commands", async () => {
    const cwd = await tempDir();
    const bash = createBashTool();
    const result = await bash.execute(
      call("bash", { command: 'node -e "setTimeout(() => {}, 10000)"', timeoutMs: 50 }),
      ctx(cwd)
    );

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("Timed out: yes");
  });

  it("greps with bounded output", async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, "a.txt"), "alpha\nalpha\nalpha\n", "utf8");
    const grep = createGrepTool();
    const result = await grep.execute(call("grep", { pattern: "alpha", path: ".", maxBytes: 20 }), ctx(cwd));

    expect(firstText(result)).toContain("alpha");
    expect(firstText(result).length).toBeLessThan(200);
  });
});
