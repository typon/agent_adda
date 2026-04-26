use crate::agent_communications::build_agent_task_prompt;
use crate::codex::{CodexCommandPlan, CodexRunRequest};
use crate::db::{Db, DbPool};
use crate::orchestrator::{AgentRunPlan, plan_agent_run_with_summary};
use crate::runtime::{RunSupervisor, StartQueuedRunResult, start_queued_run_by_id};
use rocket::State;
use rocket::http::Status;
use rocket::serde::json::Json;
use rocket::{Route, get, post, routes};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, Transaction};
use std::path::PathBuf;
use uuid::Uuid;

const DEFAULT_RUN_LIMIT: i64 = 50;
const MAX_RUN_LIMIT: i64 = 200;
const DEFAULT_EVENT_LIMIT: i64 = 200;
const MAX_EVENT_LIMIT: i64 = 1_000;
const MAX_TRIGGER_KIND_BYTES: usize = 64;
const MAX_BRANCH_BYTES: usize = 160;
const MAX_SUMMARY_BYTES: usize = 4_000;
pub(crate) const RUN_PRIORITY_URGENT: i64 = 0;
pub(crate) const RUN_PRIORITY_NORMAL: i64 = 100;

#[derive(Debug, Deserialize)]
struct QueueRunRequest {
    prompt: String,
    workspace: Option<String>,
    conversation_id: Option<String>,
    trigger_kind: Option<String>,
    queue_action: Option<String>,
    branch: Option<String>,
}

pub(crate) struct QueueAgentRunInput {
    pub agent_id: String,
    pub prompt: String,
    pub workspace: Option<String>,
    pub conversation_id: Option<String>,
    pub trigger_kind: String,
    pub branch: String,
    pub queue_priority: i64,
    pub queued_by: String,
}

#[derive(Debug, Deserialize)]
struct CompleteRunRequest {
    summary: Option<String>,
    payload: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct FailRunRequest {
    error: String,
    payload: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct CancelRunRequest {
    reason: Option<String>,
    payload: Option<Value>,
}

#[derive(Debug, Serialize)]
struct QueueRunResponse {
    run: RunResponse,
    plan: AgentRunPlan,
    request: CodexRunRequest,
    command: CodexCommandPlan,
    queue_action: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct RunResponse {
    pub(crate) id: String,
    pub(crate) agent_id: String,
    pub(crate) agent_name: String,
    pub(crate) conversation_id: Option<String>,
    pub(crate) status: String,
    pub(crate) trigger_kind: String,
    pub(crate) prompt_hash: String,
    pub(crate) prompt_summary: String,
    pub(crate) summary: String,
    pub(crate) model: String,
    pub(crate) reasoning_effort: String,
    pub(crate) branch: String,
    pub(crate) workspace: String,
    pub(crate) command: Value,
    pub(crate) queue_priority: i64,
    pub(crate) queued_by: String,
    pub(crate) started_at: Option<String>,
    pub(crate) ended_at: Option<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) event_count: i64,
}

#[derive(Debug, Serialize)]
struct RunEventResponse {
    id: String,
    run_id: String,
    event_type: String,
    payload: Value,
    created_at: String,
}

#[derive(Debug, FromRow)]
struct RunRow {
    id: String,
    agent_id: String,
    agent_name: String,
    conversation_id: Option<String>,
    status: String,
    trigger_kind: String,
    prompt_hash: String,
    prompt_summary: String,
    summary: String,
    model: String,
    reasoning_effort: String,
    branch: String,
    workspace: String,
    command_json: String,
    queue_priority: i32,
    queued_by: String,
    started_at: Option<String>,
    ended_at: Option<String>,
    created_at: String,
    updated_at: String,
    event_count: i64,
}

#[derive(Debug, FromRow)]
struct RunEventRow {
    id: String,
    run_id: String,
    event_type: String,
    payload_json: String,
    created_at: String,
}

#[derive(Debug, FromRow)]
struct TransitionRow {
    agent_id: String,
    status: String,
    command_json: String,
}

#[get("/runs?<agent_id>&<status>&<conversation_id>&<limit>")]
async fn list(
    pool: &State<DbPool>,
    agent_id: Option<String>,
    status: Option<String>,
    conversation_id: Option<String>,
    limit: Option<i64>,
) -> Result<Json<Vec<RunResponse>>, Status> {
    if let Some(status) = status.as_deref() {
        if !is_run_status(status) {
            return Err(Status::BadRequest);
        }
    }

    let limit = clamp_limit(limit);
    let runs = sqlx::query_as::<_, RunRow>(
        r#"
        SELECT r.id,
               r.agent_id,
               COALESCE(a.name, 'Unknown agent') AS agent_name,
               r.conversation_id,
               r.status,
               r.trigger_kind,
               r.prompt_hash,
               r.prompt_summary,
               r.summary,
               r.model,
               r.reasoning_effort,
	               r.branch,
	               r.workspace,
	               r.command_json,
	               r.queue_priority,
	               r.queued_by,
	               r.started_at,
               r.ended_at,
               r.created_at,
               r.updated_at,
               COALESCE(events.event_count, 0) AS event_count
        FROM agent_runs r
        LEFT JOIN agents a ON a.id = r.agent_id
        LEFT JOIN (
            SELECT run_id, COUNT(*) AS event_count
            FROM run_events
            GROUP BY run_id
        ) events ON events.run_id = r.id
        WHERE ($1 IS NULL OR r.agent_id = $2)
          AND ($3 IS NULL OR r.status = $4)
          AND ($5 IS NULL OR r.conversation_id = $6)
        ORDER BY r.created_at::timestamptz DESC, r.id DESC
        LIMIT $7
        "#,
    )
    .bind(agent_id.as_deref())
    .bind(agent_id.as_deref())
    .bind(status.as_deref())
    .bind(status.as_deref())
    .bind(conversation_id.as_deref())
    .bind(conversation_id.as_deref())
    .bind(limit)
    .fetch_all(pool.inner())
    .await
    .map_err(|_| Status::InternalServerError)?;

    Ok(Json(runs.into_iter().map(run_response).collect()))
}

#[get("/runs/<id>")]
async fn get_run(pool: &State<DbPool>, id: &str) -> Result<Json<RunResponse>, Status> {
    fetch_run(pool.inner(), id).await.map(Json)
}

#[get("/runs/<id>/events?<limit>")]
async fn events(
    pool: &State<DbPool>,
    id: &str,
    limit: Option<i64>,
) -> Result<Json<Vec<RunEventResponse>>, Status> {
    if !run_exists(pool.inner(), id).await? {
        return Err(Status::NotFound);
    }

    let limit = clamp_event_limit(limit);
    let mut events = sqlx::query_as::<_, RunEventRow>(
        r#"
        SELECT id, run_id, event_type, payload_json, created_at
        FROM run_events
        WHERE run_id = $1
        ORDER BY created_at::timestamptz DESC, id DESC
        LIMIT $2
        "#,
    )
    .bind(id)
    .bind(limit)
    .fetch_all(pool.inner())
    .await
    .map_err(|_| Status::InternalServerError)?;
    events.reverse();

    Ok(Json(events.into_iter().map(run_event_response).collect()))
}

#[post("/agents/<agent_id>/runs", data = "<payload>")]
async fn queue(
    pool: &State<DbPool>,
    supervisor: &State<RunSupervisor>,
    agent_id: &str,
    payload: Json<QueueRunRequest>,
) -> Result<Json<QueueRunResponse>, Status> {
    let has_queue_action = payload
        .queue_action
        .as_deref()
        .map(str::trim)
        .is_some_and(|value| !value.is_empty());
    let queue_action = queue_action(payload.queue_action.as_deref())?;
    let trigger_kind = optional_text(payload.trigger_kind.as_deref(), MAX_TRIGGER_KIND_BYTES)?
        .unwrap_or_else(|| {
            if !has_queue_action {
                "manual".to_string()
            } else if queue_action == "urgent" {
                "enter".to_string()
            } else {
                "tab".to_string()
            }
        });
    let branch = optional_text(payload.branch.as_deref(), MAX_BRANCH_BYTES)?.unwrap_or_default();
    let queue_priority = if queue_action == "urgent" {
        RUN_PRIORITY_URGENT
    } else {
        RUN_PRIORITY_NORMAL
    };
    let queued = queue_agent_run(
        pool.inner(),
        QueueAgentRunInput {
            agent_id: agent_id.to_string(),
            prompt: payload.prompt.clone(),
            workspace: payload.workspace.clone(),
            conversation_id: payload.conversation_id.clone(),
            trigger_kind,
            branch,
            queue_priority,
            queued_by: "owner".to_string(),
        },
    )
    .await?;
    supervisor.wake();

    Ok(Json(QueueRunResponse {
        run: queued.run,
        plan: queued.plan,
        request: queued.request,
        command: queued.command,
        queue_action,
    }))
}

pub(crate) struct QueuedAgentRun {
    pub run: RunResponse,
    pub plan: AgentRunPlan,
    pub request: CodexRunRequest,
    pub command: CodexCommandPlan,
}

pub(crate) async fn queue_agent_run(
    pool: &DbPool,
    input: QueueAgentRunInput,
) -> Result<QueuedAgentRun, Status> {
    let prompt = required_text(&input.prompt, usize::MAX)?;
    let trigger_kind = required_text(&input.trigger_kind, MAX_TRIGGER_KIND_BYTES)?;
    let branch = optional_text(Some(input.branch.as_str()), MAX_BRANCH_BYTES)?.unwrap_or_default();
    let queued_by =
        optional_text(Some(input.queued_by.as_str()), 80)?.unwrap_or_else(|| "owner".to_string());

    let Some((model, reasoning_effort)) = sqlx::query_as::<_, (String, String)>(
        "SELECT model, reasoning_effort FROM agents WHERE id = $1 AND deleted_at IS NULL",
    )
    .bind(&input.agent_id)
    .fetch_optional(pool)
    .await
    .map_err(|_| Status::InternalServerError)?
    else {
        return Err(Status::NotFound);
    };

    let conversation_id = optional_text(input.conversation_id.as_deref(), usize::MAX)?;
    if let Some(conversation_id) = conversation_id.as_deref() {
        if !conversation_exists(pool, conversation_id).await? {
            return Err(Status::NotFound);
        }
    }

    let workspace = resolve_workspace(pool, input.workspace.as_deref()).await?;
    let runtime_prompt =
        build_agent_task_prompt(pool, &input.agent_id, conversation_id.as_deref(), &prompt)
            .await
            .map_err(|_| Status::InternalServerError)?;
    let (mut plan, request) = plan_agent_run_with_summary(
        &input.agent_id,
        workspace.clone(),
        runtime_prompt,
        &prompt,
        model,
        reasoning_effort,
    );
    plan.status = "queued".to_string();

    let codex_bin = resolve_codex_bin(pool).await?;
    let command = codex_command_for_agent(pool, &input.agent_id, &request, &codex_bin).await?;
    let command_payload = command_preview(&command, &plan.prompt_hash);
    let command_json = to_json_string(&command_payload)?;
    let workspace_text = workspace.to_string_lossy().into_owned();
    let event_payload = json!({
        "status": "queued",
        "agent_id": &input.agent_id,
        "conversation_id": &conversation_id,
        "trigger_kind": &trigger_kind,
        "branch": &branch,
        "workspace": &workspace_text,
        "model": &plan.model,
        "reasoning_effort": &plan.reasoning_effort,
        "prompt_hash": &plan.prompt_hash,
        "prompt_summary": &plan.prompt_summary,
        "queue_priority": input.queue_priority,
        "queued_by": &queued_by,
        "command": command_payload
    });
    let event_payload_json = to_json_string(&event_payload)?;
    let event_id = Uuid::new_v4().to_string();

    let mut tx = pool
        .begin()
        .await
        .map_err(|_| Status::InternalServerError)?;

    sqlx::query(
        r#"
        INSERT INTO agent_runs (
            id,
            agent_id,
            conversation_id,
            status,
            trigger_kind,
            prompt,
            prompt_hash,
            prompt_summary,
            summary,
            model,
            reasoning_effort,
            branch,
            workspace,
            command_json,
            queue_priority,
            queued_by,
            created_at,
            updated_at
        )
        VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7, '', $8, $9, $10, $11, $12, $13, $14, CURRENT_TIMESTAMP::text, CURRENT_TIMESTAMP::text)
        "#,
    )
    .bind(&plan.run_id)
    .bind(&input.agent_id)
    .bind(conversation_id.as_deref())
    .bind(&trigger_kind)
    .bind(&request.prompt)
    .bind(&plan.prompt_hash)
    .bind(&plan.prompt_summary)
    .bind(&plan.model)
    .bind(&plan.reasoning_effort)
    .bind(&branch)
    .bind(&workspace_text)
    .bind(&command_json)
    .bind(input.queue_priority)
    .bind(&queued_by)
    .execute(&mut *tx)
    .await
    .map_err(database_write_status)?;

    sqlx::query(
        r#"
        INSERT INTO run_events (id, run_id, event_type, payload_json)
        VALUES ($1, $2, 'run.queued', $3)
        "#,
    )
    .bind(&event_id)
    .bind(&plan.run_id)
    .bind(&event_payload_json)
    .execute(&mut *tx)
    .await
    .map_err(database_write_status)?;

    sync_agent_runtime_status_in_tx(&mut tx, &input.agent_id)
        .await
        .map_err(database_write_status)?;

    tx.commit().await.map_err(|_| Status::InternalServerError)?;

    let run = fetch_run(pool, &plan.run_id).await?;
    Ok(QueuedAgentRun {
        run,
        plan,
        request,
        command,
    })
}

#[post("/runs/<id>/start")]
async fn start(
    pool: &State<DbPool>,
    supervisor: &State<RunSupervisor>,
    id: &str,
) -> Result<Json<RunResponse>, Status> {
    match start_queued_run_by_id(pool.inner().clone(), supervisor.inner().clone(), id)
        .await
        .map_err(|_| Status::InternalServerError)?
    {
        StartQueuedRunResult::Started => fetch_run(pool.inner(), id).await.map(Json),
        StartQueuedRunResult::AtCapacity => Err(Status::Conflict),
        StartQueuedRunResult::NotQueued => {
            let _ = fetch_run(pool.inner(), id).await?;
            Err(Status::Conflict)
        }
    }
}

#[post("/runs/<id>/complete", data = "<payload>")]
async fn complete(
    pool: &State<DbPool>,
    id: &str,
    payload: Json<CompleteRunRequest>,
) -> Result<Json<RunResponse>, Status> {
    let summary = optional_text(payload.summary.as_deref(), MAX_SUMMARY_BYTES)?;
    let detail = json!({
        "summary": &summary,
        "payload": &payload.payload
    });
    transition_run(
        pool.inner(),
        id,
        &["running"],
        "completed",
        summary.as_deref(),
        "run.completed",
        detail,
    )
    .await
    .map(Json)
}

#[post("/runs/<id>/fail", data = "<payload>")]
async fn fail(
    pool: &State<DbPool>,
    id: &str,
    payload: Json<FailRunRequest>,
) -> Result<Json<RunResponse>, Status> {
    let error = required_text(&payload.error, MAX_SUMMARY_BYTES)?;
    let detail = json!({
        "error": &error,
        "payload": &payload.payload
    });
    transition_run(
        pool.inner(),
        id,
        &["queued", "running"],
        "failed",
        Some(&error),
        "run.failed",
        detail,
    )
    .await
    .map(Json)
}

#[post("/runs/<id>/cancel", data = "<payload>")]
async fn cancel(
    pool: &State<DbPool>,
    supervisor: &State<RunSupervisor>,
    id: &str,
    payload: Json<CancelRunRequest>,
) -> Result<Json<RunResponse>, Status> {
    let reason = optional_text(payload.reason.as_deref(), MAX_SUMMARY_BYTES)?
        .unwrap_or_else(|| "canceled".to_string());
    stop_or_cancel_run(
        pool.inner(),
        supervisor.inner(),
        id,
        &reason,
        &payload.payload,
    )
    .await
    .map(Json)
}

#[post("/runs/<id>/stop", data = "<payload>")]
async fn stop(
    pool: &State<DbPool>,
    supervisor: &State<RunSupervisor>,
    id: &str,
    payload: Json<CancelRunRequest>,
) -> Result<Json<RunResponse>, Status> {
    let reason = optional_text(payload.reason.as_deref(), MAX_SUMMARY_BYTES)?
        .unwrap_or_else(|| "stopped by owner".to_string());
    stop_or_cancel_run(
        pool.inner(),
        supervisor.inner(),
        id,
        &reason,
        &payload.payload,
    )
    .await
    .map(Json)
}

pub(crate) async fn stop_or_cancel_run(
    pool: &DbPool,
    supervisor: &RunSupervisor,
    run_id: &str,
    reason: &str,
    payload: &Option<Value>,
) -> Result<RunResponse, Status> {
    let Some(row) = sqlx::query_as::<_, TransitionRow>(
        "SELECT agent_id, status, command_json FROM agent_runs WHERE id = $1",
    )
    .bind(run_id)
    .fetch_optional(pool)
    .await
    .map_err(|_| Status::InternalServerError)?
    else {
        return Err(Status::NotFound);
    };

    if row.status == "queued" {
        return transition_run(
            pool,
            run_id,
            &["queued"],
            "canceled",
            Some(reason),
            "run.canceled",
            json!({
                "reason": reason,
                "payload": payload
            }),
        )
        .await;
    }

    if row.status != "running" {
        return Err(Status::Conflict);
    }

    if !supervisor.is_run_active(run_id) {
        return transition_run(
            pool,
            run_id,
            &["running"],
            "canceled",
            Some(reason),
            "run.canceled",
            json!({
                "reason": reason,
                "payload": payload,
                "stale_running": true
            }),
        )
        .await;
    }

    supervisor.request_stop(run_id, reason);
    insert_run_event(
        pool,
        run_id,
        "run.stop_requested",
        json!({
            "status": row.status,
            "reason": reason,
            "payload": payload,
            "command": parse_json(&row.command_json)
        }),
    )
    .await?;

    fetch_run(pool, run_id).await
}

async fn transition_run(
    pool: &DbPool,
    run_id: &str,
    allowed_statuses: &[&str],
    next_status: &str,
    summary: Option<&str>,
    event_type: &str,
    detail: Value,
) -> Result<RunResponse, Status> {
    let mut tx = pool
        .begin()
        .await
        .map_err(|_| Status::InternalServerError)?;

    let Some(row) = sqlx::query_as::<_, TransitionRow>(
        "SELECT agent_id, status, command_json FROM agent_runs WHERE id = $1",
    )
    .bind(run_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|_| Status::InternalServerError)?
    else {
        return Err(Status::NotFound);
    };

    if !allowed_statuses.iter().any(|status| *status == row.status) {
        return Err(Status::Conflict);
    }

    sqlx::query(
        r#"
        UPDATE agent_runs
        SET status = $1,
            summary = COALESCE($2, summary),
            ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP::text),
            updated_at = CURRENT_TIMESTAMP::text
        WHERE id = $3
        "#,
    )
    .bind(next_status)
    .bind(summary)
    .bind(run_id)
    .execute(&mut *tx)
    .await
    .map_err(database_write_status)?;

    if is_terminal_run_status(next_status) {
        sqlx::query(
            r#"
            UPDATE agent_threads
            SET active_run_id = NULL,
                updated_at = CURRENT_TIMESTAMP::text
            WHERE agent_id = $1
              AND active_run_id = $2
            "#,
        )
        .bind(&row.agent_id)
        .bind(run_id)
        .execute(&mut *tx)
        .await
        .map_err(database_write_status)?;
    }

    let event_payload = json!({
        "from_status": row.status,
        "to_status": next_status,
        "command": parse_json(&row.command_json),
        "detail": detail
    });
    let event_payload_json = to_json_string(&event_payload)?;
    let event_id = Uuid::new_v4().to_string();
    sqlx::query(
        r#"
        INSERT INTO run_events (id, run_id, event_type, payload_json)
        VALUES ($1, $2, $3, $4)
        "#,
    )
    .bind(event_id)
    .bind(run_id)
    .bind(event_type)
    .bind(event_payload_json)
    .execute(&mut *tx)
    .await
    .map_err(database_write_status)?;

    sync_agent_runtime_status_in_tx(&mut tx, &row.agent_id)
        .await
        .map_err(database_write_status)?;

    tx.commit().await.map_err(|_| Status::InternalServerError)?;

    fetch_run(pool, run_id).await
}

fn is_terminal_run_status(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "canceled")
}

async fn sync_agent_runtime_status_in_tx(
    tx: &mut Transaction<'_, Db>,
    agent_id: &str,
) -> Result<(), sqlx::Error> {
    let running = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM agent_runs WHERE agent_id = $1 AND status = 'running'",
    )
    .bind(agent_id)
    .fetch_one(&mut **tx)
    .await?;

    if running > 0 {
        sqlx::query(
            "UPDATE agents SET status = 'working', updated_at = CURRENT_TIMESTAMP::text WHERE id = $1",
        )
        .bind(agent_id)
        .execute(&mut **tx)
        .await?;
        return Ok(());
    }

    let queued = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM agent_runs WHERE agent_id = $1 AND status = 'queued'",
    )
    .bind(agent_id)
    .fetch_one(&mut **tx)
    .await?;

    if queued > 0 {
        sqlx::query(
            "UPDATE agents SET status = 'pending', updated_at = CURRENT_TIMESTAMP::text WHERE id = $1",
        )
        .bind(agent_id)
        .execute(&mut **tx)
        .await?;
        return Ok(());
    }

    sqlx::query(
        "UPDATE agents SET status = 'idle', updated_at = CURRENT_TIMESTAMP::text WHERE id = $1 AND status IN ('working', 'pending')",
    )
    .bind(agent_id)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

async fn insert_run_event(
    pool: &DbPool,
    run_id: &str,
    event_type: &str,
    payload: Value,
) -> Result<(), Status> {
    let payload_json = to_json_string(&payload)?;
    sqlx::query(
        r#"
        INSERT INTO run_events (id, run_id, event_type, payload_json)
        VALUES ($1, $2, $3, $4)
        "#,
    )
    .bind(Uuid::new_v4().to_string())
    .bind(run_id)
    .bind(event_type)
    .bind(payload_json)
    .execute(pool)
    .await
    .map_err(database_write_status)?;

    Ok(())
}

async fn fetch_run(pool: &DbPool, id: &str) -> Result<RunResponse, Status> {
    sqlx::query_as::<_, RunRow>(
        r#"
        SELECT r.id,
               r.agent_id,
               COALESCE(a.name, 'Unknown agent') AS agent_name,
               r.conversation_id,
               r.status,
               r.trigger_kind,
               r.prompt_hash,
               r.prompt_summary,
               r.summary,
               r.model,
               r.reasoning_effort,
	               r.branch,
	               r.workspace,
	               r.command_json,
	               r.queue_priority,
	               r.queued_by,
	               r.started_at,
               r.ended_at,
               r.created_at,
               r.updated_at,
               COALESCE(events.event_count, 0) AS event_count
        FROM agent_runs r
        LEFT JOIN agents a ON a.id = r.agent_id
        LEFT JOIN (
            SELECT run_id, COUNT(*) AS event_count
            FROM run_events
            GROUP BY run_id
        ) events ON events.run_id = r.id
        WHERE r.id = $1
        "#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(|_| Status::InternalServerError)?
    .map(run_response)
    .ok_or(Status::NotFound)
}

async fn run_exists(pool: &DbPool, id: &str) -> Result<bool, Status> {
    let count = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM agent_runs WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .map_err(|_| Status::InternalServerError)?;

    Ok(count > 0)
}

async fn resolve_workspace(
    pool: &DbPool,
    requested_workspace: Option<&str>,
) -> Result<PathBuf, Status> {
    if let Some(workspace) = requested_workspace {
        return required_path(workspace);
    }

    let Some(workspace) =
        sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = 'workspace_path'")
            .fetch_optional(pool)
            .await
            .map_err(|_| Status::InternalServerError)?
    else {
        return Err(Status::BadRequest);
    };

    required_path(&workspace)
}

async fn resolve_codex_bin(pool: &DbPool) -> Result<String, Status> {
    let value = sqlx::query_scalar::<_, String>(
        "SELECT value FROM settings WHERE key = 'codex_binary_path'",
    )
    .fetch_optional(pool)
    .await
    .map_err(|_| Status::InternalServerError)?;
    Ok(value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "codex".to_string()))
}

pub(crate) async fn codex_command_for_agent(
    pool: &DbPool,
    agent_id: &str,
    request: &CodexRunRequest,
    codex_bin: &str,
) -> Result<CodexCommandPlan, Status> {
    if let Some(session_id) = agent_codex_session_id(pool, agent_id).await? {
        return Ok(request.resume_command_plan(codex_bin, &session_id));
    }

    Ok(request.command_plan(codex_bin))
}

async fn agent_codex_session_id(pool: &DbPool, agent_id: &str) -> Result<Option<String>, Status> {
    let value = sqlx::query_scalar::<_, String>(
        "SELECT codex_session_id FROM agent_threads WHERE agent_id = $1",
    )
    .bind(agent_id)
    .fetch_optional(pool)
    .await
    .map_err(|_| Status::InternalServerError)?;

    Ok(value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty()))
}

async fn conversation_exists(pool: &DbPool, conversation_id: &str) -> Result<bool, Status> {
    let count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM conversations WHERE id = $1 AND archived_at IS NULL",
    )
    .bind(conversation_id)
    .fetch_one(pool)
    .await
    .map_err(|_| Status::InternalServerError)?;

    Ok(count > 0)
}

fn run_response(row: RunRow) -> RunResponse {
    RunResponse {
        id: row.id,
        agent_id: row.agent_id,
        agent_name: row.agent_name,
        conversation_id: row.conversation_id,
        status: row.status,
        trigger_kind: row.trigger_kind,
        prompt_hash: row.prompt_hash,
        prompt_summary: row.prompt_summary,
        summary: row.summary,
        model: row.model,
        reasoning_effort: row.reasoning_effort,
        branch: row.branch,
        workspace: row.workspace,
        command: parse_json(&row.command_json),
        queue_priority: i64::from(row.queue_priority),
        queued_by: row.queued_by,
        started_at: row.started_at,
        ended_at: row.ended_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
        event_count: row.event_count,
    }
}

fn run_event_response(row: RunEventRow) -> RunEventResponse {
    RunEventResponse {
        id: row.id,
        run_id: row.run_id,
        event_type: row.event_type,
        payload: parse_json(&row.payload_json),
        created_at: row.created_at,
    }
}

fn command_preview(command: &CodexCommandPlan, prompt_hash: &str) -> Value {
    json!({
        "program": &command.program,
        "args": &command.args,
        "stdin_bytes": command.stdin.len(),
        "stdin_hash": prompt_hash
    })
}

fn parse_json(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap_or_else(|_| {
        json!({
            "raw": raw
        })
    })
}

fn to_json_string(value: &Value) -> Result<String, Status> {
    serde_json::to_string(value).map_err(|_| Status::InternalServerError)
}

fn required_path(value: &str) -> Result<PathBuf, Status> {
    let value = value.trim();
    if value.is_empty() {
        Err(Status::BadRequest)
    } else {
        Ok(PathBuf::from(value))
    }
}

fn required_text(value: &str, max_bytes: usize) -> Result<String, Status> {
    let value = value.trim();
    if value.is_empty() || value.len() > max_bytes {
        Err(Status::BadRequest)
    } else {
        Ok(value.to_string())
    }
}

fn optional_text(value: Option<&str>, max_bytes: usize) -> Result<Option<String>, Status> {
    let Some(value) = value else {
        return Ok(None);
    };

    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > max_bytes {
        return Err(Status::BadRequest);
    }

    Ok(Some(value.to_string()))
}

fn queue_action(action: Option<&str>) -> Result<String, Status> {
    let value = action
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("queued");
    match value {
        "queued" | "urgent" => Ok(value.to_string()),
        _ => Err(Status::BadRequest),
    }
}

fn clamp_limit(limit: Option<i64>) -> i64 {
    match limit {
        Some(value) if value > 0 => value.min(MAX_RUN_LIMIT),
        _ => DEFAULT_RUN_LIMIT,
    }
}

fn clamp_event_limit(limit: Option<i64>) -> i64 {
    match limit {
        Some(value) if value > 0 => value.min(MAX_EVENT_LIMIT),
        _ => DEFAULT_EVENT_LIMIT,
    }
}

fn is_run_status(status: &str) -> bool {
    matches!(
        status,
        "queued" | "running" | "completed" | "failed" | "canceled"
    )
}

fn database_write_status(error: sqlx::Error) -> Status {
    if error.as_database_error().is_some_and(|database_error| {
        database_error.is_unique_violation()
            || database_error.is_foreign_key_violation()
            || database_error.is_check_violation()
    }) {
        Status::Conflict
    } else {
        Status::InternalServerError
    }
}

pub fn routes() -> Vec<Route> {
    routes![
        list, get_run, events, queue, start, complete, fail, cancel, stop
    ]
}

#[cfg(test)]
mod tests {
    use super::routes;
    use crate::db::DbPool;
    use crate::db::init_database;
    use crate::runtime::RunSupervisor;
    use rocket::http::{ContentType, Status};
    use rocket::local::asynchronous::Client;
    use serde_json::{Value, json};
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::TempDir;
    use tokio::time::{Duration, sleep};

    const TEST_AGENT_ID: &str = "agent_run_contract";

    struct TestApp {
        _db_dir: TempDir,
        pool: DbPool,
        client: Client,
    }

    #[rocket::async_test]
    async fn queue_records_tab_queue_enter_urgent_and_multiline_prompt() {
        let app = test_app().await;
        let prompt = "First line from composer\nSecond line from Shift+Enter";

        let tab = queue_run(&app.client, prompt, "tab-queue", "agent/tab-queue-contract").await;

        assert_eq!(tab["run"]["status"].as_str(), Some("queued"));
        assert_eq!(tab["run"]["trigger_kind"].as_str(), Some("tab-queue"));
        assert_eq!(
            tab["run"]["prompt_summary"].as_str(),
            Some("First line from composer Second line from Shift+Enter")
        );
        let runtime_prompt = tab["request"]["prompt"].as_str().expect("runtime prompt");
        assert!(runtime_prompt.contains("Agent Adda communication protocol"));
        assert!(runtime_prompt.contains("agent_adda.actions"));
        assert!(runtime_prompt.contains("Latest assigned task:"));
        assert!(runtime_prompt.contains(prompt));
        assert!(
            tab["command"]["program"]
                .as_str()
                .is_some_and(|program| program.ends_with("fake-codex.sh"))
        );
        assert_eq!(tab["command"]["stdin"].as_str(), Some(runtime_prompt));
        assert!(
            tab["command"]["args"]
                .as_array()
                .expect("command args")
                .iter()
                .any(|arg| arg.as_str() == Some("--json"))
        );

        let urgent = queue_run(
            &app.client,
            "Production issue from Enter",
            "enter-urgent",
            "agent/urgent-contract",
        )
        .await;

        assert_eq!(urgent["run"]["status"].as_str(), Some("queued"));
        assert_eq!(urgent["run"]["trigger_kind"].as_str(), Some("enter-urgent"));
        assert_eq!(
            urgent["run"]["branch"].as_str(),
            Some("agent/urgent-contract")
        );
        assert_eq!(
            urgent["run"]["conversation_id"].as_str(),
            Some("channel_general")
        );
    }

    #[rocket::async_test]
    async fn stop_interrupt_cancel_records_trace_events_in_order() {
        let app = test_app().await;
        let queued = queue_run(
            &app.client,
            "Interruptible run for trace expansion",
            "enter-urgent",
            "agent/interrupt-contract",
        )
        .await;
        let run_id = queued["run"]["id"].as_str().expect("run id");

        let started = app
            .client
            .post(format!("/api/v1/runs/{run_id}/start"))
            .dispatch()
            .await;
        assert_eq!(started.status(), Status::Ok);
        let started_body = started.into_json::<Value>().await.expect("start json");
        assert_eq!(started_body["status"].as_str(), Some("running"));

        let stopped = app
            .client
            .post(format!("/api/v1/runs/{run_id}/stop"))
            .header(ContentType::JSON)
            .body(
                json!({
                    "reason": "Stop interrupt requested",
                    "payload": {
                        "source": "mission-control-stop"
                    }
                })
                .to_string(),
            )
            .dispatch()
            .await;
        assert_eq!(stopped.status(), Status::Ok);
        let stopped_body = stopped.into_json::<Value>().await.expect("stop json");
        assert_eq!(stopped_body["status"].as_str(), Some("running"));

        let canceled_body = wait_for_run_status(&app.client, run_id, "canceled").await;
        assert_eq!(canceled_body["status"].as_str(), Some("canceled"));
        assert_eq!(
            canceled_body["summary"].as_str(),
            Some("Stop interrupt requested")
        );
        assert!(
            canceled_body["event_count"]
                .as_i64()
                .is_some_and(|count| count >= 4)
        );

        let events = app
            .client
            .get(format!("/api/v1/runs/{run_id}/events"))
            .dispatch()
            .await;
        assert_eq!(events.status(), Status::Ok);
        let event_body = events.into_json::<Vec<Value>>().await.expect("events json");
        let event_types: Vec<&str> = event_body
            .iter()
            .map(|event| event["event_type"].as_str().expect("event type"))
            .collect();
        assert!(event_types.starts_with(&["run.queued", "run.started"]));
        assert!(event_types.contains(&"run.stop_requested"));
        assert_eq!(event_types.last(), Some(&"run.canceled"));

        let canceled_event = event_body
            .iter()
            .find(|event| event["event_type"].as_str() == Some("run.canceled"))
            .expect("canceled event");
        let canceled_event = &canceled_event["payload"];
        assert_eq!(canceled_event["from_status"].as_str(), Some("running"));
        assert_eq!(canceled_event["to_status"].as_str(), Some("canceled"));
        assert_eq!(
            canceled_event["reason"].as_str(),
            Some("Stop interrupt requested")
        );
        assert_eq!(canceled_event["detail"]["interrupt"].as_bool(), Some(true));
    }

    #[rocket::async_test]
    async fn stale_running_stop_clears_agent_active_run() {
        let app = test_app().await;
        let queued = queue_run(
            &app.client,
            "Stale run should clear active slot",
            "enter-urgent",
            "agent/stale-running-contract",
        )
        .await;
        let run_id = queued["run"]["id"].as_str().expect("run id");

        sqlx::query(
            r#"
            UPDATE agent_runs
            SET status = 'running',
                started_at = CURRENT_TIMESTAMP::text,
                updated_at = CURRENT_TIMESTAMP::text
            WHERE id = $1
            "#,
        )
        .bind(run_id)
        .execute(&app.pool)
        .await
        .expect("mark run stale-running");
        sqlx::query(
            r#"
            INSERT INTO agent_threads (agent_id, conversation_id, active_run_id, codex_session_id)
            VALUES ($1, 'channel_general', $2, 'thread-stale')
            ON CONFLICT(agent_id) DO UPDATE
            SET active_run_id = excluded.active_run_id,
                codex_session_id = excluded.codex_session_id,
                updated_at = CURRENT_TIMESTAMP::text
            "#,
        )
        .bind(TEST_AGENT_ID)
        .bind(run_id)
        .execute(&app.pool)
        .await
        .expect("seed active thread");

        let stopped = app
            .client
            .post(format!("/api/v1/runs/{run_id}/stop"))
            .header(ContentType::JSON)
            .body(json!({ "reason": "stale run cleanup" }).to_string())
            .dispatch()
            .await;
        assert_eq!(stopped.status(), Status::Ok);
        let stopped_body = stopped.into_json::<Value>().await.expect("stop json");
        assert_eq!(stopped_body["status"].as_str(), Some("canceled"));

        let active_run = sqlx::query_scalar::<_, Option<String>>(
            "SELECT active_run_id FROM agent_threads WHERE agent_id = $1",
        )
        .bind(TEST_AGENT_ID)
        .fetch_one(&app.pool)
        .await
        .expect("active run");
        assert_eq!(active_run, None);
    }

    async fn test_app() -> TestApp {
        let db_dir = tempfile::tempdir().expect("database tempdir");
        let _db_path = db_dir.path().join("agent_adda_runs_test.db");
        let database_url = std::env::var("AGENT_ADDA_TEST_DATABASE_URL").unwrap_or_else(|_| {
            "postgres://agent_adda:agent_adda@127.0.0.1:15432/agent_adda_test".to_string()
        });
        let pool = init_database(&database_url)
            .await
            .expect("database initializes");
        let fake_codex = db_dir.path().join("fake-codex.sh");
        fs::write(
            &fake_codex,
            "#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '{\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"phase\":\"final_answer\",\"message\":\"started\"}}'\nexec tail -f /dev/null\n",
        )
        .expect("fake codex script");
        let mut permissions = fs::metadata(&fake_codex).expect("metadata").permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&fake_codex, permissions).expect("permissions");
        sqlx::query(
            r#"
            INSERT INTO settings (key, value, updated_at)
            VALUES ('codex_binary_path', $1, CURRENT_TIMESTAMP::text)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP::text
            "#,
        )
        .bind(fake_codex.to_string_lossy().as_ref())
        .execute(&pool)
        .await
        .expect("seed fake codex path");
        seed_agent(&pool).await;
        let rocket = rocket::build()
            .manage(pool.clone())
            .manage(RunSupervisor::new())
            .mount("/api/v1", routes());
        let client = Client::tracked(rocket).await.expect("rocket client");

        TestApp {
            _db_dir: db_dir,
            pool,
            client,
        }
    }

    async fn seed_agent(pool: &DbPool) {
        sqlx::query(
            r#"
            INSERT INTO agents (
                id,
                name,
                slug,
                role,
                description,
                profile,
                system_prompt,
                model,
                reasoning_effort
            )
            VALUES ($1, 'Run Contract Agent', 'run-contract-agent', 'Runner', '', '', '', 'gpt-5.5', 'high')
            "#,
        )
        .bind(TEST_AGENT_ID)
        .execute(pool)
        .await
        .expect("seed agent");
    }

    async fn queue_run(client: &Client, prompt: &str, trigger_kind: &str, branch: &str) -> Value {
        let response = client
            .post(format!("/api/v1/agents/{TEST_AGENT_ID}/runs"))
            .header(ContentType::JSON)
            .body(
                json!({
                    "prompt": prompt,
                    "conversation_id": "channel_general",
                    "trigger_kind": trigger_kind,
                    "branch": branch
                })
                .to_string(),
            )
            .dispatch()
            .await;
        assert_eq!(response.status(), Status::Ok);
        response.into_json::<Value>().await.expect("queue json")
    }

    async fn wait_for_run_status(client: &Client, run_id: &str, status: &str) -> Value {
        for _ in 0..50 {
            let response = client
                .get(format!("/api/v1/runs/{run_id}"))
                .dispatch()
                .await;
            assert_eq!(response.status(), Status::Ok);
            let body = response.into_json::<Value>().await.expect("run json");
            if body["status"].as_str() == Some(status) {
                return body;
            }
            sleep(Duration::from_millis(100)).await;
        }

        panic!("run {run_id} did not reach status {status}");
    }
}
