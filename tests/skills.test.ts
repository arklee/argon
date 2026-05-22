import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { PromptManager, SkillManager, createReadTool, loadSkills } from "../src/index.js";

async function tempDir(): Promise<string> {
  const dir = join(tmpdir(), `argon-skills-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeSkill(root: string, name: string, description: string, body: string): Promise<string> {
  const dir = join(root, ".agents", "skills", name);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  await writeFile(path, `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`, "utf8");
  return path;
}

describe("skills", () => {
  it("discovers repo skills and renders them in the system prompt", async () => {
    const cwd = await tempDir();
    await mkdir(join(cwd, ".git"));
    const skillPath = await writeSkill(cwd, "review-helper", "Use when reviewing code changes.", "# Review Helper");

    const outcome = loadSkills(cwd, undefined);
    expect(outcome.errors).toEqual([]);
    expect(outcome.skills).toEqual([
      expect.objectContaining({
        name: "review-helper",
        description: "Use when reviewing code changes.",
        path: skillPath,
        scope: "repo"
      })
    ]);

    const prompt = new PromptManager().buildSystemPrompt({
      cwd,
      tools: [createReadTool()],
      skills: outcome.skills
    });
    expect(prompt).toContain("# Skills");
    expect(prompt).toContain("review-helper");
    expect(prompt).toContain(skillPath);
  });

  it("injects explicitly mentioned skill contents into user input", async () => {
    const cwd = await tempDir();
    await mkdir(join(cwd, ".git"));
    await writeSkill(cwd, "review-helper", "Use when reviewing code changes.", "# Review Helper\nFollow the review checklist.");
    const manager = new SkillManager(cwd, undefined);
    manager.load();

    const result = manager.inject("Use $review-helper on this diff");

    expect(result.injections).toHaveLength(1);
    expect(typeof result.input === "string" ? result.input : "").toContain("<skill>");
    expect(typeof result.input === "string" ? result.input : "").toContain("Follow the review checklist.");
    expect(typeof result.input === "string" ? result.input : "").toContain("Use $review-helper on this diff");
  });
});
