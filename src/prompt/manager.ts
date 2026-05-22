import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { platform } from "node:os";
import type { PromptBuildInput, PromptConfig, ToolRuntime } from "../types.js";
import { buildStartupContext } from "./startup-context.js";
import { renderAvailableSkills } from "../skills/render.js";

const DEFAULT_MAX_PROJECT_INSTRUCTIONS_BYTES = 64 * 1024;

const DEFAULT_BASE = `You are Argon, a precise, safe, and helpful coding agent running in a local workspace. Work from the actual project state, inspect code before acting, run commands when useful, edit files carefully, and explain changes clearly. Keep the core agent runtime independent from any UI surface.`;

const DEFAULT_BEHAVIOR_RULES = [
  "Read relevant files before changing behavior, especially before editing.",
  "Preserve user changes and unrelated local work; never revert or overwrite them unless explicitly asked.",
  "Avoid destructive actions such as deleting files, resetting git state, or replacing broad content unless the user clearly requested them.",
  "Keep changes scoped to the request and consistent with existing project patterns before adding new abstractions.",
  "Use precise file paths when discussing code or changes.",
  "For exploration, prefer read, ls, grep, rg, or rg --files; use bash for broader commands and workflows.",
  "When you need multiple independent file reads, searches, or directory listings, request those tool calls together so Argon can run parallel-safe tools concurrently.",
  "Update documentation when module behavior, public APIs, tool contracts, session formats, or architectural decisions change.",
  "Run focused tests or checks when appropriate, and do not claim a change was verified unless a check actually ran.",
  "Keep user-facing responses concise, with clear paths, changed behavior, and verification status."
];

const DEFAULT_PREAMBLE_RULES = [
  "Before non-trivial or grouped tool calls, send a brief user-visible preamble explaining what you are about to do.",
  "Group related actions into one preamble instead of sending a separate note for each tool call.",
  "Keep preambles concise: one or two sentences focused on immediate, tangible next steps.",
  "For later tool calls in the same turn, connect the dots with what you have learned so far and what you will do next.",
  "Skip preambles for trivial single-file reads or similarly tiny inspection steps unless they are part of a larger grouped action.",
  "For longer tasks with many tool calls or multiple phases, provide occasional concise progress updates that summarize progress and next steps."
];

const AGENTS_PRECEDENCE_GUIDANCE = [
  "AGENTS.md files included below are ordered from repository root to the active cwd.",
  "More specific nested AGENTS.md instructions take precedence over broader ones when they conflict.",
  "Direct system, developer, and user instructions outrank project instructions."
];

export class PromptManager {
  buildSystemPrompt(input: PromptBuildInput): string {
    const config = input.config ?? {};
    const cwd = resolve(input.cwd);
    const sections: string[] = [];

    sections.push(config.baseInstructions?.trim() || DEFAULT_BASE);
    sections.push(this.renderBehaviorRules(config));
    sections.push(this.renderPreambleGuidance());

    const toolSection = this.renderToolGuidelines(input.tools);
    if (toolSection) sections.push(toolSection);

    const skillsSection = renderAvailableSkills(input.skills ?? [], input.skillPromptMaxBytes);
    if (skillsSection) sections.push(skillsSection);

    const projectInstructions = this.renderProjectInstructions(cwd, config);
    if (projectInstructions) sections.push(projectInstructions);

    const startupContext = buildStartupContext(cwd, config.startupContext);
    if (startupContext) sections.push(["# Startup Context", startupContext].join("\n"));

    sections.push(this.renderEnvironmentContext(cwd, config.now ?? new Date()));

    return sections.filter(Boolean).join("\n\n");
  }

  private renderBehaviorRules(config: PromptConfig): string {
    const rules = [...DEFAULT_BEHAVIOR_RULES, ...(config.behaviorRules ?? [])]
      .map((rule) => rule.trim())
      .filter((rule, index, all) => rule.length > 0 && all.indexOf(rule) === index);

    return ["# Coding Behavior", ...rules.map((rule) => `- ${rule}`)].join("\n");
  }

  private renderPreambleGuidance(): string {
    return ["# Preamble and Progress Updates", ...DEFAULT_PREAMBLE_RULES.map((rule) => `- ${rule}`)].join("\n");
  }

  private renderToolGuidelines(tools: readonly ToolRuntime[]): string | undefined {
    if (tools.length === 0) return undefined;

    const lines = tools.map((tool) => {
      const suffix = tool.guideline ? ` ${tool.guideline}` : tool.definition.description;
      return `- ${tool.definition.name}: ${suffix}`;
    });

    return ["# Available Tools", ...lines].join("\n");
  }

  private renderProjectInstructions(cwd: string, config: PromptConfig): string | undefined {
    if (config.includeProjectInstructions === false) return undefined;

    const parts: string[] = [];
    if (config.projectInstructions?.trim()) {
      parts.push(config.projectInstructions.trim());
    }

    const maxBytes = config.maxProjectInstructionsBytes ?? DEFAULT_MAX_PROJECT_INSTRUCTIONS_BYTES;
    const agents = discoverAgentsInstructions(cwd, maxBytes);
    if (agents.length > 0) {
      parts.push(
        [
          ...AGENTS_PRECEDENCE_GUIDANCE.map((rule) => `- ${rule}`),
          "",
          agents
            .map((entry) => `## ${entry.label}\n\n${entry.content}`)
            .join("\n\n--- project-doc ---\n\n")
        ].join("\n")
      );
    }

    if (parts.length === 0) return undefined;
    return ["# Project Instructions", ...parts].join("\n\n");
  }

  private renderEnvironmentContext(cwd: string, now: Date): string {
    const packageManager = detectPackageManager(cwd);
    const lines = [
      `- Current date: ${formatDate(now)}`,
      `- Current working directory: ${cwd}`,
      `- Platform: ${platform()}`
    ];

    if (packageManager) {
      lines.push(`- Detected package manager: ${packageManager}`);
    }

    return ["# Environment Context", ...lines].join("\n");
  }
}

export interface AgentsInstruction {
  path: string;
  label: string;
  content: string;
}

export function discoverAgentsInstructions(cwd: string, maxBytes: number): AgentsInstruction[] {
  if (maxBytes <= 0) return [];

  const root = findProjectRoot(cwd);
  const chain = pathChain(root, cwd);
  const entries: AgentsInstruction[] = [];
  let remaining = maxBytes;

  for (const dir of chain) {
    const filePath = join(dir, "AGENTS.md");
    if (!existsSync(filePath) || !statSync(filePath).isFile()) continue;

    const content = readFileSync(filePath, "utf8").trim();
    if (!content) continue;

    const bytes = Buffer.byteLength(content, "utf8");
    const clipped =
      bytes <= remaining
        ? content
        : Buffer.from(content, "utf8").subarray(0, remaining).toString("utf8").trimEnd();

    if (clipped) {
      entries.push({
        path: filePath,
        label: relative(root, filePath) || basename(filePath),
        content: clipped
      });
    }

    remaining -= Math.min(bytes, remaining);
    if (remaining <= 0) break;
  }

  return entries;
}

export function findProjectRoot(cwd: string): string {
  let current = resolve(cwd);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  current = resolve(cwd);
  while (true) {
    if (existsSync(join(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
}

function pathChain(root: string, cwd: string): string[] {
  const chain: string[] = [];
  let current = resolve(cwd);
  const resolvedRoot = resolve(root);

  while (true) {
    chain.push(current);
    if (current === resolvedRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return chain.reverse();
}

function detectPackageManager(cwd: string): string | undefined {
  const root = findProjectRoot(cwd);
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))) return "bun";
  if (existsSync(join(root, "package-lock.json"))) return "npm";
  return undefined;
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
