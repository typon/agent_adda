use crate::agent_communications::default_agent_system_prompt;
use crate::codex::is_known_reasoning_effort;
use crate::db::DbPool;
use crate::models::{InitializeOnboardingRequest, OnboardingExtraRoleRequest};
use crate::routes::runs::{QueueAgentRunInput, RUN_PRIORITY_NORMAL, queue_agent_run};
use crate::wiki::slugify;
use rocket::State;
use rocket::http::Status;
use rocket::serde::json::Json;
use serde::Serialize;
use sqlx::FromRow;
use std::path::Path;
use uuid::Uuid;

const COMPANY_OVERVIEW_TITLE: &str = "Company Overview";
const COMPANY_OVERVIEW_SLUG: &str = "company-overview";
const PROJECT_MEMORY_SPACE_ID: &str = "space_project_memory";

const STARTER_ROLES: &[(&str, &str, &str)] = &[
    (
        "CEO",
        "CEO",
        "Keeps the company focused, breaks down priorities, delegates work, and reviews progress.",
    ),
    (
        "Founding Engineer",
        "Founding Engineer",
        "Builds the product, keeps implementation simple, and turns plans into working code.",
    ),
    (
        "Researcher",
        "Researcher",
        "Finds technical/product context, compares options, and writes durable findings into the wiki.",
    ),
    (
        "Product Manager",
        "Product Manager",
        "Clarifies user workflows, prioritizes tasks, and keeps product decisions tied to the company focus.",
    ),
];

#[derive(Debug, Serialize)]
pub struct OnboardingStatusResponse {
    initialized: bool,
    completed: bool,
    project_name: String,
    project_summary: String,
    workspace_path: String,
    default_model: String,
    default_reasoning_effort: String,
    agent_count: i64,
    queued_ceo_task_runs: i64,
}

#[derive(Debug, Serialize)]
pub struct InitializeOnboardingResponse {
    status: OnboardingStatusResponse,
    agents: Vec<OnboardingAgent>,
    overview_page_id: String,
    queued_run_ids: Vec<String>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct OnboardingAgent {
    id: String,
    name: String,
    role: String,
    model: String,
    reasoning_effort: String,
}

#[derive(Debug, Clone, Serialize)]
struct ExtraRole {
    name: String,
    role: String,
    description: String,
}

#[get("/onboarding/status")]
async fn status(pool: &State<DbPool>) -> Result<Json<OnboardingStatusResponse>, Status> {
    onboarding_status(pool.inner()).await.map(Json)
}

#[post("/onboarding/initialize", data = "<payload>")]
async fn initialize(
    pool: &State<DbPool>,
    payload: Json<InitializeOnboardingRequest>,
) -> Result<Json<InitializeOnboardingResponse>, Status> {
    let request = payload.into_inner();

    let project_name = required_text(request.project_name.as_deref().unwrap_or(""), 200)?;
    let project_summary = required_text(request.project_summary.as_deref().unwrap_or(""), 8_000)?;
    let workspace_path = required_text(request.workspace_path.as_deref().unwrap_or(""), 1_024)?;
    if !Path::new(&workspace_path).is_dir() {
        return Err(Status::BadRequest);
    }
    let model = request
        .default_model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("gpt-5.5")
        .to_string();
    let reasoning_effort = request
        .default_reasoning_effort
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("high")
        .to_string();
    if !is_valid_model(&model) || !is_valid_reasoning_effort(&reasoning_effort) {
        return Err(Status::BadRequest);
    }

    let extra_roles = normalize_extra_roles(&request.extra_roles)?;
    let tasks = normalize_tasks(&request.tasks)?;
    if tasks.is_empty() {
        return Err(Status::BadRequest);
    }
    let github_repo = optional_text(request.github_repo.as_deref(), 200)?;
    let codex_binary_path = optional_text(request.codex_binary_path.as_deref(), 1_024)?;
    let codex_home = optional_text(request.codex_home.as_deref(), 1_024)?;
    let initialization_id = Uuid::new_v4().to_string();
    let tasks_json = serde_json::to_string(&tasks).map_err(|_| Status::InternalServerError)?;
    let extra_roles_json =
        serde_json::to_string(&extra_roles).map_err(|_| Status::InternalServerError)?;

    let mut tx = pool
        .inner()
        .begin()
        .await
        .map_err(|_| Status::InternalServerError)?;

    upsert_setting(&mut tx, "project_name", &project_name).await?;
    upsert_setting(&mut tx, "project_summary", &project_summary).await?;
    upsert_setting(&mut tx, "workspace_path", &workspace_path).await?;
    upsert_setting(&mut tx, "default_model", &model).await?;
    upsert_setting(&mut tx, "default_reasoning_effort", &reasoning_effort).await?;
    if let Some(github_repo) = github_repo.as_deref() {
        upsert_setting(&mut tx, "github_repo", github_repo).await?;
    }
    if let Some(codex_binary_path) = codex_binary_path.as_deref() {
        upsert_setting(&mut tx, "codex_binary_path", codex_binary_path).await?;
    }
    if let Some(codex_home) = codex_home.as_deref() {
        upsert_setting(&mut tx, "codex_home", codex_home).await?;
    }

    let mut agent_ids = Vec::new();
    for (name, role, description) in STARTER_ROLES {
        let agent_id = upsert_agent(
            &mut tx,
            name,
            role,
            description,
            &project_summary,
            &model,
            &reasoning_effort,
        )
        .await?;
        ensure_owner_agent_dm(&mut tx, &agent_id, name).await?;
        agent_ids.push(agent_id);
    }
    for extra_role in &extra_roles {
        let agent_id = upsert_agent(
            &mut tx,
            &extra_role.name,
            &extra_role.role,
            &extra_role.description,
            &project_summary,
            &model,
            &reasoning_effort,
        )
        .await?;
        ensure_owner_agent_dm(&mut tx, &agent_id, &extra_role.name).await?;
        agent_ids.push(agent_id);
    }

    let overview_page_id =
        upsert_company_overview(&mut tx, &project_name, &project_summary, &workspace_path).await?;
    sqlx::query(
        r#"
        INSERT INTO onboarding_initializations (
            id,
            workspace_path,
            github_repo,
            project_name,
            overview_page_id,
            requested_tasks_json,
            extra_roles_json
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        "#,
    )
    .bind(&initialization_id)
    .bind(&workspace_path)
    .bind(github_repo.as_deref().unwrap_or(""))
    .bind(&project_name)
    .bind(&overview_page_id)
    .bind(&tasks_json)
    .bind(&extra_roles_json)
    .execute(&mut *tx)
    .await
    .map_err(|_| Status::InternalServerError)?;
    tx.commit().await.map_err(|_| Status::InternalServerError)?;

    let ceo_id = fetch_agent_id(pool.inner(), "ceo").await?;
    let ceo_dm = format!("dm_{ceo_id}");
    let mut queued_run_ids = Vec::new();
    let mut queued_task_runs = Vec::new();
    for task in tasks {
        let prompt = format!(
            "Project name:\n{project_name}\n\nCompany focus:\n{project_summary}\n\nMajor task assigned during onboarding:\n{task}\n\nBreak this down, decide what to do next, and delegate through Agent Adda if useful."
        );
        let queued = queue_agent_run(
            pool.inner(),
            QueueAgentRunInput {
                agent_id: ceo_id.clone(),
                prompt,
                workspace: Some(workspace_path.clone()),
                conversation_id: Some(ceo_dm.clone()),
                trigger_kind: "onboarding-task".to_string(),
                branch: String::new(),
                queue_priority: RUN_PRIORITY_NORMAL,
                queued_by: "onboarding".to_string(),
            },
        )
        .await?;
        let run_id = queued.plan.run_id.clone();
        queued_task_runs.push((task, run_id.clone()));
        queued_run_ids.push(run_id);
    }
    complete_onboarding_initialization(pool.inner(), &initialization_id, &queued_task_runs).await?;

    let status = onboarding_status(pool.inner()).await?;
    let agents = fetch_onboarding_agents(pool.inner(), &agent_ids).await?;
    Ok(Json(InitializeOnboardingResponse {
        status,
        agents,
        overview_page_id,
        queued_run_ids,
    }))
}

async fn onboarding_status(pool: &DbPool) -> Result<OnboardingStatusResponse, Status> {
    let project_name = setting(pool, "project_name", "").await?;
    let project_summary = setting(pool, "project_summary", "").await?;
    let completed_at = setting(pool, "onboarding.completed_at", "").await?;
    let workspace_path = setting(pool, "workspace_path", "").await?;
    let default_model = setting(pool, "default_model", "gpt-5.5").await?;
    let default_reasoning_effort = setting(pool, "default_reasoning_effort", "high").await?;
    let agent_count =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM agents WHERE deleted_at IS NULL")
            .fetch_one(pool)
            .await
            .map_err(|_| Status::InternalServerError)?;
    let queued_ceo_tasks = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT COUNT(*)
        FROM agent_runs r
        JOIN agents a ON a.id = r.agent_id
        WHERE a.slug = 'ceo'
          AND r.trigger_kind = 'onboarding-task'
          AND r.status IN ('queued', 'running')
        "#,
    )
    .fetch_one(pool)
    .await
    .map_err(|_| Status::InternalServerError)?;

    let initialized = !completed_at.trim().is_empty() && !project_summary.trim().is_empty();
    Ok(OnboardingStatusResponse {
        initialized,
        completed: initialized,
        project_name,
        project_summary,
        workspace_path,
        default_model,
        default_reasoning_effort,
        agent_count,
        queued_ceo_task_runs: queued_ceo_tasks,
    })
}

async fn setting(pool: &DbPool, key: &str, default_value: &str) -> Result<String, Status> {
    Ok(
        sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = $1")
            .bind(key)
            .fetch_optional(pool)
            .await
            .map_err(|_| Status::InternalServerError)?
            .unwrap_or_else(|| default_value.to_string()),
    )
}

async fn upsert_setting(
    tx: &mut sqlx::Transaction<'_, crate::db::Db>,
    key: &str,
    value: &str,
) -> Result<(), Status> {
    let value = if key == "onboarding.completed_at" {
        sqlx::query(
            r#"
            INSERT INTO settings (key, value, updated_at)
            VALUES ($1, CURRENT_TIMESTAMP::text, CURRENT_TIMESTAMP::text)
            ON CONFLICT(key) DO UPDATE SET
                value = CURRENT_TIMESTAMP::text,
                updated_at = CURRENT_TIMESTAMP::text
            "#,
        )
        .bind(key)
        .execute(&mut **tx)
        .await
        .map_err(|_| Status::InternalServerError)?;
        return Ok(());
    } else {
        value
    };

    sqlx::query(
        r#"
        INSERT INTO settings (key, value, updated_at)
        VALUES ($1, $2, CURRENT_TIMESTAMP::text)
        ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = CURRENT_TIMESTAMP::text
        "#,
    )
    .bind(key)
    .bind(value)
    .execute(&mut **tx)
    .await
    .map_err(|_| Status::InternalServerError)?;
    Ok(())
}

async fn upsert_agent(
    tx: &mut sqlx::Transaction<'_, crate::db::Db>,
    name: &str,
    role: &str,
    description: &str,
    _project_summary: &str,
    model: &str,
    reasoning_effort: &str,
) -> Result<String, Status> {
    let slug = slugify(name);
    let id = Uuid::new_v4().to_string();
    let profile = format!("{name} is responsible for {description}");
    let system_prompt = default_agent_system_prompt(name, role, description);

    sqlx::query(
        r#"
        INSERT INTO agents (id, name, slug, role, description, profile, system_prompt, model, reasoning_effort, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'idle')
        ON CONFLICT(slug) DO NOTHING
        "#,
    )
    .bind(&id)
    .bind(name)
    .bind(&slug)
    .bind(role)
    .bind(description)
    .bind(&profile)
    .bind(&system_prompt)
    .bind(model)
    .bind(reasoning_effort)
    .execute(&mut **tx)
    .await
    .map_err(|_| Status::InternalServerError)?;

    sqlx::query_scalar::<_, String>("SELECT id FROM agents WHERE slug = $1 AND deleted_at IS NULL")
        .bind(&slug)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|_| Status::InternalServerError)?
        .ok_or(Status::Conflict)
}

async fn ensure_owner_agent_dm(
    tx: &mut sqlx::Transaction<'_, crate::db::Db>,
    agent_id: &str,
    agent_name: &str,
) -> Result<(), Status> {
    let conversation_id = format!("dm_{agent_id}");
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
    .bind(agent_name)
    .bind(format!("Direct message with {agent_name}"))
    .execute(&mut **tx)
    .await
    .map_err(|_| Status::InternalServerError)?;
    for (kind, member_id) in [("human", "owner"), ("agent", agent_id)] {
        sqlx::query(
            "INSERT INTO conversation_members (conversation_id, member_kind, member_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        )
        .bind(&conversation_id)
        .bind(kind)
        .bind(member_id)
        .execute(&mut **tx)
        .await
        .map_err(|_| Status::InternalServerError)?;
    }
    sqlx::query(
        r#"
        INSERT INTO agent_threads (agent_id, conversation_id, updated_at)
        VALUES ($1, $2, CURRENT_TIMESTAMP::text)
        ON CONFLICT(agent_id) DO UPDATE SET
            conversation_id = excluded.conversation_id,
            updated_at = CURRENT_TIMESTAMP::text
        "#,
    )
    .bind(agent_id)
    .bind(&conversation_id)
    .execute(&mut **tx)
    .await
    .map_err(|_| Status::InternalServerError)?;
    Ok(())
}

async fn upsert_company_overview(
    tx: &mut sqlx::Transaction<'_, crate::db::Db>,
    project_name: &str,
    project_summary: &str,
    workspace_path: &str,
) -> Result<String, Status> {
    let body = format!(
        "# {project_name}\n\n## Main Focus\n\n{project_summary}\n\n## Workspace\n\n`{workspace_path}`\n\n## Operating Notes\n\n- Agents coordinate through DMs and channels.\n- Durable project knowledge belongs in the wiki.\n- The CEO owns initial task triage and delegation.\n"
    );
    let page_id = sqlx::query_scalar::<_, String>(
        "SELECT id FROM wiki_pages WHERE slug = $1 AND archived_at IS NULL",
    )
    .bind(COMPANY_OVERVIEW_SLUG)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| Status::InternalServerError)?
    .unwrap_or_else(|| Uuid::new_v4().to_string());
    let exists = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM wiki_pages WHERE id = $1")
        .bind(&page_id)
        .fetch_one(&mut **tx)
        .await
        .map_err(|_| Status::InternalServerError)?
        > 0;

    if exists {
        sqlx::query(
            r#"
            UPDATE wiki_pages
            SET title = $1,
                body_markdown = $2,
                updated_by = 'onboarding',
                updated_at = CURRENT_TIMESTAMP::text
            WHERE id = $3
            "#,
        )
        .bind(COMPANY_OVERVIEW_TITLE)
        .bind(&body)
        .bind(&page_id)
        .execute(&mut **tx)
        .await
        .map_err(|_| Status::InternalServerError)?;
    } else {
        sqlx::query(
            r#"
            INSERT INTO wiki_pages (id, space_id, slug, title, body_markdown, created_by, updated_by)
            VALUES ($1, $2, $3, $4, $5, 'onboarding', 'onboarding')
            "#,
        )
        .bind(&page_id)
        .bind(PROJECT_MEMORY_SPACE_ID)
        .bind(COMPANY_OVERVIEW_SLUG)
        .bind(COMPANY_OVERVIEW_TITLE)
        .bind(&body)
        .execute(&mut **tx)
        .await
        .map_err(|_| Status::InternalServerError)?;
    }

    sqlx::query(
        "INSERT INTO wiki_revisions (id, page_id, body_markdown, author_kind, author_id, change_summary) VALUES ($1, $2, $3, 'system', 'onboarding', 'Updated company overview from onboarding')",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(&page_id)
    .bind(&body)
    .execute(&mut **tx)
    .await
    .map_err(|_| Status::InternalServerError)?;

    sqlx::query("DELETE FROM search_index WHERE entity_type = 'wiki_page' AND entity_id = $1")
        .bind(&page_id)
        .execute(&mut **tx)
        .await
        .map_err(|_| Status::InternalServerError)?;
    sqlx::query(
        r#"
        INSERT INTO search_index (entity_type, entity_id, title, body)
        VALUES ('wiki_page', $1, $2, $3)
        ON CONFLICT (entity_type, entity_id) DO UPDATE SET
            title = excluded.title,
            body = excluded.body
        "#,
    )
    .bind(&page_id)
    .bind(COMPANY_OVERVIEW_TITLE)
    .bind(&body)
    .execute(&mut **tx)
    .await
    .map_err(|_| Status::InternalServerError)?;

    Ok(page_id)
}

async fn fetch_agent_id(pool: &DbPool, slug: &str) -> Result<String, Status> {
    sqlx::query_scalar::<_, String>("SELECT id FROM agents WHERE slug = $1 AND deleted_at IS NULL")
        .bind(slug)
        .fetch_one(pool)
        .await
        .map_err(|_| Status::InternalServerError)
}

async fn fetch_onboarding_agents(
    pool: &DbPool,
    agent_ids: &[String],
) -> Result<Vec<OnboardingAgent>, Status> {
    let mut agents = Vec::with_capacity(agent_ids.len());
    for agent_id in agent_ids {
        if let Some(agent) = sqlx::query_as::<_, OnboardingAgent>(
            "SELECT id, name, role, model, reasoning_effort FROM agents WHERE id = $1",
        )
        .bind(agent_id)
        .fetch_optional(pool)
        .await
        .map_err(|_| Status::InternalServerError)?
        {
            agents.push(agent);
        }
    }
    Ok(agents)
}

async fn complete_onboarding_initialization(
    pool: &DbPool,
    initialization_id: &str,
    task_runs: &[(String, String)],
) -> Result<(), Status> {
    let mut tx = pool
        .begin()
        .await
        .map_err(|_| Status::InternalServerError)?;
    for (task, run_id) in task_runs {
        sqlx::query(
            r#"
            INSERT INTO onboarding_task_runs (id, initialization_id, task, run_id)
            VALUES ($1, $2, $3, $4)
            "#,
        )
        .bind(Uuid::new_v4().to_string())
        .bind(initialization_id)
        .bind(task)
        .bind(run_id)
        .execute(&mut *tx)
        .await
        .map_err(|_| Status::InternalServerError)?;
    }
    upsert_setting(&mut tx, "onboarding.completed_at", "now").await?;
    tx.commit().await.map_err(|_| Status::InternalServerError)?;
    Ok(())
}

fn normalize_tasks(tasks: &[String]) -> Result<Vec<String>, Status> {
    if tasks.len() > 50 {
        return Err(Status::BadRequest);
    }

    let mut out = Vec::new();
    for value in tasks {
        let value = required_text(value, 2_000)?;
        if !out.iter().any(|existing| existing == &value) {
            out.push(value);
        }
    }
    Ok(out)
}

fn normalize_extra_roles(values: &[OnboardingExtraRoleRequest]) -> Result<Vec<ExtraRole>, Status> {
    if values.len() > 24 {
        return Err(Status::BadRequest);
    }

    let mut out = Vec::new();
    for value in values {
        let role = normalize_extra_role(value)?;
        let slug = slugify(&role.name);
        let is_starter = STARTER_ROLES
            .iter()
            .any(|(name, _, _)| slugify(name) == slug);
        if is_starter
            || out
                .iter()
                .any(|existing: &ExtraRole| slugify(&existing.name) == slug)
        {
            continue;
        }
        out.push(role);
    }
    Ok(out)
}

fn normalize_extra_role(value: &OnboardingExtraRoleRequest) -> Result<ExtraRole, Status> {
    let name = required_text(&value.name, 80)?;
    let role = value
        .role
        .as_deref()
        .map(|value| required_text(value, 80))
        .transpose()?
        .unwrap_or_else(|| name.clone());
    let description = optional_text(value.description.as_deref(), 400)?
        .unwrap_or_else(|| format!("{role} for this company focus."));
    Ok(ExtraRole {
        name,
        role,
        description,
    })
}

fn required_text(value: &str, max_len: usize) -> Result<String, Status> {
    let value = value.trim();
    if value.is_empty() || value.len() > max_len {
        Err(Status::BadRequest)
    } else {
        Ok(value.to_string())
    }
}

fn optional_text(value: Option<&str>, max_len: usize) -> Result<Option<String>, Status> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > max_len {
        return Err(Status::BadRequest);
    }
    Ok(Some(value.to_string()))
}

fn is_valid_model(value: &str) -> bool {
    value.starts_with("gpt-")
        && value.len() <= 64
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
}

fn is_valid_reasoning_effort(value: &str) -> bool {
    is_known_reasoning_effort(value)
}

pub fn routes() -> Vec<rocket::Route> {
    routes![status, initialize]
}
