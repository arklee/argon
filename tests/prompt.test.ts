import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { PromptManager, createReadTool, createBashTool } from "../src/index.js";

async function tempDir(): Promise<string> {
  const dir = join(tmpdir(), `argon-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("PromptManager", () => {
  it("includes cwd, date, and enabled tool guidelines", async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, "index.ts"), "export {}", "utf8");
    const prompt = new PromptManager().buildSystemPrompt({
      cwd,
      tools: [createReadTool()],
      config: { now: new Date("2026-05-10T00:00:00Z") }
    });

    expect(prompt).toContain("Current working directory");
    expect(prompt).toContain(cwd);
    expect(prompt).toContain("2026-05-10");
    expect(prompt).toContain("# Startup Context");
    expect(prompt).toContain("Working directory tree");
    expect(prompt).toContain("index.ts");
    expect(prompt).toContain("- read:");
    expect(prompt).not.toContain("- bash:");
  });

  it("can disable startup context injection", async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, "index.ts"), "export {}", "utf8");
    const prompt = new PromptManager().buildSystemPrompt({
      cwd,
      tools: [],
      config: { startupContext: false }
    });

    expect(prompt).not.toContain("# Startup Context");
    expect(prompt).not.toContain("index.ts");
  });

  it("includes Codex-lite default behavior guidance", async () => {
    const cwd = await tempDir();
    const prompt = new PromptManager().buildSystemPrompt({
      cwd,
      tools: []
    });

    expect(prompt).toContain("precise, safe, and helpful coding agent");
    expect(prompt).toContain("Preserve user changes and unrelated local work");
    expect(prompt).toContain("Keep changes scoped to the request");
    expect(prompt).toContain("do not claim a change was verified unless a check actually ran");
    expect(prompt).toContain("verification status");
  });

  it("includes Codex-style preamble and progress guidance", async () => {
    const cwd = await tempDir();
    const prompt = new PromptManager().buildSystemPrompt({
      cwd,
      tools: []
    });

    expect(prompt).toContain("# Preamble and Progress Updates");
    expect(prompt).toContain("Before non-trivial or grouped tool calls, send a brief user-visible preamble");
    expect(prompt).toContain("Group related actions into one preamble");
    expect(prompt).toContain("For later tool calls in the same turn, connect the dots");
    expect(prompt).toContain("Skip preambles for trivial single-file reads");
    expect(prompt.indexOf("# Coding Behavior")).toBeLessThan(prompt.indexOf("# Preamble and Progress Updates"));
    expect(prompt.indexOf("# Preamble and Progress Updates")).toBeLessThan(prompt.indexOf("# Environment Context"));
  });

  it("orders AGENTS.md files from project root to cwd", async () => {
    const root = await tempDir();
    await mkdir(join(root, ".git"));
    await mkdir(join(root, "packages", "app"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "root instructions", "utf8");
    await writeFile(join(root, "packages", "AGENTS.md"), "package instructions", "utf8");
    await writeFile(join(root, "packages", "app", "AGENTS.md"), "app instructions", "utf8");

    const prompt = new PromptManager().buildSystemPrompt({
      cwd: join(root, "packages", "app"),
      tools: [createBashTool()]
    });

    expect(prompt.indexOf("root instructions")).toBeLessThan(prompt.indexOf("package instructions"));
    expect(prompt.indexOf("package instructions")).toBeLessThan(prompt.indexOf("app instructions"));
  });

  it("describes AGENTS.md precedence near project instructions", async () => {
    const root = await tempDir();
    await mkdir(join(root, ".git"));
    await writeFile(join(root, "AGENTS.md"), "root instructions", "utf8");

    const prompt = new PromptManager().buildSystemPrompt({
      cwd: root,
      tools: []
    });

    expect(prompt).toContain("AGENTS.md files included below are ordered from repository root to the active cwd");
    expect(prompt).toContain("More specific nested AGENTS.md instructions take precedence");
    expect(prompt).toContain("Direct system, developer, and user instructions outrank project instructions");
    expect(prompt.indexOf("AGENTS.md files included below")).toBeLessThan(prompt.indexOf("root instructions"));
  });
});
