import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai";
import {
  ARGON_RPC_ERROR,
  AgentRuntime,
  ArgonRpcClient,
  ArgonRpcServer,
  AuthStorage,
  ModelRegistry,
  SessionManager,
  type ArgonRpcNotification
} from "../src/index.js";

async function tempDir(prefix = "argon-rpc"): Promise<string> {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function startHarness(
  runtime: AgentRuntime,
  options: { cwd: string; sessionDir?: string; modelRegistry?: ModelRegistry }
): {
  client: ArgonRpcClient;
  notifications: ArgonRpcNotification[];
  stop: () => Promise<void>;
} {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const server = new ArgonRpcServer({
    runtime,
    cwd: options.cwd,
    ...(options.sessionDir ? { sessionDir: options.sessionDir } : {}),
    ...(options.modelRegistry ? { modelRegistry: options.modelRegistry } : {})
  });
  const done = server.serve(toServer, fromServer);
  const client = new ArgonRpcClient({ input: fromServer, output: toServer });
  const notifications: ArgonRpcNotification[] = [];
  client.onNotification((notification) => notifications.push(notification));
  client.start();

  return {
    client,
    notifications,
    stop: async () => {
      toServer.end();
      await done;
      fromServer.end();
    }
  };
}

function waitForNotification(
  client: ArgonRpcClient,
  predicate: (notification: ArgonRpcNotification) => boolean
): Promise<ArgonRpcNotification> {
  return new Promise((resolve) => {
    const off = client.onNotification((notification) => {
      if (!predicate(notification)) return;
      off();
      resolve(notification);
    });
  });
}

describe("Argon RPC", () => {
  let faux: FauxProviderRegistration | undefined;

  afterEach(() => {
    faux?.unregister();
    faux = undefined;
  });

  it("initializes and streams a completed turn over JSONL", async () => {
    const cwd = await tempDir();
    const sessionDir = join(cwd, ".sessions");
    const authStorage = AuthStorage.inMemory();
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    faux = registerFauxProvider({ tokensPerSecond: 0, tokenSize: { min: 1000, max: 1000 } });
    faux.setResponses([fauxAssistantMessage("hello")]);

    const runtime = new AgentRuntime({
      model: faux.getModel(),
      cwd,
      tools: [],
      apiKey: "test",
      session: SessionManager.create(cwd, sessionDir)
    });
    const harness = startHarness(runtime, { cwd, sessionDir, modelRegistry });

    const initialized = await harness.client.initialize();
    expect(initialized).toMatchObject({
      protocolVersion: 1,
      server: { name: "argon" },
      capabilities: { transport: "jsonl-stdio" },
      state: { cwd, model: { provider: faux.getModel().provider, id: faux.getModel().id } }
    });

    const completed = waitForNotification(harness.client, (notification) => notification.method === "turn/completed");
    const accepted = await harness.client.startTurn({ input: "hi" });
    expect(accepted.accepted).toBe(true);

    await expect(completed).resolves.toMatchObject({
      method: "turn/completed",
      params: { runId: accepted.runId, kind: "turn", reason: "stop" }
    });
    expect(harness.notifications.some((notification) => notification.method === "turn/event")).toBe(true);

    const messages = await harness.client.messages();
    expect(messages.messages.map((message) => message.role)).toEqual(["user", "assistant"]);

    const sessions = await harness.client.listThreads();
    expect(sessions.sessions).toHaveLength(1);

    await harness.stop();
  });

  it("rejects concurrent turn starts while the runtime is busy", async () => {
    const cwd = await tempDir();
    const assistant = fauxAssistantMessage("done");
    let release!: () => void;
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const runtime = new AgentRuntime({
      model: {
        provider: "faux",
        id: "slow",
        name: "slow",
        api: "faux",
        baseUrl: "https://example.test",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096
      },
      cwd,
      tools: [],
      apiKey: "test",
      stream: () =>
        (async function* () {
          yield { type: "start", partial: assistant };
          await new Promise<void>((resolve) => {
            release = resolve;
            markReady();
          });
          yield { type: "done", reason: "stop", message: assistant };
        })() as any
    });
    const harness = startHarness(runtime, { cwd });

    const completed = waitForNotification(harness.client, (notification) => notification.method === "turn/completed");
    await harness.client.startTurn({ input: "one" });
    await ready;
    await expect(harness.client.startTurn({ input: "two" })).rejects.toMatchObject({ code: ARGON_RPC_ERROR.busy });

    release();
    await completed;
    await harness.stop();
  });
});
