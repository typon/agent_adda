import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ClipboardList,
  RefreshCw,
  SquareTerminal,
  XCircle
} from "lucide-react";
import {
  createAgentRunPlan,
  listAgents,
  listConversations,
  listRecentRunEvents,
  listRunStats,
  type ApiAgent,
  type ApiConversation,
  type ApiRecentRunEvent,
  type ApiRunPlanResponse,
  type ApiRunStats
} from "@/lib/api/missionControl";
import { Sidebar } from "./Sidebar";
import { WindowChrome } from "./WindowChrome";
import { normalizeAgentStatus, type AppAgent, type ConversationSummary } from "./types";

type BuilderSource = "loading" | "api" | "partial" | "unavailable";
type PlanState = "idle" | "planning" | "ready" | "error";

type RunBuilderRecords = {
  agents: AppAgent[];
  conversations: ConversationSummary[];
  recentEvents: ApiRecentRunEvent[];
  runStats: ApiRunStats[];
  source: BuilderSource;
  notice: string | null;
};

type PlanStep = {
  id: string;
  name: string;
  tool: string;
  output: string;
  status: "idle" | "ok" | "warning";
};

const emptyBuilderRecords: RunBuilderRecords = {
  agents: [],
  conversations: [],
  recentEvents: [],
  runStats: [],
  source: "loading",
  notice: null
};

export function RunBuilderPage() {
  const [records, setRecords] = useState<RunBuilderRecords>(emptyBuilderRecords);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [selectedConversationId, setSelectedConversationId] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [prompt, setPrompt] = useState("");
  const [planState, setPlanState] = useState<PlanState>("idle");
  const [planResponse, setPlanResponse] = useState<ApiRunPlanResponse | null>(null);
  const [planNotice, setPlanNotice] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    loadRunBuilderRecords(controller.signal).then((nextRecords) => {
      if (controller.signal.aborted) {
        return;
      }

      setRecords(nextRecords);
      setSelectedAgentId((current) => current || nextRecords.agents[0]?.id || "");
      setSelectedConversationId((current) => current || firstChannelId(nextRecords.conversations));
    });

    return () => controller.abort();
  }, [refreshToken]);

  const selectedAgent = records.agents.find((agent) => agent.id === selectedAgentId) ?? null;
  const selectedConversation =
    records.conversations.find((conversation) => conversation.id === selectedConversationId) ?? null;
  const planSteps = useMemo(
    () => buildPlanSteps(planResponse, selectedAgent, prompt),
    [planResponse, prompt, selectedAgent]
  );
  const activeRuns = activeRunCount(records.runStats);
  const canCreatePlan = Boolean(selectedAgent && prompt.trim()) && planState !== "planning";

  function handleCreatePlan(event: { preventDefault: () => void }) {
    event.preventDefault();

    if (!selectedAgent || !prompt.trim() || planState === "planning") {
      return;
    }

    const workspaceOverride = workspace.trim();
    setPlanState("planning");
    setPlanNotice(null);
    setPlanResponse(null);

    createAgentRunPlan(selectedAgent.id, {
      prompt: prompt.trim(),
      workspace: workspaceOverride || undefined,
      conversation_id: selectedConversation?.id
    })
      .then((response) => {
        setPlanResponse(response);
        setPlanState("ready");
        setPlanNotice("Run plan created. Backend returned a Codex command plan; execution is not wired yet.");
      })
      .catch((error: unknown) => {
        setPlanState("error");
        setPlanNotice(planErrorMessage(error));
      });
  }

  function handleClear() {
    setPrompt("");
    setPlanResponse(null);
    setPlanState("idle");
    setPlanNotice(null);
  }

  return (
    <WindowChrome
      title="Agent Adda - Run Builder"
      toolbar={[]}
      statusItems={
        <>
          <StatusCell>{formatNumber(records.agents.length)} agents</StatusCell>
          <StatusCell>{formatNumber(activeRuns)} active runs</StatusCell>
          <StatusCell>{sourceStatusLabel(records.source)}</StatusCell>
          <StatusCell>{planState === "ready" ? "Plan ready" : "No plan"}</StatusCell>
        </>
      }
    >
      <div className="h-full min-h-0 p-0 text-[12px] md:flex md:gap-1 md:p-1 md:text-[15px]">
        <Sidebar
          agents={records.agents}
          className="hidden md:flex"
          conversations={records.conversations}
          loading={records.source === "loading"}
          notice={records.notice}
        />
        <section className="win-panel flex h-full min-w-0 flex-1 flex-col overflow-hidden">
          <div className="win-titlebar">Run Builder - Backend Plan</div>
          <form
            className="grid grid-cols-2 gap-1 border-b border-[#777] bg-[#d7d7d7] p-2 md:grid-cols-[220px_220px_minmax(180px,1fr)_auto_auto] md:gap-2 max-xl:md:grid-cols-2"
            onSubmit={handleCreatePlan}
          >
            <label className="grid gap-1 text-[11px] font-bold md:text-sm">
              Agent
              <select
                aria-label="Agent"
                className="win-select h-9 min-w-0 px-2 font-normal"
                disabled={records.agents.length === 0 || planState === "planning"}
                onChange={(event) => setSelectedAgentId(event.target.value)}
                value={selectedAgentId}
              >
                {records.agents.length > 0 ? (
                  records.agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))
                ) : (
                  <option value="">No backend agents</option>
                )}
              </select>
            </label>

            <label className="grid gap-1 text-[11px] font-bold md:text-sm">
              Room
              <select
                aria-label="Room"
                className="win-select h-9 min-w-0 px-2 font-normal"
                disabled={records.conversations.length === 0 || planState === "planning"}
                onChange={(event) => setSelectedConversationId(event.target.value)}
                value={selectedConversationId}
              >
                {records.conversations.length > 0 ? (
                  records.conversations.map((conversation) => (
                    <option key={conversation.id} value={conversation.id}>
                      {conversation.kind === "channel" ? `# ${conversation.name}` : conversation.name}
                    </option>
                  ))
                ) : (
                  <option value="">No backend rooms</option>
                )}
              </select>
            </label>

            <label className="col-span-full grid gap-1 text-[11px] font-bold md:col-span-1 md:text-sm">
              Workspace Override
              <input
                className="win-input h-9 min-w-0 px-2 font-normal"
                onChange={(event) => setWorkspace(event.target.value)}
                placeholder="Uses backend workspace setting"
                value={workspace}
              />
            </label>

            <button className="win-button mt-auto h-8 min-h-0 px-2 py-0 md:h-9 md:px-3" disabled={!canCreatePlan} type="submit">
              {planState === "planning" ? "Planning" : "Create Plan"}
            </button>
            <button className="win-button mt-auto h-8 min-h-0 px-2 py-0 md:h-9 md:px-3" onClick={handleClear} type="button">
              Clear
            </button>

            <label className="col-span-full grid gap-1 text-[11px] font-bold md:text-sm">
              Prompt
              <textarea
                className="win-panel-inset min-h-16 resize-y p-2 font-normal md:min-h-24"
                disabled={planState === "planning"}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Describe the concrete work for the selected agent."
                value={prompt}
              />
            </label>
          </form>

          <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="app-scrollbar min-h-0 overflow-auto bg-[radial-gradient(#b7b7b7_1px,transparent_1px)] p-2 [background-size:18px_18px] md:p-5">
              <div className="mx-auto flex max-w-[560px] flex-col items-center gap-2 md:gap-4">
                {planSteps.length > 0 ? (
                  planSteps.map((step, index) => (
                    <div className="contents" key={step.id}>
                      <div className={`win-panel relative grid w-full max-w-[480px] grid-cols-[32px_minmax(0,1fr)_58px] gap-2 bg-[#ededed] p-2 md:grid-cols-[44px_minmax(0,1fr)_86px] md:p-3 ${step.status === "warning" ? "outline outline-2 outline-[#9f7600]" : ""}`}>
                        <div className="grid place-items-center">
                          {step.id === "command" ? <SquareTerminal size={25} /> : <Bot size={25} />}
                        </div>
                        <div className="min-w-0">
                          <strong className="block truncate">{index + 1}. {step.name}</strong>
                          <div className="truncate text-[11px] md:text-sm">Tool: {step.tool}</div>
                          <div className="truncate text-[11px] md:text-sm">Output: {step.output}</div>
                        </div>
                        <div className="text-[11px] md:text-sm">{step.status === "ok" ? "Ready" : step.status === "warning" ? "Manual" : "Idle"}</div>
                        <span className={`status-dot absolute right-2 top-2 ${step.status === "ok" ? "status-working" : step.status === "warning" ? "status-awaiting-human" : "status-idle"}`} />
                      </div>
                      {index < planSteps.length - 1 ? <div className="h-5 border-l-2 border-black" /> : null}
                    </div>
                  ))
                ) : (
                  <EmptyCanvas source={records.source} />
                )}
              </div>
            </div>

            <aside className="app-scrollbar min-h-0 overflow-auto border-t border-[#777] bg-[#d0d0d0] p-2 md:border-l md:border-t-0 md:p-3">
              <h2 className="mb-3 text-base font-bold">Plan Properties</h2>
              <DetailRow label="Agent" value={selectedAgent?.name ?? "No agent selected"} />
              <DetailRow label="Role" value={selectedAgent?.role ?? "-"} />
              <DetailRow label="Model" value={planResponse?.plan.model ?? selectedAgent?.model ?? "-"} />
              <DetailRow label="Reasoning" value={planResponse?.plan.reasoning_effort ?? selectedAgent?.reasoningEffort ?? "-"} />
              <DetailRow label="Room" value={selectedConversation ? conversationLabel(selectedConversation) : "-"} />
              <DetailRow label="Run ID" value={planResponse?.plan.run_id ?? "Not planned"} />

              <section className="win-panel-inset mt-4 p-3" aria-labelledby="command-title">
                <h3 id="command-title" className="mb-2 flex items-center gap-2 font-bold">
                  <SquareTerminal size={17} />
                  Codex Command
                </h3>
                {planResponse ? (
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words border border-[#aaa] bg-white p-2 text-xs">
                    {commandPreview(planResponse)}
                  </pre>
                ) : (
                  <p className="text-sm text-[var(--adda-muted)]">
                    Create a plan to view the command the backend would run.
                  </p>
                )}
              </section>
            </aside>
          </div>

          <div className="grid min-h-[112px] grid-cols-1 gap-2 border-t border-[#777] bg-[#d0d0d0] p-2 md:min-h-[146px] xl:grid-cols-[minmax(0,1fr)_320px]">
            <section className="win-panel-inset min-w-0 p-3">
              <div className="mb-2 flex items-center gap-2">
                {planState === "error" ? <AlertTriangle className="text-[var(--adda-danger)]" size={18} /> : <CheckCircle2 className="text-[var(--adda-success)]" size={18} />}
                <strong>Plan Output</strong>
              </div>
              <p className="break-words text-sm">
                {planNotice ??
                  (records.source === "loading"
                    ? "Loading backend agents and run history..."
                    : "Select an agent, enter a prompt, and create a backend run plan.")}
              </p>
            </section>

            <section className="win-panel-inset p-3" aria-labelledby="recent-events-title">
              <div className="mb-2 flex items-center gap-2">
                <ClipboardList size={18} />
                <h3 id="recent-events-title" className="font-bold">Recent Run Events</h3>
                <button
                  className="win-button ml-auto grid h-7 min-h-0 w-8 place-items-center p-0"
                  onClick={() => setRefreshToken((value) => value + 1)}
                  type="button"
                  aria-label="Refresh run events"
                >
                  <RefreshCw size={14} />
                </button>
              </div>
              {records.recentEvents.length > 0 ? (
                <div className="grid gap-1 text-sm">
                  {records.recentEvents.slice(0, 4).map((event) => (
                    <div className="grid grid-cols-[58px_minmax(0,1fr)] gap-2" key={event.id}>
                      <time className="tabular-nums">{formatShortTime(event.created_at)}</time>
                      <span className="truncate">{event.event_type} - {event.run_id}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-[var(--adda-muted)]">
                  {records.source === "unavailable" ? "Backend unavailable." : "No recent run events recorded."}
                </p>
              )}
            </section>
          </div>
        </section>
      </div>
    </WindowChrome>
  );
}

async function loadRunBuilderRecords(signal: AbortSignal): Promise<RunBuilderRecords> {
  const [agentsResult, conversationsResult, eventsResult, runStatsResult] = await Promise.allSettled([
    listAgents(signal),
    listConversations(signal),
    listRecentRunEvents(20, signal),
    listRunStats(signal)
  ]);

  const fulfilledCount = [agentsResult, conversationsResult, eventsResult, runStatsResult].filter(
    (result) => result.status === "fulfilled"
  ).length;

  return {
    agents: valueOr<ApiAgent[]>(agentsResult, []).map(mapApiAgent),
    conversations: valueOr<ApiConversation[]>(conversationsResult, []).map(mapApiConversation),
    recentEvents: valueOr<ApiRecentRunEvent[]>(eventsResult, []),
    runStats: valueOr<ApiRunStats[]>(runStatsResult, []),
    source: fulfilledCount === 0 ? "unavailable" : fulfilledCount === 4 ? "api" : "partial",
    notice: noticeForFulfilledCount(fulfilledCount)
  };
}

function buildPlanSteps(
  planResponse: ApiRunPlanResponse | null,
  selectedAgent: AppAgent | null,
  prompt: string
): PlanStep[] {
  if (!planResponse) {
    return [];
  }

  const promptLabel = prompt.trim() ? `${Math.min(prompt.trim().length, 999)} chars` : "Prompt";

  return [
    {
      id: "prompt",
      name: "Prompt Intake",
      tool: "Run Builder",
      output: promptLabel,
      status: "ok"
    },
    {
      id: "agent",
      name: selectedAgent?.name ?? "Agent",
      tool: planResponse.request.model,
      output: planResponse.request.reasoning_effort,
      status: "ok"
    },
    {
      id: "command",
      name: "Codex Command",
      tool: planResponse.command.program,
      output: `${planResponse.command.args.length} args`,
      status: "ok"
    }
  ];
}

function mapApiAgent(agent: ApiAgent): AppAgent {
  return {
    id: agent.id,
    name: agent.name || agent.slug || agent.id,
    slug: agent.slug,
    status: normalizeAgentStatus(agent.status),
    role: agent.role || "Agent",
    description: agent.description,
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

function valueOr<T>(result: PromiseSettledResult<T>, fallback: T): T {
  return result.status === "fulfilled" ? result.value : fallback;
}

function noticeForFulfilledCount(count: number): string | null {
  if (count === 0) {
    return "Backend unavailable. Run planning is disabled.";
  }
  if (count < 4) {
    return "Some run builder endpoints are unavailable. Showing partial backend data.";
  }

  return null;
}

function firstChannelId(conversations: ConversationSummary[]): string {
  return conversations.find((conversation) => conversation.kind === "channel")?.id ?? conversations[0]?.id ?? "";
}

function conversationLabel(conversation: ConversationSummary): string {
  return conversation.kind === "channel" ? `# ${conversation.name}` : conversation.name;
}

function commandPreview(response: ApiRunPlanResponse): string {
  const args = response.command.args.map(shellPart).join(" ");
  return `${shellPart(response.command.program)} ${args}\n\nstdin:\n${response.command.stdin}`;
}

function shellPart(value: string): string {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(value)) {
    return value;
  }

  return JSON.stringify(value);
}

function planErrorMessage(error: unknown): string {
  if (isApiStatus(error, 400)) {
    return "Run plan failed. Enter a workspace override or configure workspace_path in Settings.";
  }
  if (isApiStatus(error, 404)) {
    return "Run plan failed. The selected agent or room was not found by the backend.";
  }

  return "Run plan failed. Backend is unavailable or returned an error.";
}

function isApiStatus(error: unknown, status: number): boolean {
  return typeof error === "object" && error !== null && "status" in error && (error as { status?: unknown }).status === status;
}

function EmptyCanvas({ source }: { source: BuilderSource }) {
  return (
    <div className="win-panel-inset grid min-h-[260px] w-full max-w-[520px] place-items-center p-6 text-center text-[var(--adda-muted)]">
      <div>
        <XCircle className="mx-auto mb-3" size={34} />
        <p>
          {source === "loading"
            ? "Loading backend builder data..."
            : source === "unavailable"
              ? "Backend unavailable. No run plan can be created."
              : "No run plan yet."}
        </p>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="mb-2 grid grid-cols-[92px_minmax(0,1fr)] items-start gap-2 text-sm max-sm:grid-cols-1 max-sm:gap-0">
      <span className="font-bold">{label}:</span>
      <span className="min-w-0 break-words">{value}</span>
    </div>
  );
}

function activeRunCount(rows: ApiRunStats[]): number {
  return statusCount(rows, ["running", "working", "in-progress", "in_progress"]);
}

function statusCount(rows: ApiRunStats[], names: string[]): number {
  let count = 0;
  const accepted = new Set(names.map(normalizeStatus));

  for (const row of rows) {
    if (accepted.has(normalizeStatus(row.status))) {
      count += row.count;
    }
  }

  return count;
}

function normalizeStatus(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, "-");
}

function sourceStatusLabel(source: BuilderSource): string {
  if (source === "loading") return "Connecting";
  if (source === "api") return "API OK";
  if (source === "partial") return "Partial API";
  return "API unavailable";
}

function formatShortTime(value: string): string {
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

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined).format(value);
}

function StatusCell({ children }: { children: ReactNode }) {
  return (
    <div className="win-panel flex min-w-0 items-center gap-2 truncate px-3">
      {children}
    </div>
  );
}
