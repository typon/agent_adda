import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, BarChart3, RefreshCw } from "lucide-react";
import {
  listAgentStats,
  listRunStats,
  type ApiAgentStats,
  type ApiRunStats
} from "@/lib/api/missionControl";

type StatsSummaryPanelProps = {
  agentStats?: ApiAgentStats[];
  runStats?: ApiRunStats[];
  loading?: boolean;
  error?: string | null;
  compact?: boolean;
};

type LocalStatsState = {
  agentStats: ApiAgentStats[];
  runStats: ApiRunStats[];
  loading: boolean;
  error: string | null;
};

const emptyLocalStats: LocalStatsState = {
  agentStats: [],
  runStats: [],
  loading: true,
  error: null
};

export function StatsSummaryPanel({
  agentStats,
  runStats,
  loading,
  error,
  compact = false
}: StatsSummaryPanelProps) {
  const usesProps = agentStats !== undefined || runStats !== undefined || loading !== undefined || error !== undefined;
  const [localStats, setLocalStats] = useState<LocalStatsState>(emptyLocalStats);

  useEffect(() => {
    if (usesProps) {
      return;
    }

    const controller = new AbortController();
    setLocalStats((current) => ({ ...current, loading: true, error: null }));

    Promise.all([listAgentStats(controller.signal), listRunStats(controller.signal)])
      .then(([nextAgentStats, nextRunStats]) => {
        if (controller.signal.aborted) {
          return;
        }

        setLocalStats({
          agentStats: nextAgentStats,
          runStats: nextRunStats,
          loading: false,
          error: null
        });
      })
      .catch((loadError: unknown) => {
        if (isAbortError(loadError)) {
          return;
        }

        setLocalStats({
          agentStats: [],
          runStats: [],
          loading: false,
          error: "Stats API unavailable."
        });
      });

    return () => controller.abort();
  }, [usesProps]);

  const rows = agentStats ?? localStats.agentStats;
  const statuses = runStats ?? localStats.runStats;
  const isLoading = loading ?? localStats.loading;
  const loadError = error ?? localStats.error;
  const totals = useMemo(() => totalAgentStats(rows), [rows]);
  const activeRuns = activeRunCount(statuses);
  const queuedRuns = statusCount(statuses, ["queued", "pending", "planned"]);
  const maxTokens = Math.max(1, ...rows.map((row) => row.total_tokens));

  return (
    <section className="win-panel-inset p-3" aria-labelledby="stats-summary-title">
      <div className="mb-2 flex min-w-0 items-center gap-2">
        <BarChart3 size={18} className="shrink-0" />
        <h2 id="stats-summary-title" className="min-w-0 truncate font-bold">
          {compact ? "Stats" : "Agent Statistics"}
        </h2>
        {isLoading ? <RefreshCw className="ml-auto animate-spin" size={16} /> : null}
      </div>

      {loadError ? (
        <div className="mb-2 flex gap-2 border border-[#9f7600] bg-[#fff8c8] p-2 text-sm">
          <AlertTriangle size={17} className="shrink-0" />
          <span>{loadError}</span>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 text-sm">
        <StatBox label="Active runs" value={formatNumber(activeRuns)} />
        <StatBox label="Queued runs" value={formatNumber(queuedRuns)} />
        <StatBox label="Tokens" value={formatCompact(totals.totalTokens)} />
        <StatBox label="PRs / Reviews" value={`${formatNumber(totals.pullRequests)} / ${formatNumber(totals.reviews)}`} />
      </div>

      {rows.length > 0 ? (
        <div className="mt-3 grid gap-2">
          {rows.slice(0, compact ? 4 : 8).map((row) => {
            const width = Math.max(4, Math.round((row.total_tokens / maxTokens) * 100));

            return (
              <div className="grid min-w-0 grid-cols-[92px_1fr_58px] items-center gap-2 text-sm" key={row.agent_id}>
                <span className="truncate font-bold">{row.name}</span>
                <div className="h-4 border border-[#777] bg-white p-[2px]">
                  <div className="h-full bg-[var(--adda-blue)]" style={{ width: `${width}%` }} />
                </div>
                <span className="truncate text-right tabular-nums">{formatCompact(row.total_tokens)}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="mt-3 border border-[#aaa] bg-[#efefef] p-2 text-sm text-[var(--adda-muted)]">
          {isLoading ? "Loading backend stats..." : "No recorded token, PR, review, or run stats yet."}
        </div>
      )}
    </section>
  );
}

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="win-panel bg-[#dfdfdf] p-2">
      <div className="truncate text-[12px] text-[var(--adda-muted)]">{label}</div>
      <div className="truncate font-bold tabular-nums">{value}</div>
    </div>
  );
}

function totalAgentStats(rows: ApiAgentStats[]) {
  let totalTokens = 0;
  let pullRequests = 0;
  let reviews = 0;

  for (const row of rows) {
    totalTokens += row.total_tokens;
    pullRequests += row.pull_requests;
    reviews += row.reviews;
  }

  return { totalTokens, pullRequests, reviews };
}

function activeRunCount(rows: ApiRunStats[]): number {
  return statusCount(rows, ["running", "working", "in-progress", "in_progress"]);
}

function statusCount(rows: ApiRunStats[], names: string[]): number {
  let count = 0;
  const accepted = new Set(names);

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

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined).format(value);
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1
  }).format(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
