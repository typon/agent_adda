use crate::models::HealthResponse;
use crate::runtime::{RunSupervisor, RuntimeHealthSnapshot};
use rocket::State;
use rocket::serde::json::Json;

#[get("/health")]
fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        service: "agent_adda_backend",
    })
}

#[get("/health/runtime")]
fn runtime_health(supervisor: &State<RunSupervisor>) -> Json<RuntimeHealthSnapshot> {
    Json(supervisor.runtime_health())
}

#[post("/health/runtime/clear")]
fn clear_runtime_health(supervisor: &State<RunSupervisor>) -> Json<RuntimeHealthSnapshot> {
    supervisor.clear_runtime_health();
    Json(supervisor.runtime_health())
}

pub fn routes() -> Vec<rocket::Route> {
    routes![health, runtime_health, clear_runtime_health]
}
