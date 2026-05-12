import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const DEFAULT_MAX_BYTES = 16 * 1024;
const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_ENTRIES_PER_DIR = 20;

const NOISY_DIR_NAMES = new Set([
  ".git",
  ".next",
  ".pytest_cache",
  ".ruff_cache",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target"
]);

export interface StartupContextConfig {
  enabled?: boolean | undefined;
  maxBytes?: number | undefined;
  maxDepth?: number | undefined;
  maxEntriesPerDirectory?: number | undefined;
}

export function buildStartupContext(cwd: string, config: StartupContextConfig | false | undefined): string | undefined {
  if (config === false || config?.enabled === false) return undefined;

  const resolvedCwd = resolve(cwd);
  const maxDepth = finitePositive(config?.maxDepth, DEFAULT_MAX_DEPTH);
  const maxEntriesPerDirectory = finitePositive(config?.maxEntriesPerDirectory, DEFAULT_MAX_ENTRIES_PER_DIR);
  const maxBytes = finitePositive(config?.maxBytes, DEFAULT_MAX_BYTES);
  const projectRoot = findNearestAncestor(resolvedCwd, ".git") ?? findNearestAncestor(resolvedCwd, "package.json");

  const lines = [
    "Startup context from Argon.",
    "This is bounded background context about the current workspace. It may be incomplete or stale; use it to orient exploration, not as proof.",
    "",
    `Current working directory: ${resolvedCwd}`,
    `Working directory name: ${basename(resolvedCwd)}`
  ];

  if (projectRoot) {
    lines.push(`Project root: ${projectRoot}`);
    lines.push(`Project name: ${basename(projectRoot)}`);
  }

  const cwdTree = renderTree(resolvedCwd, maxDepth, maxEntriesPerDirectory);
  if (cwdTree.length > 0) {
    lines.push("", "Working directory tree:", ...cwdTree);
  }

  if (projectRoot && projectRoot !== resolvedCwd) {
    const projectTree = renderTree(projectRoot, maxDepth, maxEntriesPerDirectory);
    if (projectTree.length > 0) {
      lines.push("", "Project root tree:", ...projectTree);
    }
  }

  return truncateUtf8(lines.join("\n"), maxBytes);
}

function findNearestAncestor(start: string, marker: string): string | undefined {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, marker))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function renderTree(root: string, maxDepth: number, maxEntriesPerDirectory: number): string[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];

  const lines: string[] = [];
  collectTreeLines(root, 0, maxDepth, maxEntriesPerDirectory, lines);
  return lines;
}

function collectTreeLines(
  dir: string,
  depth: number,
  maxDepth: number,
  maxEntriesPerDirectory: number,
  lines: string[]
): void {
  if (depth >= maxDepth) return;

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => !NOISY_DIR_NAMES.has(entry.name))
      .sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
        return left.name.localeCompare(right.name);
      });
  } catch {
    return;
  }

  const visible = entries.slice(0, maxEntriesPerDirectory);
  for (const entry of visible) {
    const indent = "  ".repeat(depth);
    const suffix = entry.isDirectory() ? "/" : "";
    lines.push(`${indent}- ${entry.name}${suffix}`);
    if (entry.isDirectory()) {
      collectTreeLines(join(dir, entry.name), depth + 1, maxDepth, maxEntriesPerDirectory, lines);
    }
  }

  if (entries.length > visible.length) {
    lines.push(`${"  ".repeat(depth)}- ... ${entries.length - visible.length} more entries`);
  }
}

function finitePositive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return text;

  const clipped = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8").trimEnd();
  return `${clipped}\n\n[truncated ${bytes - maxBytes} bytes]`;
}
