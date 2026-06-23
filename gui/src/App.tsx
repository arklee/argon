import { useCallback, useEffect, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import {
  Activity,
  Bell,
  Bot,
  Brain,
  ChevronDown,
  Circle,
  Code2,
  FileCode2,
  GitBranch,
  GitPullRequestArrow,
  Maximize2,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Search,
  SendHorizonal,
  Settings,
  Moon,
  Sparkles,
  SquareTerminal,
  StopCircle,
  Sun,
  Trash2,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from "@/components/ui/alert-dialog";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup
} from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@/components/ui/tooltip";
import {
  changedFiles,
  codePreview,
  quickActions,
  terminalLines,
  threadGroups,
  timeline,
  type ChangedFile,
  type ThreadSummary
} from "@/data";
import { cn } from "@/lib/utils";
import {
  deleteThread,
  getMessages,
  initializeRpc,
  interruptTurn,
  isTauriRuntime,
  listModels,
  listThreads,
  newThread,
  onRpcError,
  onRpcLog,
  onRpcNotification,
  resumeThread,
  setModel,
  startRpc,
  startTurn,
  type AgentMessage,
  type RpcModel,
  type RpcNotification,
  type RpcSessionInfo,
  type RpcSessionState
} from "@/rpc";

interface TimelineViewItem {
  id: string;
  actor: "user" | "assistant" | "tool" | "thinking";
  icon: LucideIcon;
  title: string;
  body: string;
  meta?: string;
  state?: "active" | "done" | "muted";
  toolCallId?: string;
}

interface RpcUiState {
  available: boolean;
  connected: boolean;
  running: boolean;
  cwd?: string;
  model?: RpcModel;
  runId?: string;
  error?: string;
}

const statusLabel: Record<ThreadSummary["status"], string> = {
  running: "Running",
  ready: "Ready",
  review: "Review",
  archived: "Archived"
};

type ThemeMode = "light" | "dark";

const themeStorageKey = "argon-gui-theme";

function App() {
  const [threads, setThreads] = useState<ThreadSummary[]>(() => threadGroups.flatMap((group) => group.threads));
  const [activeThreadId, setActiveThreadId] = useState("desktop-gui");
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(true);
  const [rightInspectorOpen, setRightInspectorOpen] = useState(true);
  const [theme, setTheme] = useState<ThemeMode>(() => {
    if (typeof window === "undefined") return "dark";
    return window.localStorage.getItem(themeStorageKey) === "light" ? "light" : "dark";
  });
  const [composer, setComposer] = useState("");
  const [items, setItems] = useState<TimelineViewItem[]>(() => timeline);
  const [rpcLogs, setRpcLogs] = useState<string[]>(() => terminalLines);
  const [rpc, setRpc] = useState<RpcUiState>(() => ({ available: isTauriRuntime(), connected: false, running: false }));
  const [models, setModels] = useState<RpcModel[]>([]);
  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === activeThreadId) ?? threads[0] ?? threadGroups[0].threads[0],
    [activeThreadId, threads]
  );

  const reloadMessages = useCallback(async () => {
    if (!isTauriRuntime()) return;
    const result = await getMessages();
    setItems(messagesToTimeline(result.messages));
  }, []);

  const reloadThreads = useCallback(async (state?: RpcSessionState) => {
    if (!isTauriRuntime()) return;
    const result = await listThreads();
    const mapped = sessionsToThreads(result.sessions, state);
    setThreads(mapped.length > 0 ? mapped : [stateToThread(state)]);
    if (state?.path) setActiveThreadId(state.path);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem(themeStorageKey, theme);
  }, [theme]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      setRpc((current) => ({
        ...current,
        error: "Use the Tauri desktop command: npm run gui:tauri:dev"
      }));
      return;
    }

    let disposed = false;
    let unlistenNotification: (() => void) | undefined;
    let unlistenLog: (() => void) | undefined;
    let unlistenError: (() => void) | undefined;

    async function boot() {
      try {
        const started = await startRpc();
        setRpcLogs((logs) => appendLog(logs, `rpc bridge: ${started.command}`));
        const initialized = await initializeRpc();
        if (disposed) return;
        setRpc({
          available: true,
          connected: true,
          running: Boolean(initialized.state.running),
          cwd: initialized.state.cwd,
          model: initialized.state.model,
          runId: initialized.state.running?.runId
        });
        const listedModels = await listModels();
        if (!disposed) setModels(listedModels.models);
        await reloadThreads(initialized.state);
        await reloadMessages();
      } catch (error) {
        if (!disposed) {
          setRpc((current) => ({
            ...current,
            available: true,
            connected: false,
            error: error instanceof Error ? error.message : String(error)
          }));
          setRpcLogs((logs) => appendLog(logs, `rpc error: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
    }

    void boot();
    void onRpcNotification((notification) => {
      handleRpcNotification(notification, setItems, setRpc, setRpcLogs);
      if (notification.method === "turn/completed") {
        void reloadMessages();
        void reloadThreads();
      }
    }).then((unlisten) => {
      unlistenNotification = unlisten;
    });
    void onRpcLog((log) => {
      setRpcLogs((logs) => appendLog(logs, `${log.stream}: ${log.line}`));
    }).then((unlisten) => {
      unlistenLog = unlisten;
    });
    void onRpcError((error) => {
      setRpc((current) => ({ ...current, connected: false, running: false, error: error.message }));
      setRpcLogs((logs) => appendLog(logs, `rpc error: ${error.message}`));
    }).then((unlisten) => {
      unlistenError = unlisten;
    });

    return () => {
      disposed = true;
      unlistenNotification?.();
      unlistenLog?.();
      unlistenError?.();
    };
  }, [reloadMessages, reloadThreads]);

  const handleSelectThread = useCallback(
    async (id: string) => {
      setActiveThreadId(id);
      if (!rpc.connected || id === "desktop-gui") return;
      try {
        const state = await resumeThread(id);
        setRpc((current) => ({
          ...current,
          cwd: state.cwd,
          model: state.model,
          running: Boolean(state.running),
          runId: state.running?.runId
        }));
        await reloadMessages();
      } catch (error) {
        setRpcLogs((logs) => appendLog(logs, `resume error: ${error instanceof Error ? error.message : String(error)}`));
      }
    },
    [reloadMessages, rpc.connected]
  );

  const handleNewThread = useCallback(async () => {
    if (!rpc.connected) return;
    try {
      const state = await newThread();
      setItems([]);
      await reloadThreads(state);
    } catch (error) {
      setRpcLogs((logs) => appendLog(logs, `new thread error: ${error instanceof Error ? error.message : String(error)}`));
    }
  }, [reloadThreads, rpc.connected]);

  const handleDeleteThread = useCallback(
    async (thread: ThreadSummary) => {
      const nextThreads = threads.filter((candidate) => candidate.id !== thread.id);
      setThreads(nextThreads);
      if (activeThreadId === thread.id) {
        const next = nextThreads[0];
        setActiveThreadId(next?.id ?? "desktop-gui");
        if (!next) setItems([]);
      }
      if (!rpc.connected || thread.id === "desktop-gui") return;
      try {
        const result = await deleteThread(thread.id);
        setRpc((current) => ({
          ...current,
          cwd: result.state.cwd,
          model: result.state.model,
          running: Boolean(result.state.running),
          runId: result.state.running?.runId
        }));
        await reloadThreads(result.state);
        await reloadMessages();
        setRpcLogs((logs) => appendLog(logs, `deleted thread: ${shortPath(result.path)}`));
      } catch (error) {
        setRpcLogs((logs) => appendLog(logs, `delete error: ${error instanceof Error ? error.message : String(error)}`));
        await reloadThreads();
      }
    },
    [activeThreadId, reloadMessages, reloadThreads, rpc.connected, threads]
  );

  const handleSend = useCallback(async () => {
    const input = composer.trim();
    if (!input) return;
    setComposer("");
    setItems((current) => [
      ...current,
      {
        id: `local-user-${Date.now()}`,
        actor: "user",
        icon: Bot,
        title: "You",
        body: input,
        meta: "sending"
      }
    ]);
    if (!rpc.connected) {
      setRpcLogs((logs) => appendLog(logs, "send skipped: RPC bridge is only available in the Tauri desktop shell"));
      return;
    }
    try {
      const result = await startTurn(input);
      setRpc((current) => ({ ...current, running: true, runId: result.runId, error: undefined }));
      setRpcLogs((logs) => appendLog(logs, `turn started: ${result.runId}`));
    } catch (error) {
      setRpc((current) => ({ ...current, running: false, error: error instanceof Error ? error.message : String(error) }));
      setRpcLogs((logs) => appendLog(logs, `turn error: ${error instanceof Error ? error.message : String(error)}`));
    }
  }, [composer, rpc.connected]);

  const handleSelectModel = useCallback(
    async (model: RpcModel) => {
      if (!rpc.connected) {
        setRpc((current) => ({ ...current, model }));
        return;
      }
      try {
        const result = await setModel(model.provider, model.id);
        setRpc((current) => ({ ...current, model: result.model }));
        setRpcLogs((logs) => appendLog(logs, `model selected: ${result.model.provider}/${result.model.id}`));
      } catch (error) {
        setRpcLogs((logs) => appendLog(logs, `model error: ${error instanceof Error ? error.message : String(error)}`));
      }
    },
    [rpc.connected]
  );

  const handleStop = useCallback(async () => {
    if (!rpc.connected) return;
    try {
      await interruptTurn(rpc.runId);
      setRpcLogs((logs) => appendLog(logs, "interrupt requested"));
    } catch (error) {
      setRpcLogs((logs) => appendLog(logs, `interrupt error: ${error instanceof Error ? error.message : String(error)}`));
    }
  }, [rpc.connected, rpc.runId]);

  return (
    <main className="min-h-screen overflow-hidden bg-background text-foreground">
      <div className="flex h-screen flex-col bg-[radial-gradient(circle_at_50%_0%,color-mix(in_oklch,var(--primary)_10%,transparent),transparent_34%),var(--background)]">
        <TopBar
          activeThread={activeThread}
          leftSidebarOpen={leftSidebarOpen}
          rightInspectorOpen={rightInspectorOpen}
          rpc={rpc}
          theme={theme}
          onToggleLeftSidebar={() => setLeftSidebarOpen((open) => !open)}
          onToggleRightInspector={() => setRightInspectorOpen((open) => !open)}
          onToggleTheme={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
        />
        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1" data-argon-layout="workspace">
          {leftSidebarOpen ? (
            <>
              <ResizablePanel defaultSize="20%" minSize="236px" maxSize="360px" className="min-w-[236px]" data-argon-panel="threads">
                <ThreadSidebar
                  activeThreadId={activeThreadId}
                  threads={threads}
                  onDeleteThread={handleDeleteThread}
                  onNewThread={handleNewThread}
                  onSelectThread={handleSelectThread}
                />
              </ResizablePanel>
              <ResizableHandle withHandle />
            </>
          ) : null}
          <ResizablePanel defaultSize={rightInspectorOpen ? "49%" : "80%"} minSize="420px" data-argon-panel="conversation">
            <ConversationPane
              composer={composer}
              items={items}
              models={models}
              rpc={rpc}
              setComposer={setComposer}
              thread={activeThread}
              onSelectModel={handleSelectModel}
              onSend={handleSend}
              onStop={handleStop}
            />
          </ResizablePanel>
          {rightInspectorOpen ? (
            <>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize="31%" minSize="340px" className="min-w-[340px]" data-argon-panel="workspace">
                <WorkspaceInspector logs={rpcLogs} rpc={rpc} onCollapse={() => setRightInspectorOpen(false)} />
              </ResizablePanel>
            </>
          ) : null}
        </ResizablePanelGroup>
      </div>
    </main>
  );
}

function TopBar({
  activeThread,
  leftSidebarOpen,
  rightInspectorOpen,
  rpc,
  theme,
  onToggleLeftSidebar,
  onToggleRightInspector,
  onToggleTheme
}: {
  activeThread: ThreadSummary;
  leftSidebarOpen: boolean;
  rightInspectorOpen: boolean;
  rpc: RpcUiState;
  theme: ThemeMode;
  onToggleLeftSidebar: () => void;
  onToggleRightInspector: () => void;
  onToggleTheme: () => void;
}) {
  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b bg-background/85 px-3 backdrop-blur">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-7 items-center justify-center rounded-md border bg-card text-[13px] font-semibold text-primary">
          A
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={leftSidebarOpen ? "Collapse threads sidebar" : "Expand threads sidebar"}
              onClick={onToggleLeftSidebar}
            >
              {leftSidebarOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{leftSidebarOpen ? "Collapse threads" : "Expand threads"}</TooltipContent>
        </Tooltip>
        <div className="hidden min-w-0 sm:block">
          <div className="flex items-center gap-2 text-sm font-medium">
            <span className="truncate">Argon</span>
            <span className="text-muted-foreground">/</span>
            <span className="truncate text-muted-foreground">{activeThread.project}</span>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <GitBranch className="size-3" />
            <span>codex/tauri-gui-client</span>
            <span>•</span>
            <span>{activeThread.title}</span>
          </div>
        </div>
      </div>
      <nav className="flex items-center gap-2">
        <Badge variant={rpc.connected ? "secondary" : "outline"} className="hidden gap-1.5 lg:inline-flex">
          <Activity className="size-3" />
          {rpc.connected ? (rpc.running ? "Running" : "RPC ready") : "Preview"}
        </Badge>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={rightInspectorOpen ? "Collapse workspace inspector" : "Expand workspace inspector"}
              onClick={onToggleRightInspector}
            >
              {rightInspectorOpen ? <PanelRightClose /> : <PanelRightOpen />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{rightInspectorOpen ? "Collapse inspector" : "Expand inspector"}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
              onClick={onToggleTheme}
            >
              {theme === "dark" ? <Sun /> : <Moon />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{theme === "dark" ? "Light theme" : "Dark theme"}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Notifications">
              <Bell />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Notifications</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Settings">
              <Settings />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Settings</TooltipContent>
        </Tooltip>
      </nav>
    </header>
  );
}

function ThreadSidebar({
  activeThreadId,
  threads,
  onDeleteThread,
  onNewThread,
  onSelectThread
}: {
  activeThreadId: string;
  threads: ThreadSummary[];
  onDeleteThread: (thread: ThreadSummary) => void;
  onNewThread: () => void;
  onSelectThread: (id: string) => void;
}) {
  const groupedThreads = useMemo(() => groupThreads(threads), [threads]);
  return (
    <aside className="flex h-full flex-col bg-sidebar/80">
      <div className="flex h-13 items-center gap-2 border-b px-3">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            className="h-8 w-full rounded-md border bg-background/70 pl-8 pr-2 text-xs outline-none transition focus-visible:ring-[3px] focus-visible:ring-ring/50"
            placeholder="Search threads"
          />
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="secondary" size="icon" aria-label="New thread" onClick={onNewThread}>
              <MessageSquarePlus />
            </Button>
          </TooltipTrigger>
          <TooltipContent>New thread</TooltipContent>
        </Tooltip>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-3">
          {groupedThreads.map((group) => (
            <section key={group.label} className="flex flex-col gap-1.5">
              <div className="px-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                {group.label}
              </div>
              {group.threads.map((thread) => (
                <div
                  key={thread.id}
                  className={cn(
                    "thread-row-interactive group/thread flex items-start gap-1 rounded-md px-2.5 py-2 transition",
                    activeThreadId === thread.id && "thread-row-active"
                  )}
                >
                  <button className="min-w-0 flex-1 text-left" type="button" onClick={() => onSelectThread(thread.id)}>
                    <div className="flex items-center gap-2">
                      <StatusDot status={thread.status} />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{thread.title}</span>
                      <span className="text-[11px] text-muted-foreground">{thread.time}</span>
                    </div>
                    <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">{thread.preview}</p>
                    <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                      <span className="truncate">{thread.project}</span>
                      {thread.unread ? <Badge variant="outline">{thread.unread}</Badge> : null}
                    </div>
                  </button>
                  <DeleteThreadButton thread={thread} onDeleteThread={onDeleteThread} />
                </div>
              ))}
            </section>
          ))}
        </div>
      </ScrollArea>
      <div className="border-t p-3">
        <div className="flex items-center gap-2 rounded-md bg-card px-2.5 py-2">
          <Avatar className="size-7 rounded-md">
            <AvatarFallback className="rounded-md text-xs">AK</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium">arkli</div>
            <div className="truncate text-[11px] text-muted-foreground">Asia/Shanghai workspace</div>
          </div>
        </div>
      </div>
    </aside>
  );
}

function DeleteThreadButton({
  thread,
  onDeleteThread
}: {
  thread: ThreadSummary;
  onDeleteThread: (thread: ThreadSummary) => void;
}) {
  return (
    <AlertDialog>
      <Tooltip>
        <TooltipTrigger asChild>
          <AlertDialogTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="mt-0.5 opacity-0 transition-opacity group-hover/thread:opacity-100 focus-visible:opacity-100"
              aria-label={`Delete ${thread.title}`}
            >
              <Trash2 />
            </Button>
          </AlertDialogTrigger>
        </TooltipTrigger>
        <TooltipContent>Delete thread</TooltipContent>
      </Tooltip>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete thread?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes "{thread.title}" from the local Argon session list. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => onDeleteThread(thread)}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ConversationPane({
  composer,
  items,
  models,
  rpc,
  setComposer,
  thread,
  onSelectModel,
  onSend,
  onStop
}: {
  composer: string;
  items: TimelineViewItem[];
  models: RpcModel[];
  rpc: RpcUiState;
  setComposer: (value: string) => void;
  thread: ThreadSummary;
  onSelectModel: (model: RpcModel) => void;
  onSend: () => void;
  onStop: () => void;
}) {
  return (
    <section className="flex h-full min-w-0 flex-col bg-background">
      <div className="flex h-14 shrink-0 items-center justify-between border-b px-4 max-sm:h-20 max-sm:items-start max-sm:pt-3">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">{thread.title}</h1>
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <Bot className="size-3.5" />
            <span>{statusLabel[thread.status]}</span>
            <span>•</span>
            <span>max iterations 12</span>
            <span>•</span>
            <span>compaction enabled</span>
          </div>
        </div>
        <Button variant="ghost" size="icon" aria-label="Stop run" onClick={onStop} disabled={!rpc.running}>
          <StopCircle />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-5 py-6">
          {rpc.error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {rpc.error}
            </div>
          ) : null}
          {rpc.running ? <RunProgress /> : null}
          {items.length === 0 ? (
            <div className="rounded-md border border-dashed bg-transparent p-4 text-sm text-muted-foreground">
              This thread is empty. Ask Argon to change this project from the composer below.
            </div>
          ) : null}
          {items.map((item) => (
            <ConversationItem key={item.id} item={item} />
          ))}
        </div>
      </ScrollArea>
      <Composer
        model={rpc.model}
        models={models}
        value={composer}
        running={rpc.running}
        onChange={setComposer}
        onSelectModel={onSelectModel}
        onSend={onSend}
      />
    </section>
  );
}

function RunProgress() {
  return (
    <div className="conversation-run-status">
      <Sparkles className="size-3.5" />
      <span>Working</span>
      <span className="text-muted-foreground">streaming agent events</span>
    </div>
  );
}

function ConversationItem({ item }: { item: TimelineViewItem }) {
  if (item.actor === "user") {
    return (
      <article className="flex justify-end">
        <div className="max-w-[78%] rounded-2xl bg-muted px-4 py-2.5 text-sm leading-6 text-foreground shadow-sm">
          {item.body}
        </div>
      </article>
    );
  }

  if (item.actor === "thinking") {
    return (
      <details className="conversation-thinking" open={item.state === "active"}>
        <summary>
          <Brain className="size-3.5" />
          <span>{item.state === "active" ? "Thinking" : "Thought"}</span>
          {item.meta ? <span className="ml-auto">{item.meta}</span> : null}
        </summary>
        <div>{item.body}</div>
      </details>
    );
  }

  if (item.actor === "tool") {
    return (
      <article className={cn("conversation-tool", item.state === "active" && "conversation-tool-active")}>
        <item.icon className="size-3.5" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">{item.title}</div>
          {item.body ? <div className="mt-1 truncate text-muted-foreground">{item.body}</div> : null}
        </div>
        {item.meta ? <span className="shrink-0 text-muted-foreground">{item.meta}</span> : null}
      </article>
    );
  }

  return (
    <article className="conversation-assistant">
      <MarkdownContent text={item.body} />
      {item.meta ? <div className="mt-3 text-xs text-muted-foreground">{item.meta}</div> : null}
    </article>
  );
}

function Composer({
  model,
  models,
  value,
  running,
  onChange,
  onSelectModel,
  onSend
}: {
  model?: RpcModel;
  models: RpcModel[];
  value: string;
  running: boolean;
  onChange: (value: string) => void;
  onSelectModel: (model: RpcModel) => void;
  onSend: () => void;
}) {
  const modelLabel = model ? modelDisplayName(model) : "GPT-5 Codex";
  const menuModels = models.length > 0 ? models : previewModels(model);
  return (
    <div className="shrink-0 bg-background/95 px-4 pb-4 pt-2">
      <div className="composer-shell mx-auto max-w-3xl">
        <Textarea
          className="min-h-[4.5rem] resize-none border-0 bg-transparent px-4 py-3 text-sm shadow-none focus-visible:ring-0"
          placeholder="Ask for follow-up changes"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            onSend();
          }}
        />
        <div className="flex items-center justify-between px-2.5 pb-2.5">
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="icon-sm" aria-label="Attach context">
              <Plus />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="max-w-[220px] text-muted-foreground">
                  <span className="truncate">{modelLabel}</span>
                  <ChevronDown data-icon="inline-end" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-72">
                <DropdownMenuGroup>
                  {menuModels.slice(0, 12).map((candidate) => (
                    <DropdownMenuItem
                      key={`${candidate.provider}/${candidate.id}`}
                      onSelect={() => onSelectModel(candidate)}
                      className="flex-col items-start gap-0.5 py-2"
                    >
                      <div className="flex w-full items-center gap-2">
                        <span className="min-w-0 flex-1 truncate">{modelDisplayName(candidate)}</span>
                        {model && candidate.provider === model.provider && candidate.id === model.id ? (
                          <span className="text-[11px] text-muted-foreground">current</span>
                        ) : null}
                      </div>
                      <span className="text-xs text-muted-foreground">{candidate.provider}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <Button size="icon" aria-label="Send message" onClick={onSend} disabled={running || value.trim().length === 0}>
            <SendHorizonal />
          </Button>
        </div>
      </div>
    </div>
  );
}

function WorkspaceInspector({ logs, rpc, onCollapse }: { logs: string[]; rpc: RpcUiState; onCollapse: () => void }) {
  return (
    <aside className="flex h-full flex-col bg-card/45">
      <Tabs defaultValue="git" className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-13 shrink-0 items-center justify-between border-b px-3">
          <TabsList variant="line">
            <TabsTrigger value="terminal">Terminal</TabsTrigger>
            <TabsTrigger value="git">Git</TabsTrigger>
            <TabsTrigger value="code">Code</TabsTrigger>
          </TabsList>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" aria-label="Collapse inspector panel" onClick={onCollapse}>
              <PanelRight />
            </Button>
            <Button variant="ghost" size="icon" aria-label="Maximize inspector">
              <Maximize2 />
            </Button>
          </div>
        </div>
        <TabsContent value="git" className="min-h-0 flex-1 p-0">
          <GitPane rpc={rpc} />
        </TabsContent>
        <TabsContent value="terminal" className="min-h-0 flex-1 p-0">
          <TerminalPane lines={logs} />
        </TabsContent>
        <TabsContent value="code" className="min-h-0 flex-1 p-0">
          <CodePane />
        </TabsContent>
      </Tabs>
    </aside>
  );
}

function GitPane({ rpc }: { rpc: RpcUiState }) {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b p-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold">
              <GitPullRequestArrow className="size-4" />
              Working tree
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {rpc.cwd ? shortPath(rpc.cwd) : "codex/tauri-gui-client"} · 5 files changed
            </p>
          </div>
          <Button variant="outline" size="sm">
            Review
          </Button>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 p-3">
          <div className="rounded-md border bg-background/70">
            {changedFiles.map((file) => (
              <FileRow key={file.path} file={file} />
            ))}
          </div>
          <DiffPreview />
        </div>
      </ScrollArea>
    </div>
  );
}

function FileRow({ file }: { file: ChangedFile }) {
  return (
    <div className="flex items-center gap-2 border-b px-3 py-2 last:border-b-0">
      <FileCode2 className="size-4 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-xs">{file.path}</span>
      <span className="text-[11px] text-green-400">+{file.additions}</span>
      <span className="text-[11px] text-red-400">-{file.deletions}</span>
    </div>
  );
}

function DiffPreview() {
  return (
    <pre className="overflow-hidden rounded-md border bg-[#090a0d] p-3 text-xs leading-5 text-muted-foreground">
      <code>
        <span className="text-muted-foreground">@@ gui/src/App.tsx @@</span>
        {"\n"}
        <span className="text-green-400">+ &lt;ResizablePanelGroup direction="horizontal"&gt;</span>
        {"\n"}
        <span className="text-green-400">+   &lt;ThreadSidebar /&gt;</span>
        {"\n"}
        <span className="text-green-400">+   &lt;ConversationPane /&gt;</span>
        {"\n"}
        <span className="text-green-400">+   &lt;WorkspaceInspector /&gt;</span>
        {"\n"}
        <span className="text-red-400">- &lt;ViteStarter /&gt;</span>
      </code>
    </pre>
  );
}

function TerminalPane({ lines }: { lines: string[] }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 items-center gap-2 border-b px-3">
        <SquareTerminal className="size-4 text-muted-foreground" />
        <span className="text-xs font-medium">argon-gui</span>
        <Badge variant="outline" className="ml-auto">
          zsh
        </Badge>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <pre className="p-3 font-mono text-xs leading-5 text-muted-foreground">
          {lines.map((line, index) => (
            <span key={`${index}-${line}`} className={cn(line.startsWith("$") && "text-primary", line.includes("error") && "text-red-300")}>
              {line}
              {"\n"}
            </span>
          ))}
        </pre>
      </ScrollArea>
    </div>
  );
}

function CodePane() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 items-center gap-2 border-b px-3">
        <Code2 className="size-4 text-muted-foreground" />
        <span className="truncate text-xs font-medium">src/rpc/client.ts</span>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-3">
          <pre className="rounded-md border bg-background/80 p-3 font-mono text-xs leading-5 text-muted-foreground">
            {codePreview.map((line, index) => (
              <span key={`${index}-${line}`}>
                <span className="mr-4 inline-block w-5 select-none text-right text-muted-foreground/60">{index + 1}</span>
                {line}
                {"\n"}
              </span>
            ))}
          </pre>
          <Separator className="my-3" />
          <div className="grid grid-cols-2 gap-2">
            {quickActions.slice(5).map((action) => (
              <Button key={action.label} variant="outline" size="sm">
                <action.icon data-icon="inline-start" />
                {action.label}
              </Button>
            ))}
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

function StatusDot({ status }: { status: ThreadSummary["status"] }) {
  return (
    <Circle
      className={cn(
        "size-2.5 fill-current",
        status === "running" && "text-blue-400",
        status === "ready" && "text-muted-foreground",
        status === "review" && "text-amber-400",
        status === "archived" && "text-muted-foreground/50"
      )}
    />
  );
}

function groupThreads(threads: ThreadSummary[]) {
  const real = threads.length > 0 ? threads : threadGroups.flatMap((group) => group.threads);
  return [
    { label: "Today", threads: real.filter((thread) => thread.status === "running" || thread.time.includes(":")) },
    { label: "This week", threads: real.filter((thread) => thread.status !== "running" && !thread.time.includes(":") && thread.status !== "archived") },
    { label: "Archived", threads: real.filter((thread) => thread.status === "archived") }
  ].filter((group) => group.threads.length > 0);
}

function sessionsToThreads(sessions: RpcSessionInfo[], state?: RpcSessionState): ThreadSummary[] {
  const threads = sessions.map((session) => ({
    id: session.path,
    title: session.firstMessage || `Session ${session.id.slice(0, 8)}`,
    project: shortPath(session.cwd),
    preview: `${session.messageCount} messages`,
    time: formatThreadTime(session.modified),
    status: state?.path === session.path && state.running ? "running" : "ready"
  })) satisfies ThreadSummary[];
  if (threads.length === 0 && state) return [stateToThread(state)];
  return threads;
}

function stateToThread(state?: RpcSessionState): ThreadSummary {
  return {
    id: state?.path ?? "desktop-gui",
    title: state?.id ? `Session ${state.id.slice(0, 8)}` : "Build desktop GUI",
    project: state?.cwd ? shortPath(state.cwd) : "agent-playground/Argon",
    preview: state ? `${state.messageCount} messages` : "Three-pane Tauri shell with thread list, transcript, and workspace tools.",
    time: "now",
    status: state?.running ? "running" : "ready"
  };
}

function messagesToTimeline(messages: AgentMessage[]): TimelineViewItem[] {
  return messages
    .filter((message) => message.role !== "system")
    .map((message, index) => {
      const actor = message.role === "user" ? "user" : message.role === "tool" ? "tool" : "assistant";
      return {
        id: `message-${index}`,
        actor,
        icon: actor === "tool" ? Wrench : actor === "user" ? Bot : Bot,
        title: actor === "user" ? "You" : actor === "tool" ? "Tool result" : "Argon",
        body: contentToText(message.content),
        state: "done"
      };
    });
}

function handleRpcNotification(
  notification: RpcNotification,
  setItems: Dispatch<SetStateAction<TimelineViewItem[]>>,
  setRpc: Dispatch<SetStateAction<RpcUiState>>,
  setRpcLogs: Dispatch<SetStateAction<string[]>>
) {
  if (notification.method === "turn/completed") {
    const reason = String(notification.params.reason ?? "stop");
    setRpc((current) => ({ ...current, running: false, runId: undefined }));
    setItems((current) => finalizeActiveItems(current));
    setRpcLogs((logs) => appendLog(logs, `turn completed: ${reason}`));
    return;
  }
  if (notification.method === "rpc/error") {
    const message = readNestedMessage(notification.params.error) ?? "RPC error";
    setRpc((current) => ({ ...current, running: false, error: message }));
    setRpcLogs((logs) => appendLog(logs, `rpc error: ${message}`));
    return;
  }

  const event = notification.params.event as Record<string, unknown> | undefined;
  if (!event || typeof event.type !== "string") return;
  setRpcLogs((logs) => appendLog(logs, `event: ${event.type}`));

  if (event.type === "turn_start") {
    setRpc((current) => ({ ...current, running: true, error: undefined }));
    return;
  }
  if (event.type === "message_delta" && event.kind === "text") {
    const delta = typeof event.delta === "string" ? event.delta : "";
    if (!delta) return;
    setItems((current) => appendAssistantDelta(current, delta));
    return;
  }
  if (event.type === "message_delta" && event.kind === "thinking") {
    const delta = typeof event.delta === "string" ? event.delta : "";
    if (!delta) return;
    setItems((current) => appendThinkingDelta(current, delta));
    return;
  }
  if (event.type === "tool_call_end") {
    const toolCall = event.toolCall as Record<string, unknown> | undefined;
    if (!toolCall) return;
    setItems((current) => appendToolCall(current, toolCall));
    return;
  }
  if (event.type === "tool_result") {
    const toolCall = event.toolCall as Record<string, unknown> | undefined;
    const result = event.result as Record<string, unknown> | undefined;
    if (!toolCall || !result) return;
    setItems((current) => completeToolCall(current, toolCall, result));
  }
}

function appendAssistantDelta(items: TimelineViewItem[], delta: string): TimelineViewItem[] {
  const last = items[items.length - 1];
  if (last?.actor === "assistant" && last.state === "active") {
    return [...items.slice(0, -1), { ...last, body: `${last.body}${delta}` }];
  }
  return [
    ...items,
    {
      id: `assistant-${Date.now()}`,
      actor: "assistant",
      icon: Sparkles,
      title: "Argon",
      body: delta,
      state: "active"
    }
  ];
}

function appendThinkingDelta(items: TimelineViewItem[], delta: string): TimelineViewItem[] {
  const last = items[items.length - 1];
  if (last?.actor === "thinking" && last.state === "active") {
    return [...items.slice(0, -1), { ...last, body: `${last.body}${delta}` }];
  }
  return [
    ...items,
    {
      id: `thinking-${Date.now()}`,
      actor: "thinking",
      icon: Brain,
      title: "Thinking",
      body: delta,
      state: "active"
    }
  ];
}

function appendToolCall(items: TimelineViewItem[], toolCall: Record<string, unknown>): TimelineViewItem[] {
  const id = typeof toolCall.id === "string" ? toolCall.id : `tool-${Date.now()}-${items.length}`;
  const description = describeToolDisplay(toolCall);
  return [
    ...items,
    {
      id: `tool-${id}`,
      actor: "tool",
      icon: Wrench,
      title: description.title,
      body: description.body,
      meta: "running",
      state: "active",
      toolCallId: id
    }
  ];
}

function completeToolCall(
  items: TimelineViewItem[],
  toolCall: Record<string, unknown>,
  result: Record<string, unknown>
): TimelineViewItem[] {
  const id = typeof toolCall.id === "string" ? toolCall.id : undefined;
  const description = describeToolDisplay(toolCall, result);
  const nextItem: TimelineViewItem = {
    id: `tool-${id ?? Date.now()}`,
    actor: "tool",
    icon: Wrench,
    title: description.title,
    body: description.body,
    meta: result.isError ? "error" : "done",
    state: result.isError ? "muted" : "done",
    ...(id ? { toolCallId: id } : {})
  };
  if (!id) return [...items, nextItem];
  const index = items.findIndex((item) => item.toolCallId === id);
  if (index === -1) return [...items, nextItem];
  return [...items.slice(0, index), nextItem, ...items.slice(index + 1)];
}

function finalizeActiveItems(items: TimelineViewItem[]): TimelineViewItem[] {
  return items.map((item) => (item.state === "active" ? { ...item, state: "done", meta: item.actor === "tool" ? "done" : item.meta } : item));
}

function describeToolDisplay(toolCall: Record<string, unknown>, result?: Record<string, unknown>): { title: string; body: string } {
  const name = typeof toolCall.name === "string" ? toolCall.name : "tool";
  const args = isRecord(toolCall.arguments) ? toolCall.arguments : {};
  const isDone = result !== undefined;
  const isError = Boolean(result?.isError);
  const outcome = isError ? "failed" : isDone ? "done" : "running";
  const output = result ? compactLine(contentToText(result.content), 160) : "";

  if (name === "read" || name === "ls" || name === "grep") {
    return {
      title: outcome === "running" ? "Exploring" : isError ? "Explore failed" : "Explored",
      body: output || explorationDetail(name, args)
    };
  }
  if (name === "bash") {
    return {
      title: outcome === "running" ? "Running" : isError ? "Failed" : "Ran",
      body: output || quoteIfNeeded(summaryValue(args.command)) || "(empty command)"
    };
  }
  if (name === "write") {
    return {
      title: outcome === "running" ? "Writing" : isError ? "Write failed" : "Wrote",
      body: output || summaryValue(args.path) || "(missing path)"
    };
  }
  if (name === "edit") {
    return {
      title: outcome === "running" ? "Editing" : isError ? "Edit failed" : "Edited",
      body: output || summaryValue(args.path) || "(missing path)"
    };
  }
  return {
    title: outcome === "running" ? "Calling" : isError ? "Call failed" : "Called",
    body: output || `${name}(${compactLine(JSON.stringify(args), 120)})`
  };
}

function explorationDetail(name: string, args: Record<string, unknown>): string {
  if (name === "read") return `Read ${summaryValue(args.path) || "(missing path)"}`;
  if (name === "ls") return `List ${summaryValue(args.path) || "."}`;
  const pattern = summaryValue(args.pattern) || "(missing pattern)";
  const path = summaryValue(args.path);
  return `Search ${quoteIfNeeded(pattern)}${path ? ` in ${path}` : ""}`;
}

function summaryValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return String(value);
}

function quoteIfNeeded(value: string): string {
  if (!value) return "";
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

function compactLine(value: string, maxLength: number): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > maxLength ? `${line.slice(0, Math.max(0, maxLength - 3))}...` : line;
}

function modelDisplayName(model: RpcModel): string {
  return model.name || model.id;
}

function previewModels(model: RpcModel | undefined): RpcModel[] {
  return [
    model ?? { provider: "openai", id: "gpt-5.2-codex", name: "GPT-5 Codex" },
    { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet" },
    { provider: "local", id: "local-provider", name: "Local provider" }
  ];
}

function MarkdownContent({ text }: { text: string }) {
  return <div className="markdown-body">{renderMarkdownBlocks(text)}</div>;
}

function renderMarkdownBlocks(text: string): ReactNode[] {
  const lines = text.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) {
      index++;
      continue;
    }

    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const code: string[] = [];
      index++;
      while (index < lines.length && !lines[index]!.startsWith("```")) {
        code.push(lines[index]!);
        index++;
      }
      if (index < lines.length) index++;
      blocks.push(
        <pre key={`code-${index}`} className="markdown-code-block">
          {language ? <span className="markdown-code-language">{language}</span> : null}
          <code>{code.join("\n")}</code>
        </pre>
      );
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const className = level === 1 ? "markdown-h1" : level === 2 ? "markdown-h2" : "markdown-h3";
      blocks.push(
        <div key={`heading-${index}`} className={className}>
          {renderInlineMarkdown(heading[2]!)}
        </div>
      );
      index++;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: ReactNode[] = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index]!)) {
        items.push(<li key={`li-${index}`}>{renderInlineMarkdown(lines[index]!.replace(/^\s*[-*]\s+/, ""))}</li>);
        index++;
      }
      blocks.push(<ul key={`ul-${index}`}>{items}</ul>);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: ReactNode[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index]!)) {
        items.push(<li key={`oli-${index}`}>{renderInlineMarkdown(lines[index]!.replace(/^\s*\d+\.\s+/, ""))}</li>);
        index++;
      }
      blocks.push(<ol key={`ol-${index}`}>{items}</ol>);
      continue;
    }

    if (line.startsWith(">")) {
      const quote: string[] = [];
      while (index < lines.length && lines[index]!.startsWith(">")) {
        quote.push(lines[index]!.replace(/^>\s?/, ""));
        index++;
      }
      blocks.push(<blockquote key={`quote-${index}`}>{renderInlineMarkdown(quote.join(" "))}</blockquote>);
      continue;
    }

    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index]!.trim().length > 0 &&
      !lines[index]!.startsWith("```") &&
      !/^(#{1,3})\s+/.test(lines[index]!) &&
      !/^\s*[-*]\s+/.test(lines[index]!) &&
      !/^\s*\d+\.\s+/.test(lines[index]!) &&
      !lines[index]!.startsWith(">")
    ) {
      paragraph.push(lines[index]!);
      index++;
    }
    blocks.push(<p key={`p-${index}`}>{renderInlineMarkdown(paragraph.join(" "))}</p>);
  }

  return blocks;
}

function renderInlineMarkdown(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

function appendLog(logs: string[], line: string): string[] {
  return [...logs, line].slice(-200);
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (isRecord(part)) {
          if (typeof part.text === "string") return part.text;
          if (typeof part.content === "string") return part.content;
          if (typeof part.name === "string") return `[${part.name}]`;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content === undefined || content === null) return "";
  if (isRecord(content) && typeof content.text === "string") return content.text;
  return JSON.stringify(content, null, 2);
}

function readNestedMessage(value: unknown): string | undefined {
  return isRecord(value) && typeof value.message === "string" ? value.message : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/") || path;
}

function formatThreadTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "now";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

export default App;
