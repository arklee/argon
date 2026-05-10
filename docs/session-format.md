# Argon Session Format

Argon stores resumable conversations as JSONL files under:

```text
~/.argon/sessions/--<encoded-cwd>--/<timestamp>_<session-id>.jsonl
```

The existing runtime event log remains separate debug telemetry and is not used for `/resume`.
New sessions are materialized lazily: opening Argon without sending a user message does not create
a session file and does not appear in `/resume`.

Each session file starts with a header:

```json
{"type":"session","version":1,"id":"uuid","cwd":"/path/to/project","createdAt":"2026-05-11T00:00:00.000Z"}
```

Every later record is an append-only tree entry with `id`, `parentId`, and `timestamp`.
Argon rebuilds model context by walking from the current leaf to the root and collecting
model-visible `message` records.

Record types:

- `turn_context`: cwd, provider/model, reasoning, available tools, and turn start time.
- `message`: a pi-ai compatible `AgentMessage`.
- `model_change`: provider/model selection for the branch.
- `branch`: a tree navigation marker created by `/tree`.

Malformed JSONL lines are skipped during load. Files without a valid `session` header are not
loaded as sessions.
