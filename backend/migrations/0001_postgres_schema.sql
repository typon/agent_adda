CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  profile TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'idle',
  model TEXT NOT NULL DEFAULT 'gpt-5.5',
  reasoning_effort TEXT NOT NULL DEFAULT 'high',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
  deleted_at TEXT
);

CREATE TABLE agent_capabilities (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  capability TEXT NOT NULL,
  PRIMARY KEY (agent_id, capability)
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('dm', 'channel')),
  name TEXT NOT NULL,
  slug TEXT,
  topic TEXT NOT NULL DEFAULT '',
  loop_enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
  archived_at TEXT
);

CREATE TABLE conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  member_kind TEXT NOT NULL CHECK (member_kind IN ('human', 'agent')),
  member_id TEXT NOT NULL,
  PRIMARY KEY (conversation_id, member_kind, member_id)
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('human', 'agent', 'system')),
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  run_id TEXT,
  linked_wiki_pages_json TEXT NOT NULL DEFAULT '[]',
  linked_prs_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
);

CREATE TABLE wiki_spaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
);

CREATE TABLE wiki_pages (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES wiki_spaces(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  body_markdown TEXT NOT NULL,
  rendered_hash TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
  archived_at TEXT,
  UNIQUE (space_id, slug)
);

CREATE TABLE wiki_revisions (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  body_markdown TEXT NOT NULL,
  author_kind TEXT NOT NULL DEFAULT 'system',
  author_id TEXT NOT NULL DEFAULT 'system',
  run_id TEXT,
  change_summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
);

CREATE TABLE wiki_links (
  source_page_id TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  target_slug TEXT NOT NULL,
  target_page_id TEXT REFERENCES wiki_pages(id) ON DELETE SET NULL,
  link_text TEXT NOT NULL,
  PRIMARY KEY (source_page_id, target_slug, link_text)
);

CREATE TABLE wiki_backlinks (
  source_page_id TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  target_slug TEXT NOT NULL,
  link_text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
  PRIMARY KEY (source_page_id, target_slug)
);

CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  trigger_kind TEXT NOT NULL DEFAULT 'manual',
  prompt TEXT NOT NULL DEFAULT '',
  prompt_hash TEXT NOT NULL DEFAULT '',
  prompt_summary TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT 'gpt-5.5',
  reasoning_effort TEXT NOT NULL DEFAULT 'high',
  workspace TEXT NOT NULL DEFAULT '',
  branch TEXT NOT NULL DEFAULT '',
  command_json TEXT NOT NULL DEFAULT '{}',
  queue_priority INTEGER NOT NULL DEFAULT 100,
  queued_by TEXT NOT NULL DEFAULT 'owner',
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
);

CREATE TABLE run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
);

CREATE TABLE token_usage (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  model TEXT NOT NULL DEFAULT 'gpt-5.5',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
);

CREATE TABLE pull_requests (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  author_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open',
  url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
  merged_at TEXT,
  UNIQUE (repo, number)
);

CREATE TABLE pr_reviews (
  id TEXT PRIMARY KEY,
  pull_request_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  reviewer_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  decision TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
);

CREATE TABLE onboarding_checks (
  id TEXT PRIMARY KEY,
  check_name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  detail TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
);

CREATE TABLE agent_threads (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  active_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  codex_session_id TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
);

CREATE TABLE onboarding_initializations (
  id TEXT PRIMARY KEY,
  workspace_path TEXT NOT NULL,
  github_repo TEXT NOT NULL DEFAULT '',
  project_name TEXT NOT NULL DEFAULT '',
  overview_page_id TEXT REFERENCES wiki_pages(id) ON DELETE SET NULL,
  requested_tasks_json TEXT NOT NULL DEFAULT '[]',
  extra_roles_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
);

CREATE TABLE onboarding_task_runs (
  id TEXT PRIMARY KEY,
  initialization_id TEXT NOT NULL REFERENCES onboarding_initializations(id) ON DELETE CASCADE,
  task TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
);

CREATE TABLE agent_cron_jobs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  interval_minutes INTEGER NOT NULL CHECK (interval_minutes BETWEEN 1 AND 10080),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  next_run_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
  last_queued_at TEXT,
  last_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
);

CREATE TABLE search_index (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
);

CREATE INDEX idx_agents_status ON agents(status);
CREATE INDEX idx_conversations_kind ON conversations(kind);
CREATE INDEX idx_messages_conversation_created ON messages(conversation_id, created_at, id);
CREATE INDEX idx_agent_runs_status_priority ON agent_runs(status, queue_priority DESC, created_at, id);
CREATE INDEX idx_agent_runs_agent_status ON agent_runs(agent_id, status);
CREATE INDEX idx_run_events_run_created ON run_events(run_id, created_at, id);
CREATE INDEX idx_token_usage_agent ON token_usage(agent_id);
CREATE INDEX idx_onboarding_task_runs_initialization ON onboarding_task_runs(initialization_id);
CREATE INDEX idx_onboarding_task_runs_run ON onboarding_task_runs(run_id);
CREATE INDEX idx_agent_cron_jobs_agent ON agent_cron_jobs(agent_id);
CREATE INDEX idx_agent_cron_jobs_due ON agent_cron_jobs(enabled, next_run_at);
CREATE INDEX idx_search_index_text ON search_index USING GIN (to_tsvector('simple', title || ' ' || body));

INSERT INTO settings (key, value) VALUES
  ('default_model', 'gpt-5.5'),
  ('default_reasoning_effort', 'high'),
  ('workspace_root', ''),
  ('workspace_path', ''),
  ('codex_bin', 'codex'),
  ('codex_binary_path', 'codex'),
  ('codex_home', ''),
  ('github_repo', ''),
  ('agent_branch_prefix', 'agent/'),
  ('codex_sandbox_mode', 'danger-full-access'),
  ('codex_approval_policy', 'never'),
  ('retention_days', '90'),
  ('max_concurrent_runs', '2'),
  ('global_max_active_runs', '2'),
  ('per_agent_max_active_runs', '1'),
  ('default_workspace', ''),
  ('chatgpt_quota_used', '0'),
  ('chatgpt_quota_total', '0'),
  ('project_name', ''),
  ('project_summary', ''),
  ('onboarding.completed_at', '')
ON CONFLICT DO NOTHING;

INSERT INTO wiki_spaces (id, name, slug, description) VALUES
  ('space_project_memory', 'Project Memory', 'project-memory', 'Shared agent memory')
ON CONFLICT DO NOTHING;

INSERT INTO conversations (id, kind, name, slug, topic) VALUES
  ('channel_general', 'channel', 'general', 'general', 'Default coordination room'),
  ('channel_engineering', 'channel', 'engineering', 'engineering', 'Implementation and reviews'),
  ('channel_reviews', 'channel', 'reviews', 'reviews', 'Pull request review coordination'),
  ('channel_wiki_updates', 'channel', 'wiki-updates', 'wiki-updates', 'Durable memory changes')
ON CONFLICT DO NOTHING;

INSERT INTO conversation_members (conversation_id, member_kind, member_id)
SELECT id, 'human', 'owner'
FROM conversations
WHERE kind = 'channel'
ON CONFLICT DO NOTHING;
