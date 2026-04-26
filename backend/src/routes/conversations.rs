use crate::db::DbPool;
use crate::models::{Conversation, CreateMessageRequest, Message};
use crate::routes::runs::{
    QueueAgentRunInput, RUN_PRIORITY_NORMAL, RUN_PRIORITY_URGENT, queue_agent_run,
    stop_or_cancel_run,
};
use crate::runtime::RunSupervisor;
use rocket::State;
use rocket::http::Status;
use rocket::serde::json::Json;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
struct CreateConversationRequest {
    kind: String,
    name: Option<String>,
    topic: Option<String>,
    agent_id: Option<String>,
    member_ids: Option<Vec<String>>,
}

#[derive(Debug, Serialize, FromRow)]
struct ConversationMember {
    conversation_id: String,
    member_kind: String,
    member_id: String,
    display_name: String,
}

#[derive(Debug, Serialize)]
struct StopAgentResponse {
    interrupted: bool,
    run_id: Option<String>,
}

#[derive(Debug, Serialize)]
struct ClearMessagesResponse {
    deleted_messages: u64,
}

#[get("/conversations")]
async fn list(pool: &State<DbPool>) -> Result<Json<Vec<Conversation>>, Status> {
    sqlx::query_as::<_, Conversation>(
        "SELECT * FROM conversations WHERE archived_at IS NULL ORDER BY created_at ASC",
    )
    .fetch_all(pool.inner())
    .await
    .map(Json)
    .map_err(|_| Status::InternalServerError)
}

#[post("/conversations", data = "<payload>")]
async fn create(
    pool: &State<DbPool>,
    payload: Json<CreateConversationRequest>,
) -> Result<Json<Conversation>, Status> {
    let kind = payload.kind.trim();

    match kind {
        "channel" => create_channel(pool, &payload).await,
        "dm" => create_dm(pool, &payload).await,
        _ => Err(Status::BadRequest),
    }
}

#[post("/conversations/<id>/archive")]
async fn archive(pool: &State<DbPool>, id: &str) -> Status {
    match archive_conversation(pool.inner(), id).await {
        Ok(true) => Status::NoContent,
        Ok(false) => Status::NotFound,
        Err(_) => Status::InternalServerError,
    }
}

#[get("/conversations/<id>/messages")]
async fn messages(pool: &State<DbPool>, id: &str) -> Result<Json<Vec<Message>>, Status> {
    let Some((archived_at, _)) = conversation_for_message(pool.inner(), id).await? else {
        return Err(Status::NotFound);
    };
    if archived_at.is_some() {
        return Err(Status::Forbidden);
    }

    sqlx::query_as::<_, Message>(
        "SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC, id ASC",
    )
    .bind(id)
    .fetch_all(pool.inner())
    .await
    .map(Json)
    .map_err(|_| Status::InternalServerError)
}

#[delete("/conversations/<id>/messages")]
async fn clear_messages(
    pool: &State<DbPool>,
    id: &str,
) -> Result<Json<ClearMessagesResponse>, Status> {
    let Some((archived_at, _)) = conversation_for_message(pool.inner(), id).await? else {
        return Err(Status::NotFound);
    };
    if archived_at.is_some() {
        return Err(Status::Forbidden);
    }
    if dm_agent_for_conversation(pool.inner(), id).await?.is_none() {
        return Err(Status::BadRequest);
    }

    let mut tx = pool
        .inner()
        .begin()
        .await
        .map_err(|_| Status::InternalServerError)?;

    sqlx::query(
        r#"
        DELETE FROM search_index
        WHERE entity_type = 'message'
          AND entity_id IN (SELECT id FROM messages WHERE conversation_id = $1)
        "#,
    )
    .bind(id)
    .execute(&mut *tx)
    .await
    .map_err(|_| Status::InternalServerError)?;

    let deleted = sqlx::query("DELETE FROM messages WHERE conversation_id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(|_| Status::InternalServerError)?
        .rows_affected();

    sqlx::query("UPDATE conversations SET updated_at = CURRENT_TIMESTAMP::text WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(|_| Status::InternalServerError)?;

    tx.commit().await.map_err(|_| Status::InternalServerError)?;

    Ok(Json(ClearMessagesResponse {
        deleted_messages: deleted,
    }))
}

#[post("/conversations/<id>/messages", data = "<payload>")]
async fn create_message(
    pool: &State<DbPool>,
    runtime: &State<RunSupervisor>,
    id: &str,
    payload: Json<CreateMessageRequest>,
) -> Result<Json<Message>, Status> {
    let author_kind = payload.author_kind.trim();
    let author_id = payload.author_id.trim();
    let body = payload.body.trim();

    let Some((archived_at, conversation_name)) = conversation_for_message(pool.inner(), id).await?
    else {
        return Err(Status::NotFound);
    };
    if archived_at.is_some() {
        return Err(Status::Forbidden);
    }

    if !is_valid_author_kind(author_kind) {
        return Err(Status::BadRequest);
    }

    if author_id.is_empty() || body.is_empty() {
        return Err(Status::BadRequest);
    }
    let dm_agent_id = dm_agent_for_conversation(pool.inner(), id).await?;
    let delivery_mode = delivery_mode(
        payload.delivery_mode.as_deref(),
        author_kind,
        dm_agent_id.is_some(),
    )?;

    let message_id = Uuid::new_v4().to_string();
    let search_title = format!("Message in {conversation_name}");
    let mut tx = pool
        .inner()
        .begin()
        .await
        .map_err(|_| Status::InternalServerError)?;

    sqlx::query(
        "INSERT INTO messages (id, conversation_id, author_kind, author_id, body) VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(&message_id)
    .bind(id)
    .bind(author_kind)
    .bind(author_id)
    .bind(body)
    .execute(&mut *tx)
    .await
    .map_err(|_| Status::InternalServerError)?;

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
    .execute(&mut *tx)
    .await
    .map_err(|_| Status::InternalServerError)?;

    sqlx::query("UPDATE conversations SET updated_at = CURRENT_TIMESTAMP::text WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(|_| Status::InternalServerError)?;

    tx.commit().await.map_err(|_| Status::InternalServerError)?;

    if let Some(agent_id) = dm_agent_id.as_deref() {
        if author_kind == "human" && delivery_mode != "message_only" {
            if let Some(run_id) = queue_dm_run(
                pool.inner(),
                runtime.inner(),
                id,
                agent_id,
                body,
                &delivery_mode,
            )
            .await
            {
                sqlx::query("UPDATE messages SET run_id = $1 WHERE id = $2")
                    .bind(run_id)
                    .bind(&message_id)
                    .execute(pool.inner())
                    .await
                    .map_err(|_| Status::InternalServerError)?;
            }
        }
    }

    sqlx::query_as::<_, Message>("SELECT * FROM messages WHERE id = $1")
        .bind(message_id)
        .fetch_one(pool.inner())
        .await
        .map(Json)
        .map_err(|_| Status::InternalServerError)
}

#[post("/conversations/<id>/agent/stop")]
async fn stop_agent(
    pool: &State<DbPool>,
    runtime: &State<RunSupervisor>,
    id: &str,
) -> Result<Json<StopAgentResponse>, Status> {
    let Some(agent_id) = dm_agent_for_conversation(pool.inner(), id).await? else {
        return Err(Status::NotFound);
    };
    let run_id = active_run_for_agent(pool.inner(), &agent_id).await?;
    if let Some(run_id) = run_id.as_deref() {
        let payload: Option<Value> = None;
        stop_or_cancel_run(
            pool.inner(),
            runtime.inner(),
            run_id,
            "Interrupted from Mission Control.",
            &payload,
        )
        .await?;
    }
    Ok(Json(StopAgentResponse {
        interrupted: run_id.is_some(),
        run_id,
    }))
}

#[get("/conversations/<id>/members")]
async fn members(pool: &State<DbPool>, id: &str) -> Result<Json<Vec<ConversationMember>>, Status> {
    if archived_at(pool.inner(), id).await?.is_none() {
        return Err(Status::NotFound);
    }

    sqlx::query_as::<_, ConversationMember>(
        r#"
        SELECT cm.conversation_id,
               cm.member_kind,
               cm.member_id,
               CASE
                   WHEN cm.member_kind = 'human' THEN 'Owner'
                   ELSE COALESCE(a.name, cm.member_id)
               END AS display_name
        FROM conversation_members cm
        LEFT JOIN agents a ON cm.member_kind = 'agent' AND cm.member_id = a.id
        WHERE cm.conversation_id = $1
        ORDER BY cm.member_kind ASC, display_name ASC
        "#,
    )
    .bind(id)
    .fetch_all(pool.inner())
    .await
    .map(Json)
    .map_err(|_| Status::InternalServerError)
}

async fn create_channel(
    pool: &State<DbPool>,
    payload: &CreateConversationRequest,
) -> Result<Json<Conversation>, Status> {
    let id = Uuid::new_v4().to_string();
    let name = required_text(payload.name.as_deref())?;
    let topic = optional_text(payload.topic.as_deref());

    let mut tx = pool
        .inner()
        .begin()
        .await
        .map_err(|_| Status::InternalServerError)?;

    sqlx::query("INSERT INTO conversations (id, kind, name, topic) VALUES ($1, 'channel', $2, $3)")
        .bind(&id)
        .bind(&name)
        .bind(&topic)
        .execute(&mut *tx)
        .await
        .map_err(database_write_status)?;

    sqlx::query(
        "INSERT INTO conversation_members (conversation_id, member_kind, member_id) VALUES ($1, 'human', 'owner') ON CONFLICT DO NOTHING",
    )
    .bind(&id)
    .execute(&mut *tx)
    .await
    .map_err(database_write_status)?;

    if let Some(member_ids) = &payload.member_ids {
        for member_id in member_ids {
            let member_id = member_id.trim();
            if member_id.is_empty() {
                return Err(Status::BadRequest);
            }

            sqlx::query(
                "INSERT INTO conversation_members (conversation_id, member_kind, member_id) VALUES ($1, 'agent', $2) ON CONFLICT DO NOTHING",
            )
            .bind(&id)
            .bind(member_id)
            .execute(&mut *tx)
            .await
            .map_err(database_write_status)?;
        }
    }

    tx.commit().await.map_err(|_| Status::InternalServerError)?;

    get_conversation(pool, &id).await
}

async fn create_dm(
    pool: &State<DbPool>,
    payload: &CreateConversationRequest,
) -> Result<Json<Conversation>, Status> {
    let agent_id = required_text(payload.agent_id.as_deref())?;
    let Some(agent_name) = sqlx::query_scalar::<_, String>(
        "SELECT name FROM agents WHERE id = $1 AND deleted_at IS NULL",
    )
    .bind(&agent_id)
    .fetch_optional(pool.inner())
    .await
    .map_err(|_| Status::InternalServerError)?
    else {
        return Err(Status::NotFound);
    };

    let id = format!("dm_{}", agent_id);
    let name = payload
        .name
        .as_deref()
        .map(|value| value.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or(agent_name);
    let topic = payload
        .topic
        .as_deref()
        .map(|value| value.trim().to_string())
        .filter(|topic| !topic.is_empty())
        .unwrap_or_else(|| format!("Direct message with {}", name));

    let mut tx = pool
        .inner()
        .begin()
        .await
        .map_err(|_| Status::InternalServerError)?;

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
    .bind(&id)
    .bind(&name)
    .bind(&topic)
    .execute(&mut *tx)
    .await
    .map_err(database_write_status)?;

    sqlx::query(
        "INSERT INTO conversation_members (conversation_id, member_kind, member_id) VALUES ($1, 'human', 'owner') ON CONFLICT DO NOTHING",
    )
    .bind(&id)
    .execute(&mut *tx)
    .await
    .map_err(database_write_status)?;

    sqlx::query(
        "INSERT INTO conversation_members (conversation_id, member_kind, member_id) VALUES ($1, 'agent', $2) ON CONFLICT DO NOTHING",
    )
    .bind(&id)
    .bind(&agent_id)
    .execute(&mut *tx)
    .await
    .map_err(database_write_status)?;

    tx.commit().await.map_err(|_| Status::InternalServerError)?;

    get_conversation(pool, &id).await
}

async fn get_conversation(pool: &State<DbPool>, id: &str) -> Result<Json<Conversation>, Status> {
    sqlx::query_as::<_, Conversation>("SELECT * FROM conversations WHERE id = $1")
        .bind(id)
        .fetch_optional(pool.inner())
        .await
        .map_err(|_| Status::InternalServerError)?
        .map(Json)
        .ok_or(Status::NotFound)
}

async fn archived_at(
    pool: &DbPool,
    conversation_id: &str,
) -> Result<Option<Option<String>>, Status> {
    sqlx::query_scalar::<_, Option<String>>("SELECT archived_at FROM conversations WHERE id = $1")
        .bind(conversation_id)
        .fetch_optional(pool)
        .await
        .map_err(|_| Status::InternalServerError)
}

async fn conversation_for_message(
    pool: &DbPool,
    conversation_id: &str,
) -> Result<Option<(Option<String>, String)>, Status> {
    sqlx::query_as::<_, (Option<String>, String)>(
        "SELECT archived_at, name FROM conversations WHERE id = $1",
    )
    .bind(conversation_id)
    .fetch_optional(pool)
    .await
    .map_err(|_| Status::InternalServerError)
}

async fn dm_agent_for_conversation(
    pool: &DbPool,
    conversation_id: &str,
) -> Result<Option<String>, Status> {
    sqlx::query_scalar::<_, String>(
        r#"
        SELECT cm.member_id
        FROM conversation_members cm
        JOIN conversations c ON c.id = cm.conversation_id
        WHERE cm.conversation_id = $1
          AND c.kind = 'dm'
          AND c.archived_at IS NULL
          AND cm.member_kind = 'agent'
        ORDER BY cm.member_id ASC
        LIMIT 1
        "#,
    )
    .bind(conversation_id)
    .fetch_optional(pool)
    .await
    .map_err(|_| Status::InternalServerError)
}

fn delivery_mode(
    requested: Option<&str>,
    author_kind: &str,
    has_dm_agent: bool,
) -> Result<String, Status> {
    let mode = requested
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(if author_kind == "human" && has_dm_agent {
            "queue"
        } else {
            "message_only"
        });

    if !matches!(mode, "message_only" | "queue" | "urgent") {
        return Err(Status::BadRequest);
    }
    if mode != "message_only" && !has_dm_agent {
        return Err(Status::BadRequest);
    }
    Ok(mode.to_string())
}

async fn queue_dm_run(
    pool: &DbPool,
    runtime: &RunSupervisor,
    conversation_id: &str,
    agent_id: &str,
    body: &str,
    delivery_mode: &str,
) -> Option<String> {
    let queue_priority = if delivery_mode == "urgent" {
        RUN_PRIORITY_URGENT
    } else {
        RUN_PRIORITY_NORMAL
    };

    let queued = queue_agent_run(
        pool,
        QueueAgentRunInput {
            agent_id: agent_id.to_string(),
            prompt: body.to_string(),
            workspace: None,
            conversation_id: Some(conversation_id.to_string()),
            trigger_kind: if delivery_mode == "urgent" {
                "owner-urgent-dm".to_string()
            } else {
                "owner-dm".to_string()
            },
            branch: String::new(),
            queue_priority,
            queued_by: "owner".to_string(),
        },
    )
    .await;

    match queued {
        Ok(queued) => {
            let run_id = queued.run.id.clone();
            if delivery_mode == "urgent" {
                if let Ok(Some(run_id)) = active_run_for_agent(pool, agent_id).await {
                    let payload: Option<Value> = None;
                    let _ = stop_or_cancel_run(
                        pool,
                        runtime,
                        &run_id,
                        "Interrupted by urgent DM.",
                        &payload,
                    )
                    .await;
                }
            }
            runtime.notify_queued();
            Some(run_id)
        }
        Err(_) => {
            let _ = insert_system_message(
                pool,
                conversation_id,
                "Agent run could not be queued. Check the workspace path and agent settings.",
            )
            .await;
            None
        }
    }
}

async fn active_run_for_agent(pool: &DbPool, agent_id: &str) -> Result<Option<String>, Status> {
    sqlx::query_scalar::<_, String>(
        r#"
        SELECT id
        FROM agent_runs
        WHERE agent_id = $1 AND status = 'running'
        ORDER BY started_at::timestamptz ASC, id ASC
        LIMIT 1
        "#,
    )
    .bind(agent_id)
    .fetch_optional(pool)
    .await
    .map_err(|_| Status::InternalServerError)
}

async fn insert_system_message(
    pool: &DbPool,
    conversation_id: &str,
    body: &str,
) -> Result<(), sqlx::Error> {
    let message_id = Uuid::new_v4().to_string();
    let search_title = sqlx::query_scalar::<_, String>(
        "SELECT 'Message in ' || name FROM conversations WHERE id = $1",
    )
    .bind(conversation_id)
    .fetch_one(pool)
    .await?;
    let mut tx = pool.begin().await?;
    sqlx::query(
        "INSERT INTO messages (id, conversation_id, author_kind, author_id, body) VALUES ($1, $2, 'system', 'runtime', $3)",
    )
    .bind(&message_id)
    .bind(conversation_id)
    .bind(body)
    .execute(&mut *tx)
    .await?;
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
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

async fn archive_conversation(pool: &DbPool, id: &str) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        "UPDATE conversations SET archived_at = COALESCE(archived_at, CURRENT_TIMESTAMP::text), updated_at = CURRENT_TIMESTAMP::text WHERE id = $1",
    )
    .bind(id)
    .execute(pool)
    .await?;

    Ok(result.rows_affected() > 0)
}

fn required_text(value: Option<&str>) -> Result<String, Status> {
    let Some(value) = value else {
        return Err(Status::BadRequest);
    };

    let value = value.trim();
    if value.is_empty() {
        Err(Status::BadRequest)
    } else {
        Ok(value.to_string())
    }
}

fn optional_text(value: Option<&str>) -> String {
    value.unwrap_or("").trim().to_string()
}

fn is_valid_author_kind(author_kind: &str) -> bool {
    matches!(author_kind, "human" | "agent" | "system")
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

pub fn routes() -> Vec<rocket::Route> {
    routes![
        list,
        create,
        archive,
        messages,
        clear_messages,
        create_message,
        stop_agent,
        members
    ]
}
