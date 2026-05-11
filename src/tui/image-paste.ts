import type { ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

export interface LocalImageAttachment {
  placeholder: string;
  path: string;
}

export interface PreparedImageInput {
  text: string;
  content: Array<TextContent | ImageContent>;
  attachments: LocalImageAttachment[];
}

export interface ClipboardModule {
  hasImage(): boolean;
  getImageBinary(): Promise<Array<number> | Uint8Array>;
}

const require = createRequire(import.meta.url);
const IMAGE_PLACEHOLDER_PATTERN = /\[Image #(\d+)\]/g;

export function currentModelSupportsImages(model: Model<any>): boolean {
  return model.input?.includes("image") ?? true;
}

export function imagePlaceholder(index: number): string {
  return `[Image #${index}]`;
}

export function nextImagePlaceholder(attachments: readonly LocalImageAttachment[]): string {
  return imagePlaceholder(attachments.length + 1);
}

export function normalizePastedPath(pasted: string): string | undefined {
  const trimmed = pasted.trim();
  if (!trimmed || trimmed.includes("\n")) return undefined;
  const unquoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ? trimmed.slice(1, -1)
      : trimmed;

  try {
    const url = new URL(unquoted);
    if (url.protocol === "file:") return fileURLToPath(url);
  } catch {
    // Not a URL; keep treating it as a path.
  }

  const shellUnescaped = unquoted.replace(/\\([\\ "'()&;<>[\]{}$`!*?])/g, "$1");
  if (isWindowsPath(shellUnescaped)) return normalizeWindowsPath(shellUnescaped);
  if (shellUnescaped.startsWith("~/")) return join(homedir(), shellUnescaped.slice(2));
  if (/^(?:\/|\.{1,2}\/)/.test(shellUnescaped)) return shellUnescaped;
  return undefined;
}

export async function maybeCreateAttachmentFromPastedPath(
  pasted: string,
  attachments: readonly LocalImageAttachment[]
): Promise<LocalImageAttachment | undefined> {
  const path = normalizePastedPath(pasted);
  if (!path) return undefined;
  const image = await readImageContent(path);
  if (!image) return undefined;
  return { placeholder: nextImagePlaceholder(attachments), path };
}

export async function pasteClipboardImageToTempFile(
  attachments: readonly LocalImageAttachment[],
  clipboard: ClipboardModule | undefined = loadClipboardModule()
): Promise<LocalImageAttachment | undefined> {
  if (process.env.TERMUX_VERSION || !clipboard?.hasImage()) return undefined;
  const imageData = await clipboard.getImageBinary();
  const bytes = Buffer.from(imageData);
  if (bytes.length === 0) return undefined;

  const dir = await mkdtemp(join(tmpdir(), "argon-clipboard-"));
  const path = join(dir, `argon-clipboard-${randomUUID()}.png`);
  await writeFile(path, bytes);
  return { placeholder: nextImagePlaceholder(attachments), path };
}

export async function prepareImageInput(
  text: string,
  attachments: readonly LocalImageAttachment[]
): Promise<PreparedImageInput> {
  const retained = retainReferencedAttachments(text, attachments);
  const content: Array<TextContent | ImageContent> = [{ type: "text", text }];

  for (const attachment of retained) {
    const image = await readImageContent(attachment.path);
    if (!image) {
      throw new Error(`Could not read image attachment: ${attachment.path}`);
    }
    content.push(image);
  }

  return { text, content, attachments: retained };
}

export function retainReferencedAttachments(
  text: string,
  attachments: readonly LocalImageAttachment[]
): LocalImageAttachment[] {
  const referenced = new Set<string>();
  for (const match of text.matchAll(IMAGE_PLACEHOLDER_PATTERN)) {
    referenced.add(match[0]);
  }
  return attachments.filter((attachment) => referenced.has(attachment.placeholder));
}

export async function readImageContent(path: string): Promise<ImageContent | undefined> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    return undefined;
  }

  const mimeType = detectImageMimeType(bytes);
  if (!mimeType) return undefined;
  return {
    type: "image",
    data: bytes.toString("base64"),
    mimeType
  };
}

export function displayImageAttachment(attachment: LocalImageAttachment): string {
  return `${attachment.placeholder} ${basename(attachment.path)}`;
}

function detectImageMimeType(bytes: Uint8Array): string | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }

  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }

  return undefined;
}

function isWindowsPath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function normalizeWindowsPath(path: string): string {
  if (process.platform !== "linux" || !isProbablyWsl()) return path;
  if (path.startsWith("\\\\")) return path;

  const drive = path[0]?.toLowerCase();
  if (!drive || !/^[a-z]$/.test(drive) || path[1] !== ":") return path;
  const rest = path.slice(2).replace(/^[\\/]+/, "").split(/[\\/]+/).filter(Boolean);
  return join("/mnt", drive, ...rest);
}

function isProbablyWsl(): boolean {
  return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP || process.env.WSLENV);
}

function loadClipboardModule(): ClipboardModule | undefined {
  try {
    return require("@mariozechner/clipboard") as ClipboardModule;
  } catch {
    return undefined;
  }
}
