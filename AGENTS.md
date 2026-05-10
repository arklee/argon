# Argon Agent Instructions

## Scope

These instructions apply to the entire Argon repository. More specific `AGENTS.md` files in child directories override this file for their subtree.

Argon is a Node.js + TypeScript coding agent. It reuses provider support from `@mariozechner/pi-ai`, implements its own Codex-like agent loop, and may expose both a TUI and a Tauri-based GUI. Keep the core agent runtime independent from any UI surface.

## Architecture Principles

- Keep `@mariozechner/pi-ai` as the provider boundary. Use its `Context`, `Message`, `Tool`, `AssistantMessageEvent`, and `streamSimple()` abstractions instead of adding provider-specific SDK paths.
- Treat the provider layer as a thin adapter for model invocation, API key resolution, abort handling, reasoning/session options, and event normalization. Do not build a separate Responses-vs-Chat adapter layer unless explicitly requested.
- Keep the agent loop as a deterministic turn state machine: immutable `TurnContext`, append-only transcript updates, streamed `AgentEvent`s, collected tool calls, tool result messages, and explicit continuation reasons.
- Keep prompt management layered internally and flattened externally into a single `systemPrompt` for pi-ai. Project instructions should be discovered from `AGENTS.md` files in root-to-cwd order.
- Keep tool behavior behind `ToolRuntime`: a pi-ai `Tool` definition plus an `execute()` method returning a pi-ai-compatible plain text tool result.
- Keep session persistence separate from model transcript. JSONL event logs should record runtime events; transcript state should contain only model-relevant messages.
- Keep UI code out of `loop/`, `provider/`, `prompt/`, `tools/`, and `session/`. TUI and Tauri GUI surfaces should subscribe to `AgentEvent`s and call the core runtime through narrow adapters.

## Directory Guidance

- `src/provider/`: thin pi-ai integration only.
- `src/loop/`: turn execution, loop state, continuation rules, and event conversion.
- `src/prompt/`: base identity, coding rules, tool-aware instructions, project instructions, environment context, and prompt assembly.
- `src/tools/`: local tool definitions, registry, execution helpers, and bounded result formatting.
- `src/session/`: transcript and event log abstractions.
- `src/index.ts`: public exports for consumers, TUI, and GUI.
- TUI code should remain a presentation layer over the core runtime.
- Tauri code should route commands through the core runtime or backend adapters; avoid duplicating agent logic in the frontend.

## Coding Style

- Use TypeScript with ESM semantics and explicit public types.
- Prefer small modules with clear ownership over broad utility files.
- Preserve existing public interfaces unless the requested change requires a breaking update.
- Keep runtime state explicit and localized. Avoid process-wide mutable state except for deliberate lifecycle controls such as an `AbortController` owned by `AgentRuntime`.
- Keep dependencies minimal. Do not add provider SDK dependencies when pi-ai already covers the provider capability.
- Use structured parsing or existing APIs when available; avoid brittle string parsing for model messages, tool calls, or project metadata.
- Bound long outputs and file reads. Shell and search tools should support timeouts and abort signals.
- Never commit secrets, API keys, local credentials, or machine-specific private paths beyond intentional test fixtures.

## Prompt Rules

- Maintain a stable base identity for Argon as a coding agent.
- Include tool guidelines only for tools that are actually enabled.
- Include concise environment context such as cwd, current date, platform, and cheap package manager hints.
- Include project instructions from `AGENTS.md`, ordered from repository root to the active cwd.
- Do not inject long repo summaries by default. Project context should be instruction-focused unless a feature explicitly asks for summarization.
- Keep provider-specific fields out of prompts in V1. The flattened system prompt should work through the pi-ai-compatible `Context` shape.

## Loop Rules

- One user request creates one immutable turn context.
- Stream assistant deltas as soon as pi-ai emits them; do not wait for final completion to expose ordinary text.
- For V1-style loop behavior, collect tool calls from the final assistant message, execute them after `message_end`, append tool results, and continue according to the configured strategy.
- Stop cleanly when the assistant has no tool calls, when the provider reports error or abort, or when `maxIterations` is reached.
- Emit clear error events and preserve enough context for UI surfaces to render failures without inspecting internal exceptions.

## Tool Rules

- `bash` executes in the configured cwd, respects timeout/abort, and truncates stdout/stderr to bounded text.
- `read` reads UTF-8 text with size limits.
- `write` creates or replaces files intentionally.
- `edit` performs exact string replacement and fails if the match is missing or ambiguous.
- `ls` returns bounded directory listings.
- `grep` should use `rg` when available and report a clear error if the required search backend is missing.
- Tool results should be plain text and compatible with pi-ai `ToolResultMessage` expectations.

## UI Rules

- TUI and GUI should render core events rather than infer state from raw provider streams.
- Keep cancellation, streaming display, tool-call status, and errors modeled from `AgentEvent`.
- Tauri frontend code should not access filesystem, shell, or provider credentials directly; route those operations through the backend/core boundary.
- Shared UI state should be derived from transcript and event log data where practical, not from duplicated agent-loop logic.

## Tests

- Run focused tests for behavior you change. For broad runtime changes, run `npm test`, `npm run typecheck`, and `npm run build` when available.
- Use mock or faux pi-ai providers for loop tests.
- Use temporary directories for local tool tests.
- Cover at least: plain one-turn completion, tool call continuation, tool errors, max-iteration stopping, abort handling, prompt assembly, and bounded tool output.
- UI tests should remain separate from core loop tests. The core runtime must stay testable without launching a TUI or Tauri app.

## Working Agreement

- Read the relevant files before editing.
- Keep changes scoped to the request.
- Preserve user changes and unrelated local work.
- Update `src/index.ts` when public APIs change.
- Document and test new event names, prompt layers, tool contracts, or session formats.
