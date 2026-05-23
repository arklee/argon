import {
  ProcessTerminal,
  SelectList,
  TUI,
  truncateToWidth,
  visibleWidth,
  type Component,
  type SelectItem,
  type SelectListTheme
} from "@earendil-works/pi-tui";

export interface SelectionItem {
  value: string;
  label: string;
  description?: string;
  selected?: boolean;
}

export async function selectWithTui(title: string, items: SelectionItem[], theme: SelectListTheme): Promise<string | undefined> {
  return new Promise((resolve) => {
    const tui = new TUI(new ProcessTerminal());
    let settled = false;
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      tui.stop();
      resolve(value);
    };
    const picker = new PickerComponent(title, items, theme, finish);
    tui.addChild(picker);
    tui.setFocus(picker);
    tui.start();
  });
}

export class PickerComponent implements Component {
  private readonly list: SelectList;

  constructor(
    private readonly title: string,
    items: SelectionItem[],
    private readonly theme: SelectListTheme,
    private readonly onDone: (value: string | undefined) => void
  ) {
    this.list = new SelectList(
      items.map((item): SelectItem => ({ value: item.value, label: item.label, ...(item.description ? { description: item.description } : {}) })),
      12,
      theme,
      { minPrimaryColumnWidth: 28, maxPrimaryColumnWidth: 48 }
    );
    const selectedIndex = items.findIndex((item) => item.selected);
    if (selectedIndex >= 0) this.list.setSelectedIndex(selectedIndex);
    this.list.onSelect = (item) => this.onDone(item.value);
    this.list.onCancel = () => this.onDone(undefined);
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - 2);
    const contentLines = [
      ` ${this.theme.selectedText(this.title)}`,
      "",
      ...this.list.render(contentWidth),
      "",
      ` ${this.theme.scrollInfo("enter to select, esc to cancel")}`
    ];

    return renderInlinePanel(contentLines, width, this.theme.scrollInfo);
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }

  invalidate(): void {
    this.list.invalidate();
  }
}

function renderInlinePanel(lines: string[], width: number, border: (text: string) => string): string[] {
  if (width <= 4) return lines.map((line) => truncateToWidth(line, width, "", true));

  const contentWidth = Math.max(1, width);
  const rule = border("─".repeat(width));
  const body = lines.map((line) => padLine(line, contentWidth));

  return [rule, ...body, rule];
}

function padLine(line: string, width: number): string {
  const truncated = visibleWidth(line) > width ? truncateToWidth(line, width, "", true) : line;
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}
