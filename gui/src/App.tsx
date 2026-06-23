import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import {
  Activity,
  Bell,
  Bot,
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
  Play,
  Search,
  SendHorizonal,
  Settings,
  SquareTerminal,
  StopCircle,
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
  listThreads,
  newThread,
  onRpcError,
  onRpcLog,
  onRpcNotification,
  resumeThread,
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
  actor: "user" | "assistant" | "tool";
  icon: LucideIcon;
  title: string;
  body: string;
  meta?: string;
  state?: "active" | "done" | "muted";
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

function App() {
  const [threads, setThreads] = useState<ThreadSummary[]>(() => threadGroups.flatMap((group) => group.threads));
  const [activeThreadId, setActiveThreadId] = useState("desktop-gui");
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(true);
  const [rightInspectorOpen, setRightInspectorOpen] = useState(true);
  const [composer, setComposer] = useState("");
  const [items, setItems] = useState<TimelineViewItem[]>(() => timeline);
  const [rpcLogs, setRpcLogs] = useState<string[]>(() => terminalLines);
  const [rpc, setRpc] = useState<RpcUiState>(() => ({ available: isTauriRuntime(), connected: false, running: false }));
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
    <main className="dark min-h-screen overflow-hidden bg-background text-foreground">
      <div className="flex h-screen flex-col bg-[radial-gradient(circle_at_50%_0%,color-mix(in_oklch,var(--primary)_10%,transparent),transparent_34%),var(--background)]">
        <TopBar
          activeThread={activeThread}
          leftSidebarOpen={leftSidebarOpen}
          rightInspectorOpen={rightInspectorOpen}
          rpc={rpc}
          onToggleLeftSidebar={() => setLeftSidebarOpen((open) => !open)}
          onToggleRightInspector={() => setRightInspectorOpen((open) => !open)}
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
              rpc={rpc}
              setComposer={setComposer}
              thread={activeThread}
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
  onToggleLeftSidebar,
  onToggleRightInspector
}: {
  activeThread: ThreadSummary;
  leftSidebarOpen: boolean;
  rightInspectorOpen: boolean;
  rpc: RpcUiState;
  onToggleLeftSidebar: () => void;
  onToggleRightInspector: () => void;
}) {
  const modelLabel = rpc.model ? `${rpc.model.provider}/${rpc.model.id}` : "GPT-5 Codex";
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="max-sm:w-10 max-sm:px-0">
              <span className="max-sm:hidden">{modelLabel}</span>
              <ChevronDown data-icon="inline-end" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              <DropdownMenuItem>GPT-5 Codex</DropdownMenuItem>
              <DropdownMenuItem>Claude Sonnet</DropdownMenuItem>
              <DropdownMenuItem>Local provider</DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
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
                    "group/thread flex items-start gap-1 rounded-md px-2.5 py-2 transition hover:bg-sidebar-accent",
                    activeThreadId === thread.id && "bg-sidebar-accent text-sidebar-accent-foreground"
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
  rpc,
  setComposer,
  thread,
  onSend,
  onStop
}: {
  composer: string;
  items: TimelineViewItem[];
  rpc: RpcUiState;
  setComposer: (value: string) => void;
  thread: ThreadSummary;
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
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onSend} disabled={rpc.running || composer.trim().length === 0}>
            <Play data-icon="inline-start" />
            {rpc.running ? "Running" : "Continue"}
          </Button>
          <Button variant="ghost" size="icon" aria-label="Stop run" onClick={onStop} disabled={!rpc.running}>
            <StopCircle />
          </Button>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-5 py-6">
          {rpc.error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {rpc.error}
            </div>
          ) : null}
          <div className="grid grid-cols-3 gap-2">
            {buildMetrics(items, rpc).map((metric) => (
              <div key={metric.label} className="rounded-md border bg-card/70 px-3 py-2">
                <div className="text-[11px] text-muted-foreground">{metric.label}</div>
                <div className="text-lg font-semibold">{metric.value}</div>
              </div>
            ))}
          </div>
          {items.length === 0 ? (
            <div className="rounded-md border bg-card/60 p-4 text-sm text-muted-foreground">
              This thread is empty. Ask Argon to change this project from the composer below.
            </div>
          ) : null}
          {items.map((item) => (
            <article key={item.id} className="group flex gap-3">
              <div
                className={cn(
                  "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border bg-card text-muted-foreground",
                  item.actor === "user" && "text-primary",
                  item.state === "active" && "border-primary/50 text-primary"
                )}
              >
                <item.icon className="size-4" />
              </div>
              <div className="min-w-0 flex-1 rounded-md border bg-card/65 p-3">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="truncate text-sm font-semibold">{item.title}</h2>
                  {item.meta ? <span className="shrink-0 text-[11px] text-muted-foreground">{item.meta}</span> : null}
                </div>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.body}</p>
              </div>
            </article>
          ))}
        </div>
      </ScrollArea>
      <Composer value={composer} running={rpc.running} onChange={setComposer} onSend={onSend} />
    </section>
  );
}

function Composer({
  value,
  running,
  onChange,
  onSend
}: {
  value: string;
  running: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
}) {
  return (
    <div className="shrink-0 border-t bg-background/95 p-4">
      <div className="mx-auto max-w-3xl rounded-lg border bg-card shadow-lg shadow-black/15">
        <Textarea
          className="min-h-20 resize-none border-0 bg-transparent p-3 text-sm shadow-none focus-visible:ring-0"
          placeholder="Ask Argon to change this project..."
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            onSend();
          }}
        />
        <div className="flex items-center justify-between border-t px-2 py-2">
          <div className="flex items-center gap-1 overflow-x-auto">
            {quickActions.slice(0, 5).map((action, index) => (
              <Button
                key={action.label}
                variant="ghost"
                size="sm"
                className={cn(index >= 3 && "max-sm:hidden")}
                onClick={() => onChange(action.label.toLowerCase())}
              >
                <action.icon data-icon="inline-start" />
                {action.label}
              </Button>
            ))}
          </div>
          <Button size="sm" onClick={onSend} disabled={running || value.trim().length === 0}>
            <SendHorizonal data-icon="inline-start" />
            {running ? "Running" : "Send"}
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
  if (event.type === "tool_call_end") {
    const toolCall = event.toolCall as Record<string, unknown> | undefined;
    const name = String(toolCall?.name ?? "tool");
    setItems((current) => [
      ...current,
      {
        id: `tool-${Date.now()}-${current.length}`,
        actor: "tool",
        icon: Wrench,
        title: `Tool call: ${name}`,
        body: contentToText(toolCall?.arguments),
        state: "done"
      }
    ]);
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
      icon: Bot,
      title: "Argon",
      body: delta,
      state: "active"
    }
  ];
}

function buildMetrics(items: TimelineViewItem[], rpc: RpcUiState) {
  return [
    { label: "Messages", value: String(items.filter((item) => item.actor !== "tool").length) },
    { label: "Tool calls", value: String(items.filter((item) => item.actor === "tool").length) },
    { label: "Runtime", value: rpc.connected ? (rpc.running ? "Live" : "Ready") : "Preview" }
  ];
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
