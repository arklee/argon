import type { AgentMessage, RunOptions, TurnContext } from "../types.js";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createCompactionSummaryMessage } from "../compaction/index.js";
import type { CompactionReason } from "../types.js";

export const CURRENT_SESSION_VERSION = 1;

export interface SessionHeader {
  type: "session";
  version: number;
  id: string;
  cwd: string;
  createdAt: string;
}

export interface SessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface SessionTurnContextEntry extends SessionEntryBase {
  type: "turn_context";
  cwd: string;
  provider: string;
  modelId: string;
  reasoning?: RunOptions["reasoning"];
  availableTools: string[];
  startedAt: number;
}

export interface SessionMessageEntry extends SessionEntryBase {
  type: "message";
  message: AgentMessage;
}

export interface SessionModelChangeEntry extends SessionEntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}

export interface SessionBranchEntry extends SessionEntryBase {
  type: "branch";
  targetId: string | null;
  note?: string;
}

export interface SessionCompactionEntry extends SessionEntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  reason: CompactionReason;
}

export type SessionEntry =
  | SessionTurnContextEntry
  | SessionMessageEntry
  | SessionModelChangeEntry
  | SessionBranchEntry
  | SessionCompactionEntry;

export type SessionRecord = SessionHeader | SessionEntry;

export interface SessionContext {
  messages: AgentMessage[];
  model: { provider: string; modelId: string } | null;
  reasoning: RunOptions["reasoning"] | undefined;
}

export interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
}

export interface SessionTreeNode {
  entry: SessionEntry;
  depth: number;
  current: boolean;
  preview: string;
}

export function getArgonHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.ARGON_HOME || join(homedir(), ".argon"));
}

export function encodeSessionCwd(cwd: string): string {
  const normalized = resolve(cwd);
  return `--${normalized.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export function getDefaultSessionDir(cwd: string, argonHome = getArgonHome()): string {
  return join(argonHome, "sessions", encodeSessionCwd(cwd));
}

export function parseSessionRecords(text: string): SessionRecord[] {
  const records: SessionRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as SessionRecord);
    } catch {
      // Malformed JSONL lines are ignored so one bad write does not poison a session.
    }
  }
  return records;
}

export function loadSessionRecords(filePath: string): SessionRecord[] {
  if (!existsSync(filePath)) return [];
  const records = parseSessionRecords(readFileSync(filePath, "utf8"));
  const header = records[0];
  if (!isValidHeader(header)) return [];
  return records;
}

export function findMostRecentSession(sessionDir: string): string | undefined {
  if (!existsSync(sessionDir)) return undefined;
  const files = readdirSync(sessionDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(sessionDir, name))
    .filter((path) => {
      const info = buildSessionInfo(path);
      return info !== undefined && info.messageCount > 0;
    })
    .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files[0]?.path;
}

export function resolveSessionPath(cwd: string, value: string, sessionDir = getDefaultSessionDir(cwd)): string | undefined {
  const candidate = isAbsolute(value) ? value : resolve(value);
  if (existsSync(candidate)) return candidate;

  if (!existsSync(sessionDir)) return undefined;
  const matches = readdirSync(sessionDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(sessionDir, name))
    .filter((path) => {
      const info = buildSessionInfo(path);
      return (
        info !== undefined &&
        info.messageCount > 0 &&
        (info.id === value || info.id.startsWith(value) || basename(path).startsWith(value))
      );
    });
  return matches.length === 1 ? matches[0] : undefined;
}

export class SessionManager {
  private readonly entries: SessionEntry[] = [];
  private readonly byId = new Map<string, SessionEntry>();
  private header: SessionHeader;
  private leafId: string | null = null;

  private constructor(
    private readonly sessionDir: string,
    private readonly sessionFile: string,
    records: SessionRecord[]
  ) {
    const header = records[0];
    if (!isValidHeader(header)) {
      throw new Error(`Invalid session file: ${sessionFile}`);
    }
    this.header = header;
    for (const record of records.slice(1)) {
      if (!isSessionEntry(record)) continue;
      this.entries.push(record);
      this.byId.set(record.id, record);
      this.leafId = record.id;
    }
  }

  static create(cwd: string, sessionDir = getDefaultSessionDir(cwd)): SessionManager {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const fileTimestamp = createdAt.replace(/[:.]/g, "-");
    const sessionFile = join(sessionDir, `${fileTimestamp}_${id}.jsonl`);
    const header: SessionHeader = { type: "session", version: CURRENT_SESSION_VERSION, id, cwd: resolve(cwd), createdAt };
    return new SessionManager(sessionDir, sessionFile, [header]);
  }

  static open(filePath: string, sessionDir = dirname(filePath)): SessionManager {
    const resolved = resolve(filePath);
    const records = loadSessionRecords(resolved);
    if (records.length === 0) {
      throw new Error(`Invalid or empty session file: ${resolved}`);
    }
    return new SessionManager(sessionDir, resolved, records);
  }

  static continueRecent(cwd: string, sessionDir = getDefaultSessionDir(cwd)): SessionManager {
    const recent = findMostRecentSession(sessionDir);
    return recent ? SessionManager.open(recent, sessionDir) : SessionManager.create(cwd, sessionDir);
  }

  static list(cwd: string, sessionDir = getDefaultSessionDir(cwd)): SessionInfo[] {
    if (!existsSync(sessionDir)) return [];
    const sessions: SessionInfo[] = [];
    for (const name of readdirSync(sessionDir)) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(sessionDir, name);
      const info = buildSessionInfo(path);
      if (info && info.messageCount > 0 && resolve(info.cwd) === resolve(cwd)) sessions.push(info);
    }
    return sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  }

  static openResolved(cwd: string, value: string, sessionDir = getDefaultSessionDir(cwd)): SessionManager {
    const path = resolveSessionPath(cwd, value, sessionDir);
    if (!path) throw new Error(`No unique session found for: ${value}`);
    return SessionManager.open(path, sessionDir);
  }

  getHeader(): SessionHeader {
    return { ...this.header };
  }

  getSessionId(): string {
    return this.header.id;
  }

  getSessionFile(): string {
    return this.sessionFile;
  }

  getSessionDir(): string {
    return this.sessionDir;
  }

  getCwd(): string {
    return this.header.cwd;
  }

  getLeafId(): string | null {
    return this.leafId;
  }

  getEntries(): SessionEntry[] {
    return [...this.entries];
  }

  getEntry(id: string): SessionEntry | undefined {
    return this.byId.get(id);
  }

  appendTurnContext(context: TurnContext, reasoning: RunOptions["reasoning"] | undefined): string {
    const entry: SessionTurnContextEntry = {
      type: "turn_context",
      id: createEntryId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      cwd: context.cwd,
      provider: context.model.provider,
      modelId: context.model.id,
      availableTools: [...context.availableTools],
      startedAt: context.startedAt,
      ...(reasoning !== undefined ? { reasoning } : {})
    };
    return this.appendEntry(entry);
  }

  appendMessage(message: AgentMessage): string {
    const entry: SessionMessageEntry = {
      type: "message",
      id: createEntryId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      message: structuredClone(message)
    };
    return this.appendEntry(entry);
  }

  appendModelChange(provider: string, modelId: string): string {
    const lastModel = [...this.buildBranch()].reverse().find((entry) => entry.type === "model_change") as
      | SessionModelChangeEntry
      | undefined;
    if (lastModel?.provider === provider && lastModel.modelId === modelId) return lastModel.id;
    const entry: SessionModelChangeEntry = {
      type: "model_change",
      id: createEntryId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      provider,
      modelId
    };
    return this.appendEntry(entry);
  }

  appendCompaction(summary: string, firstKeptEntryId: string, tokensBefore: number, reason: CompactionReason): string {
    const entry: SessionCompactionEntry = {
      type: "compaction",
      id: createEntryId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      summary,
      firstKeptEntryId,
      tokensBefore,
      reason
    };
    return this.appendEntry(entry);
  }

  branchTo(entryId: string | null, note?: string): void {
    if (entryId !== null && !this.byId.has(entryId)) {
      throw new Error(`Session entry not found: ${entryId}`);
    }
    const entry: SessionBranchEntry = {
      type: "branch",
      id: createEntryId(this.byId),
      parentId: entryId,
      timestamp: new Date().toISOString(),
      targetId: entryId,
      ...(note !== undefined ? { note } : {})
    };
    this.appendEntry(entry);
  }

  buildContext(): SessionContext {
    const branch = this.buildBranch();
    const messages: AgentMessage[] = [];
    let model: SessionContext["model"] = null;
    let reasoning: RunOptions["reasoning"] | undefined;
    const latestCompactionIndex = findLatestCompactionIndex(branch);
    for (const entry of branch) {
      if (entry.type === "model_change") {
        model = { provider: entry.provider, modelId: entry.modelId };
      } else if (entry.type === "turn_context") {
        model = { provider: entry.provider, modelId: entry.modelId };
        reasoning = entry.reasoning;
      }
    }

    if (latestCompactionIndex !== -1) {
      const compaction = branch[latestCompactionIndex] as SessionCompactionEntry;
      messages.push(createCompactionSummaryMessage(compaction.summary, Date.parse(compaction.timestamp)));

      let foundFirstKept = false;
      for (let index = 0; index < latestCompactionIndex; index++) {
        const entry = branch[index]!;
        if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
        if (foundFirstKept && entry.type === "message") messages.push(structuredClone(entry.message));
      }

      for (let index = latestCompactionIndex + 1; index < branch.length; index++) {
        const entry = branch[index]!;
        if (entry.type === "message") messages.push(structuredClone(entry.message));
      }
      return { messages, model, reasoning };
    }

    for (const entry of branch) {
      if (entry.type === "message") messages.push(structuredClone(entry.message));
    }
    return { messages, model, reasoning };
  }

  buildBranch(fromId: string | null = this.leafId): SessionEntry[] {
    const branch: SessionEntry[] = [];
    let current = fromId ? this.byId.get(fromId) : undefined;
    while (current) {
      branch.unshift(current);
      current = current.parentId ? this.byId.get(current.parentId) : undefined;
    }
    return branch;
  }

  tree(): SessionTreeNode[] {
    const children = new Map<string | null, SessionEntry[]>();
    for (const entry of this.entries) {
      const list = children.get(entry.parentId) ?? [];
      list.push(entry);
      children.set(entry.parentId, list);
    }
    const rows: SessionTreeNode[] = [];
    const visit = (parentId: string | null, depth: number) => {
      for (const entry of children.get(parentId) ?? []) {
        rows.push({ entry, depth, current: entry.id === this.leafId, preview: previewEntry(entry) });
        visit(entry.id, depth + 1);
      }
    };
    visit(null, 0);
    return rows;
  }

  private appendEntry(entry: SessionEntry): string {
    this.ensureMaterialized();
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    this.leafId = entry.id;
    appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`, "utf8");
    return entry.id;
  }

  private ensureMaterialized(): void {
    if (existsSync(this.sessionFile)) return;
    mkdirSync(dirname(this.sessionFile), { recursive: true });
    writeFileSync(this.sessionFile, `${JSON.stringify(this.header)}\n`, "utf8");
  }
}

function buildSessionInfo(path: string): SessionInfo | undefined {
  const records = loadSessionRecords(path);
  const header = records[0];
  if (!isValidHeader(header)) return undefined;
  const stats = statSync(path);
  let messageCount = 0;
  let firstMessage = "";
  for (const record of records) {
    if (!isSessionEntry(record) || record.type !== "message") continue;
    messageCount++;
    if (!firstMessage && record.message.role === "user") {
      firstMessage = messageText(record.message) || "(no text)";
    }
  }
  return {
    path,
    id: header.id,
    cwd: header.cwd,
    created: new Date(header.createdAt),
    modified: stats.mtime,
    messageCount,
    firstMessage: firstMessage || "(no messages)"
  };
}

function isValidHeader(record: unknown): record is SessionHeader {
  return (
    isRecord(record) &&
    record.type === "session" &&
    typeof record.id === "string" &&
    typeof record.cwd === "string" &&
    typeof record.createdAt === "string"
  );
}

function isSessionEntry(record: unknown): record is SessionEntry {
  return (
    isRecord(record) &&
    typeof record.type === "string" &&
    typeof record.id === "string" &&
    (typeof record.parentId === "string" || record.parentId === null)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createEntryId(existing: Map<string, SessionEntry>): string {
  for (let index = 0; index < 100; index++) {
    const id = randomUUID().slice(0, 8);
    if (!existing.has(id)) return id;
  }
  return randomUUID();
}

function previewEntry(entry: SessionEntry): string {
  switch (entry.type) {
    case "message":
      return `${entry.message.role}: ${messageText(entry.message) || "(empty)"}`;
    case "turn_context":
      return `turn ${entry.provider}/${entry.modelId}`;
    case "model_change":
      return `model ${entry.provider}/${entry.modelId}`;
    case "branch":
      return `branch${entry.note ? ` ${entry.note}` : ""}`;
    case "compaction":
      return `compaction ${entry.tokensBefore} tokens`;
  }
}

function findLatestCompactionIndex(branch: readonly SessionEntry[]): number {
  for (let index = branch.length - 1; index >= 0; index--) {
    if (branch[index]?.type === "compaction") return index;
  }
  return -1;
}

function messageText(message: AgentMessage): string {
  const content = "content" in message ? message.content : undefined;
  if (typeof content === "string") return compact(content);
  if (!Array.isArray(content)) return "";
  return compact(
    content
      .filter((block): block is { type: "text"; text: string } => isRecord(block) && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join(" ")
  );
}

function compact(text: string, max = 120): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= max ? single : `${single.slice(0, max - 3)}...`;
}
