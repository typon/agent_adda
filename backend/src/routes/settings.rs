use crate::agent_communications::DEFAULT_AGENT_GLOBAL_SYSTEM_PROMPT;
use crate::codex::{CodexReasoningEfforts, is_known_reasoning_effort, query_reasoning_efforts};
use crate::db::DbPool;
use crate::models::{Setting, UpdateSettingRequest, UpsertSettingRequest};
use rocket::Route;
use rocket::State;
use rocket::http::Status;
use rocket::serde::json::Json;

const MAX_SETTING_KEY_LEN: usize = 80;
const MAX_SETTING_VALUE_LEN: usize = 1024;
const MAX_GLOBAL_SYSTEM_PROMPT_LEN: usize = 16 * 1024;

const DEFAULT_SETTINGS: &[(&str, &str)] = &[
    ("default_model", "gpt-5.5"),
    ("default_reasoning_effort", "high"),
    ("project_name", ""),
    ("workspace_path", ""),
    ("codex_binary_path", "codex"),
    ("codex_home", ""),
    ("github_repo", ""),
    ("global_max_active_runs", "2"),
    ("per_agent_max_active_runs", "1"),
    ("agent_branch_prefix", "agent/"),
    (
        "agent_global_system_prompt",
        DEFAULT_AGENT_GLOBAL_SYSTEM_PROMPT,
    ),
    ("retention_days", "90"),
];

#[get("/settings")]
async fn list(pool: &State<DbPool>) -> Result<Json<Vec<Setting>>, Status> {
    ensure_default_settings(pool.inner())
        .await
        .map_err(|_| Status::InternalServerError)?;

    list_settings(pool.inner())
        .await
        .map(Json)
        .map_err(|_| Status::InternalServerError)
}

#[get("/settings/<key>")]
async fn get(pool: &State<DbPool>, key: &str) -> Result<Json<Setting>, Status> {
    let key = key.trim();
    if !is_valid_setting_key(key) {
        return Err(Status::BadRequest);
    }

    if default_setting_value(key).is_some() {
        ensure_default_setting(pool.inner(), key)
            .await
            .map_err(|_| Status::InternalServerError)?;
    }

    fetch_setting(pool.inner(), key)
        .await
        .map_err(|_| Status::InternalServerError)?
        .map(Json)
        .ok_or(Status::NotFound)
}

#[post("/settings", data = "<payload>")]
async fn upsert(
    pool: &State<DbPool>,
    payload: Json<UpsertSettingRequest>,
) -> Result<Json<Setting>, Status> {
    let key = payload.key.trim();
    let value = payload.value.trim();

    if !is_valid_setting_key(key) || !is_valid_setting_value(key, value) {
        return Err(Status::BadRequest);
    }

    upsert_setting_value(pool.inner(), key, value)
        .await
        .map_err(|_| Status::InternalServerError)?;

    fetch_setting(pool.inner(), key)
        .await
        .map_err(|_| Status::InternalServerError)?
        .map(Json)
        .ok_or(Status::InternalServerError)
}

#[put("/settings/<key>", data = "<payload>")]
async fn update(
    pool: &State<DbPool>,
    key: &str,
    payload: Json<UpdateSettingRequest>,
) -> Result<Json<Setting>, Status> {
    let key = key.trim();
    let value = payload.value.trim();

    if !is_valid_setting_key(key) {
        return Err(Status::BadRequest);
    }
    if !is_valid_setting_value(key, value) {
        return Err(Status::BadRequest);
    }

    upsert_setting_value(pool.inner(), key, value)
        .await
        .map_err(|_| Status::InternalServerError)?;

    fetch_setting(pool.inner(), key)
        .await
        .map_err(|_| Status::InternalServerError)?
        .map(Json)
        .ok_or(Status::InternalServerError)
}

#[get("/codex/reasoning-efforts?<model>")]
async fn codex_reasoning_efforts(
    pool: &State<DbPool>,
    model: Option<&str>,
) -> Result<Json<CodexReasoningEfforts>, Status> {
    let model = match model.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => value.to_string(),
        None => fetch_setting(pool.inner(), "default_model")
            .await
            .map_err(|_| Status::InternalServerError)?
            .map(|setting| setting.value)
            .unwrap_or_else(|| "gpt-5.5".to_string()),
    };

    if !is_valid_model_value(&model) {
        return Err(Status::BadRequest);
    }

    let codex_bin = resolve_codex_bin(pool.inner())
        .await
        .map_err(|_| Status::InternalServerError)?;
    let codex_home = resolve_codex_home(pool.inner())
        .await
        .map_err(|_| Status::InternalServerError)?;
    Ok(Json(
        query_reasoning_efforts(&codex_bin, codex_home.as_deref(), &model).await,
    ))
}

pub(super) async fn list_settings(pool: &DbPool) -> Result<Vec<Setting>, sqlx::Error> {
    sqlx::query_as::<_, Setting>("SELECT key, value, updated_at FROM settings ORDER BY key ASC")
        .fetch_all(pool)
        .await
}

pub(super) async fn fetch_setting(
    pool: &DbPool,
    key: &str,
) -> Result<Option<Setting>, sqlx::Error> {
    sqlx::query_as::<_, Setting>("SELECT key, value, updated_at FROM settings WHERE key = $1")
        .bind(key)
        .fetch_optional(pool)
        .await
}

pub(super) async fn upsert_setting_value(
    pool: &DbPool,
    key: &str,
    value: &str,
) -> Result<(), sqlx::Error> {
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
    .execute(pool)
    .await?;

    Ok(())
}

async fn ensure_default_settings(pool: &DbPool) -> Result<(), sqlx::Error> {
    for (key, _) in DEFAULT_SETTINGS {
        ensure_default_setting(pool, key).await?;
    }
    Ok(())
}

async fn ensure_default_setting(pool: &DbPool, key: &str) -> Result<(), sqlx::Error> {
    let Some(value) = default_setting_value(key) else {
        return Ok(());
    };

    sqlx::query(
        r#"
        INSERT INTO settings (key, value, updated_at)
        VALUES ($1, $2, CURRENT_TIMESTAMP::text)
        ON CONFLICT DO NOTHING
        "#,
    )
    .bind(key)
    .bind(value)
    .execute(pool)
    .await?;

    Ok(())
}

fn default_setting_value(key: &str) -> Option<&'static str> {
    DEFAULT_SETTINGS
        .iter()
        .find(|(default_key, _)| *default_key == key)
        .map(|(_, value)| *value)
}

pub(super) fn is_valid_setting_key(key: &str) -> bool {
    let key = key.trim();
    !key.is_empty()
        && key.len() <= MAX_SETTING_KEY_LEN
        && key.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.')
        })
}

fn is_valid_setting_value(key: &str, value: &str) -> bool {
    if value.len() > max_setting_value_len(key) {
        return false;
    }

    if is_model_setting_key(key) {
        return is_valid_model_value(value);
    }
    if is_reasoning_effort_setting_key(key) {
        return is_valid_reasoning_effort(value);
    }
    if is_positive_integer_setting_key(key) {
        return value
            .parse::<u16>()
            .is_ok_and(|number| (1..=1440).contains(&number));
    }
    true
}

fn max_setting_value_len(key: &str) -> usize {
    if key == "agent_global_system_prompt" {
        MAX_GLOBAL_SYSTEM_PROMPT_LEN
    } else {
        MAX_SETTING_VALUE_LEN
    }
}

fn is_model_setting_key(key: &str) -> bool {
    key == "default_model" || key.ends_with(".model") || key.ends_with("_model")
}

fn is_reasoning_effort_setting_key(key: &str) -> bool {
    key == "default_reasoning_effort"
        || key.ends_with(".reasoning_effort")
        || key.ends_with("_reasoning_effort")
}

fn is_positive_integer_setting_key(key: &str) -> bool {
    matches!(
        key,
        "global_max_active_runs" | "per_agent_max_active_runs" | "retention_days"
    )
}

fn is_valid_model_value(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.starts_with("gpt-")
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
}

fn is_valid_reasoning_effort(value: &str) -> bool {
    is_known_reasoning_effort(value)
}

pub fn routes() -> Vec<Route> {
    routes![list, get, upsert, update, codex_reasoning_efforts]
}

async fn resolve_codex_bin(pool: &DbPool) -> Result<String, sqlx::Error> {
    if let Some(setting) = fetch_setting(pool, "codex_binary_path").await? {
        let value = setting.value.trim();
        if !value.is_empty() {
            return Ok(value.to_string());
        }
    }

    Ok("codex".to_string())
}

async fn resolve_codex_home(pool: &DbPool) -> Result<Option<String>, sqlx::Error> {
    if let Some(setting) = fetch_setting(pool, "codex_home").await? {
        let value = setting.value.trim();
        if !value.is_empty() {
            return Ok(Some(value.to_string()));
        }
    }

    Ok(std::env::var("CODEX_HOME")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty()))
}
