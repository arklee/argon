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
    const prompt = new PromptManager().buildSystemPrompt({
      cwd,
      tools: [createReadTool()],
      config: { now: new Date("2026-05-10T00:00:00Z") }
    });

    expect(prompt).toContain("Current working directory");
    expect(prompt).toContain(cwd);
    expect(prompt).toContain("2026-05-10");
    expect(prompt).toContain("- read:");
    expect(prompt).not.toContain("- bash:");
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
});
