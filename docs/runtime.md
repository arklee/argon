# Argon Runtime

Argon builds a flattened system prompt for each turn and executes collected tool calls after
the assistant message ends.

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
