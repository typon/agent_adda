use crate::db::DbPool;
use rocket::State;
use rocket::http::Status;
use rocket::serde::json::Json;
use rocket::{Route, get, routes};
use serde::Serialize;
use sqlx::FromRow;

#[derive(Debug, Serialize, FromRow)]
struct AgentStats {
    agent_id: String,
    name: String,
    status: String,
    input_tokens: i64,
    cached_input_tokens: i64,
    output_tokens: i64,
    reasoning_tokens: i64,
    total_tokens: i64,
    run_count: i64,
    pull_requests: i64,
    merged_pull_requests: i64,
    reviews: i64,
}

#[derive(Debug, Serialize, FromRow)]
struct TokenStats {
    agent_id: String,
    agent_name: String,
    model: String,
    input_tokens: i64,
    cached_input_tokens: i64,
    output_tokens: i64,
    reasoning_tokens: i64,
    total_tokens: i64,
}

#[derive(Debug, Serialize, FromRow)]
struct PullRequestStats {
    agent_id: String,
    agent_name: String,
    status: String,
    count: i64,
}

#[derive(Debug, Serialize, FromRow)]
struct ReviewStats {
    agent_id: String,
    agent_name: String,
    decision: String,
    count: i64,
}

#[derive(Debug, Serialize, FromRow)]
struct RunStats {
    status: String,
    count: i64,
}

#[derive(Debug, Serialize)]
struct StatsSummary {
    input_tokens: i64,
    output_tokens: i64,
    total_tokens: i64,
    chatgpt_quota_used: i64,
    chatgpt_quota_total: i64,
    tasks_in_flight: i64,
    active_runs: i64,
    queued_runs: i64,
    pull_requests_merged: i64,
    employees: i64,
}

#[derive(Debug, FromRow)]
struct TokenTotals {
    input_tokens: i64,
    output_tokens: i64,
    total_tokens: i64,
}

#[derive(Debug, FromRow)]
struct RunFlightTotals {
    active_runs: i64,
    queued_runs: i64,
}

#[derive(Debug, Serialize)]
struct EmployeeGrowthStats {
    period: String,
    hired_count: i64,
    employee_count: i64,
}

#[derive(Debug, FromRow)]
struct EmployeeHireRow {
    period: String,
    hired_count: i64,
}

#[get("/stats/agents")]
async fn agents(pool: &State<DbPool>) -> Result<Json<Vec<AgentStats>>, Status> {
    let stats = sqlx::query_as::<_, AgentStats>(
        "SELECT a.id AS agent_id,
                a.name,
                a.status,
                COALESCE(tokens.input_tokens, 0) AS input_tokens,
                COALESCE(tokens.cached_input_tokens, 0) AS cached_input_tokens,
                COALESCE(tokens.output_tokens, 0) AS output_tokens,
                COALESCE(tokens.reasoning_tokens, 0) AS reasoning_tokens,
                COALESCE(tokens.total_tokens, 0) AS total_tokens,
                COALESCE(runs.run_count, 0) AS run_count,
                COALESCE(prs.pull_requests, 0) AS pull_requests,
                COALESCE(merged_prs.merged_pull_requests, 0) AS merged_pull_requests,
                COALESCE(reviews.reviews, 0) AS reviews
         FROM agents a
         LEFT JOIN (
             SELECT agent_id,
                    SUM(input_tokens) AS input_tokens,
                    SUM(cached_input_tokens) AS cached_input_tokens,
                    SUM(output_tokens) AS output_tokens,
                    SUM(reasoning_tokens) AS reasoning_tokens,
                    SUM(total_tokens) AS total_tokens
             FROM token_usage
             GROUP BY agent_id
         ) tokens ON tokens.agent_id = a.id
         LEFT JOIN (
             SELECT agent_id, COUNT(*) AS run_count
             FROM agent_runs
             GROUP BY agent_id
         ) runs ON runs.agent_id = a.id
         LEFT JOIN (
             SELECT author_agent_id AS agent_id, COUNT(*) AS pull_requests
             FROM pull_requests
             WHERE author_agent_id IS NOT NULL
             GROUP BY author_agent_id
         ) prs ON prs.agent_id = a.id
         LEFT JOIN (
             SELECT author_agent_id AS agent_id, COUNT(*) AS merged_pull_requests
             FROM pull_requests
             WHERE author_agent_id IS NOT NULL
               AND (merged_at IS NOT NULL OR lower(status) = 'merged')
             GROUP BY author_agent_id
         ) merged_prs ON merged_prs.agent_id = a.id
         LEFT JOIN (
             SELECT reviewer_agent_id AS agent_id, COUNT(*) AS reviews
             FROM pr_reviews
             WHERE reviewer_agent_id IS NOT NULL
             GROUP BY reviewer_agent_id
         ) reviews ON reviews.agent_id = a.id
         WHERE a.deleted_at IS NULL
         ORDER BY a.name",
    )
    .fetch_all(pool.inner())
    .await
    .map_err(|_| Status::InternalServerError)?;

    Ok(Json(stats))
}

#[get("/stats/tokens")]
async fn tokens(pool: &State<DbPool>) -> Result<Json<Vec<TokenStats>>, Status> {
    let stats = sqlx::query_as::<_, TokenStats>(
        "SELECT t.agent_id,
                COALESCE(a.name, 'Unknown agent') AS agent_name,
                t.model,
                COALESCE(SUM(t.input_tokens), 0) AS input_tokens,
                COALESCE(SUM(t.cached_input_tokens), 0) AS cached_input_tokens,
                COALESCE(SUM(t.output_tokens), 0) AS output_tokens,
                COALESCE(SUM(t.reasoning_tokens), 0) AS reasoning_tokens,
                COALESCE(SUM(t.total_tokens), 0) AS total_tokens
         FROM token_usage t
         LEFT JOIN agents a ON a.id = t.agent_id
         GROUP BY t.agent_id, a.name, t.model
         ORDER BY total_tokens DESC, agent_name",
    )
    .fetch_all(pool.inner())
    .await
    .map_err(|_| Status::InternalServerError)?;

    Ok(Json(stats))
}

#[get("/stats/prs")]
async fn prs(pool: &State<DbPool>) -> Result<Json<Vec<PullRequestStats>>, Status> {
    let stats = sqlx::query_as::<_, PullRequestStats>(
        "SELECT COALESCE(pr.author_agent_id, '') AS agent_id,
                COALESCE(a.name, 'Unassigned') AS agent_name,
                CASE
                    WHEN pr.merged_at IS NOT NULL OR lower(pr.status) = 'merged' THEN 'merged'
                    WHEN pr.status = '' THEN 'unknown'
                    ELSE pr.status
                END AS status,
                COUNT(*) AS count
         FROM pull_requests pr
         LEFT JOIN agents a ON a.id = pr.author_agent_id
         GROUP BY pr.author_agent_id,
                  a.name,
                  CASE
                      WHEN pr.merged_at IS NOT NULL OR lower(pr.status) = 'merged' THEN 'merged'
                      WHEN pr.status = '' THEN 'unknown'
                      ELSE pr.status
                  END
         ORDER BY count DESC",
    )
    .fetch_all(pool.inner())
    .await
    .map_err(|_| Status::InternalServerError)?;

    Ok(Json(stats))
}

#[get("/stats/reviews")]
async fn reviews(pool: &State<DbPool>) -> Result<Json<Vec<ReviewStats>>, Status> {
    let stats = sqlx::query_as::<_, ReviewStats>(
        "SELECT COALESCE(rv.reviewer_agent_id, '') AS agent_id,
                COALESCE(a.name, 'Unassigned') AS agent_name,
                rv.decision,
                COUNT(*) AS count
         FROM pr_reviews rv
         LEFT JOIN agents a ON a.id = rv.reviewer_agent_id
         GROUP BY rv.reviewer_agent_id, a.name, rv.decision
         ORDER BY count DESC",
    )
    .fetch_all(pool.inner())
    .await
    .map_err(|_| Status::InternalServerError)?;

    Ok(Json(stats))
}

#[get("/stats/runs")]
async fn runs(pool: &State<DbPool>) -> Result<Json<Vec<RunStats>>, Status> {
    let stats = sqlx::query_as::<_, RunStats>(
        "SELECT status, COUNT(*) AS count
         FROM agent_runs
         GROUP BY status
         ORDER BY count DESC",
    )
    .fetch_all(pool.inner())
    .await
    .map_err(|_| Status::InternalServerError)?;

    Ok(Json(stats))
}

#[get("/stats/summary")]
async fn summary(pool: &State<DbPool>) -> Result<Json<StatsSummary>, Status> {
    let token_totals = sqlx::query_as::<_, TokenTotals>(
        "SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(total_tokens), 0) AS total_tokens
         FROM token_usage",
    )
    .fetch_one(pool.inner())
    .await
    .map_err(|_| Status::InternalServerError)?;

    let chatgpt_quota_used = sqlx::query_scalar::<_, i64>(
        "SELECT COALESCE(SUM(total_tokens), 0)
         FROM token_usage
         WHERE date(created_at) = date('now')",
    )
    .fetch_one(pool.inner())
    .await
    .map_err(|_| Status::InternalServerError)?;

    let chatgpt_quota_total = read_i64_setting(pool.inner(), "daily_token_budget").await?;

    let run_totals = sqlx::query_as::<_, RunFlightTotals>(
        "SELECT COALESCE(SUM(CASE
                    WHEN lower(status) IN ('running', 'working', 'in-progress', 'in_progress') THEN 1
                    ELSE 0
                END), 0) AS active_runs,
                COALESCE(SUM(CASE
                    WHEN lower(status) IN ('queued', 'pending', 'planned') THEN 1
                    ELSE 0
                END), 0) AS queued_runs
         FROM agent_runs",
    )
    .fetch_one(pool.inner())
    .await
    .map_err(|_| Status::InternalServerError)?;

    let pull_requests_merged = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*)
         FROM pull_requests
         WHERE merged_at IS NOT NULL OR lower(status) = 'merged'",
    )
    .fetch_one(pool.inner())
    .await
    .map_err(|_| Status::InternalServerError)?;

    let employees = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*)
         FROM agents
         WHERE deleted_at IS NULL",
    )
    .fetch_one(pool.inner())
    .await
    .map_err(|_| Status::InternalServerError)?;

    Ok(Json(StatsSummary {
        input_tokens: token_totals.input_tokens,
        output_tokens: token_totals.output_tokens,
        total_tokens: token_totals.total_tokens,
        chatgpt_quota_used,
        chatgpt_quota_total,
        tasks_in_flight: run_totals.active_runs + run_totals.queued_runs,
        active_runs: run_totals.active_runs,
        queued_runs: run_totals.queued_runs,
        pull_requests_merged,
        employees,
    }))
}

#[get("/stats/employees-over-time")]
async fn employees_over_time(
    pool: &State<DbPool>,
) -> Result<Json<Vec<EmployeeGrowthStats>>, Status> {
    let hires = sqlx::query_as::<_, EmployeeHireRow>(
        "SELECT date(created_at) AS period, COUNT(*) AS hired_count
         FROM agents
         WHERE deleted_at IS NULL
         GROUP BY date(created_at)
         ORDER BY period",
    )
    .fetch_all(pool.inner())
    .await
    .map_err(|_| Status::InternalServerError)?;

    let mut employee_count = 0;
    let stats = hires
        .into_iter()
        .map(|row| {
            employee_count += row.hired_count;
            EmployeeGrowthStats {
                period: row.period,
                hired_count: row.hired_count,
                employee_count,
            }
        })
        .collect();

    Ok(Json(stats))
}

async fn read_i64_setting(pool: &DbPool, key: &str) -> Result<i64, Status> {
    let value = sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = $1")
        .bind(key)
        .fetch_optional(pool)
        .await
        .map_err(|_| Status::InternalServerError)?;

    Ok(value
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .unwrap_or(0))
}

pub fn routes() -> Vec<Route> {
    routes![
        agents,
        tokens,
        prs,
        reviews,
        runs,
        summary,
        employees_over_time
    ]
}
