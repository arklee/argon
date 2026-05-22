import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { getArgonHome } from "../session/manager.js";
import type { SkillLoadOutcome, SkillMetadata, SkillRuntimeConfig, SkillScope } from "./model.js";

const SKILL_FILENAME = "SKILL.md";
const MAX_SCAN_DEPTH = 6;
const MAX_SKILL_DIRS_PER_ROOT = 2000;

interface SkillRoot {
  path: string;
  scope: SkillScope;
}

export function loadSkills(cwd: string, config: SkillRuntimeConfig | undefined): SkillLoadOutcome {
  if (config?.enabled === false) return { skills: [], errors: [] };
  const disabled = new Set(config?.disabled ?? []);
  const roots = skillRoots(cwd, config);
  const skills: SkillMetadata[] = [];
  const errors: SkillLoadOutcome["errors"] = [];
  const seenPaths = new Set<string>();
  const seenNames = new Set<string>();

  for (const root of roots) {
    const outcome = loadSkillsFromRoot(root);
    errors.push(...outcome.errors);
    for (const skill of outcome.skills) {
      if (disabled.has(skill.name) || disabled.has(skill.path)) continue;
      if (seenPaths.has(skill.path) || seenNames.has(skill.name)) continue;
      seenPaths.add(skill.path);
      seenNames.add(skill.name);
      skills.push(skill);
    }
  }

  return { skills, errors };
}

export function loadSkillContents(path: string): string {
  return readFileSync(path, "utf8");
}

function skillRoots(cwd: string, config: SkillRuntimeConfig | undefined): SkillRoot[] {
  const roots: SkillRoot[] = [];
  const resolvedCwd = resolve(cwd);
  const projectRoot = findProjectRoot(resolvedCwd);

  for (const dir of dirsBetween(projectRoot, resolvedCwd)) {
    roots.push({ path: join(dir, ".agents", "skills"), scope: "repo" });
  }

  roots.push({ path: join(getArgonHome(), "skills"), scope: "user" });
  roots.push({ path: join(homedir(), ".agents", "skills"), scope: "user" });

  for (const root of config?.roots ?? []) {
    roots.push({ path: isAbsolute(root) ? root : resolve(resolvedCwd, root), scope: "user" });
  }

  const seen = new Set<string>();
  return roots
    .map((root) => ({ ...root, path: resolve(root.path) }))
    .filter((root) => {
      if (seen.has(root.path)) return false;
      seen.add(root.path);
      return true;
    });
}

function loadSkillsFromRoot(root: SkillRoot): SkillLoadOutcome {
  const skills: SkillMetadata[] = [];
  const errors: SkillLoadOutcome["errors"] = [];
  if (!existsSync(root.path)) return { skills, errors };
  if (!statSync(root.path).isDirectory()) return { skills, errors };

  const queue: Array<{ dir: string; depth: number }> = [{ dir: root.path, depth: 0 }];
  const visited = new Set<string>([root.path]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(current.dir, { withFileTypes: true });
    } catch (error) {
      errors.push({ path: current.dir, message: error instanceof Error ? error.message : String(error) });
      continue;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = join(current.dir, entry.name);
      if (entry.isFile() && entry.name === SKILL_FILENAME) {
        try {
          skills.push(parseSkillFile(fullPath, root.scope));
        } catch (error) {
          errors.push({ path: fullPath, message: error instanceof Error ? error.message : String(error) });
        }
        continue;
      }

      if (!entry.isDirectory() || current.depth >= MAX_SCAN_DEPTH || visited.size >= MAX_SKILL_DIRS_PER_ROOT) continue;
      const resolved = resolve(fullPath);
      if (visited.has(resolved)) continue;
      visited.add(resolved);
      queue.push({ dir: resolved, depth: current.depth + 1 });
    }
  }

  return { skills, errors };
}

function parseSkillFile(path: string, scope: SkillScope): SkillMetadata {
  const contents = readFileSync(path, "utf8");
  const frontmatter = extractFrontmatter(contents);
  if (!frontmatter) throw new Error("missing YAML frontmatter delimited by ---");
  const parsed = parseSimpleYaml(frontmatter);
  const name = sanitizeSingleLine(parsed.name ?? basename(dirname(path)));
  const description = sanitizeSingleLine(parsed.description ?? "");
  if (!name) throw new Error("missing field `name`");
  if (!description) throw new Error("missing field `description`");
  if (name.length > 64) throw new Error("name exceeds maximum length of 64 characters");
  if (description.length > 1024) throw new Error("description exceeds maximum length of 1024 characters");
  return { name, description, path: resolve(path), scope };
}

function extractFrontmatter(contents: string): string | undefined {
  if (!contents.startsWith("---\n")) return undefined;
  const end = contents.indexOf("\n---", 4);
  if (end === -1) return undefined;
  return contents.slice(4, end).trim();
}

function parseSimpleYaml(contents: string): Record<string, string> {
  const record: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    record[key] = unquote(value);
  }
  return record;
}

function unquote(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function sanitizeSingleLine(value: string): string {
  return value.split(/\s+/).filter(Boolean).join(" ");
}

function findProjectRoot(cwd: string): string {
  let current = resolve(cwd);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return cwd;
    current = parent;
  }
}

function dirsBetween(root: string, cwd: string): string[] {
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
