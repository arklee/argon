import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentEvent } from "../types.js";

export interface SessionEventLog {
  append(event: AgentEvent): Promise<void>;
}

export class JsonlSessionEventLog implements SessionEventLog {
  constructor(private readonly filePath: string) {}

  async append(event: AgentEvent): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify({ timestamp: Date.now(), event }, serializeError)}\n`, "utf8");
  }
}

export class MemorySessionEventLog implements SessionEventLog {
  readonly events: AgentEvent[] = [];

  async append(event: AgentEvent): Promise<void> {
    this.events.push(event);
  }
}

function serializeError(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack
    };
  }
  return value;
}
