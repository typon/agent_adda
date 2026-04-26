#[macro_use]
extern crate rocket;

mod agent_communications;
mod codex;
mod cors;
mod db;
mod github;
mod models;
mod orchestrator;
mod routes;
mod runtime;
mod wiki;

use db::init_database;
use routes::{
    agents, conversations, cron_jobs, events, github_routes, health, onboarding, search, settings,
    stats, wiki_routes,
};
use runtime::{RunSupervisor, supervise_runs};

#[launch]
async fn rocket() -> _ {
    let database_url = std::env::var("AGENT_ADDA_DATABASE_URL").unwrap_or_else(|_| {
        "postgres://agent_adda:agent_adda@127.0.0.1:15432/agent_adda".to_string()
    });

    let pool = init_database(&database_url)
        .await
        .expect("database initialization should succeed");
    let run_supervisor = RunSupervisor::new();
    rocket::tokio::spawn(supervise_runs(pool.clone(), run_supervisor.clone()));
    rocket::tokio::spawn(cron_jobs::supervise_cron_jobs(
        pool.clone(),
        run_supervisor.clone(),
    ));

    rocket::build()
        .manage(pool)
        .manage(run_supervisor)
        .attach(cors::Cors)
        .mount("/api/v1", health::routes())
        .mount("/api/v1", agents::routes())
        .mount("/api/v1", conversations::routes())
        .mount("/api/v1", wiki_routes::routes())
        .mount("/api/v1", search::routes())
        .mount("/api/v1", github_routes::routes())
        .mount("/api/v1", onboarding::routes())
        .mount("/api/v1", cron_jobs::routes())
        .mount("/api/v1", stats::routes())
        .mount("/api/v1", settings::routes())
        .mount("/api/v1", events::routes())
}
