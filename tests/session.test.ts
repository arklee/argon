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
  type AgentMessage
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

  it("finds recent sessions and resolves id prefixes", async () => {
    const cwd = await tempDir();
    const sessionDir = join(cwd, ".sessions");
    const session = SessionManager.create(cwd, sessionDir);
    session.appendMessage(userMessage("hello"));
    expect(findMostRecentSession(sessionDir)).toBe(session.getSessionFile());
    expect(resolveSessionPath(cwd, session.getSessionId().slice(0, 8), sessionDir)).toBe(session.getSessionFile());
  });
});
