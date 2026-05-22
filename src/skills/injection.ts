import type { TextContent } from "@earendil-works/pi-ai";
import type { UserInput } from "../types.js";
import { loadSkillContents } from "./loader.js";
import type { SkillInjection, SkillMetadata } from "./model.js";

export interface SkillInjectionResult {
  input: UserInput;
  injections: SkillInjection[];
}

export function injectMentionedSkills(input: UserInput | undefined, skills: readonly SkillMetadata[]): SkillInjectionResult {
  if (input === undefined || skills.length === 0) return { input: input ?? "", injections: [] };
  const text = userInputText(input);
  const mentioned = collectMentionedSkills(text, skills);
  if (mentioned.length === 0) return { input, injections: [] };

  const injections: SkillInjection[] = [];
  const blocks: string[] = [];
  for (const skill of mentioned) {
    const contents = loadSkillContents(skill.path);
    injections.push({ name: skill.name, path: skill.path, contents });
    blocks.push(`<skill>\n<name>${escapeXml(skill.name)}</name>\n<path>${escapeXml(skill.path)}</path>\n${contents.trim()}\n</skill>`);
  }

  const injectionText = blocks.join("\n\n");
  if (typeof input === "string") {
    return { input: `${injectionText}\n\n${input}`, injections };
  }

  if (typeof input.content === "string") {
    return { input: { content: `${injectionText}\n\n${input.content}` }, injections };
  }

  const content: TextContent[] = [{ type: "text", text: injectionText }];
  return { input: { content: [...content, ...input.content] }, injections };
}

function collectMentionedSkills(text: string, skills: readonly SkillMetadata[]): SkillMetadata[] {
  const mentions = extractMentions(text);
  const selected: SkillMetadata[] = [];
  const seen = new Set<string>();
  for (const skill of skills) {
    if (!mentions.has(skill.name) || seen.has(skill.path)) continue;
    selected.push(skill);
    seen.add(skill.path);
  }
  return selected;
}

function extractMentions(text: string): Set<string> {
  const mentions = new Set<string>();
  const regex = /\$([A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)?)/g;
  for (const match of text.matchAll(regex)) {
    if (match[1]) mentions.add(match[1]);
  }
  return mentions;
}

function userInputText(input: UserInput): string {
  if (typeof input === "string") return input;
  if (typeof input.content === "string") return input.content;
  return input.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
