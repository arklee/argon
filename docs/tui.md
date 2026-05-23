# Argon TUI

## Turn Progress

While a turn is running, the interactive TUI shows a live status row directly above the two-line
editor:

```text
Working (0s - Ctrl+C to interrupt)
```

When the turn ends, the same row becomes a static completion summary such as `Worked for 3s`,
`Interrupted after 1s`, or `Failed after 2s (error)`.

## Input And Selectors

The active editor follows pi's compact shape: a horizontal rule above the draft, the draft line
prefixed with `❯`, and a horizontal rule below it. It does not render rounded corners, vertical
side borders, or extra left padding inside the draft area.

Submitted user prompts render as full-width background blocks instead of prompt-shaped boxes. Slash
commands such as `/status`, `/model`, and `/thinking` do not add a submitted-command block to the
visible conversation; only their output is shown. Selection lists temporarily replace the editor
area instead of opening as centered overlays, and they open with the current model or thinking level
selected.

Status-style command output uses compact multi-line label/value rows instead of a single long
`key=value` line, so long paths and session IDs remain readable.

Tool calls render as one compact status entry. The entry shows the tool name directly, such as
`read src/index.ts`, and is updated in place when the tool result arrives, such as
`read src/index.ts hello world`. Large parameters like file contents and edit replacement texts are
hidden from the compact status line.

The assistant divider is driven by visible `message_delta` text events. It is UI telemetry only;
it is not added to the model transcript or resumable session context.

## Subscription Login

During `/login` subscription authentication, the TUI still prints the full OAuth URL for manual
copying. It also shows a short `Open in browser: click here` terminal hyperlink immediately below
the URL, so terminals with OSC 8 hyperlink support can open the login URL from a single short
clickable label instead of the wrapped URL.

## Image Paste

The interactive TUI supports image attachments for models whose `input` modalities include
`"image"` or whose modality list is unknown.

Supported paths:

- Press `Ctrl+V` or `Alt+V` to read an image directly from the system clipboard.
- Paste a single image file path, including quoted paths and `file://` URLs.

Argon inserts an `[Image #N]` placeholder into the editor and stores the local image path in the
draft. On submit, only placeholders still present in the editor are sent. Referenced images are
read as `ImageContent` blocks with base64 data and a supported MIME type (`png`, `jpeg`, `gif`, or
`webp`), alongside the text prompt.

If the current model does not support image inputs, Argon leaves the draft unchanged and shows a
warning instead of dropping the attachment.
