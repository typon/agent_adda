import { fetchJson, postJson } from "./client";

export type ApiSearchResult = {
  entity_type: string;
  entity_id: string;
  title: string;
  body: string;
};

export type ApiAgentSearchRecord = {
  id: string;
  name: string;
  slug: string;
  role: string;
  description: string;
  status: string;
};

export type ApiConversationSearchRecord = {
  id: string;
  kind: "dm" | "channel";
  name: string;
  topic: string;
};

export type ApiWikiSearchRecord = {
  id: string;
  slug: string;
  title: string;
  body_markdown: string;
  updated_by: string;
};

export type ApiSettingSearchRecord = {
  key: string;
  value: string;
};

export async function searchWorkspace(
  query: string,
  signal?: AbortSignal
): Promise<ApiSearchResult[]> {
  return postJson<ApiSearchResult[]>("/search", { query }, { signal });
}

export async function listAgents(signal?: AbortSignal): Promise<ApiAgentSearchRecord[]> {
  return fetchJson<ApiAgentSearchRecord[]>("/agents", { signal });
}

export async function listConversations(signal?: AbortSignal): Promise<ApiConversationSearchRecord[]> {
  return fetchJson<ApiConversationSearchRecord[]>("/conversations", { signal });
}

export async function listWikiPages(signal?: AbortSignal): Promise<ApiWikiSearchRecord[]> {
  return fetchJson<ApiWikiSearchRecord[]>("/wiki/pages", { signal });
}

export async function listSettings(signal?: AbortSignal): Promise<ApiSettingSearchRecord[]> {
  return fetchJson<ApiSettingSearchRecord[]>("/settings", { signal });
}
