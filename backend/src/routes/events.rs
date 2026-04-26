use crate::db::DbPool;
use chrono::Utc;
use rocket::Shutdown;
use rocket::State;
use rocket::http::Status;
use rocket::response::stream::{Event, EventStream};
use rocket::serde::json::Json;
use rocket::{Route, get, routes};
use serde::Serialize;
use serde_json::json;
use sqlx::FromRow;
use std::time::Duration;

const DEFAULT_RECENT_EVENT_LIMIT: i64 = 25;
const MAX_RECENT_EVENT_LIMIT: i64 = 100;

#[derive(Debug, Serialize, FromRow)]
struct RecentRunEvent {
    id: String,
    run_id: String,
    event_type: String,
    payload_json: String,
    created_at: String,
}

#[get("/events")]
fn events(mut shutdown: Shutdown) -> EventStream![] {
    EventStream! {
        let ready = json!({
            "type": "ready",
            "timestamp": Utc::now().to_rfc3339()
        });
        yield Event::json(&ready).event("ready");

        loop {
            rocket::tokio::select! {
                _ = rocket::tokio::time::sleep(Duration::from_secs(15)) => {
                    let payload = json!({
                        "type": "heartbeat",
                        "timestamp": Utc::now().to_rfc3339()
                    });
                    yield Event::json(&payload).event("heartbeat");
                }
                _ = &mut shutdown => {
                    break;
                }
            }
        }
    }
}

#[get("/events/recent?<limit>")]
async fn recent(
    pool: &State<DbPool>,
    limit: Option<i64>,
) -> Result<Json<Vec<RecentRunEvent>>, Status> {
    let limit = clamp_limit(limit);
    let events = sqlx::query_as::<_, RecentRunEvent>(
        "SELECT id, run_id, event_type, payload_json, created_at
         FROM run_events
         ORDER BY created_at::timestamptz DESC, id DESC
         LIMIT $1",
    )
    .bind(limit)
    .fetch_all(pool.inner())
    .await
    .map_err(|_| Status::InternalServerError)?;

    Ok(Json(events))
}

fn clamp_limit(limit: Option<i64>) -> i64 {
    match limit {
        Some(value) if value > 0 => value.min(MAX_RECENT_EVENT_LIMIT),
        _ => DEFAULT_RECENT_EVENT_LIMIT,
    }
}

pub fn routes() -> Vec<Route> {
    routes![events, recent]
}
