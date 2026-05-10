import type { AgentMessage } from "../types.js";

export class Transcript {
  private readonly entries: AgentMessage[];

  constructor(initialMessages: AgentMessage[] = []) {
    this.entries = [...initialMessages];
  }

  get messages(): AgentMessage[] {
    return this.entries;
  }

  replace(messages: AgentMessage[]): void {
    this.entries.length = 0;
    this.entries.push(...messages);
  }

  snapshot(): AgentMessage[] {
    return structuredClone(this.entries);
  }
}
