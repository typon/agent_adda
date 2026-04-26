import { fetchJson } from "./client";

export const knownReasoningEfforts = ["low", "medium", "high", "xhigh"] as const;

export type ReasoningEffort = (typeof knownReasoningEfforts)[number];

type CodexReasoningEffortsResponse = {
  model: string;
  reasoning_efforts: string[];
  source: string;
};

export async function loadCodexReasoningEfforts(
  model: string,
  signal?: AbortSignal
): Promise<ReasoningEffort[]> {
  const normalizedModel = model.trim() || "gpt-5.5";
  const query = new URLSearchParams({ model: normalizedModel });
  const response = await fetchJson<CodexReasoningEffortsResponse>(
    `/codex/reasoning-efforts?${query.toString()}`,
    { signal }
  );
  const efforts = response.reasoning_efforts.filter(isReasoningEffort);
  if (efforts.length === 0) {
    throw new Error(`Codex did not report reasoning efforts for ${normalizedModel}.`);
  }
  return efforts;
}

export function normalizeReasoningEffort(
  value: string,
  efforts: readonly ReasoningEffort[] = knownReasoningEfforts
): ReasoningEffort {
  if (isReasoningEffort(value) && efforts.includes(value)) {
    return value;
  }
  return efforts.includes("high") ? "high" : efforts[0] ?? "high";
}

function isReasoningEffort(value: string): value is ReasoningEffort {
  return knownReasoningEfforts.includes(value as ReasoningEffort);
}
