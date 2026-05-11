# Argon TUI

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
