import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { AgentMessage, CompactionReason, CompactionResult, CompactionSettings } from "../types.js";

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000
};

export const COMPACTION_SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:";

export interface CompactionEntryLike {
  type: string;
  id: string;
  timestamp: string;
}

export interface MessageEntryLike extends CompactionEntryLike {
  type: "message";
  message: AgentMessage;
}

export interface PreviousCompactionEntryLike extends CompactionEntryLike {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
}

export interface CompactionPreparation {
  messagesToSummarize: AgentMessage[];
  keptMessages: AgentMessage[];
  previousSummary?: string | undefined;
  firstKeptEntryId?: string | undefined;
  tokensBefore: number;
  messagesBefore: number;
}

export interface GenerateCompactionParams {
  preparation: CompactionPreparation;
  model: Model<any>;
  complete: (context: { systemPrompt: string; messages: AgentMessage[] }, maxTokens: number) => Promise<AssistantMessage>;
  customInstructions?: string | undefined;
  reason: CompactionReason;
}

export function resolveCompactionSettings(
  base?: Partial<CompactionSettings> | undefined,
  override?: Partial<CompactionSettings> | undefined
): CompactionSettings {
  return normalizeCompactionSettings({ ...DEFAULT_COMPACTION_SETTINGS, ...base, ...override });
}

export function normalizeCompactionSettings(settings: CompactionSettings): CompactionSettings {
  return {
    enabled: settings.enabled,
    reserveTokens: positiveInteger(settings.reserveTokens, DEFAULT_COMPACTION_SETTINGS.reserveTokens),
    keepRecentTokens: positiveInteger(settings.keepRecentTokens, DEFAULT_COMPACTION_SETTINGS.keepRecentTokens)
  };
}

export function shouldCompact(messages: readonly AgentMessage[], contextWindow: number, settings: CompactionSettings): boolean {
  if (!settings.enabled) return false;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return false;
  return estimateContextTokens(messages).tokens > Math.max(0, contextWindow - settings.reserveTokens);
}

export function estimateContextTokens(messages: readonly AgentMessage[]): { tokens: number; usageTokens?: number; trailingTokens: number } {
  let lastUsageIndex = -1;
  let usageTokens = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "assistant" && message.usage.totalTokens > 0) {
      lastUsageIndex = index;
      usageTokens = message.usage.totalTokens;
      break;
    }
  }

  if (lastUsageIndex === -1) {
    return {
      tokens: messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0),
      trailingTokens: 0
    };
  }

  let trailingTokens = 0;
  for (let index = lastUsageIndex + 1; index < messages.length; index++) {
    trailingTokens += estimateMessageTokens(messages[index]!);
  }
  return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens };
}

export function estimateMessageTokens(message: AgentMessage): number {
  return Math.max(1, Math.ceil(messageText(message).length / 4));
}

export function prepareCompactionFromMessages(
  messages: readonly AgentMessage[],
  settings: CompactionSettings
): CompactionPreparation | undefined {
  if (messages.length < 2) return undefined;
  const firstKeptIndex = findFirstKeptMessageIndex(messages, settings.keepRecentTokens);
  if (firstKeptIndex <= 0) return undefined;
  const messagesToSummarize = messages.slice(0, firstKeptIndex).map((message) => structuredClone(message));
  const keptMessages = messages.slice(firstKeptIndex).map((message) => structuredClone(message));
  if (messagesToSummarize.length === 0 || keptMessages.length === 0) return undefined;
  return {
    messagesToSummarize,
    keptMessages,
    tokensBefore: estimateContextTokens(messages).tokens,
    messagesBefore: messages.length
  };
}

export function prepareCompactionFromBranch(
  branch: readonly CompactionEntryLike[],
  settings: CompactionSettings
): CompactionPreparation | undefined {
  if (branch.length === 0 || branch[branch.length - 1]?.type === "compaction") return undefined;

  let previousSummary: string | undefined;
  let boundaryStart = 0;
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (isPreviousCompaction(entry)) {
      previousSummary = entry.summary;
      const firstKeptIndex = branch.findIndex((candidate) => candidate.id === entry.firstKeptEntryId);
      boundaryStart = firstKeptIndex >= 0 ? firstKeptIndex : index + 1;
      break;
    }
  }

  const messageEntries = branch.filter(isMessageEntry);
  const firstKeptBranchIndex = findFirstKeptBranchIndex(branch, boundaryStart, settings.keepRecentTokens);
  if (firstKeptBranchIndex <= boundaryStart) return undefined;

  const firstKeptEntry = branch[firstKeptBranchIndex];
  if (!firstKeptEntry) return undefined;
  const messagesToSummarize: AgentMessage[] = [];
  const keptMessages: AgentMessage[] = [];

  for (let index = boundaryStart; index < firstKeptBranchIndex; index++) {
    const entry = branch[index];
    if (isMessageEntry(entry)) messagesToSummarize.push(structuredClone(entry.message));
  }
  for (let index = firstKeptBranchIndex; index < branch.length; index++) {
    const entry = branch[index];
    if (isMessageEntry(entry)) keptMessages.push(structuredClone(entry.message));
  }

  if (messagesToSummarize.length === 0 || keptMessages.length === 0) return undefined;
  return {
    messagesToSummarize,
    keptMessages,
    previousSummary,
    firstKeptEntryId: firstKeptEntry.id,
    tokensBefore: estimateContextTokens(messageEntries.map((entry) => entry.message)).tokens,
    messagesBefore: messageEntries.length
  };
}

export async function generateCompaction(params: GenerateCompactionParams): Promise<CompactionResult> {
  const { preparation, model, complete, customInstructions, reason } = params;
  let messagesToSummarize = [...preparation.messagesToSummarize];
  let lastError: unknown;

  while (messagesToSummarize.length > 0) {
    try {
      const response = await complete(
        {
          systemPrompt: COMPACTION_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: buildCompactionPrompt(messagesToSummarize, preparation.previousSummary, customInstructions, reason),
              timestamp: Date.now()
            }
          ]
        },
        Math.max(512, Math.min(model.maxTokens, Math.floor(DEFAULT_COMPACTION_SETTINGS.reserveTokens / 2)))
      );
      if (response.stopReason === "error") {
        throw new Error(response.errorMessage || "Compaction summarization failed");
      }
      const summary = assistantText(response).trim();
      if (!summary) throw new Error("Compaction summarization returned an empty response");
      return {
        summary,
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
        messagesBefore: preparation.messagesBefore,
        messagesAfter: preparation.keptMessages.length + 1
      };
    } catch (error) {
      lastError = error;
      messagesToSummarize = messagesToSummarize.slice(1);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Compaction failed"));
}

export function createCompactionSummaryMessage(summary: string, timestamp = Date.now()): AgentMessage {
  return {
    role: "user",
    content: `${COMPACTION_SUMMARY_PREFIX}\n${summary}`,
    timestamp
  };
}

export function messageText(message: AgentMessage): string {
  switch (message.role) {
    case "user":
      if (typeof message.content === "string") return message.content;
      return message.content.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n");
    case "assistant":
      return message.content
        .map((block) => {
          if (block.type === "text") return block.text;
          if (block.type === "thinking") return block.thinking;
          return `[tool call: ${block.name} ${JSON.stringify(block.arguments)}]`;
        })
        .join("\n");
    case "toolResult":
      return message.content.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n");
  }
}

function findFirstKeptMessageIndex(messages: readonly AgentMessage[], keepRecentTokens: number): number {
  let remaining = keepRecentTokens;
  let firstKept = messages.length - 1;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    firstKept = index;
    remaining -= estimateMessageTokens(message);
    if (remaining <= 0 && message.role !== "toolResult") break;
  }
  while (firstKept > 0 && messages[firstKept]?.role === "toolResult") firstKept--;
  return firstKept;
}

function findFirstKeptBranchIndex(
  branch: readonly CompactionEntryLike[],
  boundaryStart: number,
  keepRecentTokens: number
): number {
  let remaining = keepRecentTokens;
  let firstKept = branch.length - 1;
  let sawMessage = false;
  for (let index = branch.length - 1; index >= boundaryStart; index--) {
    const entry = branch[index];
    if (!isMessageEntry(entry)) continue;
    sawMessage = true;
    firstKept = index;
    remaining -= estimateMessageTokens(entry.message);
    if (remaining <= 0 && entry.message.role !== "toolResult") break;
  }
  while (firstKept > boundaryStart) {
    const entry = branch[firstKept];
    if (!isMessageEntry(entry) || entry.message.role !== "toolResult") break;
    firstKept--;
  }
  return sawMessage ? firstKept : boundaryStart;
}

function buildCompactionPrompt(
  messages: readonly AgentMessage[],
  previousSummary: string | undefined,
  customInstructions: string | undefined,
  reason: CompactionReason
): string {
  return [
    previousSummary ? `<previous_summary>\n${previousSummary}\n</previous_summary>` : undefined,
    `<conversation>\n${serializeConversation(messages)}\n</conversation>`,
    customInstructions ? `<custom_instructions>\n${customInstructions}\n</custom_instructions>` : undefined,
    `Reason for compaction: ${reason}.`,
    "Summarize the conversation so another coding agent can continue from the kept recent messages.",
    "Preserve goals, constraints, decisions, files touched or inspected, errors, open tasks, and next steps. Be concise but specific."
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n\n");
}

function serializeConversation(messages: readonly AgentMessage[]): string {
  return messages
    .map((message) => {
      if (message.role === "toolResult") {
        return `[Tool result: ${message.toolName}]\n${messageText(message)}`;
      }
      const label = message.role === "assistant" ? "Assistant" : "User";
      return `[${label}]\n${messageText(message)}`;
    })
    .join("\n\n");
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function isMessageEntry(value: unknown): value is MessageEntryLike {
  return isRecord(value) && value.type === "message" && "message" in value;
}

function isPreviousCompaction(value: unknown): value is PreviousCompactionEntryLike {
  return (
    isRecord(value) &&
    value.type === "compaction" &&
    typeof value.summary === "string" &&
    typeof value.firstKeptEntryId === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

const COMPACTION_SYSTEM_PROMPT = `You are compacting a coding-agent conversation. Produce a faithful, concise summary for future continuation. Do not invent facts. Include concrete file paths, commands, failures, user preferences, and remaining work when present.`;
