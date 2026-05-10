import type { ToolRuntime } from "../types.js";

export class ToolRegistry {
  private readonly tools = new Map<string, ToolRuntime>();

  constructor(tools: ToolRuntime[] = []) {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  register(tool: ToolRuntime): void {
    this.tools.set(tool.definition.name, tool);
  }

  get(name: string): ToolRuntime | undefined {
    return this.tools.get(name);
  }

  list(): ToolRuntime[] {
    return [...this.tools.values()];
  }
}
