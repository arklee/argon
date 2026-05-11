import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  SessionManager,
  encodeSessionCwd,
  findMostRecentSession,
  loadSessionRecords,
  parseSessionRecords,
  resolveSessionPath,
  type AgentMessage,
  type TurnContext
} from "../src/index.js";

async function tempDir(prefix = "argon-session"): Promise<string> {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function userMessage(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() };
}

function assistantMessage(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
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
  };
}

function turnContext(cwd: string): TurnContext {
  return {
    turnId: "turn-test",
    cwd,
    model: { provider: "openai", id: "gpt-test" } as TurnContext["model"],
    systemPrompt: "",
    startedAt: Date.now(),
    availableTools: [],
    messageCount: 0
  };
}

describe("SessionManager", () => {
  it("encodes cwd paths into stable session directories", () => {
    expect(encodeSessionCwd("/tmp/my/project")).toBe("--tmp-my-project--");
  });

  it("parses JSONL records and skips malformed lines", () => {
    const records = parseSessionRecords('{"type":"session","version":1,"id":"s","cwd":"/tmp","createdAt":"now"}\nnot-json\n');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ type: "session", id: "s" });
  });

  it("rejects files without a valid session header", async () => {
    const dir = await tempDir();
    const file = join(dir, "bad.jsonl");
    await writeFile(file, '{"type":"message"}\n', "utf8");
    expect(loadSessionRecords(file)).toEqual([]);
  });

  it("appends records and rebuilds linear context", async () => {
    const cwd = await tempDir();
    const sessionDir = join(cwd, ".sessions");
    const session = SessionManager.create(cwd, sessionDir);
    session.appendModelChange("openai", "gpt-test");
    session.appendMessage(userMessage("hello"));
    session.appendMessage(assistantMessage("hi"));

    const reopened = SessionManager.open(session.getSessionFile(), sessionDir);
    expect(reopened.buildContext().messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(reopened.buildContext().model).toEqual({ provider: "openai", modelId: "gpt-test" });
    expect(await readFile(session.getSessionFile(), "utf8")).toContain('"type":"message"');
  });

  it("records and restores explicit off thinking level", async () => {
    const cwd = await tempDir();
    const sessionDir = join(cwd, ".sessions");
    const session = SessionManager.create(cwd, sessionDir);

    session.appendTurnContext(turnContext(cwd), "off");
    session.appendMessage(userMessage("hello"));

    const reopened = SessionManager.open(session.getSessionFile(), sessionDir);
    expect(reopened.buildContext().reasoning).toBe("off");
    expect(await readFile(session.getSessionFile(), "utf8")).toContain('"reasoning":"off"');
  });

  it("does not materialize a file until the first entry is appended", async () => {
    const cwd = await tempDir();
    const sessionDir = join(cwd, ".sessions");
    const session = SessionManager.create(cwd, sessionDir);

    expect(existsSync(session.getSessionFile())).toBe(false);
    expect(SessionManager.list(cwd, sessionDir)).toEqual([]);

    session.appendMessage(userMessage("hello"));
    expect(existsSync(session.getSessionFile())).toBe(true);
    expect(SessionManager.list(cwd, sessionDir)).toHaveLength(1);
  });

  it("supports branch selection with parentId tree reconstruction", async () => {
    const cwd = await tempDir();
    const session = SessionManager.create(cwd, join(cwd, ".sessions"));
    const rootUser = session.appendMessage(userMessage("root"));
    session.appendMessage(assistantMessage("first path"));
    session.branchTo(rootUser, "try another path");
    session.appendMessage(userMessage("branch prompt"));

    expect(session.buildContext().messages.map((message) => (message.role === "user" ? message.content : ""))).toEqual([
      "root",
      "branch prompt"
    ]);
    expect(session.tree().some((row) => row.entry.type === "branch" && row.depth > 0)).toBe(true);
  });

  it("rebuilds context from latest compaction summary and kept messages", async () => {
    const cwd = await tempDir();
    const session = SessionManager.create(cwd, join(cwd, ".sessions"));
    const old = session.appendMessage(userMessage("old request"));
    session.appendMessage(assistantMessage("old answer"));
    const kept = session.appendMessage(userMessage("recent request"));
    session.appendMessage(assistantMessage("recent answer"));
    session.appendCompaction("summary of old work", kept, 1000, "manual");
    session.appendMessage(userMessage("after compact"));

    expect(old).toBeTruthy();
    const reopened = SessionManager.open(session.getSessionFile());
    const context = reopened.buildContext().messages;
    expect(context.map((message) => message.role)).toEqual(["user", "user", "assistant", "user"]);
    expect(context[0]?.role === "user" ? context[0].content : "").toContain("summary of old work");
    expect(context[1]?.role === "user" ? context[1].content : "").toBe("recent request");
    expect(context[3]?.role === "user" ? context[3].content : "").toBe("after compact");
  });

  it("finds recent sessions and resolves id prefixes", async () => {
    const cwd = await tempDir();
    const sessionDir = join(cwd, ".sessions");
    const session = SessionManager.create(cwd, sessionDir);
    session.appendMessage(userMessage("hello"));
    expect(findMostRecentSession(sessionDir)).toBe(session.getSessionFile());
    expect(resolveSessionPath(cwd, session.getSessionId().slice(0, 8), sessionDir)).toBe(session.getSessionFile());
  });
});
