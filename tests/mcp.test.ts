import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { McpConnectionManager } from "../src/index.js";

async function tempDir(): Promise<string> {
  const dir = join(tmpdir(), `argon-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeMcpServer(dir: string): Promise<string> {
  const path = join(dir, "server.mjs");
  await writeFile(
    path,
    `
import readline from "node:readline";

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (!("id" in message)) return;
  if (message.method === "initialize") {
    respond(message.id, { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake" } });
  } else if (message.method === "tools/list") {
    respond(message.id, {
      tools: [{
        name: "echo",
        description: "Echo a message",
        inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] }
      }]
    });
  } else if (message.method === "tools/call") {
    respond(message.id, { content: [{ type: "text", text: "echo:" + message.params.arguments.message }] });
  } else {
    respond(message.id, {});
  }
});
`,
    "utf8"
  );
  return path;
}

describe("McpConnectionManager", () => {
  it("connects to a stdio MCP server and exposes its tools as ToolRuntime instances", async () => {
    const dir = await tempDir();
    const serverPath = await writeMcpServer(dir);
    const manager = new McpConnectionManager({
      servers: {
        fake: {
          command: process.execPath,
          args: [serverPath],
          startupTimeoutMs: 2_000,
          toolTimeoutMs: 2_000
        }
      }
    });

    try {
      const startup = await manager.ensureConnected();
      expect(startup.events).toEqual([
        { type: "mcp_server_status", server: "fake", status: "starting" },
        { type: "mcp_server_status", server: "fake", status: "ready" }
      ]);
      expect(startup.tools.map((tool) => tool.definition.name)).toEqual(["mcp__fake__echo"]);

      const result = await startup.tools[0]!.execute(
        { type: "toolCall", id: "call-1", name: "mcp__fake__echo", arguments: { message: "hello" } },
        {
          cwd: dir,
          turn: {
            turnId: "turn",
            cwd: dir,
            model: {} as any,
            systemPrompt: "",
            startedAt: Date.now(),
            availableTools: [],
            messageCount: 0
          },
          messages: []
        }
      );
      expect(result).toMatchObject({
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "mcp__fake__echo",
        content: [{ type: "text", text: "echo:hello" }],
        isError: false
      });
    } finally {
      manager.shutdown();
    }
  });
});
