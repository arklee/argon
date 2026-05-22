import type { SkillMetadata } from "./model.js";

const DEFAULT_SKILLS_PROMPT_BYTES = 8_000;

export function renderAvailableSkills(skills: readonly SkillMetadata[], maxBytes = DEFAULT_SKILLS_PROMPT_BYTES): string | undefined {
  if (skills.length === 0 || maxBytes <= 0) return undefined;

  const lines = [
    "# Skills",
    "A skill is a set of local instructions stored in a `SKILL.md` file. Available skills are listed below with name, description, and path. Use a skill when the user names it with `$skill-name` or when the task clearly matches its description.",
    "",
    "## Available Skills"
  ];

  let omitted = 0;
  for (const skill of skills) {
    const line = `- ${skill.name}: ${skill.description} (${skill.path})`;
    const next = [...lines, line].join("\n");
    if (Buffer.byteLength(next, "utf8") > maxBytes) {
      omitted++;
      continue;
    }
    lines.push(line);
  }

  if (omitted > 0) {
    lines.push(`- ${omitted} additional skill${omitted === 1 ? " was" : "s were"} omitted from this list because the skills prompt budget was exceeded.`);
  }

  lines.push(
    "",
    "## How To Use Skills",
    "- After selecting a skill, read its `SKILL.md` before following it unless the full skill was already injected in this turn.",
    "- Resolve relative references such as `scripts/foo.js`, `references/bar.md`, or `assets/file` from the directory containing that skill's `SKILL.md`.",
    "- Load only the referenced files needed for the task."
  );

  return lines.join("\n");
}
