import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@mariozechner/pi-tui";

export interface ArgonTuiTheme {
  editor: EditorTheme;
  markdown: MarkdownTheme;
  ansi: {
    bold(text: string): string;
    cyan(text: string): string;
    dim(text: string): string;
    green(text: string): string;
    italic(text: string): string;
    red(text: string): string;
    strikethrough(text: string): string;
    underline(text: string): string;
    yellow(text: string): string;
  };
}

export function createArgonTuiTheme(color: boolean): ArgonTuiTheme {
  const ansi = {
    bold: (text: string) => wrap(text, color, 1),
    cyan: (text: string) => wrap(text, color, 36),
    dim: (text: string) => wrap(text, color, 2),
    green: (text: string) => wrap(text, color, 32),
    italic: (text: string) => wrap(text, color, 3),
    red: (text: string) => wrap(text, color, 31),
    strikethrough: (text: string) => wrap(text, color, 9),
    underline: (text: string) => wrap(text, color, 4),
    yellow: (text: string) => wrap(text, color, 33)
  };

  const selectList: SelectListTheme = {
    selectedPrefix: ansi.cyan,
    selectedText: ansi.bold,
    description: ansi.dim,
    scrollInfo: ansi.dim,
    noMatch: ansi.dim
  };

  const markdown: MarkdownTheme = {
    heading: (text) => ansi.cyan(ansi.bold(text)),
    link: ansi.cyan,
    linkUrl: ansi.dim,
    code: ansi.yellow,
    codeBlock: ansi.green,
    codeBlockBorder: ansi.dim,
    quote: ansi.italic,
    quoteBorder: ansi.dim,
    hr: ansi.dim,
    listBullet: ansi.cyan,
    bold: ansi.bold,
    italic: ansi.italic,
    strikethrough: ansi.strikethrough,
    underline: ansi.underline
  };

  return {
    ansi,
    markdown,
    editor: {
      borderColor: ansi.dim,
      selectList
    }
  };
}

function wrap(text: string, color: boolean, code: number): string {
  return color ? `\u001b[${code}m${text}\u001b[0m` : text;
}
