use crate::db::DbPool;
use crate::routes::runs::{QueueAgentRunInput, RUN_PRIORITY_NORMAL, queue_agent_run};
use crate::runtime::RunSupervisor;
use chrono::{DateTime, Duration as ChronoDuration, FixedOffset, NaiveTime, TimeZone, Utc};
use rocket::State;
use rocket::http::Status;
use rocket::serde::json::Json;
use rocket::{Route, delete, get, patch, post, routes};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use std::time::Duration;
use uuid::Uuid;

const CRON_POLL_INTERVAL: Duration = Duration::from_secs(30);
const CRON_BATCH_LIMIT: i64 = 16;
const MAX_TITLE_BYTES: usize = 120;
const MAX_PROMPT_BYTES: usize = 12_000;
const MAX_INTERVAL_MINUTES: i64 = 10_080;
const DEFAULT_DAILY_INTERVAL_MINUTES: i64 = 1_440;
const FAILURE_RETRY_MINUTES: i64 = 5;
const SCHEDULE_INTERVAL: &str = "interval";
const SCHEDULE_DAILY_TIME: &str = "daily_time";
const CRON_TIMEZONE_LABEL: &str = "PDT";
const PDT_UTC_OFFSET_SECONDS: i32 = -7 * 60 * 60;

#[derive(Debug, Deserialize)]
struct CreateCronJobRequest {
    title: String,
    prompt: String,
    interval_minutes: Option<i64>,
    schedule_kind: Option<String>,
    time_of_day: Option<String>,
    enabled: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct UpdateCronJobRequest {
    title: Option<String>,
    prompt: Option<String>,
    interval_minutes: Option<i64>,
    schedule_kind: Option<String>,
    time_of_day: Option<String>,
    enabled: Option<bool>,
}

#[derive(Debug, Serialize)]
struct CronJobResponse {
    id: String,
    agent_id: String,
    title: String,
    prompt: String,
    interval_minutes: i64,
    schedule_kind: String,
    time_of_day: String,
    timezone: String,
    enabled: bool,
    next_run_at: String,
    last_queued_at: Option<String>,
    last_run_id: Option<String>,
    last_error: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, FromRow)]
struct CronJobRow {
    id: String,
    agent_id: String,
    title: String,
    prompt: String,
    interval_minutes: i32,
    schedule_kind: String,
    time_of_day: String,
    timezone: String,
    enabled: i32,
    next_run_at: String,
    last_queued_at: Option<String>,
    last_run_id: Option<String>,
    last_error: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, FromRow)]
struct DueCronJob {
    id: String,
    agent_id: String,
    title: String,
    prompt: String,
    interval_minutes: i32,
    schedule_kind: String,
    time_of_day: String,
}

struct CronSchedule {
    kind: String,
    interval_minutes: i64,
    time_of_day: String,
    timezone: String,
    next_run_at: String,
}

pub async fn supervise_cron_jobs(pool: DbPool, supervisor: RunSupervisor) {
    loop {
        if let Err(error) = queue_due_cron_jobs(&pool, &supervisor, CRON_BATCH_LIMIT).await {
            eprintln!("cron supervisor loop failed: {error}");
        }

        tokio::time::sleep(CRON_POLL_INTERVAL).await;
    }
}

pub async fn queue_due_cron_jobs(
    pool: &DbPool,
    supervisor: &RunSupervisor,
    limit: i64,
) -> Result<usize, sqlx::Error> {
    let due_jobs = sqlx::query_as::<_, DueCronJob>(
        r#"
        SELECT j.id, j.agent_id, j.title, j.prompt, j.interval_minutes, j.schedule_kind, j.time_of_day
        FROM agent_cron_jobs j
        JOIN agents a ON a.id = j.agent_id
        WHERE j.enabled = 1
          AND a.deleted_at IS NULL
          AND j.next_run_at::timestamptz <= CURRENT_TIMESTAMP
        ORDER BY j.next_run_at::timestamptz ASC, j.id ASC
        LIMIT $1
        "#,
    )
    .bind(limit.max(1))
    .fetch_all(pool)
    .await?;

    let mut queued_count = 0;
    for job in due_jobs {
        match queue_cron_job(pool, &job, "cron", "cron", false).await {
            Ok(run_id) => {
                mark_cron_job_queued(pool, &job, &run_id).await?;
                supervisor.wake();
                queued_count += 1;
            }
            Err(status) => {
                mark_cron_job_failed(pool, &job.id, status).await?;
            }
        }
    }

    Ok(queued_count)
}

#[get("/agents/<agent_id>/cron-jobs")]
async fn list_agent_jobs(
    pool: &State<DbPool>,
    agent_id: &str,
) -> Result<Json<Vec<CronJobResponse>>, Status> {
    if !agent_exists(pool.inner(), agent_id).await? {
        return Err(Status::NotFound);
    }

    let rows = sqlx::query_as::<_, CronJobRow>(
        r#"
        SELECT *
        FROM agent_cron_jobs
        WHERE agent_id = $1
        ORDER BY enabled DESC, next_run_at::timestamptz ASC, title ASC
        "#,
    )
    .bind(agent_id)
    .fetch_all(pool.inner())
    .await
    .map_err(|_| Status::InternalServerError)?;

    Ok(Json(rows.into_iter().map(cron_job_response).collect()))
}

#[post("/agents/<agent_id>/cron-jobs", data = "<payload>")]
async fn create_agent_job(
    pool: &State<DbPool>,
    agent_id: &str,
    payload: Json<CreateCronJobRequest>,
) -> Result<Json<CronJobResponse>, Status> {
    if !agent_exists(pool.inner(), agent_id).await? {
        return Err(Status::NotFound);
    }

    let id = Uuid::new_v4().to_string();
    let title = required_text(&payload.title, MAX_TITLE_BYTES)?;
    let prompt = required_text(&payload.prompt, MAX_PROMPT_BYTES)?;
    let schedule = checked_schedule(
        payload
            .schedule_kind
            .as_deref()
            .unwrap_or(SCHEDULE_INTERVAL),
        payload.interval_minutes,
        payload.time_of_day.as_deref(),
    )?;
    let enabled = payload.enabled.unwrap_or(true);

    sqlx::query(
        r#"
        INSERT INTO agent_cron_jobs (
            id,
            agent_id,
            title,
            prompt,
            interval_minutes,
            schedule_kind,
            time_of_day,
            timezone,
            enabled,
            next_run_at,
            created_at,
            updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP::text, CURRENT_TIMESTAMP::text)
        "#,
    )
    .bind(&id)
    .bind(agent_id)
    .bind(&title)
    .bind(&prompt)
    .bind(schedule.interval_minutes)
    .bind(&schedule.kind)
    .bind(&schedule.time_of_day)
    .bind(&schedule.timezone)
    .bind(enabled_to_int(enabled))
    .bind(&schedule.next_run_at)
    .execute(pool.inner())
    .await
    .map_err(database_write_status)?;

    fetch_cron_job(pool.inner(), &id).await.map(Json)
}

#[patch("/cron-jobs/<id>", data = "<payload>")]
async fn update_job(
    pool: &State<DbPool>,
    id: &str,
    payload: Json<UpdateCronJobRequest>,
) -> Result<Json<CronJobResponse>, Status> {
    let current = fetch_cron_job_row(pool.inner(), id).await?;
    let title = optional_text(payload.title.as_deref(), MAX_TITLE_BYTES)?;
    let prompt = optional_text(payload.prompt.as_deref(), MAX_PROMPT_BYTES)?;
    let interval_minutes = match payload.interval_minutes {
        Some(value) => Some(checked_interval(value)?),
        None => None,
    };

    if title.is_none()
        && prompt.is_none()
        && interval_minutes.is_none()
        && payload.schedule_kind.is_none()
        && payload.time_of_day.is_none()
        && payload.enabled.is_none()
    {
        return Err(Status::BadRequest);
    }

    let next_title = title.unwrap_or_else(|| current.title.clone());
    let next_prompt = prompt.unwrap_or_else(|| current.prompt.clone());
    let next_kind = match payload.schedule_kind.as_deref() {
        Some(value) => checked_schedule_kind(value)?,
        None => current.schedule_kind.clone(),
    };
    let next_time_input = payload
        .time_of_day
        .as_deref()
        .or_else(|| (next_kind == current.schedule_kind).then_some(current.time_of_day.as_str()));
    let schedule = checked_schedule(
        &next_kind,
        Some(interval_minutes.unwrap_or(i64::from(current.interval_minutes))),
        next_time_input,
    )?;
    let next_enabled = payload.enabled.unwrap_or(current.enabled != 0);
    let schedule_changed = schedule.kind != current.schedule_kind
        || schedule.interval_minutes != i64::from(current.interval_minutes)
        || schedule.time_of_day != current.time_of_day;
    let next_run_at = if schedule_changed || payload.enabled == Some(true) {
        schedule.next_run_at.clone()
    } else {
        current.next_run_at.clone()
    };
    let last_error = if payload.enabled == Some(true) {
        String::new()
    } else {
        current.last_error.clone()
    };

    let result = sqlx::query(
        r#"
        UPDATE agent_cron_jobs
        SET title = $1,
            prompt = $2,
            interval_minutes = $3,
            schedule_kind = $4,
            time_of_day = $5,
            timezone = $6,
            enabled = $7,
            next_run_at = $8,
            last_error = $9,
            updated_at = CURRENT_TIMESTAMP::text
        WHERE id = $10
        "#,
    )
    .bind(&next_title)
    .bind(&next_prompt)
    .bind(schedule.interval_minutes)
    .bind(&schedule.kind)
    .bind(&schedule.time_of_day)
    .bind(&schedule.timezone)
    .bind(enabled_to_int(next_enabled))
    .bind(&next_run_at)
    .bind(&last_error)
    .bind(id)
    .execute(pool.inner())
    .await
    .map_err(database_write_status)?;

    if result.rows_affected() == 0 {
        return Err(Status::NotFound);
    }

    fetch_cron_job(pool.inner(), id).await.map(Json)
}

#[post("/cron-jobs/<id>/run-now")]
async fn run_job_now(
    pool: &State<DbPool>,
    supervisor: &State<RunSupervisor>,
    id: &str,
) -> Result<Json<CronJobResponse>, Status> {
    let job = fetch_queueable_cron_job(pool.inner(), id).await?;
    match queue_cron_job(pool.inner(), &job, "cron-manual", "owner", true).await {
        Ok(run_id) => {
            mark_cron_job_manual_queued(pool.inner(), &job.id, &run_id)
                .await
                .map_err(|_| Status::InternalServerError)?;
            supervisor.wake();
        }
        Err(status) => {
            mark_cron_job_manual_failed(pool.inner(), &job.id, status)
                .await
                .map_err(|_| Status::InternalServerError)?;
            return Err(status);
        }
    }

    fetch_cron_job(pool.inner(), id).await.map(Json)
}

#[delete("/cron-jobs/<id>")]
async fn delete_job(pool: &State<DbPool>, id: &str) -> Status {
    match sqlx::query("DELETE FROM agent_cron_jobs WHERE id = $1")
        .bind(id)
        .execute(pool.inner())
        .await
    {
        Ok(result) if result.rows_affected() > 0 => Status::NoContent,
        Ok(_) => Status::NotFound,
        Err(_) => Status::InternalServerError,
    }
}

async fn fetch_cron_job(pool: &DbPool, id: &str) -> Result<CronJobResponse, Status> {
    fetch_cron_job_row(pool, id).await.map(cron_job_response)
}

async fn fetch_cron_job_row(pool: &DbPool, id: &str) -> Result<CronJobRow, Status> {
    sqlx::query_as::<_, CronJobRow>("SELECT * FROM agent_cron_jobs WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|_| Status::InternalServerError)?
        .ok_or(Status::NotFound)
}

async fn fetch_queueable_cron_job(pool: &DbPool, id: &str) -> Result<DueCronJob, Status> {
    sqlx::query_as::<_, DueCronJob>(
        r#"
        SELECT j.id, j.agent_id, j.title, j.prompt, j.interval_minutes, j.schedule_kind, j.time_of_day
        FROM agent_cron_jobs j
        JOIN agents a ON a.id = j.agent_id
        WHERE j.id = $1
          AND a.deleted_at IS NULL
        "#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(|_| Status::InternalServerError)?
    .ok_or(Status::NotFound)
}

async fn queue_cron_job(
    pool: &DbPool,
    job: &DueCronJob,
    trigger_kind: &str,
    queued_by: &str,
    manual: bool,
) -> Result<String, Status> {
    let queued = queue_agent_run(
        pool,
        QueueAgentRunInput {
            agent_id: job.agent_id.clone(),
            prompt: cron_prompt(job, manual),
            workspace: None,
            conversation_id: Some(format!("dm_{}", job.agent_id)),
            trigger_kind: trigger_kind.to_string(),
            branch: String::new(),
            queue_priority: RUN_PRIORITY_NORMAL,
            queued_by: queued_by.to_string(),
        },
    )
    .await?;

    insert_cron_dm_message(pool, job, &queued.run.id, manual)
        .await
        .map_err(database_write_status)?;

    Ok(queued.run.id)
}

async fn insert_cron_dm_message(
    pool: &DbPool,
    job: &DueCronJob,
    run_id: &str,
    manual: bool,
) -> Result<(), sqlx::Error> {
    let conversation_id = format!("dm_{}", job.agent_id);
    let message_id = Uuid::new_v4().to_string();
    let body = cron_dm_message_body(job, manual);
    let search_title = format!("Cron job in {}", job.title.trim());
    let mut tx = pool.begin().await?;

    sqlx::query(
        r#"
        INSERT INTO messages (id, conversation_id, author_kind, author_id, body, run_id)
        VALUES ($1, $2, 'system', 'cron', $3, $4)
        "#,
    )
    .bind(&message_id)
    .bind(&conversation_id)
    .bind(&body)
    .bind(run_id)
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
    .bind(&body)
    .execute(&mut *tx)
    .await?;

    sqlx::query("UPDATE conversations SET updated_at = CURRENT_TIMESTAMP::text WHERE id = $1")
        .bind(&conversation_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(())
}

async fn mark_cron_job_queued(
    pool: &DbPool,
    job: &DueCronJob,
    run_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE agent_cron_jobs
        SET last_queued_at = CURRENT_TIMESTAMP::text,
            last_run_id = $1,
            last_error = '',
            next_run_at = $2,
            updated_at = CURRENT_TIMESTAMP::text
        WHERE id = $3
        "#,
    )
    .bind(run_id)
    .bind(next_run_at_for_job(job).map_err(|_| sqlx::Error::RowNotFound)?)
    .bind(&job.id)
    .execute(pool)
    .await?;

    Ok(())
}

async fn mark_cron_job_manual_queued(
    pool: &DbPool,
    job_id: &str,
    run_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE agent_cron_jobs
        SET last_queued_at = CURRENT_TIMESTAMP::text,
            last_run_id = $1,
            last_error = '',
            updated_at = CURRENT_TIMESTAMP::text
        WHERE id = $2
        "#,
    )
    .bind(run_id)
    .bind(job_id)
    .execute(pool)
    .await?;

    Ok(())
}

async fn mark_cron_job_manual_failed(
    pool: &DbPool,
    job_id: &str,
    status: Status,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE agent_cron_jobs
        SET last_error = $1,
            updated_at = CURRENT_TIMESTAMP::text
        WHERE id = $2
        "#,
    )
    .bind(format!("manual queue failed: {}", status.code))
    .bind(job_id)
    .execute(pool)
    .await?;

    Ok(())
}

async fn mark_cron_job_failed(
    pool: &DbPool,
    job_id: &str,
    status: Status,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE agent_cron_jobs
        SET last_error = $1,
            next_run_at = (CURRENT_TIMESTAMP + ($2::BIGINT * INTERVAL '1 minute'))::text,
            updated_at = CURRENT_TIMESTAMP::text
        WHERE id = $3
        "#,
    )
    .bind(format!("queue failed: {}", status.code))
    .bind(FAILURE_RETRY_MINUTES)
    .bind(job_id)
    .execute(pool)
    .await?;

    Ok(())
}

async fn agent_exists(pool: &DbPool, agent_id: &str) -> Result<bool, Status> {
    let count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM agents WHERE id = $1 AND deleted_at IS NULL",
    )
    .bind(agent_id)
    .fetch_one(pool)
    .await
    .map_err(|_| Status::InternalServerError)?;

    Ok(count > 0)
}

fn cron_prompt(job: &DueCronJob, manual: bool) -> String {
    let prefix = if manual {
        "Manual cron job run"
    } else {
        "Scheduled cron job"
    };
    format!("{}: {}\n\n{}", prefix, job.title.trim(), job.prompt.trim())
}

fn cron_dm_message_body(job: &DueCronJob, manual: bool) -> String {
    let prefix = if manual {
        "Manual cron job queued"
    } else {
        "Scheduled cron job queued"
    };

    format!(
        "**{}:** {}\n\n{}",
        prefix,
        job.title.trim(),
        job.prompt.trim()
    )
}

fn cron_job_response(row: CronJobRow) -> CronJobResponse {
    CronJobResponse {
        id: row.id,
        agent_id: row.agent_id,
        title: row.title,
        prompt: row.prompt,
        interval_minutes: i64::from(row.interval_minutes),
        schedule_kind: row.schedule_kind,
        time_of_day: row.time_of_day,
        timezone: row.timezone,
        enabled: row.enabled != 0,
        next_run_at: row.next_run_at,
        last_queued_at: row.last_queued_at,
        last_run_id: row.last_run_id,
        last_error: row.last_error,
        created_at: row.created_at,
        updated_at: row.updated_at,
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
        return Err(Status::BadRequest);
    }
    if value.len() > max_bytes {
        return Err(Status::BadRequest);
    }

    Ok(Some(value.to_string()))
}

fn checked_interval(interval_minutes: i64) -> Result<i64, Status> {
    if (1..=MAX_INTERVAL_MINUTES).contains(&interval_minutes) {
        Ok(interval_minutes)
    } else {
        Err(Status::BadRequest)
    }
}

fn checked_schedule(
    schedule_kind: &str,
    interval_minutes: Option<i64>,
    time_of_day: Option<&str>,
) -> Result<CronSchedule, Status> {
    let kind = checked_schedule_kind(schedule_kind)?;
    let interval_minutes = match kind.as_str() {
        SCHEDULE_INTERVAL => checked_interval(interval_minutes.ok_or(Status::BadRequest)?)?,
        SCHEDULE_DAILY_TIME => {
            checked_interval(interval_minutes.unwrap_or(DEFAULT_DAILY_INTERVAL_MINUTES))?
        }
        _ => return Err(Status::BadRequest),
    };
    let time_of_day = checked_time_of_day(&kind, time_of_day)?;
    let next_run_at = next_run_at(&kind, interval_minutes, &time_of_day)?;

    Ok(CronSchedule {
        kind,
        interval_minutes,
        time_of_day,
        timezone: CRON_TIMEZONE_LABEL.to_string(),
        next_run_at,
    })
}

fn checked_schedule_kind(value: &str) -> Result<String, Status> {
    match value.trim() {
        SCHEDULE_INTERVAL => Ok(SCHEDULE_INTERVAL.to_string()),
        SCHEDULE_DAILY_TIME => Ok(SCHEDULE_DAILY_TIME.to_string()),
        _ => Err(Status::BadRequest),
    }
}

fn checked_time_of_day(schedule_kind: &str, value: Option<&str>) -> Result<String, Status> {
    if schedule_kind == SCHEDULE_INTERVAL {
        return Ok(String::new());
    }

    let value = value.ok_or(Status::BadRequest)?.trim();
    if parse_time_of_day(value).is_some() {
        Ok(value.to_string())
    } else {
        Err(Status::BadRequest)
    }
}

fn parse_time_of_day(value: &str) -> Option<NaiveTime> {
    if value.len() != 5 {
        return None;
    }

    NaiveTime::parse_from_str(value, "%H:%M").ok()
}

fn next_run_at(
    schedule_kind: &str,
    interval_minutes: i64,
    time_of_day: &str,
) -> Result<String, Status> {
    match schedule_kind {
        SCHEDULE_INTERVAL => {
            Ok((Utc::now() + ChronoDuration::minutes(interval_minutes)).to_rfc3339())
        }
        SCHEDULE_DAILY_TIME => daily_next_run_at_after(time_of_day, Utc::now()),
        _ => Err(Status::BadRequest),
    }
}

fn next_run_at_for_job(job: &DueCronJob) -> Result<String, Status> {
    next_run_at(
        &job.schedule_kind,
        i64::from(job.interval_minutes),
        &job.time_of_day,
    )
}

fn daily_next_run_at_after(time_of_day: &str, now_utc: DateTime<Utc>) -> Result<String, Status> {
    let time = parse_time_of_day(time_of_day).ok_or(Status::BadRequest)?;
    let offset =
        FixedOffset::east_opt(PDT_UTC_OFFSET_SECONDS).ok_or(Status::InternalServerError)?;
    let now_pdt = now_utc.with_timezone(&offset);
    let today_at_time = now_pdt.date_naive().and_time(time);
    let scheduled_today = offset
        .from_local_datetime(&today_at_time)
        .single()
        .ok_or(Status::InternalServerError)?;
    let scheduled = if scheduled_today <= now_pdt {
        scheduled_today + ChronoDuration::days(1)
    } else {
        scheduled_today
    };

    Ok(scheduled.with_timezone(&Utc).to_rfc3339())
}

fn enabled_to_int(enabled: bool) -> i32 {
    if enabled { 1 } else { 0 }
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
        list_agent_jobs,
        create_agent_job,
        update_job,
        run_job_now,
        delete_job
    ]
}

#[cfg(test)]
mod tests {
    use super::{daily_next_run_at_after, queue_due_cron_jobs};
    use crate::db::DbPool;
    use crate::db::init_database;
    use crate::runtime::RunSupervisor;
    use chrono::{TimeZone, Utc};
    use tempfile::TempDir;

    struct TestDb {
        _db_dir: TempDir,
        pool: DbPool,
    }

    #[tokio::test]
    async fn due_cron_job_queues_agent_run_and_advances_schedule() {
        let db = test_db().await;
        seed_agent(&db.pool).await;

        sqlx::query(
            r#"
            INSERT INTO agent_cron_jobs (
                id, agent_id, title, prompt, interval_minutes, enabled, next_run_at
            )
            VALUES ('cron_daily_summary', 'agent_cron_test', 'Daily summary', 'Write yesterday work into the wiki.', 60, 1, (CURRENT_TIMESTAMP - INTERVAL '1 minute')::text)
            "#,
        )
        .execute(&db.pool)
        .await
        .expect("seed cron job");

        let queued = queue_due_cron_jobs(&db.pool, &RunSupervisor::new(), 10)
            .await
            .expect("queue due jobs");

        assert_eq!(queued, 1);

        let run = sqlx::query_as::<_, (String, String, String, String)>(
            "SELECT id, trigger_kind, queued_by, prompt FROM agent_runs WHERE agent_id = 'agent_cron_test'",
        )
        .fetch_one(&db.pool)
        .await
        .expect("queued run");

        assert_eq!(run.1, "cron");
        assert_eq!(run.2, "cron");
        assert!(run.3.contains("Scheduled cron job: Daily summary"));
        assert!(run.3.contains("Write yesterday work into the wiki."));

        let message = sqlx::query_as::<_, (String, String, String, String)>(
            r#"
            SELECT author_kind, author_id, body, run_id
            FROM messages
            WHERE conversation_id = 'dm_agent_cron_test'
            ORDER BY created_at DESC, id DESC
            LIMIT 1
            "#,
        )
        .fetch_one(&db.pool)
        .await
        .expect("cron dm message");

        assert_eq!(message.0, "system");
        assert_eq!(message.1, "cron");
        assert!(message.2.contains("Scheduled cron job queued"));
        assert!(message.2.contains("Daily summary"));
        assert!(message.2.contains("Write yesterday work into the wiki."));
        assert_eq!(message.3, run.0);

        let job = sqlx::query_as::<_, (String, Option<String>, String)>(
            "SELECT id, last_run_id, last_error FROM agent_cron_jobs WHERE id = 'cron_daily_summary'",
        )
        .fetch_one(&db.pool)
        .await
        .expect("updated cron job");

        assert_eq!(job.1.as_deref(), Some(run.0.as_str()));
        assert_eq!(job.2, "");
    }

    #[test]
    fn daily_schedule_uses_next_pdt_time_today_when_possible() {
        let now = Utc.with_ymd_and_hms(2026, 4, 28, 15, 0, 0).unwrap();
        let next = daily_next_run_at_after("09:30", now).expect("next daily run");

        assert_eq!(next, "2026-04-28T16:30:00+00:00");
    }

    #[test]
    fn daily_schedule_rolls_to_tomorrow_after_pdt_time_passes() {
        let now = Utc.with_ymd_and_hms(2026, 4, 28, 17, 0, 0).unwrap();
        let next = daily_next_run_at_after("09:30", now).expect("next daily run");

        assert_eq!(next, "2026-04-29T16:30:00+00:00");
    }

    async fn test_db() -> TestDb {
        let db_dir = tempfile::tempdir().expect("database tempdir");
        let _db_path = db_dir.path().join("agent_adda_cron_test.db");
        let database_url = std::env::var("AGENT_ADDA_TEST_DATABASE_URL").unwrap_or_else(|_| {
            "postgres://agent_adda:agent_adda@127.0.0.1:15432/agent_adda_test".to_string()
        });
        let pool = init_database(&database_url)
            .await
            .expect("database initialization should succeed");

        TestDb {
            _db_dir: db_dir,
            pool,
        }
    }

    async fn seed_agent(pool: &DbPool) {
        sqlx::query("DELETE FROM agent_cron_jobs WHERE agent_id = 'agent_cron_test'")
            .execute(pool)
            .await
            .expect("clear cron jobs");
        sqlx::query("DELETE FROM agent_runs WHERE agent_id = 'agent_cron_test'")
            .execute(pool)
            .await
            .expect("clear runs");
        sqlx::query("DELETE FROM conversations WHERE id = 'dm_agent_cron_test'")
            .execute(pool)
            .await
            .expect("clear dm");
        sqlx::query("DELETE FROM agents WHERE id = 'agent_cron_test'")
            .execute(pool)
            .await
            .expect("clear agent");

        sqlx::query(
            r#"
            INSERT INTO agents (id, name, slug, role, description, system_prompt)
            VALUES ('agent_cron_test', 'Cron Agent', 'cron-agent', 'Researcher', 'Runs scheduled jobs.', 'You run scheduled jobs.')
            "#,
        )
        .execute(pool)
        .await
        .expect("seed agent");

        sqlx::query(
            r#"
            INSERT INTO conversations (id, kind, name, slug, topic)
            VALUES ('dm_agent_cron_test', 'dm', 'Cron Agent', 'cron-agent-dm', 'Direct message with Cron Agent')
            "#,
        )
        .execute(pool)
        .await
        .expect("seed dm");
    }
}
