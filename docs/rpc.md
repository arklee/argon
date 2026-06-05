# Argon RPC

Argon RPC is a headless JSONL protocol for embedding the core runtime in GUI, IDE, or test hosts without coupling those surfaces to the TUI.

The first transport is stdin/stdout JSONL:

```sh
argon --mode rpc
```

Each request is one JSON object per line with an `id`, a resource-style `method`, and optional `params`. Responses carry the same `id` and either `result` or `error`. Notifications omit `id`.

```json
{"id":1,"method":"initialize"}
{"id":2,"method":"turn/start","params":{"input":"summarize this repo"}}
```

The RPC server emits runtime notifications while a turn is active:

```json
{"method":"turn/event","params":{"runId":"...","kind":"turn","event":{"type":"turn_start"}}}
{"method":"turn/completed","params":{"runId":"...","kind":"turn","reason":"stop"}}
```

Supported methods:

- `initialize`
- `turn/start`
- `turn/interrupt`
- `thread/current`
- `thread/messages`
- `thread/list`
- `thread/new`
- `thread/resume`
- `thread/tree`
- `thread/branch`
- `thread/compact`
- `model/list`
- `model/set`
- `shutdown`

This transport intentionally exposes one active run per RPC server process, matching `AgentRuntime` today. A GUI that needs multiple concurrent background tasks should run multiple server processes or wait for a future app-server/daemon layer that owns multiple runtime handles.
