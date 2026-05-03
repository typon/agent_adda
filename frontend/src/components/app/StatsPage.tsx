import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { AlertTriangle, BarChart3, Database, GitPullRequest, RefreshCw, Users } from "lucide-react";
import {
  listAgents,
  listAgentStats,
  listConversations,
  listEmployeeGrowthStats,
  listPullRequestStats,
  listReviewStats,
  listRunStats,
  listTokenStats,
  getStatsSummary,
  type ApiAgent,
  type ApiAgentStats,
  type ApiConversation,
  type ApiEmployeeGrowthStats,
  type ApiPullRequestStats,
  type ApiReviewStats,
  type ApiRunStats,
  type ApiStatsSummary,
  type ApiTokenStats
} from "@/lib/api/missionControl";
import { Sidebar } from "./Sidebar";
import { WindowChrome } from "./WindowChrome";
import {
  normalizeAgentStatus,
  statsToolbar,
  type AppAgent,
  type ConversationSummary
} from "./types";

type StatsSource = "loading" | "api" | "partial" | "unavailable";

type StatsRecords = {
  agents: AppAgent[];
  conversations: ConversationSummary[];
  agentStats: ApiAgentStats[];
  runStats: ApiRunStats[];
  tokenStats: ApiTokenStats[];
  pullRequestStats: ApiPullRequestStats[];
  reviewStats: ApiReviewStats[];
  summary: ApiStatsSummary | null;
  employeeGrowthStats: ApiEmployeeGrowthStats[];
  source: StatsSource;
  notice: string | null;
};

type AgentTableRow = {
  id: string;
  name: string;
  role: string;
  status: string;
  runCount: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  pullRequests: number;
  mergedPullRequests: number;
  reviews: number;
};

const emptyStatsRecords: StatsRecords = {
  agents: [],
  conversations: [],
  agentStats: [],
  runStats: [],
  tokenStats: [],
  pullRequestStats: [],
  reviewStats: [],
  summary: null,
  employeeGrowthStats: [],
  source: "loading",
  notice: "Connecting to stats API..."
};

const chartColors = [
  "#0615a8",
  "#008a1e",
  "#c51616",
  "#d8c300",
  "#008080",
  "#7a42c8",
  "#404040",
  "#0b62d8"
];

export function StatsPage() {
  const [records, setRecords] = useState<StatsRecords>(emptyStatsRecords);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    setRecords((current) => ({
      ...current,
      source: "loading",
      notice: current.source === "loading" ? "Connecting to stats API..." : "Refreshing stats..."
    }));

    loadStatsRecords(controller.signal).then((nextRecords) => {
      if (!controller.signal.aborted) {
        setRecords(nextRecords);
      }
    });

    return () => controller.abort();
  }, [refreshToken]);

  const agentRows = useMemo(() => mergeAgentRows(records.agents, records.agentStats), [records.agents, records.agentStats]);
  const totals = useMemo(() => totalStats(agentRows, records.runStats, records.summary), [agentRows, records.runStats, records.summary]);
  const runChartRows = useMemo(() => runStatusRows(records.runStats), [records.runStats]);
  const agentTokenRows = useMemo(() => topAgentTokenRows(agentRows), [agentRows]);
  const modelRows = useMemo(() => modelTokenRows(records.tokenStats, agentRows), [records.tokenStats, agentRows]);
  const workflowRows = useMemo(
    () => workflowStatRows(records.pullRequestStats, records.reviewStats),
    [records.pullRequestStats, records.reviewStats]
  );
  const employeeRows = useMemo(
    () => employeeGrowthRows(records.employeeGrowthStats, totals.employees),
    [records.employeeGrowthStats, totals.employees]
  );
  const sourceLabel = sourceStatusLabel(records.source);

  function handleSelectConversation(conversationId: string) {
    window.location.href = `/#${encodeURIComponent(conversationId)}`;
  }

  return (
    <WindowChrome
      title="Agent Adda - Statistics"
      toolbar={statsToolbar}
      statusItems={
        <>
          <StatusCell>{formatNumber(records.agents.length)} agents</StatusCell>
          <StatusCell>{formatCompact(totals.inputTokens)} input</StatusCell>
          <StatusCell>{formatCompact(totals.outputTokens)} output</StatusCell>
          <StatusCell>{formatNumber(totals.tasksInFlight)} in flight</StatusCell>
          <StatusCell>{sourceLabel}</StatusCell>
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
          onSelectConversation={handleSelectConversation}
        />

        <section className="win-panel flex h-full min-w-0 flex-1 flex-col overflow-hidden" aria-label="Statistics dashboard">
          <div className="win-titlebar justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2">
              <BarChart3 size={16} />
              <span className="truncate">Stats Dashboard</span>
            </span>
          </div>
          <div className="flex min-h-9 items-center gap-2 border-b border-[#777] bg-[#d7d7d7] px-2 py-1 md:min-h-11 md:flex-wrap">
            <button
              className="win-button flex h-7 min-h-0 items-center gap-1 px-2 py-0 md:h-8 md:gap-2 md:px-3"
              disabled={records.source === "loading"}
              onClick={() => setRefreshToken((value) => value + 1)}
              type="button"
            >
              <RefreshCw className={records.source === "loading" ? "animate-spin" : ""} size={14} />
              Refresh
            </button>
            <span className="ml-auto min-w-0 truncate text-[11px] md:text-sm">
              {records.source === "loading" ? "Loading backend stats..." : records.notice ?? "Backend stats connected."}
            </span>
          </div>

          <div className="app-scrollbar min-h-0 flex-1 overflow-auto bg-[#eeeeee] p-2 md:p-3">
            {records.source === "unavailable" ? (
              <div className="mb-3 flex gap-2 border border-[#9f7600] bg-[#fff8c8] p-2 text-sm">
                <AlertTriangle size={18} className="shrink-0" />
                <span>Stats API unavailable. Charts and totals will fill in when the backend responds.</span>
              </div>
            ) : null}

            <section className="grid grid-cols-2 gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6" aria-label="Headline statistics">
              <StatTile icon={<Database size={18} />} label="Input Tokens" value={formatCompact(totals.inputTokens)} detail={`${formatCompact(totals.totalTokens)} total tokens`} />
              <StatTile icon={<Database size={18} />} label="Output Tokens" value={formatCompact(totals.outputTokens)} detail={`${formatCompact(totals.reasoningTokens)} reasoning`} />
              <StatTile icon={<BarChart3 size={18} />} label="ChatGPT Quota" value={formatQuota(totals.chatgptQuotaUsed, totals.chatgptQuotaTotal)} detail={`${formatQuotaPercent(totals.chatgptQuotaUsed, totals.chatgptQuotaTotal)} used today`} />
              <StatTile icon={<BarChart3 size={18} />} label="Tasks In Flight" value={formatNumber(totals.tasksInFlight)} detail={`${formatNumber(totals.activeRuns)} active / ${formatNumber(totals.queuedRuns)} queued`} />
              <StatTile icon={<GitPullRequest size={18} />} label="PRs Merged" value={formatNumber(totals.pullRequestsMerged)} detail={`${formatNumber(totals.pullRequests)} total PRs`} />
              <StatTile icon={<Users size={18} />} label="Employees" value={formatNumber(totals.employees)} detail={`${formatNumber(totals.onlineAgents)} online now`} />
            </section>

            <section className="mt-3 grid gap-3 xl:grid-cols-2" aria-label="Statistics charts">
              <ChartPanel title="Run Status" note={`${formatNumber(totals.totalRuns)} recorded runs`}>
                {runChartRows.length > 0 ? (
                  <ResponsiveContainer width="100%" height={260}>
                    <PieChart margin={{ top: 10, right: 10, bottom: 10, left: 10 }}>
                      <Pie
                        data={runChartRows}
                        dataKey="count"
                        innerRadius={48}
                        nameKey="name"
                        outerRadius={88}
                        paddingAngle={2}
                        stroke="#404040"
                        strokeWidth={1}
                      />
                      <Tooltip contentStyle={tooltipStyle} formatter={formatTooltipValue} />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                ) : (
                  <EmptyChart label={records.source === "loading" ? "Loading run status..." : "No run rows yet."} />
                )}
              </ChartPanel>

              <ChartPanel title="Agent Token IO" note="Input and output tokens per agent">
                {agentTokenRows.length > 0 ? (
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={agentTokenRows} margin={{ top: 14, right: 18, bottom: 24, left: 4 }}>
                      <CartesianGrid stroke="#bdbdbd" strokeDasharray="2 2" />
                      <XAxis dataKey="name" interval={0} tick={{ fontSize: 12 }} tickFormatter={shortAxisLabel} />
                      <YAxis tick={{ fontSize: 12 }} tickFormatter={formatCompact} />
                      <Tooltip contentStyle={tooltipStyle} formatter={formatTooltipValue} />
                      <Legend />
                      <Bar dataKey="inputTokens" stackId="agentTokens" fill="#0615a8" name="Input" />
                      <Bar dataKey="outputTokens" stackId="agentTokens" fill="#008080" name="Output" />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <EmptyChart label={records.source === "loading" ? "Loading agent token usage..." : "No agent token usage yet."} />
                )}
              </ChartPanel>

              <ChartPanel title="Model Token Mix" note="Input, output, and reasoning tokens by model">
                {modelRows.length > 0 ? (
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={modelRows} margin={{ top: 14, right: 18, bottom: 24, left: 4 }}>
                      <CartesianGrid stroke="#bdbdbd" strokeDasharray="2 2" />
                      <XAxis dataKey="model" interval={0} tick={{ fontSize: 12 }} tickFormatter={shortAxisLabel} />
                      <YAxis tick={{ fontSize: 12 }} tickFormatter={formatCompact} />
                      <Tooltip contentStyle={tooltipStyle} formatter={formatTooltipValue} />
                      <Legend />
                      <Bar dataKey="inputTokens" stackId="tokens" fill="#0615a8" name="Input" />
                      <Bar dataKey="outputTokens" stackId="tokens" fill="#008080" name="Output" />
                      <Bar dataKey="reasoningTokens" stackId="tokens" fill="#7a42c8" name="Reasoning" />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <EmptyChart label={records.source === "loading" ? "Loading token mix..." : "No token usage recorded yet."} />
                )}
              </ChartPanel>

              <ChartPanel title="PR and Review Flow" note="Pull request statuses and review decisions">
                {workflowRows.length > 0 ? (
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={workflowRows} margin={{ top: 14, right: 18, bottom: 24, left: 4 }}>
                      <CartesianGrid stroke="#bdbdbd" strokeDasharray="2 2" />
                      <XAxis dataKey="name" interval={0} tick={{ fontSize: 12 }} tickFormatter={shortAxisLabel} />
                      <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                      <Tooltip contentStyle={tooltipStyle} formatter={formatTooltipValue} />
                      <Bar dataKey="count" fill="#0615a8" name="Count" />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <EmptyChart label={records.source === "loading" ? "Loading PR and review flow..." : "No PR or review rows yet."} />
                )}
              </ChartPanel>

              <ChartPanel title="Employees Over Time" note={`${formatNumber(totals.employees)} current employees`}>
                {employeeRows.length > 0 ? (
                  <ResponsiveContainer width="100%" height={260}>
                    <LineChart data={employeeRows} margin={{ top: 14, right: 18, bottom: 24, left: 4 }}>
                      <CartesianGrid stroke="#bdbdbd" strokeDasharray="2 2" />
                      <XAxis dataKey="period" interval={0} tick={{ fontSize: 12 }} tickFormatter={shortDateLabel} />
                      <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                      <Tooltip contentStyle={tooltipStyle} formatter={formatTooltipValue} />
                      <Legend />
                      <Line type="monotone" dataKey="employeeCount" stroke="#0615a8" strokeWidth={2} dot={{ r: 3 }} name="Employees" />
                      <Line type="monotone" dataKey="hiredCount" stroke="#008a1e" strokeWidth={2} dot={{ r: 3 }} name="Hired" />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <EmptyChart label={records.source === "loading" ? "Loading employee history..." : "No employee history yet."} />
                )}
              </ChartPanel>
            </section>

            <section className="win-panel mt-3 overflow-hidden" aria-labelledby="agent-stats-table-title">
              <div className="win-titlebar">
                <h2 id="agent-stats-table-title" className="text-base">
                  Agent Performance
                </h2>
              </div>
              <div className="grid gap-2 bg-white p-2 md:hidden">
                {agentRows.length > 0 ? (
                  agentRows.map((row) => <AgentStatCard key={row.id} row={row} />)
                ) : (
                  <div className="border border-[#c8c8c8] p-4 text-center text-[var(--adda-muted)]">
                    {records.source === "loading" ? "Loading agent statistics..." : "No agent statistics recorded yet."}
                  </div>
                )}
              </div>
              <div className="app-scrollbar hidden overflow-auto bg-white md:block">
                <table className="min-w-[980px] w-full table-fixed border-collapse text-left text-sm">
                  <caption className="sr-only">Agent performance statistics</caption>
                  <colgroup>
                    <col />
                    <col className="w-28" />
                    <col className="w-24" />
                    <col className="w-24" />
                    <col className="w-28" />
                    <col className="w-28" />
                    <col className="w-28" />
                    <col className="w-24" />
                    <col className="w-24" />
                  </colgroup>
                  <thead className="bg-[#d7d7d7]">
                    <tr>
                      {["Agent", "Status", "Runs", "Tokens", "Input", "Output", "Reasoning", "PR / Review", "Merged"].map((header) => (
                        <th className="border border-[#aaa] px-2 py-2" key={header} scope="col">
                          {header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {agentRows.length > 0 ? (
                      agentRows.map((row) => (
                        <tr key={row.id}>
                          <td className="border border-[#c8c8c8] px-2 py-2">
                            <strong className="block truncate">{row.name}</strong>
                            <span className="block truncate text-xs text-[var(--adda-muted)]">{row.role}</span>
                          </td>
                          <td className="border border-[#c8c8c8] px-2 py-2">
                            <span className="inline-flex min-w-0 items-center gap-2">
                              <span className={`status-dot ${agentStatusDotClass(row.status)} shrink-0`} />
                              <span className="truncate">{titleize(row.status)}</span>
                            </span>
                          </td>
                          <td className="border border-[#c8c8c8] px-2 py-2 text-right tabular-nums">{formatNumber(row.runCount)}</td>
                          <td className="border border-[#c8c8c8] px-2 py-2 text-right font-bold tabular-nums">{formatCompact(row.totalTokens)}</td>
                          <td className="border border-[#c8c8c8] px-2 py-2 text-right tabular-nums">{formatCompact(row.inputTokens)}</td>
                          <td className="border border-[#c8c8c8] px-2 py-2 text-right tabular-nums">{formatCompact(row.outputTokens)}</td>
                          <td className="border border-[#c8c8c8] px-2 py-2 text-right tabular-nums">{formatCompact(row.reasoningTokens)}</td>
                          <td className="border border-[#c8c8c8] px-2 py-2 text-right tabular-nums">
                            {formatNumber(row.pullRequests)} / {formatNumber(row.reviews)}
                          </td>
                          <td className="border border-[#c8c8c8] px-2 py-2 text-right tabular-nums">{formatNumber(row.mergedPullRequests)}</td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td className="border border-[#c8c8c8] px-2 py-8 text-center text-[var(--adda-muted)]" colSpan={9}>
                          {records.source === "loading" ? "Loading agent statistics..." : "No agent statistics recorded yet."}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </section>
      </div>
    </WindowChrome>
  );
}

async function loadStatsRecords(signal: AbortSignal): Promise<StatsRecords> {
  const [
    agentsResult,
    conversationsResult,
    agentStatsResult,
    runStatsResult,
    tokenStatsResult,
    pullRequestStatsResult,
    reviewStatsResult,
    summaryResult,
    employeeGrowthResult
  ] = await Promise.allSettled([
    listAgents(signal),
    listConversations(signal),
    listAgentStats(signal),
    listRunStats(signal),
    listTokenStats(signal),
    listPullRequestStats(signal),
    listReviewStats(signal),
    getStatsSummary(signal),
    listEmployeeGrowthStats(signal)
  ]);

  const results = [
    agentsResult,
    conversationsResult,
    agentStatsResult,
    runStatsResult,
    tokenStatsResult,
    pullRequestStatsResult,
    reviewStatsResult,
    summaryResult,
    employeeGrowthResult
  ];
  const fulfilledCount = results.filter((result) => result.status === "fulfilled").length;

  return {
    agents: valueOr<ApiAgent[]>(agentsResult, []).map(mapApiAgent),
    conversations: valueOr<ApiConversation[]>(conversationsResult, []).map(mapApiConversation),
    agentStats: valueOr<ApiAgentStats[]>(agentStatsResult, []),
    runStats: valueOr<ApiRunStats[]>(runStatsResult, []),
    tokenStats: valueOr<ApiTokenStats[]>(tokenStatsResult, []),
    pullRequestStats: valueOr<ApiPullRequestStats[]>(pullRequestStatsResult, []),
    reviewStats: valueOr<ApiReviewStats[]>(reviewStatsResult, []),
    summary: summaryResult.status === "fulfilled" ? summaryResult.value : null,
    employeeGrowthStats: valueOr<ApiEmployeeGrowthStats[]>(employeeGrowthResult, []),
    source: fulfilledCount === 0 ? "unavailable" : fulfilledCount === results.length ? "api" : "partial",
    notice: statsNotice(fulfilledCount, results.length)
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

function mergeAgentRows(agents: AppAgent[], stats: ApiAgentStats[]): AgentTableRow[] {
  const rows: AgentTableRow[] = [];
  const seen = new Set<string>();
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));

  for (const row of stats) {
    const agent = agentsById.get(row.agent_id);
    seen.add(row.agent_id);
    rows.push({
      id: row.agent_id,
      name: row.name || agent?.name || row.agent_id,
      role: agent?.role ?? "Agent",
      status: row.status || agent?.status || "idle",
      runCount: row.run_count,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      reasoningTokens: row.reasoning_tokens,
      totalTokens: row.total_tokens,
      pullRequests: row.pull_requests,
      mergedPullRequests: row.merged_pull_requests,
      reviews: row.reviews
    });
  }

  for (const agent of agents) {
    if (seen.has(agent.id)) {
      continue;
    }

    rows.push({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      status: agent.status,
      runCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      pullRequests: 0,
      mergedPullRequests: 0,
      reviews: 0
    });
  }

  rows.sort((a, b) => b.totalTokens - a.totalTokens || b.runCount - a.runCount || a.name.localeCompare(b.name));
  return rows;
}

function totalStats(rows: AgentTableRow[], runStats: ApiRunStats[], summary: ApiStatsSummary | null) {
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let totalTokens = 0;
  let pullRequests = 0;
  let mergedPullRequests = 0;
  let reviews = 0;
  let tableRunCount = 0;
  let onlineAgents = 0;

  for (const row of rows) {
    inputTokens += row.inputTokens;
    outputTokens += row.outputTokens;
    reasoningTokens += row.reasoningTokens;
    totalTokens += row.totalTokens;
    pullRequests += row.pullRequests;
    mergedPullRequests += row.mergedPullRequests;
    reviews += row.reviews;
    tableRunCount += row.runCount;
    if (normalizeAgentStatus(row.status) !== "offline") {
      onlineAgents += 1;
    }
  }

  const runStatsCount = sumRunStats(runStats);
  const activeRuns = summary?.active_runs ?? statusCount(runStats, ["running", "working", "in-progress", "in_progress"]);
  const queuedRuns = summary?.queued_runs ?? statusCount(runStats, ["queued", "pending", "planned"]);
  return {
    inputTokens: summary?.input_tokens ?? inputTokens,
    outputTokens: summary?.output_tokens ?? outputTokens,
    reasoningTokens,
    totalTokens: summary?.total_tokens ?? totalTokens,
    pullRequests,
    pullRequestsMerged: summary?.pull_requests_merged ?? mergedPullRequests,
    reviews,
    onlineAgents,
    employees: summary?.employees ?? rows.length,
    totalRuns: runStatsCount > 0 ? runStatsCount : tableRunCount,
    tasksInFlight: summary?.tasks_in_flight ?? activeRuns + queuedRuns,
    activeRuns,
    queuedRuns,
    chatgptQuotaUsed: summary?.chatgpt_quota_used ?? 0,
    chatgptQuotaTotal: summary?.chatgpt_quota_total ?? 0,
    failedRuns: statusCount(runStats, ["failed", "error", "blocked"])
  };
}

function sumRunStats(rows: ApiRunStats[]): number {
  let count = 0;
  for (const row of rows) {
    count += row.count;
  }
  return count;
}

function runStatusRows(rows: ApiRunStats[]) {
  return rows
    .filter((row) => row.count > 0)
    .map((row, index) => ({
      name: titleize(row.status),
      count: row.count,
      fill: colorForStatus(row.status, index)
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function topAgentTokenRows(rows: AgentTableRow[]) {
  return rows
    .filter((row) => row.inputTokens > 0 || row.outputTokens > 0)
    .slice(0, 8)
    .map((row) => ({
      name: row.name,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens
    }));
}

function modelTokenRows(tokenRows: ApiTokenStats[], agentRows: AgentTableRow[]) {
  const byModel = new Map<string, { model: string; inputTokens: number; outputTokens: number; reasoningTokens: number; totalTokens: number }>();

  for (const row of tokenRows) {
    const model = row.model || "unknown";
    const current = byModel.get(model) ?? {
      model,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0
    };
    current.inputTokens += row.input_tokens;
    current.outputTokens += row.output_tokens;
    current.reasoningTokens += row.reasoning_tokens;
    current.totalTokens += row.total_tokens;
    byModel.set(model, current);
  }

  if (byModel.size === 0) {
    let inputTokens = 0;
    let outputTokens = 0;
    let reasoningTokens = 0;
    let totalTokens = 0;

    for (const row of agentRows) {
      inputTokens += row.inputTokens;
      outputTokens += row.outputTokens;
      reasoningTokens += row.reasoningTokens;
      totalTokens += row.totalTokens;
    }

    if (totalTokens > 0) {
      byModel.set("all models", { model: "all models", inputTokens, outputTokens, reasoningTokens, totalTokens });
    }
  }

  return Array.from(byModel.values())
    .filter((row) => row.totalTokens > 0)
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 8);
}

function workflowStatRows(prRows: ApiPullRequestStats[], reviewRows: ApiReviewStats[]) {
  const rows: Array<{ name: string; count: number }> = [];

  for (const row of prRows) {
    if (row.count > 0) {
      rows.push({ name: `PR ${titleize(row.status)}`, count: row.count });
    }
  }

  for (const row of reviewRows) {
    if (row.count > 0) {
      rows.push({ name: `Review ${titleize(row.decision)}`, count: row.count });
    }
  }

  rows.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return rows.slice(0, 10);
}

function employeeGrowthRows(rows: ApiEmployeeGrowthStats[], currentEmployees: number) {
  if (rows.length === 0) {
    return currentEmployees > 0
      ? [{ period: "Current", hiredCount: currentEmployees, employeeCount: currentEmployees }]
      : [];
  }

  return rows.map((row) => ({
    period: row.period,
    hiredCount: row.hired_count,
    employeeCount: row.employee_count
  }));
}

function statusCount(rows: ApiRunStats[], names: string[]): number {
  const accepted = new Set(names.map(normalizeStatus));
  let count = 0;

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

function colorForStatus(status: string, index: number): string {
  const normalized = normalizeStatus(status);
  if (normalized === "completed" || normalized === "complete" || normalized === "succeeded") return "#008a1e";
  if (normalized === "running" || normalized === "working" || normalized === "in-progress") return "#0615a8";
  if (normalized === "queued" || normalized === "pending" || normalized === "planned") return "#d8c300";
  if (normalized === "failed" || normalized === "error" || normalized === "blocked") return "#c51616";
  return chartColors[index % chartColors.length];
}

function agentStatusDotClass(status: string): string {
  const normalized = normalizeAgentStatus(status);
  if (normalized === "working") {
    return "status-running";
  }
  if (normalized === "pending") {
    return "status-queued";
  }

  return `status-${normalized}`;
}

function statsNotice(fulfilledCount: number, total: number): string | null {
  if (fulfilledCount === 0) {
    return "Backend unavailable. Showing empty stats.";
  }
  if (fulfilledCount < total) {
    return "Some stats endpoints are unavailable. Showing partial backend data.";
  }

  return null;
}

function sourceStatusLabel(source: StatsSource): string {
  if (source === "loading") return "Connecting";
  if (source === "api") return "Stats OK";
  if (source === "partial") return "Partial stats";
  return "Stats unavailable";
}

function titleize(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "Unknown";
  }

  return trimmed
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function shortAxisLabel(value: string): string {
  return value.length > 12 ? `${value.slice(0, 11)}...` : value;
}

function shortDateLabel(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value.slice(5);
  }

  return shortAxisLabel(value);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined).format(value);
}

function formatCompact(value: number | string): string {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) {
    return String(value);
  }

  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1
  }).format(number);
}

function formatQuota(used: number, total: number): string {
  if (total <= 0) {
    return `${formatCompact(used)} used`;
  }

  return `${formatCompact(used)} / ${formatCompact(total)}`;
}

function formatQuotaPercent(used: number, total: number): string {
  if (total <= 0) {
    return "No quota";
  }

  const percent = Math.min(999, Math.max(0, (used / total) * 100));
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(percent)}%`;
}

function formatTooltipValue(value: unknown, name: unknown): [string, string] {
  return [formatCompactValue(value), String(name ?? "")];
}

function formatCompactValue(value: unknown): string {
  if (typeof value === "number" || typeof value === "string") {
    return formatCompact(value);
  }

  return "";
}

function StatusCell({ children }: { children: ReactNode }) {
  return (
    <div className="win-panel flex min-w-0 items-center gap-2 truncate px-3">
      {children}
    </div>
  );
}

function AgentStatCard({ row }: { row: AgentTableRow }) {
  return (
    <article className="border border-[#aaa] bg-[#f7f7f7] p-2">
      <div className="mb-2 flex min-w-0 items-center gap-2">
        <span className={`status-dot ${agentStatusDotClass(row.status)} shrink-0`} />
        <div className="min-w-0">
          <strong className="block truncate">{row.name}</strong>
          <span className="block truncate text-[11px] text-[var(--adda-muted)]">{row.role}</span>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-1 text-[11px]">
        <StatPair label="Runs" value={formatNumber(row.runCount)} />
        <StatPair label="Tokens" value={formatCompact(row.totalTokens)} />
        <StatPair label="Input" value={formatCompact(row.inputTokens)} />
        <StatPair label="Output" value={formatCompact(row.outputTokens)} />
        <StatPair label="Reasoning" value={formatCompact(row.reasoningTokens)} />
        <StatPair label="Merged PRs" value={formatNumber(row.mergedPullRequests)} />
      </dl>
    </article>
  );
}

function StatPair({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-[#c8c8c8] bg-white px-2 py-1">
      <span className="block truncate text-[var(--adda-muted)]">{label}</span>
      <strong className="block truncate tabular-nums">{value}</strong>
    </div>
  );
}

function StatTile({
  detail,
  icon,
  label,
  value
}: {
  detail: string;
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="win-panel-inset grid min-h-[72px] grid-cols-[26px_minmax(0,1fr)] gap-2 bg-[#f6f6f6] p-2 md:min-h-[86px] md:grid-cols-[32px_minmax(0,1fr)] md:p-3">
      <div className="grid h-6 w-6 place-items-center border border-[#777] bg-[#d0d0d0] md:h-8 md:w-8">{icon}</div>
      <div className="min-w-0">
        <div className="truncate text-[11px] font-bold md:text-sm">{label}</div>
        <div className="truncate text-lg font-bold leading-tight tabular-nums md:text-2xl">{value}</div>
        <div className="truncate text-[10px] text-[var(--adda-muted)] md:text-xs">{detail}</div>
      </div>
    </div>
  );
}

function ChartPanel({ children, note, title }: { children: ReactNode; note: string; title: string }) {
  return (
    <section className="win-panel overflow-hidden bg-[#d1d1d1]">
      <div className="win-titlebar justify-between gap-3">
        <h2 className="min-w-0 flex-1 truncate text-base">{title}</h2>
        <span className="hidden max-w-[45%] shrink-0 truncate text-xs font-normal sm:block">{note}</span>
      </div>
      <div className="h-[240px] border-t border-[#777] bg-[#f8f8f8] p-2 md:h-[294px] md:p-3">{children}</div>
    </section>
  );
}

function EmptyChart({ label }: { label: string }) {
  return (
    <div className="grid h-full place-items-center border border-[#aaa] bg-[#efefef] text-center text-sm text-[var(--adda-muted)]">
      {label}
    </div>
  );
}

const tooltipStyle = {
  backgroundColor: "#fffff4",
  border: "2px solid #777777",
  color: "#111111",
  fontFamily: "var(--adda-font)"
};
