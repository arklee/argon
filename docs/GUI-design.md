# Argon GUI Design

This document records the desktop GUI target implemented under `gui/`.

## Stack

- React + TypeScript + Vite for the renderer.
- Tauri 2 for the native desktop shell.
- Tailwind CSS v4 and shadcn-ui radix components for UI primitives.
- `lucide-react` icons through the shadcn icon library.
- Argon core remains in `src/`; GUI code must not duplicate loop, provider, prompt, tool, or session logic.

## Architecture

The GUI is a presentation layer over Argon's headless runtime. It should consume the JSONL RPC protocol documented in `docs/rpc.md`.

- Left sidebar: session/thread discovery, search, current user/workspace affordances.
- Center pane: selected thread transcript, streamed assistant/tool events, run controls, prompt composer.
- Right inspector: workspace tools such as Terminal, Git diff/review, and Code preview.
- Tauri backend: owns native process integration, starts `node dist/tui/cli.js --mode rpc`, forwards requests, and streams notifications to the renderer.
- Renderer state: keeps selected thread, selected inspector tab, composer text, and derived view models only.

## Visual Direction

The first implementation targets a modern coding-agent desktop shell inspired by Codex app, Claude Desktop, and T3 Code:

- Dark graphite surfaces with subtle cool-neutral borders.
- Dense, IDE-like layout rather than a marketing or chat-only page.
- Three persistent panes with resizable desktop widths.
- Compact typography, small radii, restrained blue accent, and semantic red/green diff colors.
- No nested card stacks, decorative blobs, oversized hero type, or brand-copying.

## Current Implementation

`gui/src/App.tsx` implements the app shell with:

- `ResizablePanelGroup` for left threads, center conversation, and right inspector.
- `Tabs` for Terminal, Git, and Code views.
- `ScrollArea` for thread lists, transcript, diff, terminal, and code preview.
- `Textarea` composer with quick actions, Enter-to-send, and Shift+Enter newline entry.
- Collapsible left thread sidebar and right workspace inspector controls.
- Thread deletion with a confirmation dialog; connected desktop mode calls `thread/delete`.
- `gui/src/rpc.ts` as the renderer-side command/event client for the Tauri RPC bridge.
- Seed data in `gui/src/data.ts` as the browser-preview fallback when the app is not running inside Tauri.

The current Tauri command surface includes:

- `rpc_start`: starts the Argon JSONL RPC child process.
- `rpc_request`: sends a typed JSON-RPC-like request to the child process and waits for the matching response.
- `rpc_stop`: stops the bridge and child process.
- `rpc_protocol_version`: reports the bridge protocol version.

The backend emits:

- `argon-rpc-notification` for `turn/event`, `turn/completed`, and `rpc/error` messages from the Argon RPC process.
- `argon-rpc-log` for bridge and stderr status lines.
- `argon-rpc-error` for bridge-level failures.

The JSONL RPC bridge supports lifecycle operations used by the GUI, including `thread/list`, `thread/new`,
`thread/resume`, `thread/messages`, and `thread/delete`.

## Running With Real RPC

From the repository root, start the desktop app with:

```sh
npm run gui:tauri:dev
```

The root script builds the core CLI first so the desktop bridge can spawn `dist/tui/cli.js`.

`npm run gui:dev` still runs the browser preview, but it cannot connect to the native Tauri RPC bridge. In browser preview mode the UI falls back to seed data and shows a preview status.

## Next Integration Step

The right inspector still uses local seed data for Git diff and code preview. The next focused step is adding narrow Tauri commands for read-only git status/diff, file preview, and terminal session output while keeping agent runtime state behind the existing JSONL RPC bridge.
