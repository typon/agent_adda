import { fetchJson, putJson, postJson } from "./client";

export type ApiSetting = {
  key: string;
  value: string;
  updated_at: string;
};

export type GithubStatus = {
  authenticated: boolean;
  detail: string;
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

export type SettingDraft = {
  key: string;
  value: string;
};

export async function listSettings(signal?: AbortSignal): Promise<ApiSetting[]> {
  return fetchJson<ApiSetting[]>("/settings", { signal });
}

export async function saveSetting(
  key: string,
  value: string,
  signal?: AbortSignal
): Promise<ApiSetting> {
  return putJson<ApiSetting>(`/settings/${encodeURIComponent(key)}`, { value }, { signal });
}

export async function saveSettings(
  settings: SettingDraft[],
  signal?: AbortSignal
): Promise<ApiSetting[]> {
  const saved: ApiSetting[] = [];

  for (const setting of settings) {
    saved.push(await saveSetting(setting.key, setting.value, signal));
  }

  return saved;
}

export async function getGithubStatus(signal?: AbortSignal): Promise<GithubStatus> {
  return fetchJson<GithubStatus>("/github/status", { signal });
}

export async function runOnboardingChecks(signal?: AbortSignal): Promise<OnboardingStatus> {
  return postJson<OnboardingStatus>("/onboarding/checks/run", undefined, { signal });
}
