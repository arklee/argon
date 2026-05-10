import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { platform } from "node:os";
import type { PromptBuildInput, PromptConfig, ToolRuntime } from "../types.js";

const DEFAULT_MAX_PROJECT_INSTRUCTIONS_BYTES = 64 * 1024;

const DEFAULT_BASE = `You are Argon, a coding agent running in a local workspace. You help users inspect code, run commands, edit files, and explain changes. Work from the actual project state, prefer small focused changes, and keep responses concise.`;

const DEFAULT_BEHAVIOR_RULES = [
  "Read relevant files before changing behavior.",
  "Prefer existing project patterns over new abstractions.",
  "Use precise file paths when discussing code.",
  "When using shell commands for search, prefer rg when available.",
  "Do not claim a change was verified unless a check actually ran."
];

export class PromptManager {
  buildSystemPrompt(input: PromptBuildInput): string {
    const config = input.config ?? {};
    const cwd = resolve(input.cwd);
    const sections: string[] = [];

    sections.push(config.baseInstructions?.trim() || DEFAULT_BASE);
    sections.push(this.renderBehaviorRules(config));

    const toolSection = this.renderToolGuidelines(input.tools);
    if (toolSection) sections.push(toolSection);

    const projectInstructions = this.renderProjectInstructions(cwd, config);
    if (projectInstructions) sections.push(projectInstructions);

    sections.push(this.renderEnvironmentContext(cwd, config.now ?? new Date()));

    return sections.filter(Boolean).join("\n\n");
  }

  private renderBehaviorRules(config: PromptConfig): string {
    const rules = [...DEFAULT_BEHAVIOR_RULES, ...(config.behaviorRules ?? [])]
      .map((rule) => rule.trim())
      .filter((rule, index, all) => rule.length > 0 && all.indexOf(rule) === index);

    return ["# Coding Behavior", ...rules.map((rule) => `- ${rule}`)].join("\n");
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
        agents
          .map((entry) => `## ${entry.label}\n\n${entry.content}`)
          .join("\n\n--- project-doc ---\n\n")
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
