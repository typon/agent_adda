import { fetchJson, postJson } from "./client";
import type { ReasoningEffort } from "./codex";

export type { ReasoningEffort };

export type ApiSetting = {
  key: string;
  value: string;
  updated_at: string;
};

export type OnboardingCheck = {
  check_key: string;
  label: string;
  status: string;
  detail: string | null;
  checked_at: string | null;
};

export type OnboardingStatus = {
  checks: OnboardingCheck[];
};

export type OnboardingStatusResponse = {
  initialized: boolean;
  completed: boolean;
  project_name: string;
  project_summary: string;
  workspace_path: string;
  default_model: string;
  default_reasoning_effort: ReasoningEffort;
  agent_count: number;
  queued_ceo_task_runs: number;
};

export type OnboardingAgent = {
  id: string;
  name: string;
  role: string;
  model: string;
  reasoning_effort: ReasoningEffort;
};

export type StarterRoleDraft = {
  name: string;
  role: string;
  description: string;
};

export type OnboardingDefaults = {
  settings: ApiSetting[];
  checks: OnboardingCheck[];
  status: OnboardingStatusResponse | null;
  initialized: boolean;
};

export type InitializeOnboardingRequest = {
  project_name: string;
  project_summary: string;
  workspace_path: string;
  default_model: string;
  default_reasoning_effort: ReasoningEffort;
  extra_roles: StarterRoleDraft[];
  tasks: string[];
};

export type InitializeOnboardingResponse = {
  status: OnboardingStatusResponse;
  agents: OnboardingAgent[];
  overview_page_id: string;
  queued_run_ids: string[];
};

const initializedSettingKeys = new Set([
  "onboarding.completed_at"
]);

export async function loadOnboardingDefaults(signal?: AbortSignal): Promise<OnboardingDefaults> {
  const [settings, status, checks] = await Promise.all([
    fetchJson<ApiSetting[]>("/settings", { signal }),
    getOnboardingStatus(signal).catch(() => null),
    fetchJson<OnboardingStatus>("/onboarding/checks", { signal }).catch(() => ({ checks: [] }))
  ]);

  return {
    settings,
    checks: checks.checks,
    status,
    initialized: status?.initialized ?? hasInitializedSetting(settings)
  };
}

export async function getOnboardingStatus(signal?: AbortSignal): Promise<OnboardingStatusResponse> {
  return fetchJson<OnboardingStatusResponse>("/onboarding/status", { signal });
}

export async function initializeOnboarding(
  request: InitializeOnboardingRequest,
  signal?: AbortSignal
): Promise<InitializeOnboardingResponse> {
  return postJson<InitializeOnboardingResponse>("/onboarding/initialize", request, { signal });
}

export function settingValue(
  settings: readonly Pick<ApiSetting, "key" | "value">[],
  key: string,
  fallback: string
): string {
  const setting = settings.find((candidate) => candidate.key === key);
  const value = setting?.value.trim();
  return value ? value : fallback;
}

function hasInitializedSetting(settings: ApiSetting[]): boolean {
  return settings.some((setting) => {
    return initializedSettingKeys.has(setting.key) && setting.value.trim() !== "";
  });
}
