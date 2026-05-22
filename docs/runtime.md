# Argon Runtime

Argon builds a flattened system prompt for each turn and executes collected tool calls after
the assistant message ends.

## Preamble and Progress Guidance

The default system prompt asks the model to send brief user-visible preambles before
non-trivial or grouped tool calls, and to provide occasional concise progress updates during
longer multi-tool tasks. These are prompt-level assistant messages; the runtime and TUI do not
synthesize them.

## Startup Context

The prompt manager includes a bounded startup context by default. It contains the current
working directory, detected project root, and shallow workspace trees with noisy directories
such as `node_modules`, `.git`, `dist`, and `target` omitted. The context is an orientation
hint only; the agent still needs to inspect relevant files before changing behavior.

Consumers can disable it with:

```ts
new AgentRuntime({
  model,
  cwd,
  prompt: { startupContext: false }
});
```

Or tune it with:

```ts
new AgentRuntime({
  model,
  cwd,
  prompt: {
    startupContext: {
      maxBytes: 8192,
      maxDepth: 2,
      maxEntriesPerDirectory: 16
    }
  }
});
```

## Parallel Tool Calls

Tools can mark themselves as parallel-safe with `canRunInParallel`. The loop executes adjacent
parallel-safe tool calls concurrently and appends their results to the transcript in the original
tool-call order. Built-in `read`, `grep`, and `ls` are parallel-safe. `bash` is parallel-safe only
for simple read-only inspection commands such as `rg`, `sed` without in-place editing, `ls`, `cat`,
`nl`, `wc`, and read-only `git` inspection subcommands.

## MCP Clients

Argon can connect to external stdio MCP servers and expose their tools through the existing
`ToolRuntime` boundary. The loop does not know about MCP directly; `AgentRuntime` starts configured
servers, adapts listed MCP tools into namespaced tools such as `mcp__server__tool`, and routes calls
back to the MCP connection manager.

Configure MCP programmatically:

```ts
new AgentRuntime({
  model,
  cwd,
  mcp: {
    servers: {
      docs: {
        command: "node",
        args: ["./mcp-server.mjs"],
        startupTimeoutMs: 10_000,
        toolTimeoutMs: 60_000
      }
    }
  }
});
```

The same shape is accepted in `argon.config.json` under `mcp`. V1 supports stdio MCP servers,
`tools/list`, and `tools/call`. Resources, resource templates, OAuth, and MCP elicitation are not
implemented yet.

## Skills

Argon discovers Agent Skills-style `SKILL.md` files from:

- `.agents/skills` directories from the project root to the active cwd
- `$ARGON_HOME/skills`
- `$HOME/.agents/skills`
- additional `skills.roots` entries in runtime or config

Only skill metadata is added to the system prompt by default. When the user explicitly mentions a
skill with `$skill-name`, Argon injects that skill's full `SKILL.md` into the user message for that
turn. Relative files referenced by a skill should be resolved from the directory containing its
`SKILL.md`.

Configure additional skill roots:

```ts
new AgentRuntime({
  model,
  cwd,
  skills: {
    roots: ["./shared-skills"],
    disabled: ["old-skill"],
    maxPromptBytes: 8192
  }
});
```
