import {
  Bot,
  Braces,
  CircleCheck,
  Code2,
  GitBranch,
  GitPullRequestArrow,
  Hammer,
  History,
  MessageSquareText,
  Sparkles,
  TerminalSquare
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface ThreadSummary {
  id: string;
  title: string;
  project: string;
  preview: string;
  time: string;
  status: "running" | "ready" | "review" | "archived";
  unread?: number;
}

export interface ThreadGroup {
  label: string;
  threads: ThreadSummary[];
}

export interface TimelineItem {
  id: string;
  actor: "user" | "assistant" | "tool";
  icon: LucideIcon;
  title: string;
  body: string;
  meta?: string;
  state?: "active" | "done" | "muted";
}

export interface ChangedFile {
  path: string;
  change: "modified" | "added" | "deleted";
  additions: number;
  deletions: number;
}

export interface ActivityMetric {
  label: string;
  value: string;
}

export const threadGroups: ThreadGroup[] = [
  {
    label: "Today",
    threads: [
      {
        id: "desktop-gui",
        title: "Build desktop GUI",
        project: "agent-playground/Argon",
        preview: "Three-pane Tauri shell with thread list, transcript, and workspace tools.",
        time: "23:18",
        status: "running",
        unread: 3
      },
      {
        id: "rpc-polish",
        title: "RPC protocol polish",
        project: "agent-playground/Argon",
        preview: "Review JSONL notifications and model switching behavior.",
        time: "18:42",
        status: "review"
      }
    ]
  },
  {
    label: "This week",
    threads: [
      {
        id: "session-tree",
        title: "Session tree resume flow",
        project: "agent-playground/Argon",
        preview: "Expose branch tree navigation for GUI and TUI clients.",
        time: "Sat",
        status: "ready"
      },
      {
        id: "mcp-status",
        title: "MCP startup status",
        project: "agent-playground/Argon",
        preview: "Surface server connection lifecycle in AgentEvent stream.",
        time: "Fri",
        status: "ready"
      }
    ]
  },
  {
    label: "Archived",
    threads: [
      {
        id: "prompt-layers",
        title: "Prompt layer audit",
        project: "agent-playground/Argon",
        preview: "Keep provider prompt flattening stable and instruction-focused.",
        time: "Jun 7",
        status: "archived"
      }
    ]
  }
];

export const timeline: TimelineItem[] = [
  {
    id: "u1",
    actor: "user",
    icon: MessageSquareText,
    title: "User request",
    body: "Implement a Codex-like desktop GUI with thread navigation, conversation center, and workspace tools on the right.",
    meta: "docs/GUI-design.md requested"
  },
  {
    id: "a1",
    actor: "assistant",
    icon: Sparkles,
    title: "Design pass",
    body: "Derived a dark graphite desktop shell from Codex app, Claude Desktop, and T3 Code references: compact rails, persistent transcript, inspector tabs, and restrained blue accents.",
    meta: "Reference style locked",
    state: "done"
  },
  {
    id: "t1",
    actor: "tool",
    icon: Hammer,
    title: "Scaffold",
    body: "Created a React/Vite GUI package, initialized shadcn-ui, and prepared Tauri configuration for native desktop packaging.",
    meta: "gui/",
    state: "done"
  },
  {
    id: "t2",
    actor: "tool",
    icon: TerminalSquare,
    title: "Build status",
    body: "Next step is connecting the JSONL RPC process so real Argon events stream into this transcript.",
    meta: "RPC bridge pending",
    state: "active"
  }
];

export const changedFiles: ChangedFile[] = [
  { path: "gui/src/App.tsx", change: "added", additions: 314, deletions: 0 },
  { path: "gui/src/data.ts", change: "added", additions: 168, deletions: 0 },
  { path: "gui/src/index.css", change: "modified", additions: 98, deletions: 18 },
  { path: "gui/src-tauri/tauri.conf.json", change: "added", additions: 29, deletions: 0 },
  { path: "docs/GUI-design.md", change: "added", additions: 72, deletions: 0 }
];

export const terminalLines = [
  "$ npm run build",
  "> gui@0.0.0 build",
  "> tsc -b && vite build",
  "",
  "vite v8.0.12 building client for production...",
  "transforming modules...",
  "rendering chunks...",
  "dist/index.html  0.48 kB",
  "dist/assets/index.css  31.2 kB",
  "dist/assets/index.js  254.7 kB",
  "done in 1.8s"
];

export const codePreview = [
  "export class ArgonRpcClient {",
  "  async startTurn(input: UserInput) {",
  "    return this.request('turn/start', { input });",
  "  }",
  "",
  "  onEvent(listener: RpcEventListener) {",
  "    this.listeners.add(listener);",
  "    return () => this.listeners.delete(listener);",
  "  }",
  "}"
];

export const metrics: ActivityMetric[] = [
  { label: "Changed files", value: "5" },
  { label: "Tool calls", value: "12" },
  { label: "Tokens", value: "18.6k" }
];

export const quickActions = [
  { label: "Resume", icon: Bot },
  { label: "Typecheck", icon: CircleCheck },
  { label: "Diff", icon: GitPullRequestArrow },
  { label: "Code", icon: Braces },
  { label: "History", icon: History },
  { label: "Branch", icon: GitBranch },
  { label: "Terminal", icon: TerminalSquare },
  { label: "Inspect", icon: Code2 }
];
