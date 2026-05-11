# Argon TUI

## Turn Progress

While a turn is running, the interactive TUI shows a live status row directly above the input box:

```text
Working (0s - Ctrl+C to interrupt)
```

When the turn ends, the same row becomes a static completion summary such as `Worked for 3s`,
`Interrupted after 1s`, or `Failed after 2s (error)`.

When the assistant streams ordinary text, Argon inserts a dim full-width divider immediately before
that assistant text block. Tool-only model iterations do not render dividers.

```text
────────────────────────────────────────────────────────────────────────────────
assistant
```

Tool calls render as one compact status entry. The entry starts in a pending state, such as
`Calling read src/index.ts`, and is updated in place when the tool result arrives, such as
`Called read src/index.ts hello world`. Large parameters like file contents and edit replacement
texts are hidden from the compact status line.

The assistant divider is driven by visible `message_delta` text events. It is UI telemetry only;
it is not added to the model transcript or resumable session context.

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
