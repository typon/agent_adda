use crate::agent_communications::default_agent_system_prompt;
use crate::codex::is_known_reasoning_effort;
use crate::db::DbPool;
use crate::models::{Agent, CreateAgentRequest};
use crate::wiki::slugify;
use rocket::State;
use rocket::http::Status;
use rocket::serde::json::Json;
use serde::Deserialize;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
struct UpdateAgentRequest {
    name: Option<String>,
    profile: Option<String>,
    system_prompt: Option<String>,
    status: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<String>,
}

#[get("/agents")]
async fn list(pool: &State<DbPool>) -> Result<Json<Vec<Agent>>, Status> {
    sqlx::query_as::<_, Agent>(
        r#"
        SELECT a.id,
               a.name,
               a.slug,
               a.role,
               a.description,
               a.profile,
               a.system_prompt,
               CASE
                 WHEN EXISTS (
                   SELECT 1
                   FROM agent_runs running
                   WHERE running.agent_id = a.id
                     AND running.status = 'running'
                 ) THEN 'working'
                 WHEN EXISTS (
                   SELECT 1
                   FROM agent_runs queued
                   WHERE queued.agent_id = a.id
                     AND queued.status = 'queued'
                 ) THEN 'pending'
                 WHEN a.status IN ('working', 'pending') THEN 'idle'
                 ELSE a.status
               END AS status,
               a.model,
               a.reasoning_effort,
               a.created_at,
               a.updated_at,
               a.deleted_at
        FROM agents a
        WHERE a.deleted_at IS NULL
        ORDER BY a.created_at ASC
        "#,
    )
    .fetch_all(pool.inner())
    .await
    .map(Json)
    .map_err(|_| Status::InternalServerError)
}

#[post("/agents", data = "<payload>")]
async fn create(
    pool: &State<DbPool>,
    payload: Json<CreateAgentRequest>,
) -> Result<Json<Agent>, Status> {
    let id = Uuid::new_v4().to_string();
    let conversation_id = format!("dm_{}", id);
    let slug = slugify(&payload.name);
    let profile = format!(
        "{} is responsible for {}. This employee collaborates through DMs, channels, PRs, and the shared wiki memory.",
        payload.name, payload.description
    );
    let system_prompt =
        default_agent_system_prompt(&payload.name, &payload.role, &payload.description);

    let mut tx = pool
        .inner()
        .begin()
        .await
        .map_err(|_| Status::InternalServerError)?;

    sqlx::query(
        r#"
        INSERT INTO agents (id, name, slug, role, description, profile, system_prompt)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        "#,
    )
    .bind(&id)
    .bind(&payload.name)
    .bind(&slug)
    .bind(&payload.role)
    .bind(&payload.description)
    .bind(&profile)
    .bind(&system_prompt)
    .execute(&mut *tx)
    .await
    .map_err(database_write_status)?;

    sqlx::query(
        r#"
        INSERT INTO conversations (id, kind, name, topic)
        VALUES ($1, 'dm', $2, $3)
        "#,
    )
    .bind(&conversation_id)
    .bind(&payload.name)
    .bind(format!("Direct message with {}", payload.name))
    .execute(&mut *tx)
    .await
    .map_err(database_write_status)?;

    sqlx::query(
        r#"
        INSERT INTO conversation_members (conversation_id, member_kind, member_id)
        VALUES ($1, 'human', 'owner')
        ON CONFLICT DO NOTHING
        "#,
    )
    .bind(&conversation_id)
    .execute(&mut *tx)
    .await
    .map_err(database_write_status)?;

    sqlx::query(
        r#"
        INSERT INTO conversation_members (conversation_id, member_kind, member_id)
        VALUES ($1, 'agent', $2)
        ON CONFLICT DO NOTHING
        "#,
    )
    .bind(&conversation_id)
    .bind(&id)
    .execute(&mut *tx)
    .await
    .map_err(database_write_status)?;

    tx.commit().await.map_err(|_| Status::InternalServerError)?;

    get_agent(pool, &id).await
}

#[get("/agents/<id>")]
async fn get(pool: &State<DbPool>, id: &str) -> Result<Json<Agent>, Status> {
    get_agent(pool, id).await
}

#[patch("/agents/<id>", data = "<payload>")]
async fn update(
    pool: &State<DbPool>,
    id: &str,
    payload: Json<UpdateAgentRequest>,
) -> Result<Json<Agent>, Status> {
    let name = optional_bounded_text(&payload.name, 80)?;
    let status = optional_known_value(&payload.status, is_valid_agent_status)?;
    let model = optional_required_text(&payload.model)?;
    let reasoning_effort =
        optional_known_value(&payload.reasoning_effort, is_valid_reasoning_effort)?;
    let profile = payload.profile.clone();
    let system_prompt = optional_prompt(&payload.system_prompt)?;

    if name.is_none()
        && profile.is_none()
        && system_prompt.is_none()
        && status.is_none()
        && model.is_none()
        && reasoning_effort.is_none()
    {
        return Err(Status::BadRequest);
    }

    let slug = match name.as_deref() {
        Some(name) => Some(unique_agent_slug(pool.inner(), name, id).await?),
        None => None,
    };

    let mut tx = pool
        .inner()
        .begin()
        .await
        .map_err(|_| Status::InternalServerError)?;
    let result = sqlx::query(
        r#"
        UPDATE agents
        SET name = COALESCE($1, name),
            slug = COALESCE($2, slug),
            profile = COALESCE($3, profile),
            system_prompt = COALESCE($4, system_prompt),
            status = COALESCE($5, status),
            model = COALESCE($6, model),
            reasoning_effort = COALESCE($7, reasoning_effort),
            updated_at = CURRENT_TIMESTAMP::text
        WHERE id = $8 AND deleted_at IS NULL
        "#,
    )
    .bind(name.as_deref())
    .bind(slug.as_deref())
    .bind(profile.as_deref())
    .bind(system_prompt.as_deref())
    .bind(status.as_deref())
    .bind(model.as_deref())
    .bind(reasoning_effort.as_deref())
    .bind(id)
    .execute(&mut *tx)
    .await
    .map_err(database_write_status)?;

    if result.rows_affected() == 0 {
        return Err(Status::NotFound);
    }
    tx.commit().await.map_err(|_| Status::InternalServerError)?;

    get_agent(pool, id).await
}

#[delete("/agents/<id>")]
async fn delete(pool: &State<DbPool>, id: &str) -> Status {
    match sqlx::query(
        "UPDATE agents SET deleted_at = CURRENT_TIMESTAMP::text, status = 'archived' WHERE id = $1",
    )
    .bind(id)
    .execute(pool.inner())
    .await
    {
        Ok(_) => Status::NoContent,
        Err(_) => Status::InternalServerError,
    }
}

async fn get_agent(pool: &State<DbPool>, id: &str) -> Result<Json<Agent>, Status> {
    sqlx::query_as::<_, Agent>(
        r#"
        SELECT a.id,
               a.name,
               a.slug,
               a.role,
               a.description,
               a.profile,
               a.system_prompt,
               CASE
                 WHEN EXISTS (
                   SELECT 1
                   FROM agent_runs running
                   WHERE running.agent_id = a.id
                     AND running.status = 'running'
                 ) THEN 'working'
                 WHEN EXISTS (
                   SELECT 1
                   FROM agent_runs queued
                   WHERE queued.agent_id = a.id
                     AND queued.status = 'queued'
                 ) THEN 'pending'
                 WHEN a.status IN ('working', 'pending') THEN 'idle'
                 ELSE a.status
               END AS status,
               a.model,
               a.reasoning_effort,
               a.created_at,
               a.updated_at,
               a.deleted_at
        FROM agents a
        WHERE a.id = $1 AND a.deleted_at IS NULL
        "#,
    )
    .bind(id)
    .fetch_optional(pool.inner())
    .await
    .map_err(|_| Status::InternalServerError)?
    .map(Json)
    .ok_or(Status::NotFound)
}

fn optional_prompt(value: &Option<String>) -> Result<Option<String>, Status> {
    match value {
        Some(prompt) if prompt.trim().is_empty() => Err(Status::BadRequest),
        Some(prompt) => Ok(Some(prompt.clone())),
        None => Ok(None),
    }
}

fn optional_required_text(value: &Option<String>) -> Result<Option<String>, Status> {
    match value {
        Some(text) => {
            let text = text.trim();
            if text.is_empty() {
                Err(Status::BadRequest)
            } else {
                Ok(Some(text.to_string()))
            }
        }
        None => Ok(None),
    }
}

fn optional_bounded_text(value: &Option<String>, max_len: usize) -> Result<Option<String>, Status> {
    let Some(value) = optional_required_text(value)? else {
        return Ok(None);
    };

    if value.len() > max_len {
        Err(Status::BadRequest)
    } else {
        Ok(Some(value))
    }
}

fn optional_known_value(
    value: &Option<String>,
    is_valid: fn(&str) -> bool,
) -> Result<Option<String>, Status> {
    let Some(value) = optional_required_text(value)? else {
        return Ok(None);
    };

    if is_valid(&value) {
        Ok(Some(value))
    } else {
        Err(Status::BadRequest)
    }
}

fn is_valid_agent_status(status: &str) -> bool {
    matches!(
        status,
        "idle"
            | "working"
            | "blocked"
            | "reviewing"
            | "awaiting-human"
            | "rate-limited"
            | "offline"
    )
}

fn is_valid_reasoning_effort(reasoning_effort: &str) -> bool {
    is_known_reasoning_effort(reasoning_effort)
}

async fn unique_agent_slug(pool: &DbPool, name: &str, agent_id: &str) -> Result<String, Status> {
    let base_slug = slugify(name);
    for suffix in 0..128 {
        let candidate = if suffix == 0 {
            base_slug.clone()
        } else {
            format!("{base_slug}-{suffix}")
        };
        let count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM agents WHERE slug = $1 AND id != $2",
        )
        .bind(&candidate)
        .bind(agent_id)
        .fetch_one(pool)
        .await
        .map_err(|_| Status::InternalServerError)?;
        if count == 0 {
            return Ok(candidate);
        }
    }

    Err(Status::Conflict)
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
    let mut routes = routes![list, create, get, update, delete];
    routes.extend(crate::routes::runs::routes());
    routes
}

#[cfg(test)]
mod tests {
    use super::routes;
    use crate::db::DbPool;
    use crate::db::init_database;
    use crate::runtime::RunSupervisor;
    use rocket::http::Status;
    use rocket::local::asynchronous::Client;
    use serde_json::Value;
    use tempfile::TempDir;

    const TEST_AGENT_ID: &str = "agent_status_contract";

    struct TestApp {
        _db_dir: TempDir,
        client: Client,
    }

    #[rocket::async_test]
    async fn list_derives_runtime_status_from_active_runs() {
        let app = test_app().await;

        assert_eq!(agent_status(&app.client).await, "idle");

        set_run_status(&app.client, "queued").await;
        assert_eq!(agent_status(&app.client).await, "pending");

        set_run_status(&app.client, "running").await;
        assert_eq!(agent_status(&app.client).await, "working");

        set_run_status(&app.client, "completed").await;
        assert_eq!(agent_status(&app.client).await, "idle");
    }

    async fn test_app() -> TestApp {
        let db_dir = tempfile::tempdir().expect("database tempdir");
        let _db_path = db_dir.path().join("agent_status_test.db");
        let database_url = std::env::var("AGENT_ADDA_TEST_DATABASE_URL").unwrap_or_else(|_| {
            "postgres://agent_adda:agent_adda@127.0.0.1:15432/agent_adda_test".to_string()
        });
        let pool = init_database(&database_url)
            .await
            .expect("database initializes");
        seed_agent(&pool).await;
        let rocket = rocket::build()
            .manage(pool)
            .manage(RunSupervisor::new())
            .mount("/api/v1", routes());
        let client = Client::tracked(rocket).await.expect("rocket client");

        TestApp {
            _db_dir: db_dir,
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
                status,
                model,
                reasoning_effort
            )
            VALUES ($1, 'Status Contract Agent', 'status-contract-agent', 'Agent', '', '', '', 'working', 'gpt-5.5', 'high')
            "#,
        )
        .bind(TEST_AGENT_ID)
        .execute(pool)
        .await
        .expect("seed agent");
    }

    async fn set_run_status(client: &Client, status: &str) {
        let pool = client.rocket().state::<DbPool>().expect("pool");
        sqlx::query("DELETE FROM agent_runs WHERE agent_id = $1")
            .bind(TEST_AGENT_ID)
            .execute(pool)
            .await
            .expect("clear runs");
        sqlx::query(
            r#"
            INSERT INTO agent_runs (
                id,
                agent_id,
                status,
                prompt,
                prompt_hash,
                prompt_summary,
                model,
                reasoning_effort,
                workspace,
                command_json,
                updated_at
            )
            VALUES ('run_status_contract', $1, $2, 'prompt', 'hash', 'summary', 'gpt-5.5', 'high', '/tmp', '{}', CURRENT_TIMESTAMP::text)
            "#,
        )
        .bind(TEST_AGENT_ID)
        .bind(status)
        .execute(pool)
        .await
        .expect("set run");
    }

    async fn agent_status(client: &Client) -> String {
        let response = client.get("/api/v1/agents").dispatch().await;
        assert_eq!(response.status(), Status::Ok);
        let body = response
            .into_json::<Vec<Value>>()
            .await
            .expect("agents json");
        body.into_iter()
            .find(|agent| agent["id"].as_str() == Some(TEST_AGENT_ID))
            .and_then(|agent| agent["status"].as_str().map(str::to_string))
            .expect("agent status")
    }
}
