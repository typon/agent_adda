import { deleteJson, fetchJson, patchJson, postJson } from "./client";

export type ApiAgent = {
  id: string;
  name: string;
  slug: string;
  role: string;
  description: string;
  profile: string;
  system_prompt: string;
  status: string;
  model: string;
  reasoning_effort: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type ApiUpdateAgentRequest = {
  name?: string;
  profile?: string;
  system_prompt?: string;
  status?: string;
  model?: string;
  reasoning_effort?: string;
};

export type ApiCreateAgentRequest = {
  name: string;
  role: string;
  description: string;
};

export type ApiConversationKind = "dm" | "channel";

export type ApiConversation = {
  id: string;
  kind: ApiConversationKind;
  name: string;
  slug?: string;
  topic: string;
  loop_enabled?: number;
  created_at: string;
  updated_at?: string;
  archived_at: string | null;
};

export type ApiCreateConversationRequest = {
  kind: ApiConversationKind;
  name?: string;
  topic?: string;
  agent_id?: string;
  member_ids?: string[];
};

export type ApiMessage = {
  id: string;
  conversation_id: string;
  author_kind: "human" | "agent" | "system";
  author_id: string;
  body: string;
  run_id: string | null;
  created_at: string;
  linked_wiki_pages_json?: string;
  linked_prs_json?: string;
  metadata_json?: string | null;
};

export type ApiMessageDeliveryMode = "message_only" | "queue" | "urgent";

export type ApiCreateMessageOptions = {
  delivery_mode?: ApiMessageDeliveryMode;
  signal?: AbortSignal;
};

export type ApiSetting = {
  key: string;
  value: string;
  updated_at: string;
};

export type ApiSearchResult = {
  entity_type: string;
  entity_id: string;
  title: string;
  body: string;
};

export type ApiRunPlan = {
  run_id: string;
  agent_id: string;
  model: string;
  reasoning_effort: string;
  workspace: string;
  status: string;
};

export type ApiCodexRunRequest = {
  agent_id: string;
  workspace: string;
  prompt: string;
  model: string;
  reasoning_effort: string;
};

export type ApiCodexCommandPlan = {
  program: string;
  args: string[];
  stdin: string;
};

export type ApiRun = {
  id: string;
  agent_id: string;
  agent_name: string;
  conversation_id: string | null;
  status: string;
  trigger_kind: string;
  prompt_hash: string;
  prompt_summary: string;
  summary: string;
  model: string;
  reasoning_effort: string;
  branch: string;
  workspace: string;
  command: unknown;
  queue_priority: number;
  queued_by: string;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
  event_count: number;
};

export type ApiRunEvent = {
  id: string;
  run_id: string;
  event_type: string;
  payload: unknown;
  created_at: string;
};

export type ApiQueueRunRequest = {
  prompt: string;
  workspace?: string;
  conversation_id?: string;
  trigger_kind?: string;
  branch?: string;
};

export type ApiQueueRunResponse = {
  run: ApiRun;
  plan: ApiRunPlan;
  request: ApiCodexRunRequest;
  command: ApiCodexCommandPlan;
};

export type ApiRunListFilters = {
  agent_id?: string;
  status?: string;
  conversation_id?: string;
  limit?: number;
};

export type ApiStopAgentResponse = {
  interrupted: boolean;
  run_id: string | null;
};

export type ApiClearMessagesResponse = {
  deleted_messages: number;
};

export type ApiCronJob = {
  id: string;
  agent_id: string;
  title: string;
  prompt: string;
  interval_minutes: number;
  schedule_kind: "interval" | "daily_time";
  time_of_day: string;
  timezone: string;
  enabled: boolean;
  next_run_at: string;
  last_queued_at: string | null;
  last_run_id: string | null;
  last_error: string;
  created_at: string;
  updated_at: string;
};

export type ApiCreateCronJobRequest = {
  title: string;
  prompt: string;
  interval_minutes?: number;
  schedule_kind?: "interval" | "daily_time";
  time_of_day?: string;
  enabled?: boolean;
};

export type ApiUpdateCronJobRequest = {
  title?: string;
  prompt?: string;
  interval_minutes?: number;
  schedule_kind?: "interval" | "daily_time";
  time_of_day?: string;
  enabled?: boolean;
};

export type ApiRecentRunEvent = {
  id: string;
  run_id: string;
  event_type: string;
  payload_json: string;
  created_at: string;
};

export type ApiRunStats = {
  status: string;
  count: number;
};

export type ApiAgentStats = {
  agent_id: string;
  name: string;
  status: string;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  run_count: number;
  pull_requests: number;
  merged_pull_requests: number;
  reviews: number;
};

export type ApiTokenStats = {
  agent_id: string;
  agent_name: string;
  model: string;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
};

export type ApiPullRequestStats = {
  agent_id: string;
  agent_name: string;
  status: string;
  count: number;
};

export type ApiReviewStats = {
  agent_id: string;
  agent_name: string;
  decision: string;
  count: number;
};

export type ApiStatsSummary = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  chatgpt_quota_used: number;
  chatgpt_quota_total: number;
  tasks_in_flight: number;
  active_runs: number;
  queued_runs: number;
  pull_requests_merged: number;
  employees: number;
};

export type ApiEmployeeGrowthStats = {
  period: string;
  hired_count: number;
  employee_count: number;
};

export type ApiRuntimeHealth = {
  status: string;
  issue: string | null;
  message: string | null;
  last_error_at: string | null;
  clearable: boolean;
};

export type MissionControlRecords = {
  agents: ApiAgent[];
  conversations: ApiConversation[];
  activeConversation: ApiConversation | null;
  messages: ApiMessage[];
};

type JsonBody = Record<string, unknown>;

export async function listAgents(signal?: AbortSignal): Promise<ApiAgent[]> {
  return fetchJson<ApiAgent[]>("/agents", { signal });
}

export async function createAgent(
  payload: ApiCreateAgentRequest,
  signal?: AbortSignal
): Promise<ApiAgent> {
  return postJson<ApiAgent>("/agents", payload, { signal });
}

export async function listConversations(signal?: AbortSignal): Promise<ApiConversation[]> {
  return fetchJson<ApiConversation[]>("/conversations", { signal });
}

export async function createConversation(
  payload: ApiCreateConversationRequest,
  signal?: AbortSignal
): Promise<ApiConversation> {
  return postJson<ApiConversation>("/conversations", payload, { signal });
}

export async function listMessages(
  conversationId: string,
  signal?: AbortSignal
): Promise<ApiMessage[]> {
  return fetchJson<ApiMessage[]>(`/conversations/${encodeURIComponent(conversationId)}/messages`, {
    signal
  });
}

export async function createMessage(
  conversationId: string,
  body: string,
  optionsOrSignal?: AbortSignal | ApiCreateMessageOptions
): Promise<ApiMessage> {
  const options = createMessageOptions(optionsOrSignal);
  const payload: JsonBody = {
    author_kind: "human",
    author_id: "owner",
    body
  };

  if (options.delivery_mode) {
    payload.delivery_mode = options.delivery_mode;
  }

  return postJson<ApiMessage>(
    `/conversations/${encodeURIComponent(conversationId)}/messages`,
    payload,
    { signal: options.signal }
  );
}

export async function clearConversationMessages(
  conversationId: string,
  signal?: AbortSignal
): Promise<ApiClearMessagesResponse> {
  return fetchJson<ApiClearMessagesResponse>(
    `/conversations/${encodeURIComponent(conversationId)}/messages`,
    { method: "DELETE", signal }
  );
}

export async function listSettings(signal?: AbortSignal): Promise<ApiSetting[]> {
  return fetchJson<ApiSetting[]>("/settings", { signal });
}

export async function searchWorkspace(
  query: string,
  signal?: AbortSignal
): Promise<ApiSearchResult[]> {
  return postJson<ApiSearchResult[]>("/search", { query }, { signal });
}

export async function updateAgent(
  agentId: string,
  payload: ApiUpdateAgentRequest,
  signal?: AbortSignal
): Promise<ApiAgent> {
  return patchJson<ApiAgent>(`/agents/${encodeURIComponent(agentId)}`, payload, { signal });
}

export async function queueAgentRun(
  agentId: string,
  payload: ApiQueueRunRequest,
  signal?: AbortSignal
): Promise<ApiQueueRunResponse> {
  return postJson<ApiQueueRunResponse>(
    `/agents/${encodeURIComponent(agentId)}/runs`,
    queueRunPayload(payload),
    { signal }
  );
}

export async function stopConversationAgent(
  conversationId: string,
  signal?: AbortSignal
): Promise<ApiStopAgentResponse> {
  return postJson<ApiStopAgentResponse>(
    `/conversations/${encodeURIComponent(conversationId)}/agent/stop`,
    undefined,
    { signal }
  );
}

export async function listAgentCronJobs(
  agentId: string,
  signal?: AbortSignal
): Promise<ApiCronJob[]> {
  return fetchJson<ApiCronJob[]>(`/agents/${encodeURIComponent(agentId)}/cron-jobs`, { signal });
}

export async function createAgentCronJob(
  agentId: string,
  payload: ApiCreateCronJobRequest,
  signal?: AbortSignal
): Promise<ApiCronJob> {
  return postJson<ApiCronJob>(
    `/agents/${encodeURIComponent(agentId)}/cron-jobs`,
    payload,
    { signal }
  );
}

export async function updateCronJob(
  cronJobId: string,
  payload: ApiUpdateCronJobRequest,
  signal?: AbortSignal
): Promise<ApiCronJob> {
  return patchJson<ApiCronJob>(`/cron-jobs/${encodeURIComponent(cronJobId)}`, payload, { signal });
}

export async function runCronJobNow(
  cronJobId: string,
  signal?: AbortSignal
): Promise<ApiCronJob> {
  return postJson<ApiCronJob>(`/cron-jobs/${encodeURIComponent(cronJobId)}/run-now`, undefined, { signal });
}

export async function deleteCronJob(
  cronJobId: string,
  signal?: AbortSignal
): Promise<void> {
  return deleteJson(`/cron-jobs/${encodeURIComponent(cronJobId)}`, { signal });
}

export async function listRuns(
  filters: ApiRunListFilters = {},
  signal?: AbortSignal
): Promise<ApiRun[]> {
  const params = new URLSearchParams();

  if (filters.agent_id) {
    params.set("agent_id", filters.agent_id);
  }
  if (filters.status) {
    params.set("status", filters.status);
  }
  if (filters.conversation_id) {
    params.set("conversation_id", filters.conversation_id);
  }
  if (filters.limit !== undefined) {
    const boundedLimit = Math.max(1, Math.min(200, Math.floor(filters.limit)));
    params.set("limit", String(boundedLimit));
  }

  const query = params.toString();
  return fetchJson<ApiRun[]>(`/runs${query ? `?${query}` : ""}`, { signal });
}

export async function listRunEvents(
  runId: string,
  signal?: AbortSignal,
  limit = 120
): Promise<ApiRunEvent[]> {
  const boundedLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
  return fetchJson<ApiRunEvent[]>(
    `/runs/${encodeURIComponent(runId)}/events?limit=${boundedLimit}`,
    { signal }
  );
}

export async function listRecentRunEvents(
  limit = 25,
  signal?: AbortSignal
): Promise<ApiRecentRunEvent[]> {
  const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  return fetchJson<ApiRecentRunEvent[]>(`/events/recent?limit=${boundedLimit}`, { signal });
}

export async function listRunStats(signal?: AbortSignal): Promise<ApiRunStats[]> {
  return fetchJson<ApiRunStats[]>("/stats/runs", { signal });
}

export async function listAgentStats(signal?: AbortSignal): Promise<ApiAgentStats[]> {
  return fetchJson<ApiAgentStats[]>("/stats/agents", { signal });
}

export async function listTokenStats(signal?: AbortSignal): Promise<ApiTokenStats[]> {
  return fetchJson<ApiTokenStats[]>("/stats/tokens", { signal });
}

export async function listPullRequestStats(signal?: AbortSignal): Promise<ApiPullRequestStats[]> {
  return fetchJson<ApiPullRequestStats[]>("/stats/prs", { signal });
}

export async function listReviewStats(signal?: AbortSignal): Promise<ApiReviewStats[]> {
  return fetchJson<ApiReviewStats[]>("/stats/reviews", { signal });
}

export async function getStatsSummary(signal?: AbortSignal): Promise<ApiStatsSummary> {
  return fetchJson<ApiStatsSummary>("/stats/summary", { signal });
}

export async function listEmployeeGrowthStats(signal?: AbortSignal): Promise<ApiEmployeeGrowthStats[]> {
  return fetchJson<ApiEmployeeGrowthStats[]>("/stats/employees-over-time", { signal });
}

export async function getRuntimeHealth(signal?: AbortSignal): Promise<ApiRuntimeHealth> {
  return fetchJson<ApiRuntimeHealth>("/health/runtime", { signal });
}

export async function clearRuntimeHealth(signal?: AbortSignal): Promise<ApiRuntimeHealth> {
  return postJson<ApiRuntimeHealth>("/health/runtime/clear", undefined, { signal });
}

export async function loadMissionControlRecords(signal?: AbortSignal): Promise<MissionControlRecords> {
  const [agents, conversations] = await Promise.all([
    listAgents(signal),
    listConversations(signal)
  ]);
  const activeConversation = chooseMissionConversation(conversations);
  const messages = activeConversation ? await listMessages(activeConversation.id, signal) : [];

  return {
    agents,
    conversations,
    activeConversation,
    messages
  };
}

export function chooseMissionConversation(conversations: ApiConversation[]): ApiConversation | null {
  if (conversations.length === 0) {
    return null;
  }

  const launchRoom = conversations.find((conversation) => {
    return conversation.kind === "channel" && normalizeRoomName(conversation.name) === "launch-room";
  });
  if (launchRoom) {
    return launchRoom;
  }

  return (
    conversations.find((conversation) => conversation.kind === "channel") ??
    conversations[0]
  );
}

function normalizeRoomName(name: string): string {
  return name.trim().replace(/^#/, "").toLowerCase();
}

function queueRunPayload(payload: ApiQueueRunRequest): JsonBody {
  const body: JsonBody = {
    prompt: payload.prompt
  };

  if (payload.workspace) {
    body.workspace = payload.workspace;
  }
  if (payload.conversation_id) {
    body.conversation_id = payload.conversation_id;
  }
  if (payload.trigger_kind) {
    body.trigger_kind = payload.trigger_kind;
  }
  if (payload.branch) {
    body.branch = payload.branch;
  }

  return body;
}

function createMessageOptions(
  optionsOrSignal: AbortSignal | ApiCreateMessageOptions | undefined
): ApiCreateMessageOptions {
  if (!optionsOrSignal) {
    return {};
  }

  if ("aborted" in optionsOrSignal) {
    return { signal: optionsOrSignal };
  }

  return optionsOrSignal;
}
