import { useEffect, useState, type ReactNode } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Bot,
  CheckCircle2,
  Info,
  Mail,
  RefreshCw,
} from "lucide-react";
import { StatsSummaryPanel } from "@/components/stats/StatsSummaryPanel";
import {
  listAgents,
  listAgentStats,
  listConversations,
  listRecentRunEvents,
  listRunStats,
  type ApiAgent,
  type ApiAgentStats,
  type ApiConversation,
  type ApiRecentRunEvent,
  type ApiRunStats
} from "@/lib/api/missionControl";
import { Sidebar } from "./Sidebar";
import { WindowChrome } from "./WindowChrome";
import {
  normalizeAgentStatus,
  opsToolbar,
  type AppAgent,
  type ConversationSummary
} from "./types";

type OpsSource = "loading" | "api" | "partial" | "unavailable";

type OpsRecords = {
  agents: AppAgent[];
  conversations: ConversationSummary[];
  recentEvents: ApiRecentRunEvent[];
  runStats: ApiRunStats[];
  agentStats: ApiAgentStats[];
  source: OpsSource;
  notice: string | null;
};

type JsonRecord = Record<string, unknown>;

const emptyOpsRecords: OpsRecords = {
  agents: [],
  conversations: [],
  recentEvents: [],
  runStats: [],
  agentStats: [],
  source: "loading",
  notice: null
};

export function OpsDeskPage() {
  const [records, setRecords] = useState<OpsRecords>(emptyOpsRecords);
  const [selectedEventId, setSelectedEventId] = useState("");
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    setRecords((current) => ({
      ...current,
      source: current.source === "loading" ? "loading" : current.source,
      notice: current.source === "loading" ? "Connecting to API..." : current.notice
    }));

    loadOpsDeskRecords(controller.signal).then((nextRecords) => {
      if (controller.signal.aborted) {
        return;
      }

      setRecords(nextRecords);
      setSelectedEventId((current) => {
        if (nextRecords.recentEvents.some((event) => event.id === current)) {
          return current;
        }

        return nextRecords.recentEvents[0]?.id ?? "";
      });
    });

    return () => controller.abort();
  }, [refreshToken]);

  const selectedEvent =
    records.recentEvents.find((event) => event.id === selectedEventId) ?? records.recentEvents[0] ?? null;
  const selectedPayload = selectedEvent ? parsePayload(selectedEvent.payload_json) : {};
  const activeRuns = activeRunCount(records.runStats);
  const queuedRuns = statusCount(records.runStats, ["queued", "pending", "planned"]);
  const failedRuns = statusCount(records.runStats, ["failed", "error", "blocked"]);
  const onlineAgents = records.agents.filter((agent) => agent.status !== "offline").length;
  const sourceLabel = sourceStatusLabel(records.source);

  return (
    <WindowChrome
      title="Agent Adda - Ops Desk"
      toolbar={opsToolbar}
      statusItems={
        <>
          <StatusCell>{formatNumber(records.recentEvents.length)} recent events</StatusCell>
          <StatusCell>{formatNumber(activeRuns)} active runs</StatusCell>
          <StatusCell>{sourceLabel}</StatusCell>
          <StatusCell>Ops</StatusCell>
          <StatusCell compact>INS</StatusCell>
        </>
      }
    >
      <div className="flex h-full gap-1 p-1 max-lg:flex-col max-lg:[&>aside:first-child]:max-h-[260px] max-lg:[&>aside:first-child]:w-full">
        <Sidebar
          agents={records.agents}
          conversations={records.conversations}
          loading={records.source === "loading"}
          notice={records.notice}
        />
        <section className="win-panel flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="win-titlebar">Run Events - Recent Activity</div>
          <div className="flex min-h-11 flex-wrap items-center gap-2 border-b border-[#777] bg-[#d7d7d7] px-2 py-1">
            <button
              className="win-button flex h-8 min-h-0 items-center gap-2 px-3 py-0"
              disabled={records.source === "loading"}
              onClick={() => setRefreshToken((value) => value + 1)}
              type="button"
            >
              <RefreshCw size={16} className={records.source === "loading" ? "animate-spin" : ""} />
              Refresh
            </button>
            <span className="ml-auto min-w-0 truncate text-sm">
              {records.source === "loading" ? "Loading backend events..." : records.notice ?? "Backend event log connected."}
            </span>
          </div>

          <div className="app-scrollbar min-h-0 flex-1 overflow-auto bg-[#f4f4f4]">
            <table className="min-w-[760px] w-full table-fixed border-collapse text-left text-sm">
              <caption className="sr-only">Recent run events</caption>
              <colgroup>
                <col className="w-10" />
                <col className="w-24" />
                <col className="w-32" />
                <col className="w-36" />
                <col />
                <col className="w-24" />
              </colgroup>
              <thead className="sticky top-0 bg-[#d7d7d7]">
                <tr>
                  {["", "Time", "Run", "Event", "Detail", "State"].map((header) => (
                    <th className="border border-[#aaa] px-2 py-2" key={header} scope="col">
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {records.recentEvents.length > 0 ? (
                  records.recentEvents.map((event) => {
                    const payload = parsePayload(event.payload_json);
                    const row = runEventRow(event, payload);
                    const selected = event.id === selectedEvent?.id;

                    return (
                      <tr
                        className={selected ? "bg-[var(--adda-blue)] text-white" : ""}
                        key={event.id}
                      >
                        <td className="border border-[#c8c8c8] px-2 py-2">{iconFor(row.severity, selected)}</td>
                        <td className="border border-[#c8c8c8] px-2 py-2 tabular-nums">{row.time}</td>
                        <td className="border border-[#c8c8c8] px-2 py-2 font-bold" title={event.run_id}>
                          <span className="block truncate">{shortRunId(event.run_id)}</span>
                        </td>
                        <td className="border border-[#c8c8c8] px-2 py-2">
                          <span className="block truncate">{row.eventType}</span>
                        </td>
                        <td className="border border-[#c8c8c8] px-2 py-2">
                          <span className="block truncate">{row.detail}</span>
                        </td>
                        <td className="border border-[#c8c8c8] px-2 py-2">
                          <button
                            className={`w-full text-left ${selected ? "font-bold" : "text-[var(--adda-blue)]"}`}
                            onClick={() => setSelectedEventId(event.id)}
                            type="button"
                          >
                            Inspect
                          </button>
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td className="border border-[#c8c8c8] px-2 py-8 text-center text-[var(--adda-muted)]" colSpan={6}>
                      {records.source === "loading"
                        ? "Loading recent run events..."
                        : records.source === "unavailable"
                          ? "Backend unavailable. No run events can be loaded."
                          : "No run events recorded yet."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="grid min-h-[230px] grid-cols-[minmax(0,1fr)_320px] gap-3 border-t border-[#777] bg-[#efefef] p-3 max-xl:grid-cols-1">
            <section className="min-w-0">
              <div className="win-titlebar">
                Details {selectedEvent ? `- ${selectedEvent.event_type}` : "- No Event Selected"}
              </div>
              <div className="win-panel-inset min-h-[180px] p-3">
                {selectedEvent ? (
                  <div className="grid gap-3 lg:grid-cols-[68px_minmax(0,1fr)]">
                    <div className="grid h-14 w-14 place-items-center border border-[#777] bg-[#d9d9d9]">
                      {iconFor(runEventSeverity(selectedEvent.event_type), false, 38)}
                    </div>
                    <div className="min-w-0">
                      <p className="mb-3 break-words">
                        <strong>{selectedEvent.run_id}</strong> emitted <strong>{selectedEvent.event_type}</strong>{" "}
                        at {formatDateTime(selectedEvent.created_at)}.
                      </p>
                      <dl className="grid grid-cols-[132px_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
                        <dt className="font-bold">Run ID:</dt>
                        <dd className="min-w-0 break-words">{selectedEvent.run_id}</dd>
                        <dt className="font-bold">Event ID:</dt>
                        <dd className="min-w-0 break-words">{selectedEvent.id}</dd>
                        <dt className="font-bold">Summary:</dt>
                        <dd className="min-w-0 break-words">{payloadSummary(selectedPayload) || "No summary in payload."}</dd>
                        <dt className="font-bold">Payload:</dt>
                        <dd className="min-w-0">
                          <PayloadTable payload={selectedPayload} />
                        </dd>
                      </dl>
                    </div>
                  </div>
                ) : (
                  <EmptyDetail source={records.source} />
                )}
              </div>
            </section>

            <section className="win-panel-inset p-3" aria-labelledby="run-state-title">
              <h3 id="run-state-title" className="mb-2 font-bold">Run State Counts</h3>
              {records.runStats.length > 0 ? (
                <div className="grid gap-2">
                  {records.runStats.map((stat) => (
                    <div className="grid grid-cols-[1fr_64px] items-center gap-2" key={stat.status}>
                      <span className="truncate">{stat.status}</span>
                      <strong className="text-right tabular-nums">{formatNumber(stat.count)}</strong>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-[var(--adda-muted)]">
                  {records.source === "loading" ? "Loading run stats..." : "No persisted run rows yet."}
                </p>
              )}
            </section>
          </div>
        </section>

        <aside className="win-panel hidden w-[318px] shrink-0 flex-col overflow-hidden xl:flex">
          <div className="win-titlebar">System Summary</div>
          <div className="app-scrollbar min-h-0 space-y-3 overflow-auto p-3">
            <Metric label="Active Runs" value={formatNumber(activeRuns)} pct={boundedPercent(activeRuns, 8)} />
            <Metric label="Queued Runs" value={formatNumber(queuedRuns)} pct={boundedPercent(queuedRuns, 8)} />
            <Metric label="Failed / Blocked" value={formatNumber(failedRuns)} pct={boundedPercent(failedRuns, 8)} danger />
            <Metric label="Agent Availability" value={`${onlineAgents} / ${records.agents.length}`} pct={availabilityPercent(onlineAgents, records.agents.length)} good />
            <StatsSummaryPanel
              agentStats={records.agentStats}
              compact
              error={records.source === "unavailable" ? "Stats API unavailable." : null}
              loading={records.source === "loading"}
              runStats={records.runStats}
            />
          </div>
        </aside>
      </div>
    </WindowChrome>
  );
}

async function loadOpsDeskRecords(signal: AbortSignal): Promise<OpsRecords> {
  const [agentsResult, conversationsResult, eventsResult, runStatsResult, agentStatsResult] =
    await Promise.allSettled([
      listAgents(signal),
      listConversations(signal),
      listRecentRunEvents(50, signal),
      listRunStats(signal),
      listAgentStats(signal)
    ]);

  const fulfilledCount = [
    agentsResult,
    conversationsResult,
    eventsResult,
    runStatsResult,
    agentStatsResult
  ].filter((result) => result.status === "fulfilled").length;

  const agents = valueOr<ApiAgent[]>(agentsResult, []).map(mapApiAgent);
  const conversations = valueOr<ApiConversation[]>(conversationsResult, []).map(mapApiConversation);

  return {
    agents,
    conversations,
    recentEvents: valueOr<ApiRecentRunEvent[]>(eventsResult, []),
    runStats: valueOr<ApiRunStats[]>(runStatsResult, []),
    agentStats: valueOr<ApiAgentStats[]>(agentStatsResult, []),
    source: fulfilledCount === 0 ? "unavailable" : fulfilledCount === 5 ? "api" : "partial",
    notice: noticeForFulfilledCount(fulfilledCount)
  };
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
    return "Backend unavailable. Showing empty ops state.";
  }
  if (count < 5) {
    return "Some ops endpoints are unavailable. Showing partial backend data.";
  }

  return null;
}

function runEventRow(event: ApiRecentRunEvent, payload: JsonRecord) {
  const eventType = titleize(event.event_type);

  return {
    eventType,
    severity: runEventSeverity(event.event_type),
    time: formatShortTime(event.created_at),
    detail: payloadSummary(payload) || "No payload summary"
  };
}

function runEventSeverity(eventType: string): "critical" | "warning" | "complete" | "info" {
  const normalized = eventType.toLowerCase();

  if (normalized.includes("fail") || normalized.includes("error")) {
    return "critical";
  }
  if (normalized.includes("block") || normalized.includes("approval") || normalized.includes("await")) {
    return "warning";
  }
  if (normalized.includes("complete") || normalized.includes("finish") || normalized.includes("success")) {
    return "complete";
  }

  return "info";
}

function payloadSummary(payload: JsonRecord): string {
  return textField(payload, ["summary", "message", "error", "detail", "status", "step", "phase"]);
}

function parsePayload(payloadJson: string): JsonRecord {
  try {
    const payload = JSON.parse(payloadJson) as unknown;
    if (isRecord(payload)) {
      return payload;
    }

    return { value: String(payload) };
  } catch {
    return { raw: payloadJson };
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textField(payload: JsonRecord, keys: string[]): string {
  for (const key of keys) {
    const value = payload[key];

    if (typeof value === "string" && value.trim()) {
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
  }

  return "";
}

function PayloadTable({ payload }: { payload: JsonRecord }) {
  const entries = Object.entries(payload);

  if (entries.length === 0) {
    return <span className="text-[var(--adda-muted)]">Empty payload</span>;
  }

  return (
    <div className="max-h-24 overflow-auto border border-[#aaa] bg-white">
      {entries.slice(0, 8).map(([key, value]) => (
        <div className="grid grid-cols-[110px_minmax(0,1fr)] border-b border-[#ddd] last:border-b-0" key={key}>
          <span className="truncate bg-[#efefef] px-2 py-1 font-bold">{key}</span>
          <span className="min-w-0 break-words px-2 py-1">{formatPayloadValue(value)}</span>
        </div>
      ))}
    </div>
  );
}

function formatPayloadValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null) {
    return "null";
  }

  return JSON.stringify(value);
}

function EmptyDetail({ source }: { source: OpsSource }) {
  return (
    <div className="flex min-h-[140px] items-center gap-3 text-[var(--adda-muted)]">
      <Mail size={28} />
      <p>
        {source === "loading"
          ? "Loading event details..."
          : "Select a recent backend run event when one is available."}
      </p>
    </div>
  );
}

function Metric({
  label,
  value,
  pct,
  good,
  danger
}: {
  label: string;
  value: string;
  pct: number;
  good?: boolean;
  danger?: boolean;
}) {
  return (
    <div className="win-panel-inset p-3">
      <div className="flex justify-between gap-3">
        <strong className="truncate">{label}</strong>
        <span className="shrink-0 tabular-nums">{value}</span>
      </div>
      <div className="mt-2 h-5 border border-[#aaa] bg-white p-[2px]">
        <div
          className={`h-full ${danger ? "bg-[var(--adda-danger)]" : good ? "bg-[var(--adda-success)]" : "bg-[var(--adda-blue)]"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function iconFor(kind: string, selected = false, size = 22) {
  const className = selected ? "text-white" : undefined;

  if (kind === "critical") return <AlertCircle className={selected ? "text-white" : "text-[var(--adda-danger)]"} size={size} />;
  if (kind === "warning") return <AlertTriangle className={selected ? "text-white" : "text-[#9f7600]"} size={size} />;
  if (kind === "complete") return <CheckCircle2 className={selected ? "text-white" : "text-[var(--adda-success)]"} size={size} />;
  if (kind === "agent") return <Bot className={className} size={size} />;

  return <Info className={selected ? "text-white" : "text-[var(--adda-info)]"} size={size} />;
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

function boundedPercent(value: number, max: number): number {
  if (max <= 0) {
    return 0;
  }

  return Math.max(4, Math.min(100, Math.round((value / max) * 100)));
}

function availabilityPercent(online: number, total: number): number {
  if (total <= 0) {
    return 0;
  }

  return Math.round((online / total) * 100);
}

function sourceStatusLabel(source: OpsSource): string {
  if (source === "loading") return "Connecting";
  if (source === "api") return "API OK";
  if (source === "partial") return "Partial API";
  return "API unavailable";
}

function titleize(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatShortTime(value: string): string {
  const date = parseDate(value);
  if (!date) {
    return value.slice(11, 16) || "--:--";
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function formatDateTime(value: string): string {
  const date = parseDate(value);
  if (!date) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function parseDate(value: string): Date | null {
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const date = new Date(normalized);

  return Number.isNaN(date.getTime()) ? null : date;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined).format(value);
}

function shortRunId(runId: string): string {
  const value = runId.trim();
  if (value.length <= 12) {
    return value;
  }

  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function StatusCell({ children, compact }: { children: ReactNode; compact?: boolean }) {
  return (
    <div className={`win-panel flex min-w-0 items-center gap-2 truncate ${compact ? "aa-statusbar-ins" : "px-3"}`}>
      {children}
    </div>
  );
}
