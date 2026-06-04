import { describe, expect, it } from "vitest";
import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { renderExplorationToolGroupStatus, renderToolStatus, stripAnsi } from "../src/tui/events.js";

describe("TUI tool status rendering", () => {
  it("renders read calls as Codex-style exploration entries", () => {
    const call = toolCall("read", { path: "src/index.ts" });

    expect(plain(renderToolStatus(call, undefined, false))).toBe(" • Exploring\n   └ Read src/index.ts");
    expect(plain(renderToolStatus(call, toolResult(call, "one\ntwo"), false))).toBe(
      " • Explored\n   └ Read src/index.ts - 2 lines"
    );
  });

  it("groups consecutive exploration tools under one header", () => {
    const list = toolCall("ls", { path: "src" });
    const read = toolCall("read", { path: "package.json" });

    expect(
      plain(
        renderExplorationToolGroupStatus(
          [
            { toolCall: list, result: toolResult(list, "file app.ts\nfile events.ts") },
            { toolCall: read, result: toolResult(read, "{\n  \"name\": \"argon\"\n}") }
          ],
          false
        )
      )
    ).toBe(" • Explored\n   └ List src - 2 entries\n     Read package.json - 3 lines");
  });

  it("renders shell commands with run state and compact output", () => {
    const call = toolCall("bash", { command: "npm test" });

    expect(plain(renderToolStatus(call, undefined, false))).toBe(" • Running npm test");
    expect(plain(renderToolStatus(call, toolResult(call, "Exit code: 0\nSignal: none\nTimed out: no"), false))).toBe(
      " • Ran npm test\n   └ (no output)"
    );
  });

  it("summarizes grep no-match results without treating them as failures", () => {
    const call = toolCall("grep", { pattern: "renderToolStatus", path: "src" });
    const result = toolResult(call, "Exit code: 1\nSignal: none\nTimed out: no");

    expect(plain(renderToolStatus(call, result, false))).toBe(
      " • Explored\n   └ Search renderToolStatus in src - no matches"
    );
  });

  it("renders MCP tools as server.tool JSON invocations", () => {
    const call = toolCall("mcp__search__find_docs", { query: "ratatui styling", limit: 3 });

    expect(plain(renderToolStatus(call, toolResult(call, "Found styling guidance in styles.md"), false))).toBe(
      " • Called search.find_docs({\"query\":\"ratatui styling\",\"limit\":3})\n   └ Found styling guidance in styles.md"
    );
  });
});

function plain(text: string): string {
  return stripAnsi(text);
}

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return {
    type: "toolCall",
    id: `${name}-call`,
    name,
    arguments: args
  };
}

function toolResult(call: ToolCall, text: string, isError = false): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text }],
    isError,
    timestamp: 1
  };
}
