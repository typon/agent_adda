use crate::db::DbPool;
use crate::models::{SearchRequest, SearchResult};
use rocket::State;
use rocket::http::Status;
use rocket::serde::json::Json;
use rocket::{Route, get, post, routes};
use serde::Serialize;

const MAX_SEARCH_QUERY_CHARS: usize = 120;
const MAX_SEARCH_TERMS: usize = 8;
const MAX_SEARCH_TERM_CHARS: usize = 48;
const SEARCH_LIMIT: i64 = 25;

#[derive(Debug, Serialize)]
struct AppCommand {
    id: String,
    title: String,
    description: String,
    shortcut: Option<String>,
}

#[derive(Debug, Serialize)]
struct CommandResult {
    id: String,
    status: String,
}

#[post("/search", data = "<request>")]
async fn global_search(
    pool: &State<DbPool>,
    request: Json<SearchRequest>,
) -> Result<Json<Vec<SearchResult>>, Status> {
    let query = bounded_query(&request.query);
    if query.is_empty() {
        return Ok(Json(Vec::new()));
    }
    let like_query = format!("%{}%", escape_like(&query));

    let results = sqlx::query_as::<_, SearchResult>(
        r#"
        SELECT entity_type,
               entity_id,
               title,
               COALESCE(substr(body, 1, 240), '') AS body
        FROM search_index
        WHERE to_tsvector('simple', title || ' ' || body) @@ plainto_tsquery('simple', $1)
           OR title ILIKE $2 ESCAPE '\'
           OR body ILIKE $2 ESCAPE '\'
        ORDER BY
          CASE WHEN title ILIKE $2 ESCAPE '\' THEN 0 ELSE 1 END,
          ts_rank_cd(to_tsvector('simple', title || ' ' || body), plainto_tsquery('simple', $1)) DESC,
          title ASC
        LIMIT $3
        "#,
    )
    .bind(&query)
    .bind(&like_query)
    .bind(SEARCH_LIMIT)
    .fetch_all(pool.inner())
    .await
    .map_err(|_| Status::InternalServerError)?;

    Ok(Json(results))
}

#[get("/commands")]
async fn commands() -> Json<Vec<AppCommand>> {
    Json(vec![
        AppCommand {
            id: "new-employee".to_string(),
            title: "New Employee".to_string(),
            description: "Create a new agent employee".to_string(),
            shortcut: Some("Cmd+N".to_string()),
        },
        AppCommand {
            id: "new-channel".to_string(),
            title: "New Channel".to_string(),
            description: "Create a new collaboration room".to_string(),
            shortcut: None,
        },
        AppCommand {
            id: "new-wiki-page".to_string(),
            title: "New Wiki Page".to_string(),
            description: "Create a page in Project Memory".to_string(),
            shortcut: Some("Cmd+E".to_string()),
        },
        AppCommand {
            id: "open-settings".to_string(),
            title: "Open Settings".to_string(),
            description: "Change model defaults and repo settings".to_string(),
            shortcut: Some("Cmd+,".to_string()),
        },
        AppCommand {
            id: "open-shortcuts".to_string(),
            title: "Open Shortcuts".to_string(),
            description: "Show keyboard shortcuts".to_string(),
            shortcut: Some("Cmd+/".to_string()),
        },
    ])
}

#[post("/commands/<id>")]
async fn run_command(id: &str) -> Result<Json<CommandResult>, Status> {
    let known = commands()
        .await
        .into_inner()
        .into_iter()
        .any(|command| command.id == id);
    if !known {
        return Err(Status::NotFound);
    }

    Ok(Json(CommandResult {
        id: id.to_string(),
        status: "accepted".to_string(),
    }))
}

fn bounded_query(query: &str) -> String {
    query.trim().chars().take(MAX_SEARCH_QUERY_CHARS).collect()
}

fn escape_like(query: &str) -> String {
    let mut escaped = String::with_capacity(query.len());
    for character in query
        .split_whitespace()
        .take(MAX_SEARCH_TERMS)
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_SEARCH_TERM_CHARS * MAX_SEARCH_TERMS)
    {
        if matches!(character, '%' | '_' | '\\') {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

pub fn routes() -> Vec<Route> {
    routes![global_search, commands, run_command]
}
