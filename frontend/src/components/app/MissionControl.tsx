import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertTriangle, Bot, Check, Clock, ClipboardList, ListPlus, MessageSquare, Play, Plus, RefreshCw, Save, Send, Square, Target, Trash2, X } from "lucide-react";
import {
  knownReasoningEfforts,
  loadCodexReasoningEfforts,
  normalizeReasoningEffort,
  type ReasoningEffort
} from "@/lib/api/codex";
import {
  createAgent,
  createAgentCronJob,
  clearConversationMessages,
  createConversation,
  createMessage,
  clearRuntimeHealth,
  deleteCronJob,
  getRuntimeHealth,
  listAgentCronJobs,
  listRunEvents,
  listRuns,
  listMessages,
  loadMissionControlRecords,
  runCronJobNow,
  stopConversationAgent,
  updateCronJob,
  updateAgent,
  type ApiAgent,
  type ApiConversation,
  type ApiConversationKind,
  type ApiCronJob,
  type ApiMessage,
  type ApiRun,
  type ApiRunEvent,
  type ApiRuntimeHealth
} from "@/lib/api/missionControl";
import { Sidebar } from "./Sidebar";
import { WindowChrome } from "./WindowChrome";
import {
  missionToolbar,
  normalizeAgentStatus,
  type AppAgent,
  type ConversationSummary,
  type MissionMessage
} from "./types";

type DataSource = "loading" | "api" | "unavailable";
type MessageLoadState = "idle" | "loading" | "error";
type DmRunLoadState = "idle" | "loading" | "error";
type DmSendMode = "queued" | "urgent";
type RunActionState = "idle" | "queued" | "urgent" | "stop";
type MessageRunPhase = "queued" | "running" | "thinking" | "done" | "error" | "unknown";
type RunEventMap = Record<string, ApiRunEvent[]>;
type JsonRecord = Record<string, unknown>;
type SidebarCreateKind = "agent" | "room";
type CodexStdoutEntry = {
  body: string;
  command: string;
  createdAt: string;
  id: string;
  output: string;
  rows: Array<{ label: string; value: string }>;
  title: string;
};
type TraceEventSummary = {
  label: string;
  summary: string;
};

const agentModelOptions = ["gpt-5.5", "gpt-5.5-mini", "gpt-5-codex", "gpt-5.1"];

export function MissionControl() {
  const [agentRows, setAgentRows] = useState<AppAgent[]>([]);
  const [conversationRows, setConversationRows] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState("");
  const [messages, setMessages] = useState<MissionMessage[]>([]);
  const [dataSource, setDataSource] = useState<DataSource>("loading");
  const [notice, setNotice] = useState<string | null>(null);
  const [messageLoadState, setMessageLoadState] = useState<MessageLoadState>("idle");
  const [isSendingMessage, setIsSendingMessage] = useState(false);
  const [dmRuns, setDmRuns] = useState<ApiRun[]>([]);
  const [sidebarRuns, setSidebarRuns] = useState<ApiRun[]>([]);
  const [runEventsByRunId, setRunEventsByRunId] = useState<RunEventMap>({});
  const [dmRunLoadState, setDmRunLoadState] = useState<DmRunLoadState>("idle");
  const [runActionState, setRunActionState] = useState<RunActionState>("idle");
  const [runRefreshToken, setRunRefreshToken] = useState(0);
  const [sidebarRunRefreshToken, setSidebarRunRefreshToken] = useState(0);
  const [runtimeHealth, setRuntimeHealth] = useState<ApiRuntimeHealth | null>(null);
  const [runtimeHealthClearBusy, setRuntimeHealthClearBusy] = useState(false);
  const [agentSetupOpen, setAgentSetupOpen] = useState(false);
  const [sidebarCreateKind, setSidebarCreateKind] = useState<SidebarCreateKind | null>(null);
  const [mobileListOpen, setMobileListOpen] = useState(false);
  const [mobileRunSheetOpen, setMobileRunSheetOpen] = useState(false);
  const [traceModalRunId, setTraceModalRunId] = useState<string | null>(null);
  const [traceModalMessageId, setTraceModalMessageId] = useState<string | null>(null);
  const [traceModalEvents, setTraceModalEvents] = useState<ApiRunEvent[]>([]);
  const [traceModalLoadState, setTraceModalLoadState] = useState<MessageLoadState>("idle");
  const recordsAbortRef = useRef<AbortController | null>(null);
  const messageAbortRef = useRef<AbortController | null>(null);
  const runAbortRef = useRef<AbortController | null>(null);
  const sidebarRunAbortRef = useRef<AbortController | null>(null);
  const runtimeHealthAbortRef = useRef<AbortController | null>(null);
  const messageLogRef = useRef<HTMLDivElement | null>(null);

  const reloadMissionControlRecords = useCallback((showLoading: boolean) => {
    recordsAbortRef.current?.abort();
    const controller = new AbortController();
    recordsAbortRef.current = controller;

    if (showLoading) {
      setDataSource("loading");
    }

    loadMissionControlRecords(controller.signal)
      .then((records) => {
        if (controller.signal.aborted) {
          return;
        }

        const nextAgents = records.agents.map(mapApiAgent);
        const nextConversations = records.conversations.map(mapApiConversation);
        const activeConversationId =
          conversationIdFromHash(nextConversations) ?? records.activeConversation?.id ?? nextConversations[0]?.id ?? "";

        setAgentRows(nextAgents);
        setConversationRows(nextConversations);
        setActiveConversationId(activeConversationId);
        setMessages(mapApiMessages(records.messages, nextAgents));
        setDataSource("api");
        setNotice(null);
        setMessageLoadState("idle");
        recordsAbortRef.current = null;
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) {
          return;
        }

        setAgentRows([]);
        setConversationRows([]);
        setActiveConversationId("");
        setMessages([]);
        setDataSource("unavailable");
        setNotice("API unavailable. Start the backend to load shared rooms and agents.");
        setMessageLoadState("idle");
        recordsAbortRef.current = null;
      });
  }, []);

  const handleOnboardingInitialized = useCallback(() => {
    setNotice("Onboarding initialized. Refreshing workspace records...");
    reloadMissionControlRecords(false);
  }, [reloadMissionControlRecords]);

  const reloadRuntimeHealth = useCallback(() => {
    runtimeHealthAbortRef.current?.abort();
    const controller = new AbortController();
    runtimeHealthAbortRef.current = controller;

    getRuntimeHealth(controller.signal)
      .then((health) => {
        if (controller.signal.aborted) {
          return;
        }
        setRuntimeHealth(health);
        runtimeHealthAbortRef.current = null;
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) {
          return;
        }
        setRuntimeHealth(null);
        runtimeHealthAbortRef.current = null;
      });
  }, []);

  const handleClearRuntimeHealth = useCallback(() => {
    setRuntimeHealthClearBusy(true);
    clearRuntimeHealth()
      .then((health) => {
        setRuntimeHealth(health);
        setNotice(null);
      })
      .catch((error: unknown) => {
        if (!isAbortError(error)) {
          setNotice("Could not clear runtime health. Check backend logs.");
        }
      })
      .finally(() => {
        setRuntimeHealthClearBusy(false);
      });
  }, []);

  useEffect(() => {
    function handleHashChange() {
      if (window.location.hash === "#chats") {
        setMobileListOpen(true);
        return;
      }

      const conversationId = conversationIdFromHash(conversationRows);
      if (conversationId) {
        setMobileListOpen(false);
        handleSelectConversation(conversationId);
      }
    }

    window.addEventListener("hashchange", handleHashChange);
    handleHashChange();
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, [conversationRows]);

  useEffect(() => {
    reloadMissionControlRecords(true);

    return () => {
      recordsAbortRef.current?.abort();
      messageAbortRef.current?.abort();
      runAbortRef.current?.abort();
      sidebarRunAbortRef.current?.abort();
      runtimeHealthAbortRef.current?.abort();
    };
  }, [reloadMissionControlRecords]);

  useEffect(() => {
    reloadRuntimeHealth();
    const intervalId = window.setInterval(reloadRuntimeHealth, 5000);

    return () => {
      window.clearInterval(intervalId);
      runtimeHealthAbortRef.current?.abort();
    };
  }, [reloadRuntimeHealth]);

  const activeConversation =
    conversationRows.find((conversation) => conversation.id === activeConversationId) ?? null;
  const activeDmAgent = activeConversation ? agentForDm(activeConversation, agentRows) : null;
  const activeDmRun = firstActiveRun(dmRuns);
  const queuedDmRuns = queuedRuns(dmRuns);
  const visibleDmRuns = sortRunsForDisplay(dmRuns);
  const knownRuns = useMemo(() => mergeRunsById(sidebarRuns, dmRuns), [sidebarRuns, dmRuns]);
  const runsById = useMemo(() => new Map(knownRuns.map((run) => [run.id, run])), [knownRuns]);
  const traceModalRun = traceModalRunId ? runsById.get(traceModalRunId) ?? null : null;
  const traceModalMessage =
    traceModalMessageId
      ? messages.find((message) => message.id === traceModalMessageId) ?? null
      : traceModalRunId
        ? messages.find((message) => effectiveMessageRunId(message, activeConversation, knownRuns) === traceModalRunId) ?? null
        : null;
  const sidebarAgentRows = useMemo(
    () => agentsWithRunStatus(agentRows, sidebarRuns),
    [agentRows, sidebarRuns]
  );
  const isDmConversation = activeConversation?.kind === "dm";
  const composerBusy = isSendingMessage || runActionState !== "idle";
  const sidebarNotice = dataSource === "loading" ? "Connecting to API..." : notice;
  const sourceLabelBase =
    dataSource === "loading" ? "Connecting" : dataSource === "api" ? "API OK" : "API unavailable";
  const runtimeIssue = runtimeHealth?.issue ?? null;
  const sourceLabel =
    runtimeIssue === "database_locked"
      ? "DB LOCKED"
      : runtimeIssue
        ? "Runtime warning"
        : sourceLabelBase;
  const sourceTitle = runtimeHealth?.message ?? sourceLabel;
  const onlineAgents = sidebarAgentRows.filter((agent) => agent.status !== "offline").length;
  const activeAgentCount = sidebarAgentRows.filter((agent) => agent.status === "working" || agent.status === "reviewing").length;

  useEffect(() => {
    sidebarRunAbortRef.current?.abort();

    if (dataSource !== "api") {
      setSidebarRuns([]);
      return;
    }

    const controller = new AbortController();
    sidebarRunAbortRef.current = controller;

    loadSidebarRuns(controller.signal)
      .then((runs) => {
        if (controller.signal.aborted) {
          return;
        }

        setSidebarRuns(sortRunsForDisplay(runs));
        sidebarRunAbortRef.current = null;
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) {
          return;
        }

        setSidebarRuns([]);
        sidebarRunAbortRef.current = null;
      });

    return () => controller.abort();
  }, [dataSource, runRefreshToken, sidebarRunRefreshToken]);

  useEffect(() => {
    if (dataSource !== "api") {
      return;
    }

    const intervalId = window.setInterval(() => {
      setSidebarRunRefreshToken((value) => value + 1);
    }, 5000);

    return () => window.clearInterval(intervalId);
  }, [dataSource]);

  useEffect(() => {
    runAbortRef.current?.abort();

    if (!activeConversation || activeConversation.kind !== "dm" || dataSource === "loading") {
      setDmRuns([]);
      setRunEventsByRunId({});
      setDmRunLoadState("idle");
      return;
    }

    const controller = new AbortController();
    runAbortRef.current = controller;
    setDmRunLoadState("loading");

    loadDmRuntime(activeConversation.id, controller.signal)
      .then((runtime) => {
        if (controller.signal.aborted) {
          return;
        }

        setDmRuns(runtime.runs);
        setRunEventsByRunId(runtime.eventsByRunId);
        setDmRunLoadState("idle");
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) {
          return;
        }

        setDmRuns([]);
        setRunEventsByRunId({});
        setDmRunLoadState("error");
        setNotice("Run status unavailable for selected DM.");
      });

    return () => controller.abort();
  }, [activeConversation, dataSource, runRefreshToken]);

  useEffect(() => {
    if (!activeConversation || dataSource !== "api") {
      return;
    }

    const intervalId = window.setInterval(() => {
      void refreshConversationMessages(activeConversation.id);
      if (activeConversation.kind === "dm") {
        setRunRefreshToken((value) => value + 1);
      }
    }, 3000);

    return () => window.clearInterval(intervalId);
  }, [activeConversation, activeConversationId, agentRows, dataSource]);

  useEffect(() => {
    if (activeConversation?.kind !== "dm" || messageLoadState === "loading") {
      return;
    }

    const messageLog = messageLogRef.current;
    if (!messageLog) {
      return;
    }

    let frameId = 0;
    const timeoutIds: number[] = [];
    const scrollToBottom = () => {
      messageLog.scrollTop = messageLog.scrollHeight;
    };
    const scheduleScroll = () => {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(scrollToBottom);
    };
    const resizeObserver = new ResizeObserver(scheduleScroll);

    scrollToBottom();
    scheduleScroll();
    timeoutIds.push(window.setTimeout(scheduleScroll, 50));
    resizeObserver.observe(messageLog);

    return () => {
      window.cancelAnimationFrame(frameId);
      timeoutIds.forEach((timeoutId) => window.clearTimeout(timeoutId));
      resizeObserver.disconnect();
    };
  }, [activeConversation?.id, activeConversation?.kind, messageLoadState, messages.length]);

  useEffect(() => {
    if (!traceModalRunId) {
      setTraceModalEvents([]);
      setTraceModalLoadState("idle");
      setTraceModalMessageId(null);
      return;
    }

    const controller = new AbortController();
    setTraceModalLoadState("loading");

    listRunEvents(traceModalRunId, controller.signal, 1000)
      .then((events) => {
        if (controller.signal.aborted) {
          return;
        }

        setTraceModalEvents(events);
        setTraceModalLoadState("idle");
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) {
          return;
        }

        setTraceModalLoadState("error");
      });

    return () => controller.abort();
  }, [traceModalRunId, runRefreshToken]);

  useEffect(() => {
    closeMessageTrace();
  }, [activeConversation?.id]);

  function handleSelectConversation(conversationId: string) {
    setMobileListOpen(false);
    setActiveConversationId(conversationId);
    setConversationHash(conversationId);

    messageAbortRef.current?.abort();
    const controller = new AbortController();
    messageAbortRef.current = controller;
    setMessages([]);
    setNotice(null);
    setMessageLoadState("loading");

    listMessages(conversationId, controller.signal)
      .then((nextMessages) => {
        setMessages(mapApiMessages(nextMessages, agentRows));
        setNotice(null);
        setMessageLoadState("idle");
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) {
          return;
        }

        setMessages([]);
        setMessageLoadState("error");
        setNotice("Messages unavailable for selected room.");
      });
  }

  function openMessageTrace(runId: string | null, messageId: string) {
    if (!runId) {
      return;
    }

    setTraceModalEvents(runEventsByRunId[runId] ?? []);
    setTraceModalLoadState("loading");
    setTraceModalMessageId(messageId);
    setTraceModalRunId(runId);
  }

  function closeMessageTrace() {
    setTraceModalRunId(null);
    setTraceModalMessageId(null);
  }

  async function sendChannelMessage(body: string): Promise<boolean> {
    if (!body || !activeConversation || composerBusy) {
      return false;
    }

    setIsSendingMessage(true);
    try {
      const message = await createMessage(activeConversation.id, body);
      setMessages((currentMessages) => [
        ...currentMessages,
        ...mapApiMessages([message], agentRows)
      ]);
      setNotice(null);
      return true;
    } catch {
      setNotice("Message send failed; draft restored.");
      return false;
    } finally {
      setIsSendingMessage(false);
    }
  }

  async function refreshConversationMessages(conversationId: string) {
    try {
      const nextMessages = await listMessages(conversationId);
      if (activeConversationId === conversationId) {
        setMessages(mapApiMessages(nextMessages, agentRows));
      }
    } catch {
      // Keep the current transcript during transient runtime refresh failures.
    }
  }

  async function sendDmPrompt(prompt: string, mode: DmSendMode): Promise<boolean> {
    if (!prompt || !activeConversation || !activeDmAgent || composerBusy) {
      return false;
    }

    const conversationId = activeConversation.id;

    setIsSendingMessage(true);
    setRunActionState(mode);

    try {
      const message = await createMessage(conversationId, prompt, {
        delivery_mode: mode === "queued" ? "queue" : "urgent"
      });
      setMessages((currentMessages) => [
        ...currentMessages,
        ...mapApiMessages([message], agentRows)
      ]);

      setNotice(null);
      setRunRefreshToken((value) => value + 1);
      return true;
    } catch {
      setNotice("DM send failed; draft restored.");
      return false;
    } finally {
      setIsSendingMessage(false);
      setRunActionState("idle");
    }
  }

  async function handleStopActiveRun() {
    if (!activeConversation || !activeDmRun || runActionState !== "idle") {
      return;
    }

    setRunActionState("stop");
    try {
      const response = await stopConversationAgent(activeConversation.id);
      setNotice(response.interrupted ? null : "No active runtime process acknowledged the stop request.");
      setRunRefreshToken((value) => value + 1);
    } catch {
      setNotice("Stop failed; active run is still reported by the backend.");
    } finally {
      setRunActionState("idle");
    }
  }

  function handleAgentSetupSaved(agent: ApiAgent) {
    setNotice(`${agent.name} setup saved.`);
    reloadMissionControlRecords(false);
  }

  function handleAgentHistoryCleared(agentId: string, deletedMessages: number) {
    const conversationId = `dm_${agentId}`;
    if (activeConversationId === conversationId) {
      setMessages([]);
    }
    setNotice(`Deleted ${deletedMessages} DM message${deletedMessages === 1 ? "" : "s"}.`);
    reloadMissionControlRecords(false);
  }

  function handleSidebarCreated(record: ApiAgent | ApiConversation) {
    setMobileListOpen(false);
    if ("kind" in record) {
      setNotice(`Created room #${record.name}.`);
      setConversationHash(record.id);
      setActiveConversationId(record.id);
      setMessages([]);
    } else {
      const conversationId = `dm_${record.id}`;
      setNotice(`Created ${record.name} and opened their DM.`);
      setConversationHash(conversationId);
      setActiveConversationId(conversationId);
      setMessages([]);
    }

    reloadMissionControlRecords(false);
  }

  return (
    <WindowChrome
      onOnboardingInitialized={handleOnboardingInitialized}
      title="Agent Adda - Mission Control"
      toolbar={missionToolbar}
      statusItems={
        <>
          <StatusCell>{onlineAgents} agents online</StatusCell>
          <StatusCell>{activeAgentCount} agents active</StatusCell>
          <StatusCell variant={runtimeIssue ? "error" : undefined} title={sourceTitle}>
            <span className="min-w-0 truncate">{sourceLabel}</span>
            {runtimeHealth?.clearable ? (
              <button
                className="aa-statusbar-clear win-button shrink-0"
                disabled={runtimeHealthClearBusy}
                onClick={handleClearRuntimeHealth}
                type="button"
              >
                Clear
              </button>
            ) : null}
          </StatusCell>
        </>
      }
    >
      <div className="h-full min-h-0 p-0 md:flex md:gap-1 md:p-1">
        <Sidebar
          activeConversationId={activeConversationId}
          agents={sidebarAgentRows}
          className="hidden md:flex"
          conversations={conversationRows}
          loading={dataSource === "loading"}
          notice={sidebarNotice}
          onCreateAgent={() => setSidebarCreateKind("agent")}
          onCreateRoom={() => setSidebarCreateKind("room")}
          onSelectConversation={handleSelectConversation}
        />
        <div className={`${mobileListOpen ? "flex" : "hidden"} h-full min-h-0 md:hidden`}>
          <Sidebar
            activeConversationId={activeConversationId}
            agents={sidebarAgentRows}
            className="h-full text-[12px]"
            conversations={conversationRows}
            loading={dataSource === "loading"}
            notice={sidebarNotice}
            onCreateAgent={() => setSidebarCreateKind("agent")}
            onCreateRoom={() => setSidebarCreateKind("room")}
            onSelectConversation={handleSelectConversation}
          />
        </div>
        <section className={`${mobileListOpen ? "hidden md:flex" : "flex"} win-panel h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:min-h-[320px]`}>
          <div className="win-titlebar min-w-0 justify-between gap-1">
            <button
              aria-label="Open chats"
              className="win-button flex h-6 min-h-0 shrink-0 items-center gap-1 px-2 py-0 text-[11px] md:hidden"
              onClick={() => setMobileListOpen(true)}
              type="button"
            >
              <MessageSquare size={13} />
              <span>Chats</span>
            </button>
            <span className="min-w-0 flex-1 truncate">
              {activeConversation ? conversationTitle(activeConversation) : "Mission Control"}
            </span>
            {isDmConversation ? (
              <button
                aria-label="Open active run"
                className="win-button flex h-6 min-h-0 max-w-[128px] shrink-0 items-center gap-1 px-2 py-0 text-[11px] md:hidden"
                onClick={() => setMobileRunSheetOpen(true)}
                type="button"
              >
                <span className={`status-dot ${runtimeStateStatusClass(activeDmRun, queuedDmRuns.length)}`} />
                <span className="truncate">{activeDmRun ? runStatusLabel(activeDmRun.status) : queuedDmRuns.length > 0 ? `${queuedDmRuns.length} queued` : "Idle"}</span>
              </button>
            ) : null}
          </div>
          <div className="hidden min-h-10 flex-wrap items-start gap-2 border-b border-[#777] bg-[#e6e6e6] px-3 py-2 md:flex">
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--adda-muted)]">Topic</div>
              <div className="min-w-0 truncate text-sm sm:text-[15px]">
                {activeConversation?.topic || (dataSource === "loading" ? "Loading rooms..." : "No active room.")}
              </div>
            </div>
            {isDmConversation && activeDmAgent ? (
              <button
                className="win-button flex h-8 min-h-0 shrink-0 items-center gap-1 px-2 max-sm:w-full max-sm:justify-center"
                onClick={() => setAgentSetupOpen(true)}
                type="button"
              >
                <ClipboardList size={16} />
                <span>Setup</span>
              </button>
            ) : null}
          </div>
          <div
            aria-label="Conversation messages"
            className="app-scrollbar min-h-0 flex-1 overflow-auto bg-[#f7f7f7]"
            data-aa-message-log
            ref={messageLogRef}
            style={{ overflowAnchor: "none" }}
          >
            {messageLoadState === "loading" ? (
              <MessageStateRow kind="loading" title="Loading messages..." />
            ) : null}
            {messageLoadState === "error" ? (
              <MessageStateRow kind="error" title="Messages unavailable." detail="Select another room or retry after the API is reachable." />
            ) : null}
            {!activeConversation && messageLoadState !== "loading" ? (
              <MessageStateRow kind="empty" title="No room selected." detail="Rooms from the backend will appear in the sidebar." />
            ) : null}
            {activeConversation && messages.length === 0 && messageLoadState === "idle" ? (
              <MessageStateRow kind="empty" title="No messages in this room yet." />
            ) : null}
            {messages.map((message) => {
              const traceRunId = effectiveMessageRunId(message, activeConversation, knownRuns);
              const run = traceRunId ? runsById.get(traceRunId) ?? null : null;
              const runPhase = messageRunPhase(traceRunId, run, dmRunLoadState);
              const traceAvailable = Boolean(traceRunId);
              const messageBody = visibleMessageMarkdown(message.body);

              return (
                <article
                  className={`grid grid-cols-[30px_minmax(0,1fr)] gap-2 border-b border-[#bbb] p-2 text-[12px] sm:grid-cols-[78px_54px_minmax(0,1fr)] sm:p-3 sm:text-[15px] ${
                    traceAvailable ? "cursor-pointer hover:bg-[#ececec] focus:bg-[#ececec] focus:outline focus:outline-2 focus:outline-[var(--adda-blue)]" : ""
                  }`}
                  aria-label={traceAvailable ? `${message.author}: ${messageBody}. Open Codex thinking trace.` : undefined}
                  data-aa-message-run-id={traceRunId ?? undefined}
                  key={message.id}
                  onClick={traceAvailable ? () => openMessageTrace(traceRunId, message.id) : undefined}
                  onKeyDown={
                    traceAvailable
                      ? (event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            openMessageTrace(traceRunId, message.id);
                          }
                        }
                      : undefined
                  }
                  role={traceAvailable ? "button" : undefined}
                  tabIndex={traceAvailable ? 0 : undefined}
                  title={traceAvailable ? "Open Codex thinking and stdout" : undefined}
                >
                  <time className="col-span-2 text-[10px] font-medium tracking-[0.02em] text-[var(--adda-muted)] tabular-nums sm:col-span-1 sm:text-sm sm:text-black">{message.time}</time>
                  <div className="relative grid h-8 w-8 place-items-center border border-[#777] bg-[#d9d9d9] sm:h-10 sm:w-10">
                    {message.human ? <span className="text-base sm:text-xl">A</span> : <Bot size={20} className="sm:h-6 sm:w-6" />}
                    {!message.human && message.status ? (
                      <span className={`status-dot ${agentRuntimeStatusClass(message.status)} absolute -right-1 -top-1`} />
                    ) : null}
                  </div>
                  <div className="min-w-0">
                    <h3 className="flex min-w-0 flex-wrap items-center gap-2 font-bold">
                      <span className="min-w-0 truncate">{message.author}</span>
                      {traceRunId ? (
                        <span
                          className={`status-dot shrink-0 ${messageRunStatusClass(runPhase)}`}
                          data-aa-message-run-status={runPhase}
                          title={messageRunStatusLabel(runPhase)}
                        />
                      ) : null}
                      {traceAvailable ? (
                        <span className="shrink-0 border border-[#777] bg-[#e8e8e8] px-1 py-0.5 text-[10px] font-normal leading-none text-black shadow-[inset_1px_1px_0_#fff] sm:px-1.5 sm:text-xs">
                          Open trace
                        </span>
                      ) : null}
                    </h3>
                    <MessageMarkdown body={messageBody} />
                  </div>
                </article>
              );
            })}
          </div>
          <ConversationComposer
            activeConversation={activeConversation}
            activeDmAgent={activeDmAgent}
            activeDmRun={activeDmRun}
            busy={composerBusy}
            isDmConversation={Boolean(isDmConversation)}
            onSendChannel={sendChannelMessage}
            onSendDmPrompt={sendDmPrompt}
            onStopActiveRun={handleStopActiveRun}
            runActionState={runActionState}
          />
          <details className="hidden border-t border-[#777] bg-[#d8d8d8] md:block xl:hidden" open={Boolean(activeDmRun || queuedDmRuns.length)}>
            <summary className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 font-bold">
              <span>Run Queue & Mission</span>
              <span className="text-xs font-normal text-[var(--adda-muted)]">
                {activeDmRun ? runStatusLabel(activeDmRun.status) : queuedDmRuns.length > 0 ? `${queuedDmRuns.length} queued` : "Idle"}
              </span>
            </summary>
            <div className="grid gap-3 border-t border-[#777] bg-[#efefef] p-3 sm:grid-cols-2">
              <div className="win-panel-inset p-3">
                <h3 className="mb-2 font-bold">Runtime state</h3>
                <div className="flex items-center gap-2">
                  <span className={`status-dot ${runtimeStateStatusClass(activeDmRun, queuedDmRuns.length)}`} />
                  <span>{activeDmRun ? runStatusLabel(activeDmRun.status) : queuedDmRuns.length > 0 ? `${queuedDmRuns.length} queued` : "Idle"}</span>
                </div>
              </div>
              <div className="win-panel-inset p-3">
                <h3 className="mb-2 font-bold">Current Goal</h3>
                <p className="break-words text-sm leading-snug">
                  {activeDmRun ? runShortLabel(activeDmRun) : activeConversation?.topic || "Open an agent DM to inspect the active mission thread."}
                </p>
              </div>
              <div className="win-panel-inset p-3 sm:col-span-2">
                <h3 className="mb-2 flex items-center gap-2 font-bold">
                  <span
                    className={`status-dot ${runQueueStatusClass(dmRunLoadState, activeDmRun, queuedDmRuns.length, isDmConversation)}`}
                    title={runQueueStatusLabel(dmRunLoadState, activeDmRun, queuedDmRuns.length, isDmConversation)}
                  />
                  <span>Run Queue</span>
                </h3>
                {activeDmRun ? <RunQueueRow run={activeDmRun} marker="active" /> : null}
                {queuedDmRuns.length > 0 ? (
                  queuedDmRuns.map((run, index) => (
                    <RunQueueRow key={run.id} run={run} marker={`${index + 1}`} />
                  ))
                ) : !activeDmRun ? (
                  <div className="flex min-h-8 items-center gap-2 border-b border-[#bbb]">
                    <span className="h-4 w-4 shrink-0 rounded-full border border-[#777]" />
                    <span className="min-w-0 break-words text-sm">
                      {isDmConversation ? "No queued DM runs." : "Open an agent DM to queue runs."}
                    </span>
                  </div>
                ) : null}
              </div>
            </div>
          </details>
        </section>
        <aside className="win-panel hidden w-[312px] shrink-0 flex-col overflow-hidden xl:flex">
          <div className="win-titlebar">Active Run</div>
          <div className="app-scrollbar min-h-0 space-y-3 overflow-auto p-3">
            <div className="flex items-center gap-3">
              <Target size={38} />
              <div>
                <div className="max-w-[220px] truncate">Run: {activeDmRun ? runShortLabel(activeDmRun) : isDmConversation ? "No active run" : "Select a DM"}</div>
                <div>Status: <span className="text-[var(--adda-blue)]">{activeDmRun ? runStatusLabel(activeDmRun.status) : queuedDmRuns.length > 0 ? `${queuedDmRuns.length} queued` : "Idle"}</span></div>
              </div>
            </div>
            <div className="win-panel-inset p-2">
              <span>Runtime state:</span>
              <div className="mt-1 flex items-center gap-2">
                <span className={`status-dot ${runtimeStateStatusClass(activeDmRun, queuedDmRuns.length)}`} />
                <span>{activeDmRun ? runStatusLabel(activeDmRun.status) : queuedDmRuns.length > 0 ? `${queuedDmRuns.length} queued` : "Idle"}</span>
              </div>
            </div>
            <div className="win-panel-inset p-3">
              <h3 className="mb-2 font-bold">Current Goal</h3>
              <div className="flex gap-3">
                <Target size={42} className="shrink-0" />
                <p className="min-w-0 break-words">
                  {activeDmRun ? runShortLabel(activeDmRun) : activeConversation?.topic || "Select a DM to inspect the active mission thread."}
                </p>
              </div>
            </div>
            <div className="win-panel-inset p-3">
              <h3 className="mb-2 flex items-center gap-2 font-bold">
                <span
                  className={`status-dot ${runQueueStatusClass(dmRunLoadState, activeDmRun, queuedDmRuns.length, isDmConversation)}`}
                  title={runQueueStatusLabel(dmRunLoadState, activeDmRun, queuedDmRuns.length, isDmConversation)}
                />
                <span>Run Queue</span>
              </h3>
              {activeDmRun ? <RunQueueRow run={activeDmRun} marker="active" /> : null}
              {queuedDmRuns.length > 0 ? (
                queuedDmRuns.map((run, index) => (
                  <RunQueueRow key={run.id} run={run} marker={`${index + 1}`} />
                ))
              ) : !activeDmRun ? (
                <div className="flex min-h-8 items-center gap-2 border-b border-[#bbb]">
                  <span className="h-4 w-4 shrink-0 rounded-full border border-[#777]" />
                  <span className="min-w-0 break-words">
                    {isDmConversation ? "No queued DM runs." : "Open an agent DM to queue runs."}
                  </span>
                </div>
              ) : null}
            </div>
            <div className="win-panel-inset p-3">
              <h3 className="font-bold">Thinking</h3>
              {visibleDmRuns.length > 0 ? (
                <div className="mt-2 grid gap-2">
                  {visibleDmRuns.map((run) => (
                    <RunTraceDetails
                      events={runEventsByRunId[run.id] ?? []}
                      key={run.id}
                      run={run}
                    />
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-sm text-[var(--adda-muted)]">
                  {isDmConversation ? "No trace events for this DM." : "Trace appears per agent DM run."}
                </p>
              )}
            </div>
          </div>
        </aside>
      </div>
      <MobileRunSheet
        activeConversation={activeConversation}
        activeDmRun={activeDmRun}
        dmRunLoadState={dmRunLoadState}
        isDmConversation={isDmConversation}
        onClose={() => setMobileRunSheetOpen(false)}
        open={mobileRunSheetOpen}
        queuedDmRuns={queuedDmRuns}
        runEventsByRunId={runEventsByRunId}
        visibleDmRuns={visibleDmRuns}
      />
      <AgentSetupModal
        agent={activeDmAgent}
        onClose={() => setAgentSetupOpen(false)}
        onHistoryCleared={handleAgentHistoryCleared}
        onSaved={handleAgentSetupSaved}
        open={agentSetupOpen && Boolean(activeDmAgent)}
      />
      <SidebarCreateModal
        kind={sidebarCreateKind}
        onClose={() => setSidebarCreateKind(null)}
        onCreated={handleSidebarCreated}
      />
      <MessageTraceModal
        events={traceModalEvents}
        loadState={traceModalLoadState}
        message={traceModalMessage}
        onClose={closeMessageTrace}
        open={Boolean(traceModalRunId)}
        run={traceModalRun}
        runId={traceModalRunId}
      />
    </WindowChrome>
  );
}

function MobileRunSheet({
  activeConversation,
  activeDmRun,
  dmRunLoadState,
  isDmConversation,
  onClose,
  open,
  queuedDmRuns,
  runEventsByRunId,
  visibleDmRuns,
}: {
  activeConversation: ConversationSummary | null;
  activeDmRun: ApiRun | null;
  dmRunLoadState: DmRunLoadState;
  isDmConversation: boolean;
  onClose: () => void;
  open: boolean;
  queuedDmRuns: ApiRun[];
  runEventsByRunId: RunEventMap;
  visibleDmRuns: ApiRun[];
}) {
  if (!open) {
    return null;
  }

  return (
    <div className="aa-mobile-sheet-backdrop md:hidden" role="presentation" onClick={onClose}>
      <section
        aria-label="Active run and queue"
        className="aa-mobile-sheet"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="win-titlebar justify-between">
          <span>Run Queue & Mission</span>
          <button
            aria-label="Close active run"
            className="win-button grid h-6 min-h-0 w-7 place-items-center p-0"
            onClick={onClose}
            type="button"
          >
            <X size={13} />
          </button>
        </div>
        <div className="app-scrollbar max-h-[60vh] overflow-auto p-2 text-[12px]">
          <div className="win-panel-inset mb-2 p-2">
            <h3 className="mb-1 font-bold">Runtime state</h3>
            <div className="flex items-center gap-2">
              <span className={`status-dot ${runtimeStateStatusClass(activeDmRun, queuedDmRuns.length)}`} />
              <span>{activeDmRun ? runStatusLabel(activeDmRun.status) : queuedDmRuns.length > 0 ? `${queuedDmRuns.length} queued` : "Idle"}</span>
            </div>
          </div>
          <div className="win-panel-inset mb-2 p-2">
            <h3 className="mb-1 font-bold">Current Goal</h3>
            <p className="break-words leading-snug">
              {activeDmRun ? runShortLabel(activeDmRun) : activeConversation?.topic || "Open an agent DM to inspect the active mission thread."}
            </p>
          </div>
          <div className="win-panel-inset mb-2 p-2">
            <h3 className="mb-1 flex items-center gap-2 font-bold">
              <span
                className={`status-dot ${runQueueStatusClass(dmRunLoadState, activeDmRun, queuedDmRuns.length, isDmConversation)}`}
                title={runQueueStatusLabel(dmRunLoadState, activeDmRun, queuedDmRuns.length, isDmConversation)}
              />
              <span>Run Queue</span>
            </h3>
            {activeDmRun ? <RunQueueRow run={activeDmRun} marker="active" /> : null}
            {queuedDmRuns.length > 0 ? (
              queuedDmRuns.map((run, index) => (
                <RunQueueRow key={run.id} run={run} marker={`${index + 1}`} />
              ))
            ) : !activeDmRun ? (
              <div className="flex min-h-8 items-center gap-2 border-b border-[#bbb]">
                <span className="h-4 w-4 shrink-0 rounded-full border border-[#777]" />
                <span className="min-w-0 break-words">
                  {isDmConversation ? "No queued DM runs." : "Open an agent DM to queue runs."}
                </span>
              </div>
            ) : null}
          </div>
          <div className="win-panel-inset p-2">
            <h3 className="font-bold">Thinking</h3>
            {visibleDmRuns.length > 0 ? (
              <div className="mt-2 grid gap-2">
                {visibleDmRuns.map((run) => (
                  <RunTraceDetails
                    events={runEventsByRunId[run.id] ?? []}
                    key={run.id}
                    run={run}
                  />
                ))}
              </div>
            ) : (
              <p className="mt-2 text-[var(--adda-muted)]">
                {isDmConversation ? "No trace events for this DM." : "Trace appears per agent DM run."}
              </p>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

const ConversationComposer = memo(function ConversationComposer({
  activeConversation,
  activeDmAgent,
  activeDmRun,
  busy,
  isDmConversation,
  onSendChannel,
  onSendDmPrompt,
  onStopActiveRun,
  runActionState,
}: {
  activeConversation: ConversationSummary | null;
  activeDmAgent: AppAgent | null;
  activeDmRun: ApiRun | null;
  busy: boolean;
  isDmConversation: boolean;
  onSendChannel: (body: string) => Promise<boolean>;
  onSendDmPrompt: (prompt: string, mode: DmSendMode) => Promise<boolean>;
  onStopActiveRun: () => void | Promise<void>;
  runActionState: RunActionState;
}) {
  const [draft, setDraft] = useState("");
  const trimmedDraft = draft.trim();
  const canSend = Boolean(trimmedDraft && activeConversation) && !busy;
  const canQueue = Boolean(trimmedDraft && activeConversation && activeDmAgent) && !busy;

  async function submitDraft(mode: DmSendMode | "channel") {
    const prompt = draft.trim();
    if (!prompt || busy || !activeConversation) {
      return;
    }

    setDraft("");
    const didSend =
      mode === "channel"
        ? await onSendChannel(prompt)
        : await onSendDmPrompt(prompt, mode);

    if (!didSend) {
      setDraft(prompt);
    }
  }

  function handleSubmit(event: { preventDefault: () => void }) {
    event.preventDefault();
    void submitDraft(isDmConversation ? "urgent" : "channel");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Tab" && isDmConversation) {
      event.preventDefault();
      void submitDraft("queued");
      return;
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submitDraft(isDmConversation ? "urgent" : "channel");
    }
  }

  return (
    <form
      className={`grid ${isDmConversation ? "grid-cols-[minmax(0,1fr)_34px_34px_34px]" : "grid-cols-[minmax(0,1fr)_38px]"} gap-1 border-t border-[#777] bg-[#d0d0d0] p-1 md:flex md:flex-wrap md:gap-2 md:p-2`}
      onSubmit={handleSubmit}
    >
      <div className="win-panel hidden h-12 w-12 shrink-0 place-items-center bg-[#efefef] md:grid">
        <MessageSquare size={26} />
      </div>
      <textarea
        aria-label="Message"
        className="win-panel-inset h-9 min-h-9 min-w-0 resize-none px-2 py-1 text-[12px] leading-snug md:min-h-12 md:flex-1 md:basis-[calc(100%-56px)] md:resize-y md:px-3 md:py-2 md:text-[15px]"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Message room or assign agent..."
        rows={1}
        value={draft}
      />
      <button
        aria-label="Send"
        className="win-button flex h-9 min-h-0 items-center justify-center gap-2 px-0 py-0 md:h-12 md:w-24 md:flex-none md:px-2"
        disabled={!canSend || (isDmConversation && !activeDmAgent)}
        type="submit"
      >
        <Send size={16} />
        <span className="sr-only md:not-sr-only">{runActionState === "urgent" || (busy && !isDmConversation) ? "Sending" : "Send"}</span>
      </button>
      {isDmConversation ? (
        <>
          <button
            aria-label="Queue"
            className="win-button flex h-9 min-h-0 items-center justify-center gap-2 px-0 py-0 md:h-12 md:w-24 md:flex-none md:px-2"
            disabled={!canQueue}
            onClick={() => void submitDraft("queued")}
            type="button"
          >
            <ListPlus size={16} />
            <span className="sr-only md:not-sr-only">{runActionState === "queued" ? "Queueing" : "Queue"}</span>
          </button>
          <button
            aria-label="Stop"
            className="win-button flex h-9 min-h-0 items-center justify-center gap-2 px-0 py-0 md:h-12 md:w-24 md:flex-none md:px-2"
            disabled={!activeDmRun || runActionState !== "idle"}
            onClick={() => void onStopActiveRun()}
            type="button"
          >
            <Square size={15} />
            <span className="sr-only md:not-sr-only">{runActionState === "stop" ? "Stopping" : "Stop"}</span>
          </button>
        </>
      ) : null}
    </form>
  );
});

async function loadDmRuntime(
  conversationId: string,
  signal: AbortSignal
): Promise<{ runs: ApiRun[]; eventsByRunId: RunEventMap }> {
  const runs = sortRunsForDisplay(await listRuns({ conversation_id: conversationId, limit: 30 }, signal));
  const eventsByRunId: RunEventMap = {};

  await Promise.all(
    runs.slice(0, 8).map(async (run) => {
      eventsByRunId[run.id] = await listRunEvents(run.id, signal, 80);
    })
  );

  return { runs, eventsByRunId };
}

async function loadSidebarRuns(signal: AbortSignal): Promise<ApiRun[]> {
  const [runningRuns, queuedRuns] = await Promise.all([
    listRuns({ status: "running", limit: 200 }, signal),
    listRuns({ status: "queued", limit: 200 }, signal)
  ]);

  return sortRunsForDisplay([...runningRuns, ...queuedRuns]);
}

function RunQueueRow({ run, marker }: { run: ApiRun; marker: string }) {
  const active = isActiveRunStatus(run.status);
  const summary = runShortLabel(run);

  return (
    <div className="grid min-h-9 grid-cols-[18px_42px_minmax(0,1fr)] items-center gap-2 border-b border-[#bbb] py-1">
      {active ? <Check size={16} className="text-[var(--adda-success)]" /> : <span className={`status-dot ${runStatusDotClass(run.status)}`} />}
      <span className="truncate text-xs uppercase">{marker}</span>
      <span className="min-w-0">
        <span className="block truncate font-bold">{runStatusLabel(run.status)}</span>
        <span className="block truncate text-sm">{summary}</span>
      </span>
    </div>
  );
}

function RunTraceDetails({ run, events }: { run: ApiRun; events: ApiRunEvent[] }) {
  const traceItems = events.map(traceEventSummaryItem).filter(isTraceEventSummary);

  return (
    <details className="border border-[#aaa] bg-[#eeeeee] p-2">
      <summary className="grid cursor-pointer grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-2">
        <span className={`status-dot ${runStatusDotClass(run.status)}`} />
        <span className="truncate font-bold">{runShortLabel(run)}</span>
        <span className="text-xs">{traceItems.length}</span>
      </summary>
      <div className="mt-2 grid gap-2 border-t border-[#bbb] pt-2 text-xs">
        {traceItems.length > 0 ? (
          traceItems.map(({ event, label, summary }) => {
            return (
              <div className="grid grid-cols-[54px_minmax(0,1fr)] gap-2" key={event.id}>
                <time className="tabular-nums">{formatMessageTime(event.created_at)}</time>
                <span className="min-w-0 break-words">
                  <strong>{label}</strong>
                  {summary ? ` - ${summary}` : ""}
                </span>
              </div>
            );
          })
        ) : (
          <p className="text-[var(--adda-muted)]">No trace events.</p>
        )}
      </div>
    </details>
  );
}

const messageMarkdownComponents: Components = {
  p({ children }) {
    return <p className="my-1 whitespace-pre-wrap break-words leading-snug">{children}</p>;
  },
  a({ children, href }) {
    return (
      <a
        className="font-bold text-[var(--adda-blue)] underline"
        href={href}
        onClick={(event) => event.stopPropagation()}
        rel="noreferrer"
        target={href?.startsWith("#") ? undefined : "_blank"}
      >
        {children}
      </a>
    );
  },
  ul({ children }) {
    return <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>;
  },
  ol({ children }) {
    return <ol className="my-2 list-decimal space-y-1 pl-6">{children}</ol>;
  },
  li({ children }) {
    return <li className="break-words leading-snug">{children}</li>;
  },
  blockquote({ children }) {
    return <blockquote className="my-2 border-l-4 border-[var(--adda-blue)] bg-[#fffbe8] px-3 py-1">{children}</blockquote>;
  },
  code({ className, children }) {
    if (className) {
      return <code className={`${className} block whitespace-pre`}>{children}</code>;
    }

    return <code className="bg-[#e8e8e8] px-1 font-mono text-[0.92em]">{children}</code>;
  },
  pre({ children }) {
    return (
      <pre className="app-scrollbar my-2 max-h-72 overflow-auto whitespace-pre-wrap break-words border border-[#777] bg-white p-2 font-mono text-xs leading-5">
        {children}
      </pre>
    );
  },
  table({ children }) {
    return (
      <div className="app-scrollbar my-2 max-w-full overflow-auto border border-[#777] bg-white">
        <table className="w-full border-collapse text-sm">{children}</table>
      </div>
    );
  },
  th({ children }) {
    return <th className="border border-[#aaa] bg-[#dcdcdc] px-2 py-1 text-left font-bold">{children}</th>;
  },
  td({ children }) {
    return <td className="border border-[#bbb] px-2 py-1 align-top">{children}</td>;
  },
};

const MessageMarkdown = memo(function MessageMarkdown({ body }: { body: string }) {
  const visibleBody = visibleMessageMarkdown(body);

  return (
    <div className="max-w-[760px] break-words">
      <ReactMarkdown components={messageMarkdownComponents} remarkPlugins={[remarkGfm]}>
        {visibleBody}
      </ReactMarkdown>
    </div>
  );
});

const AGENT_ACTION_FENCE_LABEL = "agent_adda.actions";

type MarkdownFence = {
  marker: "`" | "~";
  len: number;
};

function visibleMessageMarkdown(body: string): string {
  return stripAgentActionBlocks(body).trim();
}

function stripAgentActionBlocks(markdown: string): string {
  const lines = markdown.split("\n");
  const visibleLines: string[] = [];
  let hiddenFence: MarkdownFence | null = null;

  for (const line of lines) {
    if (hiddenFence) {
      if (isMarkdownFenceClose(line, hiddenFence)) {
        hiddenFence = null;
      }
      continue;
    }

    const actionFence = actionFenceOpen(line);
    if (actionFence) {
      hiddenFence = actionFence;
      continue;
    }

    visibleLines.push(line);
  }

  return visibleLines.join("\n").replace(/\n{3,}/g, "\n\n");
}

function actionFenceOpen(line: string): MarkdownFence | null {
  const trimmed = line.trim();
  const fence = markdownFencePrefix(trimmed);
  if (!fence) {
    return null;
  }

  const label = trimmed.slice(fence.len).trim().split(/\s+/)[0]?.toLowerCase();
  return label === AGENT_ACTION_FENCE_LABEL ? fence : null;
}

function isMarkdownFenceClose(line: string, fence: MarkdownFence): boolean {
  const trimmed = line.trim();
  const candidate = markdownFencePrefix(trimmed);
  return Boolean(candidate && candidate.marker === fence.marker && candidate.len >= fence.len && trimmed.slice(candidate.len).trim() === "");
}

function markdownFencePrefix(line: string): MarkdownFence | null {
  const marker = line[0];
  if (marker !== "`" && marker !== "~") {
    return null;
  }

  let len = 0;
  while (line[len] === marker) {
    len += 1;
  }

  return len >= 3 ? { marker, len } : null;
}

function traceModalSubjectLabel(message: MissionMessage | null): string {
  if (message?.authorKind === "agent") {
    return "Agent response";
  }
  if (message?.authorKind === "system") {
    return "System message";
  }
  return "User query";
}

function MessageTraceModal({
  events,
  loadState,
  message,
  onClose,
  open,
  run,
  runId
}: {
  events: ApiRunEvent[];
  loadState: MessageLoadState;
  message: MissionMessage | null;
  onClose: () => void;
  open: boolean;
  run: ApiRun | null;
  runId: string | null;
}) {
  const [onlyAgentMessages, setOnlyAgentMessages] = useState(false);

  useEffect(() => {
    if (!open || !runId) {
      return undefined;
    }

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, open, runId]);

  useEffect(() => {
    setOnlyAgentMessages(false);
  }, [runId]);

  if (!open || !runId) {
    return null;
  }

  const phase = run ? messageRunPhase(runId, run, "idle") : loadState === "error" ? "error" : "unknown";
  const stdoutEntries = codexStdoutEntries(events);
  const visibleStdoutEntries = onlyAgentMessages ? stdoutEntries.filter(isAgentMessageTraceEntry) : stdoutEntries;
  const stderrText = codexStreamText(events, "stderr");
  const traceSubjectLabel = traceModalSubjectLabel(message);
  const messageSummary = message ? stripDisplayedSystemPrompt(visibleMessageMarkdown(message.body)) : "";
  const traceSubjectText = messageSummary || (run ? stripDisplayedSystemPrompt(run.prompt_summary) : "") || "Run-linked DM request";

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/35 p-4">
      <section
        aria-label="Codex Thinking"
        aria-modal="true"
        className="win-window flex max-h-[min(820px,94vh)] w-[min(980px,calc(100vw-24px))] flex-col overflow-hidden bg-[var(--adda-panel)]"
        role="dialog"
      >
        <header className="win-titlebar justify-between">
          <div className="flex min-w-0 items-center gap-2">
            <span className={`status-dot shrink-0 ${messageRunStatusClass(phase)}`} />
            <span className="min-w-0 truncate">Codex Thinking</span>
          </div>
          <button
            aria-label="Close Codex thinking"
            className="grid h-5 w-5 place-items-center border border-white bg-[var(--adda-blue)] text-white"
            onClick={onClose}
            type="button"
          >
            <X size={14} />
          </button>
        </header>
        <div className="grid gap-2 border-b border-[#777] bg-[#dcdcdc] p-3 text-sm md:grid-cols-[minmax(0,1fr)_180px]">
          <div className="min-w-0">
            <div className="mb-1 font-bold">{traceSubjectLabel}</div>
            <div className="win-panel-inset app-scrollbar max-h-32 min-w-0 overflow-auto whitespace-pre-wrap break-words bg-white px-2 py-1.5 leading-snug">
              {traceSubjectText}
            </div>
          </div>
          <div className="win-panel-inset grid grid-cols-[54px_minmax(0,1fr)] gap-x-2 gap-y-1 p-2">
            <span>Status</span>
            <strong>{run ? runStatusLabel(run.status) : messageRunStatusLabel(phase)}</strong>
            <span>Run</span>
            <span className="truncate" title={runId}>{runId.slice(0, 8)}</span>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-3">
          <section className="win-panel flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[#eeeeee]">
            <div className="flex items-center justify-between gap-3 border-b border-[#777] bg-[#d8d8d8] px-3 py-2">
              <h3 className="font-bold">Thinking trace</h3>
              <label className="flex shrink-0 items-center gap-2 text-xs">
                <input
                  checked={onlyAgentMessages}
                  className="h-4 w-4"
                  onChange={(event) => setOnlyAgentMessages(event.currentTarget.checked)}
                  type="checkbox"
                />
                <span>Only show Agent messages</span>
              </label>
            </div>
            <CodexStdoutList
              aria-label="Thinking trace"
              emptyText={
                loadState === "loading"
                  ? "Loading stdout..."
                  : onlyAgentMessages
                    ? "No agent messages captured yet."
                    : "No stdout captured yet."
              }
              entries={visibleStdoutEntries}
            />
          </section>
          {stderrText ? (
            <details className="win-panel min-w-0 shrink-0 overflow-hidden bg-[#eeeeee]">
              <summary className="cursor-pointer border-b border-[#777] bg-[#d8d8d8] px-3 py-2 font-bold">Stderr</summary>
              <pre className="app-scrollbar max-h-40 overflow-auto whitespace-pre-wrap break-words bg-[#fff4f4] p-3 font-mono text-sm text-[var(--adda-danger)]">
                {stderrText}
              </pre>
            </details>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function CodexStdoutList({
  emptyText,
  entries,
  ...props
}: {
  "aria-label": string;
  emptyText: string;
  entries: CodexStdoutEntry[];
}) {
  return (
    <div
      {...props}
      className="app-scrollbar min-h-0 flex-1 overflow-auto bg-[#f7f7f7] p-3 text-sm"
    >
      {entries.length > 0 ? (
        <ol className="grid gap-2">
          {entries.map((entry) => (
            <li className="win-panel-inset bg-white p-2" key={entry.id}>
              <div className="grid grid-cols-[68px_minmax(0,1fr)] gap-2 border-b border-[#d0d0d0] pb-1">
                <time className="tabular-nums text-[var(--adda-muted)]">{formatMessageTime(entry.createdAt)}</time>
                <div className="min-w-0">
                  <strong className="block truncate">{entry.title}</strong>
                </div>
              </div>
              {entry.body ? (
                <div className="mt-2 whitespace-pre-wrap break-words leading-5">{entry.body}</div>
              ) : null}
              {entry.command ? <TraceCommand command={entry.command} /> : null}
              {entry.output ? <TraceOutput output={entry.output} /> : null}
              {entry.rows.length > 0 ? (
                <dl className="mt-2 grid grid-cols-[150px_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-[#d0d0d0] pt-2 text-xs">
                  {entry.rows.map((row) => (
                    <FragmentPair key={`${entry.id}-${row.label}`} label={row.label} value={row.value} />
                  ))}
                </dl>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-[var(--adda-muted)]">{emptyText}</p>
      )}
    </div>
  );
}

function isAgentMessageTraceEntry(entry: CodexStdoutEntry): boolean {
  return entry.title === "Agent Message";
}

function TraceCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const isLong = command.length > 96 || command.includes("\n");

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  return (
    <details className="mt-2 border border-[#777] bg-[#f2f2f2]" open={!isLong}>
      <summary className="grid cursor-pointer grid-cols-[64px_minmax(0,1fr)] gap-2 bg-[#dcdcdc] px-2 py-1 text-xs">
        <span className="font-bold">Command</span>
        <code className="min-w-0 truncate font-mono">{truncateText(command, 180)}</code>
      </summary>
      <div className="border-t border-[#aaa] bg-white p-2">
        <textarea
          aria-label="Full command"
          className="app-scrollbar h-24 w-full resize-y border border-[#999] bg-white p-2 font-mono text-xs leading-5 outline-none"
          readOnly
          value={command}
        />
        <button className="win-button mt-2 px-3 py-1 text-xs" onClick={copyCommand} type="button">
          {copied ? "Copied" : "Copy command"}
        </button>
      </div>
    </details>
  );
}

function TraceOutput({ output }: { output: string }) {
  return (
    <details className="mt-2 border border-[#999] bg-[#f2f2f2]">
      <summary className="cursor-pointer bg-[#dcdcdc] px-2 py-1 text-xs font-bold">Output</summary>
      <textarea
        aria-label="Command output"
        className="app-scrollbar h-32 w-full resize-y border-0 bg-white p-2 font-mono text-xs leading-5 outline-none"
        readOnly
        value={output}
      />
    </details>
  );
}

function FragmentPair({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="font-bold">{label}</dt>
      <dd className="min-w-0 break-words">{value}</dd>
    </>
  );
}

type SidebarCreateDraft = {
  name: string;
  role: string;
  description: string;
  topic: string;
};

function SidebarCreateModal({
  kind,
  onClose,
  onCreated
}: {
  kind: SidebarCreateKind | null;
  onClose: () => void;
  onCreated: (record: ApiAgent | ApiConversation) => void;
}) {
  const [draft, setDraft] = useState<SidebarCreateDraft>(() => makeSidebarCreateDraft());
  const [saveState, setSaveState] = useState<"idle" | "saving" | "error">("idle");
  const [message, setMessage] = useState("Ready.");

  useEffect(() => {
    if (!kind) {
      return;
    }

    setDraft(makeSidebarCreateDraft());
    setSaveState("idle");
    setMessage("Ready.");
  }, [kind]);

  if (!kind) {
    return null;
  }

  const busy = saveState === "saving";
  const isAgent = kind === "agent";
  const title = isAgent ? "New Agent" : "Create Room";
  const Icon = isAgent ? Bot : MessageSquare;
  const closeLabel = isAgent ? "Close agent dialog" : "Close room dialog";

  async function handleSubmit(event: { preventDefault: () => void }) {
    event.preventDefault();
    if (busy) {
      return;
    }

    const name = draft.name.trim();
    const role = draft.role.trim();
    const description = draft.description.trim();
    const topic = draft.topic.trim();

    if (!name || (isAgent && (!role || !description))) {
      setSaveState("error");
      setMessage(isAgent ? "Name, role, and description are required." : "Room name is required.");
      return;
    }

    setSaveState("saving");
    setMessage(isAgent ? "Creating agent..." : "Creating room...");
    try {
      if (isAgent) {
        const agent = await createAgent({ name, role, description });
        onCreated(agent);
      } else {
        const channelKind: ApiConversationKind = "channel";
        const conversation = await createConversation({
          kind: channelKind,
          name,
          topic: topic || `Room for ${name}`
        });
        onCreated(conversation);
      }

      setSaveState("idle");
      onClose();
    } catch {
      setSaveState("error");
      setMessage(isAgent ? "Agent creation failed." : "Room creation failed.");
    }
  }

  function updateDraft(field: keyof SidebarCreateDraft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
    if (saveState === "error") {
      setSaveState("idle");
      setMessage("Ready.");
    }
  }

  return (
    <div className="fixed inset-0 z-[95] grid place-items-center bg-black/35 p-3">
      <button
        aria-label={closeLabel}
        className="absolute inset-0 cursor-default border-0 bg-transparent"
        disabled={busy}
        onClick={onClose}
        type="button"
      />
      <section
        aria-labelledby="aa-sidebar-create-title"
        aria-modal="true"
        className="win-window relative flex max-h-[min(620px,92vh)] w-[min(560px,calc(100vw-24px))] flex-col overflow-hidden bg-[var(--adda-panel)]"
        role="dialog"
      >
        <header className="win-titlebar shrink-0 justify-between">
          <div className="flex min-w-0 items-center gap-2">
            <Icon className="shrink-0" size={20} />
            <h2 className="truncate text-base" id="aa-sidebar-create-title">{title}</h2>
          </div>
          <button
            aria-label={closeLabel}
            className="win-button grid h-6 min-h-0 w-7 place-items-center p-0"
            disabled={busy}
            onClick={onClose}
            type="button"
          >
            <X size={14} />
          </button>
        </header>

        <form className="grid gap-3 p-3" onSubmit={handleSubmit}>
          <label className="grid gap-1 font-bold" htmlFor="aa-sidebar-create-name">
            {isAgent ? "Agent name" : "Room name"}
            <input
              autoFocus
              className="win-panel-inset min-h-9 min-w-0 bg-white px-2 font-normal"
              disabled={busy}
              id="aa-sidebar-create-name"
              onChange={(event) => updateDraft("name", event.target.value)}
              value={draft.name}
            />
          </label>

          {isAgent ? (
            <>
              <label className="grid gap-1 font-bold" htmlFor="aa-sidebar-create-role">
                Role
                <input
                  className="win-panel-inset min-h-9 min-w-0 bg-white px-2 font-normal"
                  disabled={busy}
                  id="aa-sidebar-create-role"
                  onChange={(event) => updateDraft("role", event.target.value)}
                  value={draft.role}
                />
              </label>
              <label className="grid gap-1 font-bold" htmlFor="aa-sidebar-create-description">
                Description
                <textarea
                  className="win-panel-inset min-h-24 resize-y bg-white p-2 font-normal leading-snug"
                  disabled={busy}
                  id="aa-sidebar-create-description"
                  onChange={(event) => updateDraft("description", event.target.value)}
                  value={draft.description}
                />
              </label>
            </>
          ) : (
            <label className="grid gap-1 font-bold" htmlFor="aa-sidebar-create-topic">
              Topic
              <textarea
                className="win-panel-inset min-h-20 resize-y bg-white p-2 font-normal leading-snug"
                disabled={busy}
                id="aa-sidebar-create-topic"
                onChange={(event) => updateDraft("topic", event.target.value)}
                value={draft.topic}
              />
            </label>
          )}

          <div className={`win-panel-inset min-h-10 bg-white p-2 ${saveState === "error" ? "text-[var(--adda-danger)]" : ""}`}>
            {message}
          </div>

          <footer className="flex flex-wrap justify-end gap-2 border-t border-[#777] pt-3">
            <button className="win-button flex min-h-9 items-center gap-2" disabled={busy} onClick={onClose} type="button">
              <X size={16} />
              <span>Close</span>
            </button>
            <button className="win-button flex min-h-9 items-center gap-2" disabled={busy} type="submit">
              {busy ? <RefreshCw className="animate-spin" size={16} /> : <Plus size={16} />}
              <span>{busy ? "Creating" : "Create"}</span>
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function makeSidebarCreateDraft(): SidebarCreateDraft {
  return {
    name: "",
    role: "Agent",
    description: "",
    topic: ""
  };
}

type AgentSetupDraft = {
  name: string;
  systemPrompt: string;
  model: string;
  reasoningEffort: ReasoningEffort;
};

function AgentSetupModal({
  agent,
  open,
  onClose,
  onHistoryCleared,
  onSaved
}: {
  agent: AppAgent | null;
  open: boolean;
  onClose: () => void;
  onHistoryCleared: (agentId: string, deletedMessages: number) => void;
  onSaved: (agent: ApiAgent) => void;
}) {
  const [draft, setDraft] = useState<AgentSetupDraft>(() => makeAgentSetupDraft(null));
  const [reasoningOptions, setReasoningOptions] = useState<ReasoningEffort[]>(() => [
    ...knownReasoningEfforts
  ]);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "error">("idle");
  const [deleteHistoryState, setDeleteHistoryState] = useState<"idle" | "confirm" | "deleting" | "error">("idle");
  const [message, setMessage] = useState("Ready.");

  useEffect(() => {
    if (!open) {
      return;
    }

    setDraft(makeAgentSetupDraft(agent));
    setReasoningOptions([...knownReasoningEfforts]);
    setSaveState("idle");
    setDeleteHistoryState("idle");
    setMessage("Ready.");
  }, [agent, open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const controller = new AbortController();
    const model = draft.model;
    loadCodexReasoningEfforts(model, controller.signal)
      .then((efforts) => {
        setReasoningOptions(efforts);
        setDraft((current) => {
          if (current.model !== model) {
            return current;
          }
          return {
            ...current,
            reasoningEffort: normalizeReasoningEffort(current.reasoningEffort, efforts)
          };
        });
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) {
          return;
        }
      });

    return () => controller.abort();
  }, [draft.model, open]);

  if (!open || !agent) {
    return null;
  }

  const busy = saveState === "saving";
  const deletingHistory = deleteHistoryState === "deleting";
  const roleLabel = agentSetupRoleLabel(agent);

  async function handleSave() {
    if (!agent || busy || deletingHistory) {
      return;
    }

    const name = draft.name.trim();
    const systemPrompt = draft.systemPrompt.trim();
    if (!name) {
      setSaveState("error");
      setMessage("Name is required.");
      return;
    }
    if (!systemPrompt) {
      setSaveState("error");
      setMessage("System prompt is required.");
      return;
    }

    setSaveState("saving");
    setMessage("Saving agent setup...");
    try {
      const saved = await updateAgent(agent.id, {
        name,
        system_prompt: systemPrompt,
        model: draft.model,
        reasoning_effort: draft.reasoningEffort
      });
      setSaveState("idle");
      setMessage("Saved.");
      onSaved(saved);
      onClose();
    } catch {
      setSaveState("error");
      setMessage("Save failed. Check for a duplicate name or backend error.");
    }
  }

  async function handleDeleteDmHistory() {
    if (!agent || busy || deletingHistory) {
      return;
    }

    if (deleteHistoryState !== "confirm") {
      setDeleteHistoryState("confirm");
      setMessage("Press Delete DM history again to permanently clear this transcript.");
      return;
    }

    const conversationId = `dm_${agent.id}`;
    setDeleteHistoryState("deleting");
    setMessage("Deleting DM history...");
    try {
      const response = await clearConversationMessages(conversationId);
      setDeleteHistoryState("idle");
      setMessage(`Deleted ${response.deleted_messages} DM message${response.deleted_messages === 1 ? "" : "s"}.`);
      onHistoryCleared(agent.id, response.deleted_messages);
    } catch {
      setDeleteHistoryState("error");
      setMessage("DM history delete failed.");
    }
  }

  return (
    <div className="fixed inset-0 z-[95] grid place-items-center bg-black/35 p-3">
      <button
        aria-label="Close agent setup"
        className="absolute inset-0 cursor-default border-0 bg-transparent"
        disabled={busy || deletingHistory}
        onClick={onClose}
        type="button"
      />
      <section
        aria-labelledby="aa-agent-setup-title"
        aria-modal="true"
        className="win-window relative flex max-h-[min(780px,92vh)] w-[min(920px,calc(100vw-24px))] flex-col overflow-hidden bg-[var(--adda-panel)]"
        role="dialog"
      >
        <header className="win-titlebar shrink-0 justify-between">
          <div className="flex min-w-0 items-center gap-2">
            <ClipboardList className="shrink-0" size={20} />
            <h2 className="truncate text-base" id="aa-agent-setup-title">{roleLabel} Setup</h2>
          </div>
          <button
            aria-label="Close agent setup"
            className="win-button grid h-6 min-h-0 w-7 place-items-center p-0"
            disabled={busy || deletingHistory}
            onClick={onClose}
            type="button"
          >
            <X size={14} />
          </button>
        </header>

        <div className="app-scrollbar min-h-0 overflow-auto p-3">
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_280px]">
            <div className="grid min-w-0 gap-3">
              <fieldset className="win-panel bg-[#dfdfdf] p-3">
                <legend className="px-1 font-bold">Identity</legend>
                <div className="grid gap-3 sm:grid-cols-[160px_minmax(0,1fr)]">
                  <span className="font-bold">Role</span>
                  <div className="win-panel-inset min-h-9 min-w-0 bg-white px-2 py-2">{roleLabel}</div>

                  <label className="font-bold" htmlFor="aa-agent-setup-name">Name</label>
                  <input
                    className="win-panel-inset min-h-9 min-w-0 bg-white px-2"
                    disabled={busy || deletingHistory}
                    id="aa-agent-setup-name"
                    onChange={(event) => {
                      setDraft((current) => ({ ...current, name: event.target.value }));
                      clearAgentSetupError(saveState, setSaveState, setMessage);
                    }}
                    value={draft.name}
                  />
                </div>
              </fieldset>

              <fieldset className="win-panel bg-[#dfdfdf] p-3">
                <legend className="px-1 font-bold">System Prompt</legend>
                <textarea
                  aria-label="Agent system prompt"
                  className="win-panel-inset min-h-64 w-full resize-y bg-white p-2 font-mono text-sm leading-snug"
                  disabled={busy || deletingHistory}
                  onChange={(event) => {
                    setDraft((current) => ({ ...current, systemPrompt: event.target.value }));
                    clearAgentSetupError(saveState, setSaveState, setMessage);
                  }}
                  value={draft.systemPrompt}
                />
              </fieldset>
            </div>

            <aside className="grid min-w-0 content-start gap-3">
              <section className="win-panel bg-[#dfdfdf] p-3">
                <h3 className="mb-2 font-bold">Runtime</h3>
                <div className="grid gap-3">
                  <label className="grid gap-1 font-bold" htmlFor="aa-agent-setup-model">
                    Model
                    <select
                      className="win-panel-inset min-h-9 min-w-0 bg-white px-2 font-normal"
                      disabled={busy || deletingHistory}
                      id="aa-agent-setup-model"
                      onChange={(event) => {
                        setDraft((current) => ({ ...current, model: event.target.value }));
                        clearAgentSetupError(saveState, setSaveState, setMessage);
                      }}
                      value={draft.model}
                    >
                      {agentModelOptions.map((model) => (
                        <option key={model} value={model}>{model}</option>
                      ))}
                    </select>
                  </label>

                  <label className="grid gap-1 font-bold" htmlFor="aa-agent-setup-effort">
                    Reasoning effort
                    <select
                      className="win-panel-inset min-h-9 min-w-0 bg-white px-2 font-normal"
                      disabled={busy || deletingHistory}
                      id="aa-agent-setup-effort"
                      onChange={(event) => {
                        setDraft((current) => ({
                          ...current,
                          reasoningEffort: normalizeReasoningEffort(event.target.value, reasoningOptions)
                        }));
                        clearAgentSetupError(saveState, setSaveState, setMessage);
                      }}
                      value={draft.reasoningEffort}
                    >
                      {reasoningOptions.map((effort) => (
                        <option key={effort} value={effort}>{effort}</option>
                      ))}
                    </select>
                  </label>
                </div>
              </section>

              <section className="win-panel bg-[#dfdfdf] p-3">
                <h3 className="mb-2 font-bold">Status</h3>
                <div className="win-panel-inset min-h-14 bg-white p-2">
                  <p className="m-0 break-words leading-snug">{message}</p>
                </div>
              </section>
            </aside>
          </div>

          <AgentCronJobsPanel agentId={agent.id} disabled={busy || deletingHistory} />

          <section className="win-panel mt-3 bg-[#dfdfdf] p-3" aria-labelledby="aa-agent-danger-title">
            <div className="mb-2 flex min-w-0 items-center gap-2">
              <AlertTriangle className="shrink-0 text-[var(--adda-danger)]" size={18} />
              <h3 className="min-w-0 flex-1 truncate font-bold" id="aa-agent-danger-title">DM History</h3>
            </div>
            <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_180px] md:items-center">
              <p className="m-0 text-sm leading-snug">
                Delete all messages in this direct message. Agent settings, cron jobs, and run records are kept.
              </p>
              <button
                className={`win-button flex min-h-9 items-center justify-center gap-2 ${deleteHistoryState === "confirm" ? "border-[var(--adda-danger)] bg-[#fff4f4]" : ""}`}
                disabled={busy || deletingHistory}
                onClick={() => void handleDeleteDmHistory()}
                type="button"
              >
                {deletingHistory ? <RefreshCw className="animate-spin" size={16} /> : <Trash2 size={16} />}
                <span>{deletingHistory ? "Deleting" : deleteHistoryState === "confirm" ? "Confirm delete" : "Delete DM history"}</span>
              </button>
            </div>
          </section>

          <footer className="mt-3 flex flex-wrap justify-end gap-2 border-t border-[#777] pt-3">
            <button className="win-button flex min-h-9 items-center gap-2" disabled={busy || deletingHistory} onClick={onClose} type="button">
              <X size={16} />
              <span>Close</span>
            </button>
            <button className="win-button flex min-h-9 items-center gap-2" disabled={busy || deletingHistory} onClick={() => void handleSave()} type="button">
              {busy ? <RefreshCw className="animate-spin" size={16} /> : <Save size={16} />}
              <span>{busy ? "Saving" : "Save"}</span>
            </button>
          </footer>
        </div>
      </section>
    </div>
  );
}

type CronJobDraft = {
  title: string;
  prompt: string;
  scheduleKind: ApiCronJob["schedule_kind"];
  intervalMinutes: string;
  timeOfDay: string;
  enabled: boolean;
};

type CronPanelState = "idle" | "loading" | "saving" | "error";

function AgentCronJobsPanel({ agentId, disabled }: { agentId: string; disabled: boolean }) {
  const [jobs, setJobs] = useState<ApiCronJob[]>([]);
  const [draft, setDraft] = useState<CronJobDraft>(() => makeCronJobDraft());
  const [panelState, setPanelState] = useState<CronPanelState>("loading");
  const [busyJobId, setBusyJobId] = useState("");
  const [message, setMessage] = useState("Loading cron jobs...");

  const loadJobs = useCallback(async (signal?: AbortSignal) => {
    setPanelState("loading");
    setMessage("Loading cron jobs...");
    try {
      const nextJobs = await listAgentCronJobs(agentId, signal);
      setJobs(nextJobs);
      setPanelState("idle");
      setMessage(nextJobs.length > 0 ? `${nextJobs.length} cron job${nextJobs.length === 1 ? "" : "s"} loaded.` : "No cron jobs assigned.");
    } catch (error: unknown) {
      if (isAbortError(error)) {
        return;
      }
      setJobs([]);
      setPanelState("error");
      setMessage("Cron jobs unavailable.");
    }
  }, [agentId]);

  useEffect(() => {
    const controller = new AbortController();
    void loadJobs(controller.signal);
    return () => controller.abort();
  }, [loadJobs]);

  const busy = disabled || panelState === "loading" || panelState === "saving" || Boolean(busyJobId);

  async function handleCreateCronJob() {
    if (busy) {
      return;
    }

    const title = draft.title.trim();
    const prompt = draft.prompt.trim();
    if (!title || !prompt) {
      setPanelState("error");
      setMessage("Title and prompt are required.");
      return;
    }

    const schedulePayload = cronSchedulePayload(draft);
    if (!schedulePayload) {
      setPanelState("error");
      setMessage(draft.scheduleKind === "daily_time" ? "Choose a valid PDT time of day." : "Choose a positive interval in minutes.");
      return;
    }

    setPanelState("saving");
    setMessage("Creating cron job...");
    try {
      const created = await createAgentCronJob(agentId, {
        title,
        prompt,
        ...schedulePayload,
        enabled: draft.enabled
      });
      setJobs((current) => sortCronJobs([...current, created]));
      setDraft(makeCronJobDraft());
      setPanelState("idle");
      setMessage(`Cron job "${created.title}" created.`);
    } catch {
      setPanelState("error");
      setMessage("Cron job creation failed.");
    }
  }

  async function handleRunCronJobNow(job: ApiCronJob) {
    if (busy) {
      return;
    }

    setBusyJobId(job.id);
    setMessage(`Queueing ${job.title} now...`);
    try {
      const updated = await runCronJobNow(job.id);
      setJobs((current) => sortCronJobs(replaceCronJob(current, updated)));
      setPanelState("idle");
      setMessage(`${updated.title} queued to run now.`);
    } catch {
      setPanelState("error");
      setMessage("Cron job run failed.");
    } finally {
      setBusyJobId("");
    }
  }

  async function handleToggleCronJob(job: ApiCronJob) {
    if (busy) {
      return;
    }

    setBusyJobId(job.id);
    setMessage(`${job.enabled ? "Disabling" : "Enabling"} ${job.title}...`);
    try {
      const updated = await updateCronJob(job.id, { enabled: !job.enabled });
      setJobs((current) => sortCronJobs(replaceCronJob(current, updated)));
      setPanelState("idle");
      setMessage(`${updated.title} ${updated.enabled ? "enabled" : "disabled"}.`);
    } catch {
      setPanelState("error");
      setMessage("Cron job update failed.");
    } finally {
      setBusyJobId("");
    }
  }

  async function handleDeleteCronJob(job: ApiCronJob) {
    if (busy) {
      return;
    }

    setBusyJobId(job.id);
    setMessage(`Deleting ${job.title}...`);
    try {
      await deleteCronJob(job.id);
      setJobs((current) => current.filter((candidate) => candidate.id !== job.id));
      setPanelState("idle");
      setMessage(`${job.title} deleted.`);
    } catch {
      setPanelState("error");
      setMessage("Cron job delete failed.");
    } finally {
      setBusyJobId("");
    }
  }

  function updateDraft<K extends keyof CronJobDraft>(field: K, value: CronJobDraft[K]) {
    setDraft((current) => ({ ...current, [field]: value }));
    if (panelState === "error") {
      setPanelState("idle");
      setMessage(jobs.length > 0 ? `${jobs.length} cron job${jobs.length === 1 ? "" : "s"} loaded.` : "No cron jobs assigned.");
    }
  }

  return (
    <section className="win-panel mt-3 bg-[#dfdfdf] p-3" aria-labelledby="aa-agent-cron-title">
      <div className="mb-2 flex min-w-0 items-center gap-2">
        <Clock className="shrink-0" size={18} />
        <h3 className="min-w-0 flex-1 truncate font-bold" id="aa-agent-cron-title">Cron Jobs</h3>
        <button
          aria-label="Refresh cron jobs"
          className="win-button grid h-7 min-h-0 w-8 shrink-0 place-items-center p-0"
          disabled={busy}
          onClick={() => void loadJobs()}
          type="button"
        >
          <RefreshCw className={panelState === "loading" ? "animate-spin" : ""} size={15} />
        </button>
      </div>

      <div className={`win-panel-inset mb-3 min-h-9 bg-white p-2 text-sm ${panelState === "error" ? "text-[var(--adda-danger)]" : ""}`}>
        {message}
      </div>

      <div className="grid gap-2">
        {jobs.length > 0 ? (
          jobs.map((job) => (
            <div className="win-panel-inset grid gap-2 bg-white p-2 md:grid-cols-[minmax(0,1fr)_150px_112px]" key={job.id}>
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <span className={`status-dot ${job.enabled ? "status-working" : "status-offline"} shrink-0`} title={job.enabled ? "enabled" : "disabled"} />
                  <strong className="truncate">{job.title}</strong>
                </div>
                <p className="mt-1 max-h-10 min-w-0 overflow-hidden break-words text-sm leading-snug">{job.prompt}</p>
                <div className="mt-1 truncate text-xs text-[var(--adda-muted)]">
                  Next: {formatCronDate(job.next_run_at)}
                  {job.last_queued_at ? ` | Last queued: ${formatCronDate(job.last_queued_at)}` : ""}
                  {job.last_error ? ` | ${job.last_error}` : ""}
                </div>
              </div>
              <div className="grid content-center gap-1 text-sm">
                <span className="truncate font-bold">{cronScheduleLabel(job)}</span>
                <span className="truncate text-[var(--adda-muted)]">{job.enabled ? "Enabled" : "Paused"}</span>
              </div>
              <div className="flex items-center justify-end gap-1">
                <button
                  aria-label={`Run ${job.title} now`}
                  className="win-button grid h-8 min-h-0 w-8 place-items-center p-0"
                  disabled={busy}
                  onClick={() => void handleRunCronJobNow(job)}
                  title="Run now"
                  type="button"
                >
                  <Play size={15} />
                </button>
                <button
                  aria-label={`${job.enabled ? "Disable" : "Enable"} ${job.title}`}
                  className="win-button grid h-8 min-h-0 w-8 place-items-center p-0"
                  disabled={busy}
                  onClick={() => void handleToggleCronJob(job)}
                  title={job.enabled ? "Disable" : "Enable"}
                  type="button"
                >
                  <Clock size={15} />
                </button>
                <button
                  aria-label={`Delete ${job.title}`}
                  className="win-button grid h-8 min-h-0 w-8 place-items-center p-0"
                  disabled={busy}
                  onClick={() => void handleDeleteCronJob(job)}
                  title="Delete"
                  type="button"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
          ))
        ) : (
          <div className="win-panel-inset bg-white p-3 text-sm text-[var(--adda-muted)]">
            {panelState === "loading" ? "Loading assigned cron jobs..." : "No periodic work assigned to this agent."}
          </div>
        )}
      </div>

      <fieldset className="win-panel-inset mt-3 grid gap-3 bg-[#eeeeee] p-3">
        <legend className="px-1 font-bold">Assign Periodic Work</legend>
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <label className="grid gap-1 font-bold" htmlFor="aa-cron-title">
            Cron job title
            <input
              className="win-panel-inset min-h-9 min-w-0 bg-white px-2 font-normal"
              disabled={busy}
              id="aa-cron-title"
              onChange={(event) => updateDraft("title", event.target.value)}
              value={draft.title}
            />
          </label>
          <fieldset className="grid gap-2">
            <legend className="font-bold">Schedule</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className={`win-button flex min-h-9 items-center gap-2 px-2 ${draft.scheduleKind === "interval" ? "bg-white" : ""}`}>
                <input
                  checked={draft.scheduleKind === "interval"}
                  disabled={busy}
                  name="aa-cron-schedule-kind"
                  onChange={() => updateDraft("scheduleKind", "interval")}
                  type="radio"
                />
                Every N minutes
              </label>
              <label className={`win-button flex min-h-9 items-center gap-2 px-2 ${draft.scheduleKind === "daily_time" ? "bg-white" : ""}`}>
                <input
                  checked={draft.scheduleKind === "daily_time"}
                  disabled={busy}
                  name="aa-cron-schedule-kind"
                  onChange={() => updateDraft("scheduleKind", "daily_time")}
                  type="radio"
                />
                At time of day (PDT)
              </label>
            </div>
          </fieldset>
        </div>
        <div className="grid gap-3 md:grid-cols-[minmax(0,180px)_112px]">
          {draft.scheduleKind === "daily_time" ? (
            <label className="grid gap-1 font-bold" htmlFor="aa-cron-time">
              Time of day (PDT)
              <input
                className="win-panel-inset min-h-9 min-w-0 bg-white px-2 font-normal tabular-nums"
                disabled={busy}
                id="aa-cron-time"
                onChange={(event) => updateDraft("timeOfDay", event.target.value)}
                type="time"
                value={draft.timeOfDay}
              />
            </label>
          ) : (
            <label className="grid gap-1 font-bold" htmlFor="aa-cron-interval">
              Interval minutes
              <input
                className="win-panel-inset min-h-9 min-w-0 bg-white px-2 font-normal tabular-nums"
                disabled={busy}
                id="aa-cron-interval"
                min={1}
                max={10080}
                onChange={(event) => updateDraft("intervalMinutes", event.target.value)}
                type="number"
                value={draft.intervalMinutes}
              />
            </label>
          )}
          <label className="mt-6 flex min-h-9 items-center gap-2 font-bold">
            <input
              checked={draft.enabled}
              disabled={busy}
              onChange={(event) => updateDraft("enabled", event.target.checked)}
              type="checkbox"
            />
            Enabled
          </label>
        </div>
        <label className="grid gap-1 font-bold" htmlFor="aa-cron-prompt">
          Cron job prompt
          <textarea
            className="win-panel-inset min-h-24 resize-y bg-white p-2 font-normal leading-snug"
            disabled={busy}
            id="aa-cron-prompt"
            onChange={(event) => updateDraft("prompt", event.target.value)}
            value={draft.prompt}
          />
        </label>
        <div className="flex justify-end">
          <button
            className="win-button flex min-h-9 items-center gap-2"
            disabled={busy}
            onClick={() => void handleCreateCronJob()}
            type="button"
          >
            {panelState === "saving" ? <RefreshCw className="animate-spin" size={16} /> : <Plus size={16} />}
            <span>{panelState === "saving" ? "Adding" : "Add cron job"}</span>
          </button>
        </div>
      </fieldset>
    </section>
  );
}

function makeCronJobDraft(): CronJobDraft {
  return {
    title: "",
    prompt: "",
    scheduleKind: "interval",
    intervalMinutes: "1440",
    timeOfDay: "09:00",
    enabled: true
  };
}

function replaceCronJob(jobs: ApiCronJob[], updated: ApiCronJob): ApiCronJob[] {
  return jobs.map((job) => (job.id === updated.id ? updated : job));
}

function sortCronJobs(jobs: ApiCronJob[]): ApiCronJob[] {
  return [...jobs].sort((left, right) => {
    if (left.enabled !== right.enabled) {
      return left.enabled ? -1 : 1;
    }

    return dateTimeValue(left.next_run_at) - dateTimeValue(right.next_run_at) || left.title.localeCompare(right.title);
  });
}

function cronSchedulePayload(draft: CronJobDraft): Pick<ApiCronJob, "schedule_kind" | "interval_minutes" | "time_of_day"> | null {
  if (draft.scheduleKind === "daily_time") {
    const timeOfDay = draft.timeOfDay.trim();
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(timeOfDay)) {
      return null;
    }

    return {
      schedule_kind: "daily_time",
      interval_minutes: 1440,
      time_of_day: timeOfDay
    };
  }

  const intervalMinutes = Number.parseInt(draft.intervalMinutes, 10);
  if (!Number.isFinite(intervalMinutes) || intervalMinutes < 1) {
    return null;
  }

  return {
    schedule_kind: "interval",
    interval_minutes: Math.min(intervalMinutes, 10080),
    time_of_day: ""
  };
}

function cronScheduleLabel(job: ApiCronJob): string {
  if (job.schedule_kind === "daily_time" && job.time_of_day) {
    return `Daily at ${job.time_of_day} ${job.timezone || "PDT"}`;
  }

  return `Every ${formatNumber(job.interval_minutes)} min`;
}

function makeAgentSetupDraft(agent: AppAgent | null): AgentSetupDraft {
  return {
    name: defaultAgentSetupName(agent),
    systemPrompt: agent?.systemPrompt?.trim() || generatedAgentSystemPrompt(agent),
    model: agent?.model || "gpt-5.5",
    reasoningEffort: normalizeReasoningEffort(agent?.reasoningEffort || "high")
  };
}

function defaultAgentSetupName(agent: AppAgent | null): string {
  if (!agent) {
    return "Unnamed";
  }
  return isStarterRoleLabel(agent.name) ? "Unnamed" : agent.name || "Unnamed";
}

function agentSetupRoleLabel(agent: AppAgent): string {
  return isStarterRoleLabel(agent.name) ? agent.name : agent.role || "Agent";
}

function isStarterRoleLabel(value: string): boolean {
  return ["CEO", "Founding Engineer", "Researcher", "Product Manager"].includes(value);
}

function generatedAgentSystemPrompt(agent: AppAgent | null): string {
  if (!agent) {
    return "You are an agent in this company workspace. Work through DMs, channels, and the shared wiki memory.";
  }
  return `You are ${defaultAgentSetupName(agent)}. Role: ${agentSetupRoleLabel(agent)}. ${agent.description || ""}`.trim();
}

function clearAgentSetupError(
  saveState: "idle" | "saving" | "error",
  setSaveState: (state: "idle" | "saving" | "error") => void,
  setMessage: (message: string) => void
) {
  if (saveState === "error") {
    setSaveState("idle");
    setMessage("Ready.");
  }
}

function mapApiAgent(agent: ApiAgent): AppAgent {
  return {
    id: agent.id,
    name: agent.name || agent.slug || agent.id,
    slug: agent.slug,
    status: normalizeAgentStatus(agent.status),
    role: agent.role || "Agent",
    description: agent.description,
    profile: agent.profile,
    systemPrompt: agent.system_prompt,
    model: agent.model,
    reasoningEffort: agent.reasoning_effort
  };
}

function mapApiConversation(conversation: ApiConversation): ConversationSummary {
  return {
    id: conversation.id,
    kind: conversation.kind,
    name: conversation.name || conversation.slug || conversation.id,
    topic: conversation.topic,
    unread: 0,
    updatedAt: conversation.updated_at ?? conversation.created_at
  };
}

function mapApiMessages(messages: ApiMessage[], agents: AppAgent[]): MissionMessage[] {
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));

  return messages.map((message) => {
    const authorAgent = agentsById.get(message.author_id);
    const human = message.author_kind === "human";
    const system = message.author_kind === "system";

    return {
      id: message.id,
      runId: message.run_id,
      time: formatMessageTime(message.created_at),
      author: human ? "You" : system ? "System" : authorAgent?.name ?? (message.author_id || "Agent"),
      authorKind: message.author_kind,
      body: message.body,
      human,
      status: authorAgent?.status
    };
  });
}

function agentForDm(conversation: ConversationSummary, agents: AppAgent[]): AppAgent | null {
  if (conversation.kind !== "dm") {
    return null;
  }

  if (conversation.id.startsWith("dm_")) {
    const agentId = conversation.id.slice(3);
    const agent = agents.find((candidate) => candidate.id === agentId);
    if (agent) {
      return agent;
    }
  }

  const conversationName = normalizeLookup(conversation.name);
  return (
    agents.find((agent) => {
      return normalizeLookup(agent.name) === conversationName || normalizeLookup(agent.slug ?? "") === conversationName;
    }) ?? null
  );
}

function agentsWithRunStatus(agents: AppAgent[], runs: ApiRun[]): AppAgent[] {
  const runStatusByAgentId = agentRunStatusByAgentId(runs);

  return agents.map((agent) => {
    const runStatus = runStatusByAgentId.get(agent.id);
    if (runStatus === "working") {
      return { ...agent, status: "working" };
    }
    if (runStatus === "pending") {
      return { ...agent, status: "pending" };
    }

    return { ...agent, status: clearTransientAgentStatus(agent.status) };
  });
}

function clearTransientAgentStatus(status: AppAgent["status"]): AppAgent["status"] {
  if (status === "working" || status === "pending") {
    return "idle";
  }

  return status;
}

function agentRunStatusByAgentId(runs: ApiRun[]): Map<string, "working" | "pending"> {
  const statusByAgentId = new Map<string, "working" | "pending">();
  for (const run of runs) {
    if (isActiveRunStatus(run.status)) {
      statusByAgentId.set(run.agent_id, "working");
      continue;
    }
    if (isQueuedRunStatus(run.status) && !statusByAgentId.has(run.agent_id)) {
      statusByAgentId.set(run.agent_id, "pending");
    }
  }

  return statusByAgentId;
}

function mergeRunsById(primaryRuns: ApiRun[], secondaryRuns: ApiRun[]): ApiRun[] {
  const runsById = new Map<string, ApiRun>();
  for (const run of primaryRuns) {
    runsById.set(run.id, run);
  }
  for (const run of secondaryRuns) {
    runsById.set(run.id, run);
  }

  return Array.from(runsById.values());
}

function sortRunsForDisplay(runs: ApiRun[]): ApiRun[] {
  return [...runs].sort(compareRunsForDisplay);
}

function compareRunsForDisplay(left: ApiRun, right: ApiRun): number {
  const leftBucket = runDisplayBucket(left);
  const rightBucket = runDisplayBucket(right);
  if (leftBucket !== rightBucket) {
    return leftBucket - rightBucket;
  }

  if (leftBucket === 2) {
    return runSortTime(right) - runSortTime(left);
  }
  if (leftBucket === 1) {
    const priorityDelta = runQueuePriority(left) - runQueuePriority(right);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
  }

  return runSortTime(left) - runSortTime(right);
}

function runDisplayBucket(run: ApiRun): number {
  if (isActiveRunStatus(run.status)) {
    return 0;
  }
  if (isQueuedRunStatus(run.status)) {
    return 1;
  }

  return 2;
}

function firstActiveRun(runs: ApiRun[]): ApiRun | null {
  return sortRunsForDisplay(runs).find((run) => isActiveRunStatus(run.status)) ?? null;
}

function queuedRuns(runs: ApiRun[]): ApiRun[] {
  return sortRunsForDisplay(runs).filter((run) => isQueuedRunStatus(run.status));
}

function messageRunPhase(
  runId: string | null | undefined,
  run: ApiRun | null,
  loadState: "idle" | "loading" | "error"
): MessageRunPhase {
  if (!runId) {
    return "unknown";
  }
  if (!run) {
    return loadState === "error" ? "error" : loadState === "loading" ? "thinking" : "unknown";
  }

  const normalized = normalizeRunStatus(run.status);
  if (normalized === "completed") {
    return "done";
  }
  if (normalized === "failed" || normalized === "canceled" || normalized === "blocked") {
    return "error";
  }
  if (isQueuedRunStatus(run.status)) {
    return "queued";
  }
  if (isActiveRunStatus(run.status)) {
    return "running";
  }

  return "unknown";
}

function messageRunStatusClass(phase: MessageRunPhase): string {
  if (phase === "queued") {
    return "status-queued";
  }
  if (phase === "running") {
    return "status-running";
  }
  if (phase === "thinking") {
    return "status-thinking";
  }
  if (phase === "done") {
    return "status-done";
  }
  if (phase === "error") {
    return "status-error";
  }

  return "status-idle";
}

function messageRunStatusLabel(phase: MessageRunPhase): string {
  if (phase === "queued") {
    return "Queued";
  }
  if (phase === "running") {
    return "Running";
  }
  if (phase === "thinking") {
    return "Thinking";
  }
  if (phase === "done") {
    return "Done";
  }
  if (phase === "error") {
    return "Error";
  }

  return "Run status unavailable";
}

function effectiveMessageRunId(
  message: MissionMessage,
  activeConversation: ConversationSummary | null,
  runs: ApiRun[]
): string | null {
  if (activeConversation?.kind !== "dm") {
    return null;
  }
  if (message.runId) {
    if (message.authorKind === "system") {
      return null;
    }
    return message.runId;
  }
  if (!message.human) {
    return null;
  }

  const messageText = comparableTraceText(message.body);
  if (!messageText) {
    return null;
  }

  const matchedRun = sortRunsForDisplay(runs).find((run) => {
    if (run.conversation_id !== activeConversation.id) {
      return false;
    }

    const summary = comparableTraceText(run.prompt_summary);
    return Boolean(summary && (summary === messageText || summary.includes(messageText) || messageText.includes(summary)));
  });

  return matchedRun?.id ?? null;
}

function comparableTraceText(value: string): string {
  return stripDisplayedSystemPrompt(value).toLowerCase().replace(/\s+/g, " ").trim();
}

function runtimeStateStatusClass(activeRun: ApiRun | null, queuedRunCount: number): string {
  if (activeRun) {
    return "status-running";
  }
  if (queuedRunCount > 0) {
    return "status-queued";
  }

  return "status-idle";
}

function runQueueStatusClass(
  loadState: DmRunLoadState,
  activeRun: ApiRun | null,
  queuedRunCount: number,
  isDmConversation: boolean
): string {
  if (loadState === "error") {
    return "status-blocked";
  }
  if (activeRun) {
    return "status-running";
  }
  if (queuedRunCount > 0) {
    return "status-queued";
  }
  if (loadState === "loading" && isDmConversation) {
    return "status-reviewing";
  }

  return "status-idle";
}

function runQueueStatusLabel(
  loadState: DmRunLoadState,
  activeRun: ApiRun | null,
  queuedRunCount: number,
  isDmConversation: boolean
): string {
  if (loadState === "error") {
    return "Run status unavailable";
  }
  if (activeRun) {
    return "Run active";
  }
  if (queuedRunCount > 0) {
    return `${queuedRunCount} queued`;
  }
  if (loadState === "loading" && isDmConversation) {
    return "Refreshing run status";
  }

  return isDmConversation ? "No queued DM runs" : "Select a DM";
}

function isActiveRunStatus(status: string): boolean {
  const normalized = normalizeRunStatus(status);
  return normalized === "running" || normalized === "working" || normalized === "in-progress";
}

function isQueuedRunStatus(status: string): boolean {
  const normalized = normalizeRunStatus(status);
  return normalized === "queued" || normalized === "pending";
}

function normalizeRunStatus(status: string): string {
  return status.trim().toLowerCase().replace(/_/g, "-");
}

function runStatusLabel(status: string): string {
  const normalized = normalizeRunStatus(status);
  if (normalized === "running") return "Running";
  if (normalized === "queued") return "Queued";
  if (normalized === "completed") return "Completed";
  if (normalized === "failed") return "Failed";
  if (normalized === "canceled") return "Canceled";

  return titleize(normalized);
}

function runStatusDotClass(status: string): string {
  const normalized = normalizeRunStatus(status);
  if (normalized === "running" || normalized === "working" || normalized === "in-progress") {
    return "status-running";
  }
  if (normalized === "queued" || normalized === "pending") {
    return "status-queued";
  }
  if (normalized === "failed" || normalized === "blocked") {
    return "status-blocked";
  }
  if (normalized === "canceled") {
    return "status-offline";
  }

  return "status-idle";
}

function agentRuntimeStatusClass(status: string): string {
  const normalized = normalizeAgentStatus(status);
  if (normalized === "working") {
    return "status-running";
  }
  if (normalized === "pending") {
    return "status-queued";
  }

  return `status-${normalized}`;
}

function runShortLabel(run: ApiRun): string {
  const summary = stripDisplayedSystemPrompt(run.prompt_summary);
  if (summary) {
    return summary;
  }

  return `${run.agent_name || "Run"} ${run.id.slice(0, 8)}`;
}

function runSortTime(run: ApiRun): number {
  return dateTimeValue(run.started_at ?? run.ended_at ?? run.created_at) || dateTimeValue(run.updated_at);
}

function runQueuePriority(run: ApiRun): number {
  return typeof run.queue_priority === "number" ? run.queue_priority : 100;
}

function codexStdoutEntries(events: ApiRunEvent[]): CodexStdoutEntry[] {
  const entries: CodexStdoutEntry[] = [];

  for (const event of events) {
    if (event.event_type !== "codex.stdout") {
      continue;
    }

    const entry = codexStdoutEntry(event, codexStdoutValue(event));
    if (entry) {
      entries.push(entry);
    }
  }

  return entries;
}

function codexStdoutEntry(event: ApiRunEvent, value: unknown): CodexStdoutEntry | null {
  if (typeof value === "string") {
    const body = stripDisplayedSystemPrompt(value);
    if (!body) {
      return null;
    }

    return {
      body,
      command: "",
      createdAt: event.created_at,
      id: event.id,
      output: "",
      rows: [],
      title: "Stdout",
    };
  }

  const codexEvent = jsonRecord(value);
  const eventType = stringValue(codexEvent.type);
  const payload = jsonRecord(codexEvent.payload);
  const item = jsonRecord(codexEvent.item);
  const usage = jsonRecord(codexEvent.usage);
  const rows: Array<{ label: string; value: string }> = [];
  let title = eventType ? titleize(eventType) : "Codex Event";
  let body = "";
  let command = "";
  let output = "";

  if (eventType === "thread.started") {
    title = "Thread Started";
    appendRow(rows, "Thread ID", codexEvent.thread_id);
  } else if (eventType === "turn.started") {
    title = "Turn Started";
  } else if (eventType === "turn.completed") {
    title = "Turn Completed";
    appendUsageRows(rows, usage);
  } else if (eventType === "item.completed" || eventType === "item.started") {
    const itemType = stringValue(item.type);
    command = commandTextFromRecords(item, payload, codexEvent);
    if (itemType === "command_execution") {
      title = "Command Execution";
      output = firstTextField(item, ["aggregated_output", "output", "stdout", "stderr"]);
      appendRow(rows, "Status", item.status);
      appendRow(rows, "Exit code", item.exit_code);
      if (!command && !output) {
        return null;
      }
    } else {
      title = itemType
        ? eventType === "item.started"
          ? `${titleize(itemType)} Started`
          : titleize(itemType)
        : eventType === "item.started"
          ? "Item Started"
          : "Item Completed";
      body = firstTextField(item, ["text", "message", "summary", "content"]);
    }
  } else if (eventType === "event_msg") {
    const payloadType = stringValue(payload.type);
    title = payloadType ? titleize(payloadType) : "Event Message";
    body = firstTextField(payload, ["message", "text", "summary", "content"]);
    command = commandTextFromRecords(payload, codexEvent);
    appendRow(rows, "Payload Type", payloadType);
  } else {
    body =
      firstTextField(codexEvent, ["message", "text", "summary", "content"]) ||
      firstTextField(payload, ["message", "text", "summary", "content"]) ||
      firstTextField(item, ["message", "text", "summary", "content"]);
    command = commandTextFromRecords(item, payload, codexEvent);
    appendRow(rows, "Thread ID", codexEvent.thread_id);
    appendRow(rows, "Status", codexEvent.status);
    appendRow(rows, "ID", codexEvent.id);
  }

  body = stripDisplayedSystemPrompt(body);
  output = stripDisplayedSystemPrompt(output);
  if (!body && !command && !output && rows.length === 0) {
    return null;
  }

  return {
    body,
    command,
    createdAt: event.created_at,
    id: event.id,
    output,
    rows,
    title,
  };
}

function commandTextFromRecords(...records: JsonRecord[]): string {
  for (const record of records) {
    const direct = firstTextField(record, ["command", "cmd", "command_line", "shell_command"]);
    if (direct) {
      return direct;
    }

    let argv = stringArrayValue(record.argv);
    if (argv.length === 0) {
      argv = stringArrayValue(record.args);
    }
    if (argv.length > 0) {
      return argv.map(shellQuote).join(" ");
    }

    const nested = [
      jsonRecord(record.command),
      jsonRecord(record.exec),
      jsonRecord(record.input),
      jsonRecord(record.arguments),
      jsonRecord(record.payload),
    ];
    for (const child of nested) {
      if (Object.keys(child).length === 0) {
        continue;
      }

      const childCommand = commandTextFromRecords(child);
      if (childCommand) {
        return childCommand;
      }
    }
  }

  return "";
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function codexStdoutValue(event: ApiRunEvent): unknown {
  const payload = jsonRecord(event.payload);
  if (payload.event !== undefined) {
    return payload.event;
  }

  if (typeof payload.line === "string") {
    const line = payload.line.trim();
    if (!line) {
      return "";
    }

    try {
      return JSON.parse(line) as unknown;
    } catch {
      return line;
    }
  }

  return event.payload;
}

function appendUsageRows(rows: Array<{ label: string; value: string }>, usage: JsonRecord) {
  appendRow(rows, "Cached input tokens", usage.cached_input_tokens);
  appendRow(rows, "Input tokens", usage.input_tokens);
  appendRow(rows, "Output tokens", usage.output_tokens);
  appendRow(rows, "Reasoning tokens", usage.reasoning_output_tokens);
}

function appendRow(rows: Array<{ label: string; value: string }>, label: string, value: unknown) {
  const text = displayScalar(value);
  if (text) {
    rows.push({ label, value: text });
  }
}

function displayScalar(value: unknown): string {
  if (typeof value === "string") {
    return stripDisplayedSystemPrompt(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? formatNumber(value) : String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  return "";
}

function codexStreamText(events: ApiRunEvent[], stream: "stdout" | "stderr"): string {
  return events
    .filter((event) => event.event_type === `codex.${stream}`)
    .map(codexOutputLine)
    .filter((line) => stream !== "stderr" || !isIgnorableCodexStderr(line))
    .filter(Boolean)
    .join("\n");
}

function codexOutputLine(event: ApiRunEvent): string {
  const payload = jsonRecord(event.payload);
  if (typeof payload.line === "string") {
    return payload.line;
  }
  if (payload.event !== undefined) {
    return stringifyJson(payload.event);
  }

  return stringifyJson(event.payload);
}

function isIgnorableCodexStderr(line: string): boolean {
  const text = line.trim();
  return text.includes("ERROR codex_core::session: failed to record rollout items: thread ") && text.endsWith(" not found");
}

function traceEventSummaryItem(event: ApiRunEvent): ({ event: ApiRunEvent } & TraceEventSummary) | null {
  if (event.event_type === "codex.stdout") {
    const entry = codexStdoutEntry(event, codexStdoutValue(event));
    if (!entry) {
      return null;
    }

    const summary = traceEntrySummary(entry);
    return { event, label: entry.title, summary };
  }

  if (event.event_type === "codex.stderr") {
    const line = codexOutputLine(event);
    if (!line || isIgnorableCodexStderr(line)) {
      return null;
    }

    return { event, label: "Stderr", summary: truncateText(line, 220) };
  }

  const summary = eventTraceSummary(event);
  if (!summary) {
    return null;
  }

  return { event, label: traceEventLabel(event.event_type), summary };
}

function isTraceEventSummary(
  value: ({ event: ApiRunEvent } & TraceEventSummary) | null
): value is { event: ApiRunEvent } & TraceEventSummary {
  return value !== null;
}

function traceEntrySummary(entry: CodexStdoutEntry): string {
  if (entry.command) {
    return truncateText(entry.command, 220);
  }
  if (entry.body) {
    return truncateText(entry.body, 220);
  }
  if (entry.output) {
    return truncateText(entry.output, 220);
  }
  if (entry.rows.length > 0) {
    return truncateText(entry.rows.map((row) => `${row.label}: ${row.value}`).join("; "), 220);
  }

  return "";
}

function eventTraceSummary(event: ApiRunEvent): string {
  const payload = jsonRecord(event.payload);
  const detail = jsonRecord(payload.detail);
  const codexEvent = jsonRecord(payload.event);
  const codexPayload = jsonRecord(codexEvent.payload);
  const codexItem = jsonRecord(codexEvent.item);
  const codexDetail = jsonRecord(codexEvent.detail);

  const candidates = [
    firstTextField(payload, ["summary", "reason", "error", "message"]),
    firstTextField(detail, ["summary", "reason", "error", "message", "status"]),
    firstTextField(codexPayload, ["summary", "reason", "error", "message", "text", "content", "status"]),
    firstTextField(codexItem, ["summary", "message", "text", "content", "status"]),
    firstTextField(codexDetail, ["summary", "reason", "error", "message", "status"]),
    firstTextField(codexEvent, ["summary", "reason", "error", "message", "text", "content", "status"]),
    transitionSummary(payload),
    stringValue(payload.status),
    stringValue(payload.prompt_summary),
  ];

  for (const candidate of candidates) {
    const summary = traceSummaryText(candidate);
    if (summary) {
      return summary;
    }
  }

  return "";
}

const agentAddaRuntimePromptPrefix =
  "You are working inside Agent Adda. Treat this as your effective system and task prompt for this run.";
const agentAddaLatestTaskMarker = "Latest assigned task:";

function traceSummaryText(value: string): string {
  return truncateText(stripDisplayedSystemPrompt(value), 260);
}

function stripDisplayedSystemPrompt(value: string): string {
  let text = value.trim();
  if (!text) {
    return "";
  }

  return stripCurrentAgentAddaRuntimePrompt(text);
}

function stripCurrentAgentAddaRuntimePrompt(value: string): string {
  if (!value.startsWith(agentAddaRuntimePromptPrefix)) {
    return value;
  }

  const markerIndex = value.lastIndexOf(agentAddaLatestTaskMarker);
  if (markerIndex < 0) {
    return "";
  }

  return cleanTraceSummary(value.slice(markerIndex + agentAddaLatestTaskMarker.length));
}

function cleanTraceSummary(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/^\s*(?:system prompt|prompt|stdin|input)\s*[:=-]\s*/i, "")
    .replace(/^[\s:;,.|-]+/, "")
    .trim();
}

function transitionSummary(payload: JsonRecord): string {
  const fromStatus = stringValue(payload.from_status);
  const toStatus = stringValue(payload.to_status);
  if (!fromStatus && !toStatus) {
    return "";
  }

  return `${fromStatus || "unknown"} to ${toStatus || "unknown"}`;
}

function truncateText(value: string, maxChars: number): string {
  const text = value.trim();
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxChars - 3)).trim()}...`;
}

function traceEventLabel(eventType: string): string {
  return titleize(eventType.replace(/^run\./, ""));
}

function titleize(value: string): string {
  return value
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function jsonRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : {};
}

function firstTextField(payload: JsonRecord, keys: string[]): string {
  for (const key of keys) {
    const value = stringValue(payload[key]);
    if (value) {
      return value;
    }
  }

  return "";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeLookup(value: string): string {
  return value.trim().toLowerCase().replace(/^@/, "");
}

function dateTimeValue(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }

  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function formatCronDate(value: string | null | undefined): string {
  const time = dateTimeValue(value);
  if (!time) {
    return "not scheduled";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(time));
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined).format(value);
}

function conversationTitle(conversation: ConversationSummary): string {
  return conversation.kind === "channel" ? `# ${conversation.name}` : conversation.name;
}

function conversationIdFromHash(conversations: ConversationSummary[]): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const value = decodeURIComponent(window.location.hash.replace(/^#/, "")).trim();
  if (!value) {
    return null;
  }

  return conversations.some((conversation) => conversation.id === value) ? value : null;
}

function setConversationHash(conversationId: string) {
  if (typeof window === "undefined") {
    return;
  }

  const nextHash = `#${encodeURIComponent(conversationId)}`;
  if (window.location.hash !== nextHash) {
    history.replaceState(null, "", `${window.location.pathname}${window.location.search}${nextHash}`);
  }
}

function formatMessageTime(value: string): string {
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    return value.slice(11, 16) || "--:--";
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function StatusCell({
  children,
  title,
  variant
}: {
  children: ReactNode;
  title?: string;
  variant?: "error";
}) {
  return (
    <div
      className={`win-panel flex min-w-0 items-center gap-2 truncate px-3 ${variant === "error" ? "aa-statusbar-alert" : ""}`}
      title={title}
    >
      {children}
    </div>
  );
}

function MessageStateRow({
  kind,
  title,
  detail
}: {
  kind: "loading" | "empty" | "error";
  title: string;
  detail?: string;
}) {
  const Icon = kind === "error" ? AlertTriangle : kind === "loading" ? RefreshCw : MessageSquare;

  return (
    <article className="grid grid-cols-[40px_minmax(0,1fr)] gap-2 border-b border-[#bbb] p-3 sm:grid-cols-[78px_54px_minmax(0,1fr)]">
      <div className="col-span-2 text-[11px] font-medium tracking-[0.02em] text-[var(--adda-muted)] tabular-nums sm:col-span-1 sm:text-sm sm:text-black">--:--</div>
      <div className="grid h-10 w-10 place-items-center border border-[#777] bg-[#d9d9d9]">
        <Icon className={kind === "loading" ? "animate-spin" : ""} size={22} />
      </div>
      <div className="min-w-0">
        <h3 className="truncate font-bold">{title}</h3>
        {detail ? <p className="max-w-[760px] break-words leading-snug">{detail}</p> : null}
      </div>
    </article>
  );
}
