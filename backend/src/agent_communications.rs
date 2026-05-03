use crate::db::{Db, DbPool};
use crate::wiki::{DEFAULT_MEMORY_CLAUSE, extract_wiki_link_targets, slugify, wiki_slug};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Transaction};
use std::fmt::Write;
use uuid::Uuid;

const ACTION_FENCE_LABEL: &str = "agent_adda.actions";
const PROJECT_MEMORY_SPACE_ID: &str = "space_project_memory";
const MAX_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_WIKI_BYTES: usize = 256 * 1024;
const DATASETS_WIKI_SLUG: &str = "datasets";
const DATASET_CATALOG_PATH_ENV: &str = "AGENT_ADDA_DATASET_CATALOG_PATH";
const DEFAULT_DATASET_CATALOG_PATH: &str = "datasets/_state/catalog.json";
const CORPUS_OVERVIEW_ROUTE_ENV: &str = "AGENT_ADDA_CORPUS_OVERVIEW_ROUTE";
const DEFAULT_CORPUS_OVERVIEW_ROUTE: &str = "/api/corpus-overview";

pub const DEFAULT_AGENT_GLOBAL_SYSTEM_PROMPT: &str = r#"Agent Adda is an internal Slack-like operating system for Codex agent employees. The owner assigns work through DMs, agents collaborate through DMs and shared channels, and the wiki is the durable project memory.

Use the wiki for durable facts, decisions, runbooks, research findings, and open questions. Use shared channels when a result, blocker, or decision should be visible to a team. DM another employee when their role is relevant to your task or when handing off focused work.

You may communicate by emitting the `agent_adda.actions` JSON block described below. Prefer concise messages with clear next actions."#;

pub const COMMUNICATION_SCHEMA: &str = r##"Agent Adda communication protocol:
- You may send side-effect requests by adding one fenced block labeled `agent_adda.actions` to your final answer.
- The app parses that block after your run completes. The visible DM reply shown to the owner has the block removed.
- DMs to agents are posted into that agent's DM and queued as a new Codex task for that agent.
- Channel posts are written as messages in the named channel.
- Wiki upserts create or replace a page in Project Memory and add a revision.

Schema:
```agent_adda.actions
{
  "actions": [
    {
      "type": "dm",
      "to_agent": "Founding Engineer",
      "body": "Please review the API shape and reply with risks."
    },
    {
      "type": "channel_post",
      "to_channel": "engineering",
      "body": "I queued the Founding Engineer to review the API shape."
    },
    {
      "type": "wiki_upsert",
      "title": "Dataset Plan",
      "body_markdown": "# Dataset Plan\n\nDurable notes go here.",
      "change_summary": "Captured dataset plan"
    }
  ]
}
```

Rules:
- Use agent names, slugs, or ids from the roster below. Do not invent agents.
- Use channel names with or without `#`, slugs, or ids from the roster below.
- Keep action bodies concise and self-contained; the recipient agent sees the body as its task.
- Only write durable facts, decisions, runbooks, and open questions to the wiki.
- If you do not need side effects, omit the `agent_adda.actions` block."##;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentCommunicationAction {
    Dm {
        to_agent: String,
        body: String,
    },
    ChannelPost {
        to_channel: String,
        body: String,
    },
    WikiUpsert {
        title: String,
        body_markdown: String,
        change_summary: Option<String>,
    },
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedAgentCommunications {
    pub visible_message: String,
    pub actions: Vec<AgentCommunicationAction>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct DmDelivery {
    pub target_agent_id: String,
    pub conversation_id: String,
    pub message_id: String,
    pub body: String,
}

#[derive(Debug, Deserialize)]
struct AgentCommunicationEnvelope {
    #[serde(default)]
    actions: Vec<AgentCommunicationAction>,
}

#[derive(Debug, FromRow)]
struct PromptAgent {
    id: String,
    name: String,
    slug: String,
    role: String,
    description: String,
    system_prompt: String,
}

#[derive(Debug, FromRow)]
struct ChannelRow {
    id: String,
    name: String,
    slug: String,
    topic: String,
}

#[derive(Debug, FromRow)]
struct WikiPageRow {
    title: String,
    slug: String,
}

#[derive(Debug, FromRow)]
struct TranscriptRow {
    author_kind: String,
    author_id: String,
    author_name: String,
    body: String,
}

#[derive(Debug, FromRow)]
struct ResolvedAgent {
    id: String,
    name: String,
}

#[derive(Debug, FromRow)]
struct WikiUpsertGuardContext {
    agent_name: String,
    agent_slug: String,
    agent_role: String,
    trigger_kind: String,
}

pub fn default_agent_system_prompt(name: &str, role: &str, description: &str) -> String {
    format!(
        "You are {name}. Role: {role}. {description}\n\n{DEFAULT_MEMORY_CLAUSE}\n\nThe Agent Adda runtime injects current agent, channel, and wiki rosters plus a communication action schema into every assigned task. Use that schema when you need to DM another agent, post to a channel, or update the wiki."
    )
}

pub async fn build_agent_task_prompt(
    pool: &DbPool,
    agent_id: &str,
    conversation_id: Option<&str>,
    task: &str,
) -> Result<String, sqlx::Error> {
    let agent = sqlx::query_as::<_, PromptAgent>(
        r#"
        SELECT id, name, slug, role, description, system_prompt
        FROM agents
        WHERE id = $1 AND deleted_at IS NULL
        "#,
    )
    .bind(agent_id)
    .fetch_one(pool)
    .await?;
    let agents = sqlx::query_as::<_, PromptAgent>(
        r#"
        SELECT id, name, slug, role, description, system_prompt
        FROM agents
        WHERE deleted_at IS NULL
        ORDER BY name ASC
        "#,
    )
    .fetch_all(pool)
    .await?;
    let channels = sqlx::query_as::<_, ChannelRow>(
        r#"
        SELECT id, name, COALESCE(slug, '') AS slug, topic
        FROM conversations
        WHERE kind = 'channel' AND archived_at IS NULL
        ORDER BY name ASC
        "#,
    )
    .fetch_all(pool)
    .await?;
    let wiki_pages = sqlx::query_as::<_, WikiPageRow>(
        r#"
        SELECT title, slug
        FROM wiki_pages
        WHERE archived_at IS NULL
        ORDER BY updated_at DESC, title ASC
        LIMIT 24
        "#,
    )
    .fetch_all(pool)
    .await?;
    let project_name = read_setting(pool, "project_name").await?;
    let project_summary = read_setting(pool, "project_summary").await?;
    let configured_global_system_prompt = read_setting(pool, "agent_global_system_prompt").await?;
    let transcript = match conversation_id {
        Some(id) => recent_transcript(pool, id).await?,
        None => Vec::new(),
    };

    let mut prompt = String::with_capacity(task.len() + 8_192);
    prompt.push_str("You are working inside Agent Adda. Treat this as your effective system and task prompt for this run.\n\n");
    prompt.push_str("Global Agent Adda system prompt:\n");
    prompt.push_str(&render_global_system_prompt(
        configured_global_system_prompt
            .as_deref()
            .unwrap_or(DEFAULT_AGENT_GLOBAL_SYSTEM_PROMPT),
        &agents,
        &channels,
    ));
    prompt.push_str("\n\n");
    prompt.push_str("Stored agent system prompt:\n");
    prompt.push_str(agent.system_prompt.trim());
    prompt.push_str("\n\nCurrent agent:\n");
    let _ = writeln!(
        prompt,
        "- {} (role: {}, id: {}, slug: {})",
        agent.name, agent.role, agent.id, agent.slug
    );
    if !agent.description.trim().is_empty() {
        let _ = writeln!(prompt, "  {}", agent.description.trim());
    }
    prompt.push('\n');

    if let Some(project_name) = project_name.as_deref().filter(|value| !value.is_empty()) {
        prompt.push_str("Project name:\n");
        prompt.push_str(project_name);
        prompt.push_str("\n\n");
    }
    if let Some(project_summary) = project_summary.as_deref().filter(|value| !value.is_empty()) {
        prompt.push_str("Project focus:\n");
        prompt.push_str(project_summary);
        prompt.push_str("\n\n");
    }

    prompt.push_str("Agent roster:\n");
    for roster_agent in &agents {
        let marker = if roster_agent.id == agent.id {
            " (you)"
        } else {
            ""
        };
        let _ = writeln!(
            prompt,
            "- {}{}: role={}, id={}, slug={}, dm=dm_{}",
            roster_agent.name,
            marker,
            roster_agent.role,
            roster_agent.id,
            roster_agent.slug,
            roster_agent.id
        );
        if !roster_agent.description.trim().is_empty() {
            let _ = writeln!(prompt, "  {}", roster_agent.description.trim());
        }
    }
    prompt.push('\n');

    prompt.push_str("Channel roster:\n");
    for channel in &channels {
        let slug = if channel.slug.trim().is_empty() {
            slugify(&channel.name)
        } else {
            channel.slug.clone()
        };
        let _ = writeln!(
            prompt,
            "- #{}: id={}, slug={}, topic={}",
            channel.name, channel.id, slug, channel.topic
        );
    }
    prompt.push('\n');

    if !wiki_pages.is_empty() {
        prompt.push_str("Recent wiki pages:\n");
        for page in &wiki_pages {
            let _ = writeln!(prompt, "- [[{}]] (slug: {})", page.title, page.slug);
        }
        prompt.push('\n');
    }

    prompt.push_str(COMMUNICATION_SCHEMA);
    prompt.push_str("\n\n");

    if !transcript.is_empty() {
        prompt.push_str("Recent conversation transcript:\n");
        for row in transcript {
            let _ = writeln!(
                prompt,
                "{}:{} ({}): {}",
                row.author_kind,
                row.author_id,
                row.author_name,
                row.body.trim()
            );
        }
        prompt.push('\n');
    }

    prompt.push_str("Latest assigned task:\n");
    prompt.push_str(task.trim());
    prompt.push('\n');
    Ok(prompt)
}

fn render_global_system_prompt(
    configured_prompt: &str,
    agents: &[PromptAgent],
    channels: &[ChannelRow],
) -> String {
    let mut prompt = String::with_capacity(configured_prompt.len() + 2_048);
    let configured_prompt = configured_prompt.trim();
    if configured_prompt.is_empty() {
        prompt.push_str(DEFAULT_AGENT_GLOBAL_SYSTEM_PROMPT);
    } else {
        prompt.push_str(configured_prompt);
    }
    prompt.push_str("\n\nCurrent employees available for DMs:\n");
    if agents.is_empty() {
        prompt.push_str("- No agent employees are currently registered.\n");
    } else {
        for agent in agents {
            let _ = writeln!(
                prompt,
                "- {}: role={}, id={}, slug={}, dm=dm_{}",
                agent.name, agent.role, agent.id, agent.slug, agent.id
            );
            if !agent.description.trim().is_empty() {
                let _ = writeln!(prompt, "  {}", agent.description.trim());
            }
        }
    }

    prompt.push_str("\nCurrent shared channels available for posts:\n");
    if channels.is_empty() {
        prompt.push_str("- No shared channels are currently registered.\n");
    } else {
        for channel in channels {
            let slug = if channel.slug.trim().is_empty() {
                slugify(&channel.name)
            } else {
                channel.slug.clone()
            };
            let _ = writeln!(
                prompt,
                "- #{}: id={}, slug={}, topic={}",
                channel.name, channel.id, slug, channel.topic
            );
        }
    }

    prompt.push_str("\nCollaboration guidance:\n");
    prompt.push_str("- Post to relevant channels when your work affects that channel's topic or should be visible to more than one person.\n");
    prompt.push_str("- DM relevant employees when their role, context, or ownership can help the task move faster.\n");
    prompt.push_str("- Keep the final user-visible answer concise; use communication actions for side effects.\n");
    prompt
}

pub fn parse_agent_communications(message: &str) -> ParsedAgentCommunications {
    let (visible_message, blocks) = extract_action_blocks(message);
    let mut actions = Vec::new();
    let mut errors = Vec::new();

    for block in blocks {
        match serde_json::from_str::<AgentCommunicationEnvelope>(&block) {
            Ok(envelope) => actions.extend(envelope.actions),
            Err(error) => errors.push(format!("failed to parse {ACTION_FENCE_LABEL}: {error}")),
        }
    }

    ParsedAgentCommunications {
        visible_message: visible_message.trim().to_string(),
        actions,
        errors,
    }
}

pub async fn post_agent_dm(
    pool: &DbPool,
    source_agent_id: &str,
    run_id: &str,
    to_agent: &str,
    body: &str,
) -> Result<DmDelivery, String> {
    let body = bounded_text(body, MAX_MESSAGE_BYTES, "dm body")?;
    let target = resolve_agent(pool, to_agent).await?;
    let conversation_id = format!("dm_{}", target.id);
    let mut tx = pool
        .begin()
        .await
        .map_err(|error| db_error("begin dm", error))?;
    ensure_agent_dm_in_tx(&mut tx, &target).await?;
    let message_id =
        insert_agent_message_in_tx(&mut tx, &conversation_id, source_agent_id, run_id, &body)
            .await?;
    tx.commit()
        .await
        .map_err(|error| db_error("commit dm", error))?;

    Ok(DmDelivery {
        target_agent_id: target.id,
        conversation_id,
        message_id,
        body,
    })
}

pub async fn post_channel_message(
    pool: &DbPool,
    source_agent_id: &str,
    run_id: &str,
    to_channel: &str,
    body: &str,
) -> Result<(), String> {
    let body = bounded_text(body, MAX_MESSAGE_BYTES, "channel body")?;
    let conversation_id = resolve_channel_id(pool, to_channel).await?;
    let mut tx = pool
        .begin()
        .await
        .map_err(|error| db_error("begin channel post", error))?;
    insert_agent_message_in_tx(&mut tx, &conversation_id, source_agent_id, run_id, &body).await?;
    tx.commit()
        .await
        .map_err(|error| db_error("commit channel post", error))
}

pub async fn upsert_wiki_page_from_agent(
    pool: &DbPool,
    source_agent_id: &str,
    run_id: &str,
    title: &str,
    body_markdown: &str,
    change_summary: Option<&str>,
) -> Result<(), String> {
    let title = bounded_text(title, 160, "wiki title")?;
    let body = bounded_text(body_markdown, MAX_WIKI_BYTES, "wiki body")?;
    let slug = wiki_slug(&title).ok_or_else(|| format!("invalid wiki title: {title}"))?;
    guard_datasets_wiki_upsert(pool, source_agent_id, run_id, &slug, &body).await?;
    let summary = change_summary
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Agent communication wiki upsert")
        .to_string();
    let mut tx = pool
        .begin()
        .await
        .map_err(|error| db_error("begin wiki upsert", error))?;

    let existing = sqlx::query_as::<_, (String, String)>(
        "SELECT id, space_id FROM wiki_pages WHERE slug = $1 AND archived_at IS NULL",
    )
    .bind(&slug)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|error| db_error("resolve wiki page", error))?;

    let (page_id, space_id) = match existing {
        Some((page_id, space_id)) => {
            sqlx::query(
                r#"
                UPDATE wiki_pages
                SET title = $1,
                    body_markdown = $2,
                    updated_by = $3,
                    updated_at = CURRENT_TIMESTAMP::text
                WHERE id = $4
                "#,
            )
            .bind(&title)
            .bind(&body)
            .bind(source_agent_id)
            .bind(&page_id)
            .execute(&mut *tx)
            .await
            .map_err(|error| db_error("update wiki page", error))?;
            (page_id, space_id)
        }
        None => {
            let page_id = Uuid::new_v4().to_string();
            sqlx::query(
                r#"
                INSERT INTO wiki_pages (id, space_id, slug, title, body_markdown, created_by, updated_by)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                "#,
            )
            .bind(&page_id)
            .bind(PROJECT_MEMORY_SPACE_ID)
            .bind(&slug)
            .bind(&title)
            .bind(&body)
            .bind(source_agent_id)
            .bind(source_agent_id)
            .execute(&mut *tx)
            .await
            .map_err(|error| db_error("create wiki page", error))?;
            (page_id, PROJECT_MEMORY_SPACE_ID.to_string())
        }
    };

    sqlx::query(
        r#"
        INSERT INTO wiki_revisions (id, page_id, body_markdown, author_kind, author_id, run_id, change_summary)
        VALUES ($1, $2, $3, 'agent', $4, $5, $6)
        "#,
    )
    .bind(Uuid::new_v4().to_string())
    .bind(&page_id)
    .bind(&body)
    .bind(source_agent_id)
    .bind(run_id)
    .bind(&summary)
    .execute(&mut *tx)
    .await
    .map_err(|error| db_error("create wiki revision", error))?;

    refresh_wiki_links_in_tx(&mut tx, &page_id, &space_id, &body).await?;
    refresh_wiki_search_in_tx(&mut tx, &page_id, &title, &body).await?;
    resolve_wiki_links_to_page_in_tx(&mut tx, &page_id, &space_id, &slug).await?;

    tx.commit()
        .await
        .map_err(|error| db_error("commit wiki upsert", error))
}

async fn guard_datasets_wiki_upsert(
    pool: &DbPool,
    source_agent_id: &str,
    run_id: &str,
    slug: &str,
    body_markdown: &str,
) -> Result<(), String> {
    if slug != DATASETS_WIKI_SLUG {
        return Ok(());
    }

    let context = sqlx::query_as::<_, WikiUpsertGuardContext>(
        r#"
        SELECT COALESCE(a.name, '') AS agent_name,
               COALESCE(a.slug, '') AS agent_slug,
               COALESCE(a.role, '') AS agent_role,
               COALESCE(r.trigger_kind, '') AS trigger_kind
        FROM agents a
        LEFT JOIN agent_runs r ON r.id = $2
        WHERE a.id = $1
        "#,
    )
    .bind(source_agent_id)
    .bind(run_id)
    .fetch_optional(pool)
    .await
    .map_err(|error| db_error("load wiki upsert guard context", error))?;

    let Some(context) = context else {
        return Ok(());
    };

    if !is_dataset_wizard_cron_context(&context) {
        return Ok(());
    }

    if datasets_body_mentions_live_catalog(body_markdown) {
        return Ok(());
    }

    let catalog_path = dataset_catalog_path();
    let corpus_overview_route = corpus_overview_route();
    Err(format!(
        "Dataset Wizard cron Datasets wiki upsert blocked: read and cite {catalog_path} or {corpus_overview_route} before replacing [[Datasets]]. {}",
        datasets_live_catalog_status()
    ))
}

fn is_dataset_wizard_cron_context(context: &WikiUpsertGuardContext) -> bool {
    let name = context.agent_name.to_ascii_lowercase();
    let slug = context.agent_slug.to_ascii_lowercase();
    let role = context.agent_role.to_ascii_lowercase();
    let trigger_kind = context.trigger_kind.to_ascii_lowercase();

    let is_dataset_wizard = name.contains("dataset wizard")
        || role.contains("dataset wizard")
        || slug == "pepe"
        || slug.contains("dataset-wizard");
    let is_cron = trigger_kind.starts_with("cron");

    is_dataset_wizard && is_cron
}

fn datasets_body_mentions_live_catalog(body_markdown: &str) -> bool {
    let body = body_markdown.to_ascii_lowercase();
    let catalog_path = dataset_catalog_path().to_ascii_lowercase();
    let corpus_overview_route = corpus_overview_route().to_ascii_lowercase();

    body.contains(&catalog_path) || body.contains(&corpus_overview_route)
}

fn datasets_live_catalog_status() -> String {
    let catalog_path = dataset_catalog_path();
    let corpus_overview_route = corpus_overview_route();
    match std::fs::read_to_string(&catalog_path) {
        Ok(contents) => {
            let bytes = contents.len();
            match serde_json::from_str::<serde_json::Value>(&contents) {
                Ok(value) => format!(
                    "Live catalog file is present ({bytes} bytes; {}).",
                    summarize_catalog_json(&value)
                ),
                Err(_) => format!("Live catalog file is present ({bytes} bytes; not valid JSON)."),
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            format!(
                "Live catalog file is not present at {catalog_path}; use {corpus_overview_route} instead."
            )
        }
        Err(error) => {
            format!("Live catalog file could not be read at {catalog_path}: {error}.")
        }
    }
}

fn dataset_catalog_path() -> String {
    std::env::var(DATASET_CATALOG_PATH_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_DATASET_CATALOG_PATH.to_string())
}

fn corpus_overview_route() -> String {
    std::env::var(CORPUS_OVERVIEW_ROUTE_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_CORPUS_OVERVIEW_ROUTE.to_string())
}

fn summarize_catalog_json(value: &serde_json::Value) -> String {
    let Some(object) = value.as_object() else {
        return "top-level value is not an object".to_string();
    };

    let mut parts = Vec::new();
    let keys = object
        .keys()
        .take(8)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    if !keys.is_empty() {
        parts.push(format!("keys: {keys}"));
    }

    for key in ["datasets", "sources", "items", "records"] {
        match object.get(key) {
            Some(serde_json::Value::Array(items)) => parts.push(format!("{key}: {}", items.len())),
            Some(serde_json::Value::Object(items)) => parts.push(format!("{key}: {}", items.len())),
            _ => {}
        }
    }

    if parts.is_empty() {
        "no summary fields found".to_string()
    } else {
        parts.join("; ")
    }
}

async fn read_setting(pool: &DbPool, key: &str) -> Result<Option<String>, sqlx::Error> {
    let value = sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = $1")
        .bind(key)
        .fetch_optional(pool)
        .await?;

    Ok(value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty()))
}

async fn recent_transcript(
    pool: &DbPool,
    conversation_id: &str,
) -> Result<Vec<TranscriptRow>, sqlx::Error> {
    let mut rows = sqlx::query_as::<_, TranscriptRow>(
        r#"
        SELECT m.author_kind,
               m.author_id,
               COALESCE(a.name, m.author_id) AS author_name,
               m.body
        FROM messages m
        LEFT JOIN agents a ON m.author_kind = 'agent' AND m.author_id = a.id
        WHERE m.conversation_id = $1
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 16
        "#,
    )
    .bind(conversation_id)
    .fetch_all(pool)
    .await?;
    rows.reverse();
    Ok(rows)
}

fn extract_action_blocks(message: &str) -> (String, Vec<String>) {
    let mut visible = String::with_capacity(message.len());
    let mut blocks = Vec::new();

    let mut lines = message.split_inclusive('\n');
    while let Some(line) = lines.next() {
        let Some(fence) = action_fence_open(line) else {
            visible.push_str(line);
            continue;
        };

        let mut block = String::new();
        for body_line in lines.by_ref() {
            if is_fence_close(body_line, fence.marker, fence.len) {
                break;
            }
            block.push_str(body_line);
        }
        blocks.push(block.trim().to_string());
    }

    (visible.trim().to_string(), blocks)
}

#[derive(Clone, Copy)]
struct ActionFence {
    marker: char,
    len: usize,
}

fn action_fence_open(line: &str) -> Option<ActionFence> {
    let line = line.trim();
    let Some((marker, len)) = fence_prefix(line) else {
        return None;
    };
    if line[len..].trim() == ACTION_FENCE_LABEL {
        Some(ActionFence { marker, len })
    } else {
        None
    }
}

fn is_fence_close(line: &str, marker: char, min_len: usize) -> bool {
    let line = line.trim();
    let Some((candidate_marker, len)) = fence_prefix(line) else {
        return false;
    };
    candidate_marker == marker && len >= min_len && line[len..].trim().is_empty()
}

fn fence_prefix(line: &str) -> Option<(char, usize)> {
    let marker = line.chars().next()?;
    if marker != '`' && marker != '~' {
        return None;
    }

    let len = line.chars().take_while(|value| *value == marker).count();
    if len >= 3 { Some((marker, len)) } else { None }
}

async fn resolve_agent(pool: &DbPool, reference: &str) -> Result<ResolvedAgent, String> {
    let reference = normalized_reference(reference)?;
    let slug = slugify(&reference);
    sqlx::query_as::<_, ResolvedAgent>(
        r#"
        SELECT id, name
        FROM agents
        WHERE deleted_at IS NULL
          AND (id = $1 OR lower(name) = $2 OR lower(slug) = $3 OR slug = $4)
        ORDER BY created_at ASC
        LIMIT 1
        "#,
    )
    .bind(&reference)
    .bind(&reference)
    .bind(&reference)
    .bind(&slug)
    .fetch_optional(pool)
    .await
    .map_err(|error| db_error("resolve target agent", error))?
    .ok_or_else(|| format!("unknown target agent: {reference}"))
}

async fn resolve_channel_id(pool: &DbPool, reference: &str) -> Result<String, String> {
    let reference = normalized_reference(reference)?
        .trim_start_matches('#')
        .to_string();
    let slug = slugify(&reference);
    sqlx::query_scalar::<_, String>(
        r#"
        SELECT id
        FROM conversations
        WHERE kind = 'channel'
          AND archived_at IS NULL
          AND (id = $1 OR lower(name) = $2 OR lower(COALESCE(slug, '')) = $3 OR slug = $4)
        ORDER BY created_at ASC
        LIMIT 1
        "#,
    )
    .bind(&reference)
    .bind(&reference)
    .bind(&reference)
    .bind(&slug)
    .fetch_optional(pool)
    .await
    .map_err(|error| db_error("resolve target channel", error))?
    .ok_or_else(|| format!("unknown target channel: {reference}"))
}

async fn ensure_agent_dm_in_tx(
    tx: &mut Transaction<'_, Db>,
    agent: &ResolvedAgent,
) -> Result<(), String> {
    let conversation_id = format!("dm_{}", agent.id);
    sqlx::query(
        r#"
        INSERT INTO conversations (id, kind, name, topic)
        VALUES ($1, 'dm', $2, $3)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            topic = excluded.topic,
            archived_at = NULL,
            updated_at = CURRENT_TIMESTAMP::text
        "#,
    )
    .bind(&conversation_id)
    .bind(&agent.name)
    .bind(format!("Direct message with {}", agent.name))
    .execute(&mut **tx)
    .await
    .map_err(|error| db_error("ensure agent dm", error))?;

    sqlx::query(
        "INSERT INTO conversation_members (conversation_id, member_kind, member_id) VALUES ($1, 'human', 'owner') ON CONFLICT DO NOTHING",
    )
    .bind(&conversation_id)
    .execute(&mut **tx)
    .await
    .map_err(|error| db_error("ensure dm owner member", error))?;

    sqlx::query(
        "INSERT INTO conversation_members (conversation_id, member_kind, member_id) VALUES ($1, 'agent', $2) ON CONFLICT DO NOTHING",
    )
    .bind(&conversation_id)
    .bind(&agent.id)
    .execute(&mut **tx)
    .await
    .map_err(|error| db_error("ensure dm agent member", error))?;

    Ok(())
}

async fn insert_agent_message_in_tx(
    tx: &mut Transaction<'_, Db>,
    conversation_id: &str,
    source_agent_id: &str,
    run_id: &str,
    body: &str,
) -> Result<String, String> {
    let message_id = Uuid::new_v4().to_string();
    let search_title = sqlx::query_scalar::<_, String>(
        "SELECT 'Message in ' || name FROM conversations WHERE id = $1",
    )
    .bind(conversation_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(|error| db_error("resolve search title", error))?;

    sqlx::query(
        "INSERT INTO messages (id, conversation_id, author_kind, author_id, body, run_id) VALUES ($1, $2, 'agent', $3, $4, $5)",
    )
    .bind(&message_id)
    .bind(conversation_id)
    .bind(source_agent_id)
    .bind(body)
    .bind(run_id)
    .execute(&mut **tx)
    .await
    .map_err(|error| db_error("insert communication message", error))?;

    sqlx::query(
        r#"
        INSERT INTO search_index (entity_type, entity_id, title, body)
        VALUES ('message', $1, $2, $3)
        ON CONFLICT (entity_type, entity_id) DO UPDATE SET
            title = excluded.title,
            body = excluded.body
        "#,
    )
    .bind(&message_id)
    .bind(&search_title)
    .bind(body)
    .execute(&mut **tx)
    .await
    .map_err(|error| db_error("index communication message", error))?;

    sqlx::query("UPDATE conversations SET updated_at = CURRENT_TIMESTAMP::text WHERE id = $1")
        .bind(conversation_id)
        .execute(&mut **tx)
        .await
        .map_err(|error| db_error("update conversation timestamp", error))?;

    Ok(message_id)
}

async fn refresh_wiki_links_in_tx(
    tx: &mut Transaction<'_, Db>,
    page_id: &str,
    space_id: &str,
    body: &str,
) -> Result<(), String> {
    sqlx::query("DELETE FROM wiki_links WHERE source_page_id = $1")
        .bind(page_id)
        .execute(&mut **tx)
        .await
        .map_err(|error| db_error("clear wiki links", error))?;
    sqlx::query("DELETE FROM wiki_backlinks WHERE source_page_id = $1")
        .bind(page_id)
        .execute(&mut **tx)
        .await
        .map_err(|error| db_error("clear wiki backlinks", error))?;

    for link in extract_wiki_link_targets(body) {
        sqlx::query(
            r#"
            INSERT INTO wiki_links (source_page_id, target_slug, target_page_id, link_text)
            VALUES (
              $1,
              $2,
              (SELECT id FROM wiki_pages WHERE space_id = $3 AND slug = $4 AND archived_at IS NULL),
              $5
            )
            ON CONFLICT DO NOTHING
            "#,
        )
        .bind(page_id)
        .bind(&link.slug)
        .bind(space_id)
        .bind(&link.slug)
        .bind(&link.link_text)
        .execute(&mut **tx)
        .await
        .map_err(|error| db_error("insert wiki link", error))?;

        sqlx::query(
            "INSERT INTO wiki_backlinks (source_page_id, target_slug, link_text) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        )
        .bind(page_id)
        .bind(&link.slug)
        .bind(&link.link_text)
        .execute(&mut **tx)
        .await
        .map_err(|error| db_error("insert wiki backlink", error))?;
    }

    Ok(())
}

async fn refresh_wiki_search_in_tx(
    tx: &mut Transaction<'_, Db>,
    page_id: &str,
    title: &str,
    body: &str,
) -> Result<(), String> {
    sqlx::query("DELETE FROM search_index WHERE entity_type = 'wiki_page' AND entity_id = $1")
        .bind(page_id)
        .execute(&mut **tx)
        .await
        .map_err(|error| db_error("clear wiki search", error))?;
    sqlx::query(
        r#"
        INSERT INTO search_index (entity_type, entity_id, title, body)
        VALUES ('wiki_page', $1, $2, $3)
        ON CONFLICT (entity_type, entity_id) DO UPDATE SET
            title = excluded.title,
            body = excluded.body
        "#,
    )
    .bind(page_id)
    .bind(title)
    .bind(body)
    .execute(&mut **tx)
    .await
    .map_err(|error| db_error("index wiki page", error))?;
    Ok(())
}

async fn resolve_wiki_links_to_page_in_tx(
    tx: &mut Transaction<'_, Db>,
    page_id: &str,
    space_id: &str,
    slug: &str,
) -> Result<(), String> {
    sqlx::query("UPDATE wiki_links SET target_page_id = NULL WHERE target_page_id = $1")
        .bind(page_id)
        .execute(&mut **tx)
        .await
        .map_err(|error| db_error("clear resolved wiki links", error))?;
    sqlx::query(
        r#"
        UPDATE wiki_links
        SET target_page_id = $1
        WHERE target_slug = $2
          AND source_page_id IN (
            SELECT id FROM wiki_pages WHERE space_id = $3 AND archived_at IS NULL
          )
        "#,
    )
    .bind(page_id)
    .bind(slug)
    .bind(space_id)
    .execute(&mut **tx)
    .await
    .map_err(|error| db_error("resolve wiki links", error))?;
    Ok(())
}

fn normalized_reference(reference: &str) -> Result<String, String> {
    let reference = reference.trim().to_lowercase();
    if reference.is_empty() {
        Err("empty communication target".to_string())
    } else {
        Ok(reference)
    }
}

fn bounded_text(value: &str, max_bytes: usize, label: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("{label} is empty"));
    }
    if value.len() > max_bytes {
        return Err(format!("{label} is too large"));
    }
    Ok(value.to_string())
}

fn db_error(action: &str, error: sqlx::Error) -> String {
    format!("{action} failed: {error}")
}

#[cfg(test)]
mod tests {
    use super::{
        AgentCommunicationAction, WikiUpsertGuardContext, build_agent_task_prompt,
        corpus_overview_route, dataset_catalog_path, datasets_body_mentions_live_catalog,
        is_dataset_wizard_cron_context, parse_agent_communications, upsert_wiki_page_from_agent,
    };
    use crate::db::DbPool;
    use crate::db::init_database;
    use tempfile::TempDir;

    #[test]
    fn parses_and_strips_agent_action_blocks() {
        let parsed = parse_agent_communications(
            r#"Visible reply.

```agent_adda.actions
{"actions":[{"type":"dm","to_agent":"Researcher","body":"Check this."}]}
```
"#,
        );

        assert_eq!(parsed.visible_message, "Visible reply.");
        assert_eq!(parsed.errors, Vec::<String>::new());
        assert_eq!(
            parsed.actions,
            vec![AgentCommunicationAction::Dm {
                to_agent: "Researcher".to_string(),
                body: "Check this.".to_string()
            }]
        );
    }

    #[test]
    fn action_blocks_may_contain_markdown_code_fences() {
        let envelope = serde_json::json!({
            "actions": [
                {
                    "type": "wiki_upsert",
                    "title": "Dashboard Linuxbrew PATH",
                    "body_markdown": "# Dashboard Linuxbrew PATH\n\n```bash\ndocker compose up --build -d app-dashboard\n```\n",
                    "change_summary": "Documented dashboard Linuxbrew PATH behavior"
                }
            ]
        });
        let message = format!(
            "Implemented the dashboard Linuxbrew PATH change.\n\n```agent_adda.actions\n{}\n```\n",
            envelope
        );

        let parsed = parse_agent_communications(&message);

        assert_eq!(
            parsed.visible_message,
            "Implemented the dashboard Linuxbrew PATH change."
        );
        assert_eq!(parsed.errors, Vec::<String>::new());
        assert_eq!(
            parsed.actions,
            vec![AgentCommunicationAction::WikiUpsert {
                title: "Dashboard Linuxbrew PATH".to_string(),
                body_markdown: "# Dashboard Linuxbrew PATH\n\n```bash\ndocker compose up --build -d app-dashboard\n```\n".to_string(),
                change_summary: Some("Documented dashboard Linuxbrew PATH behavior".to_string())
            }]
        );
    }

    #[test]
    fn dataset_wizard_cron_context_is_guarded_for_datasets_page() {
        let context = WikiUpsertGuardContext {
            agent_name: "Pepe".to_string(),
            agent_slug: "pepe".to_string(),
            agent_role: "Dataset Wizard".to_string(),
            trigger_kind: "cron".to_string(),
        };

        assert!(is_dataset_wizard_cron_context(&context));

        let manual_context = WikiUpsertGuardContext {
            trigger_kind: "agent-dm".to_string(),
            ..context
        };
        assert!(!is_dataset_wizard_cron_context(&manual_context));
    }

    #[test]
    fn datasets_body_must_cite_live_catalog_or_corpus_overview() {
        assert!(!datasets_body_mentions_live_catalog(
            "# Datasets\n\nScoped crawl candidates only."
        ));
        assert!(datasets_body_mentions_live_catalog(&format!(
            "Checked `{}` before updating this page.",
            dataset_catalog_path()
        )));
        assert!(datasets_body_mentions_live_catalog(&format!(
            "Checked `{}` before updating this page.",
            corpus_overview_route()
        )));
    }

    #[tokio::test]
    async fn dataset_wizard_cron_datasets_upsert_requires_live_catalog_evidence() {
        let pool = prompt_test_pool().await;
        sqlx::query("DELETE FROM agent_runs WHERE id = 'run_dataset_guard_test'")
            .execute(&pool)
            .await
            .expect("clear guard run");
        sqlx::query("DELETE FROM agents WHERE id = 'agent_dataset_guard_test'")
            .execute(&pool)
            .await
            .expect("clear guard agent");
        sqlx::query(
            r#"
            INSERT INTO agents (id, name, slug, role, description, profile, system_prompt)
            VALUES ('agent_dataset_guard_test', 'Pepe', 'pepe-guard-test', 'Dataset Wizard', '', '', '')
            "#,
        )
        .execute(&pool)
        .await
        .expect("seed guard agent");
        sqlx::query(
            r#"
            INSERT INTO agent_runs (id, agent_id, trigger_kind, prompt)
            VALUES ('run_dataset_guard_test', 'agent_dataset_guard_test', 'cron', 'Refresh datasets.')
            "#,
        )
        .execute(&pool)
        .await
        .expect("seed guard run");

        let result = upsert_wiki_page_from_agent(
            &pool,
            "agent_dataset_guard_test",
            "run_dataset_guard_test",
            "Datasets",
            "# Datasets\n\nScoped crawl candidates only.",
            Some("Scoped crawl update"),
        )
        .await;

        let error = result.expect_err("guard should block unsafe Datasets overwrite");
        assert!(error.contains("Dataset Wizard cron Datasets wiki upsert blocked"));
        assert!(error.contains(&dataset_catalog_path()));
        assert!(error.contains(&corpus_overview_route()));
    }

    #[tokio::test]
    async fn task_prompt_includes_rosters_and_schema() {
        let pool = prompt_test_pool().await;

        let prompt = build_agent_task_prompt(
            &pool,
            "agent_ceo",
            Some("dm_agent_ceo"),
            "Prepare the first delegation.",
        )
        .await
        .expect("prompt");

        assert!(prompt.contains("CEO"));
        assert!(prompt.contains("Founding Engineer"));
        assert!(prompt.contains("#engineering"));
        assert!(prompt.contains("Global Agent Adda system prompt:"));
        assert!(prompt.contains("Current employees available for DMs:"));
        assert!(prompt.contains("Current shared channels available for posts:"));
        assert!(prompt.contains("Custom global architecture prompt."));
        assert!(prompt.contains("agent_adda.actions"));
        assert!(prompt.contains("Prepare the first delegation."));

        let global_index = prompt.find("Global Agent Adda system prompt:").unwrap();
        let stored_index = prompt.find("Stored agent system prompt:").unwrap();
        assert!(global_index < stored_index);
    }

    async fn prompt_test_pool() -> DbPool {
        let _temp = TempDir::new().expect("tempdir");
        let database_url = std::env::var("AGENT_ADDA_TEST_DATABASE_URL").unwrap_or_else(|_| {
            "postgres://agent_adda:agent_adda@127.0.0.1:15432/agent_adda_test".to_string()
        });
        let pool = init_database(&database_url).await.expect("database");
        sqlx::query(
            r#"
            INSERT INTO agents (id, name, slug, role, description, profile, system_prompt)
            VALUES
              ('agent_ceo', 'CEO', 'ceo', 'CEO', 'Runs planning', '', 'Lead the company.'),
              ('agent_fe', 'Founding Engineer', 'founding-engineer', 'Engineer', 'Builds', '', 'Build carefully.')
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              slug = excluded.slug,
              role = excluded.role,
              description = excluded.description,
              profile = excluded.profile,
              system_prompt = excluded.system_prompt,
              deleted_at = NULL
            "#,
        )
        .execute(&pool)
        .await
        .expect("agents");
        sqlx::query(
            r#"
            INSERT INTO conversations (id, kind, name, slug, topic)
            VALUES ('dm_agent_ceo', 'dm', 'CEO', 'ceo', 'Direct message with CEO')
            ON CONFLICT(id) DO UPDATE SET
              kind = excluded.kind,
              name = excluded.name,
              slug = excluded.slug,
              topic = excluded.topic,
              archived_at = NULL
            "#,
        )
        .execute(&pool)
        .await
        .expect("dm");
        sqlx::query(
            r#"
            INSERT INTO settings (key, value, updated_at)
            VALUES ('agent_global_system_prompt', 'Custom global architecture prompt.', CURRENT_TIMESTAMP::text)
            ON CONFLICT(key) DO UPDATE SET
              value = excluded.value,
              updated_at = CURRENT_TIMESTAMP::text
            "#,
        )
        .execute(&pool)
        .await
        .expect("global prompt setting");
        pool
    }
}
