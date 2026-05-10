export { createBashTool } from "./bash.js";
export { createEditTool } from "./edit.js";
export { createGrepTool } from "./grep.js";
export { createLsTool } from "./ls.js";
export { createReadTool } from "./read.js";
export { ToolRegistry } from "./registry.js";
export { createWriteTool } from "./write.js";

import type { ToolRuntime } from "../types.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createGrepTool } from "./grep.js";
import { createLsTool } from "./ls.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";

export function createDefaultTools(_cwd: string): ToolRuntime[] {
  return [
    createReadTool(),
    createWriteTool(),
    createEditTool(),
    createLsTool(),
    createGrepTool(),
    createBashTool()
  ];
}
