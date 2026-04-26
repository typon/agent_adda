use crate::db::{DbConnection, DbPool};
use crate::models::{UpsertWikiPageRequest, WikiPage, WikiRevision};
use crate::wiki::{extract_wiki_link_targets, wiki_slug};
use rocket::State;
use rocket::http::Status;
use rocket::serde::json::Json;
use serde::Serialize;
use sqlx::FromRow;
use uuid::Uuid;

const PROJECT_MEMORY_SPACE_ID: &str = "space_project_memory";

#[derive(Debug)]
struct WikiPayload {
    title: String,
    slug: String,
    body_markdown: String,
    author_kind: String,
    author_id: String,
    change_summary: String,
}

#[derive(Debug, Serialize, FromRow)]
struct WikiOutgoingLink {
    target_slug: String,
    link_text: String,
    target_page_id: Option<String>,
    target_title: Option<String>,
}

#[derive(Debug, Serialize, FromRow)]
struct WikiBacklink {
    source_page_id: String,
    source_slug: String,
    source_title: String,
    target_slug: String,
    link_text: String,
}

#[get("/wiki/pages")]
async fn list(pool: &State<DbPool>) -> Result<Json<Vec<WikiPage>>, Status> {
    sqlx::query_as::<_, WikiPage>(
        "SELECT * FROM wiki_pages WHERE archived_at IS NULL ORDER BY title ASC",
    )
    .fetch_all(pool.inner())
    .await
    .map(Json)
    .map_err(|_| Status::InternalServerError)
}

#[post("/wiki/pages", data = "<payload>")]
async fn create(
    pool: &State<DbPool>,
    payload: Json<UpsertWikiPageRequest>,
) -> Result<Json<WikiPage>, Status> {
    let payload = normalize_payload(&payload.into_inner(), "Created page")?;
    let id = Uuid::new_v4().to_string();
    let revision_id = Uuid::new_v4().to_string();
    let mut tx = pool
        .inner()
        .begin()
        .await
        .map_err(|_| Status::InternalServerError)?;

    sqlx::query(
        r#"
        INSERT INTO wiki_pages (id, space_id, slug, title, body_markdown, created_by, updated_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        "#,
    )
    .bind(&id)
    .bind(PROJECT_MEMORY_SPACE_ID)
    .bind(&payload.slug)
    .bind(&payload.title)
    .bind(&payload.body_markdown)
    .bind(&payload.author_id)
    .bind(&payload.author_id)
    .execute(&mut *tx)
    .await
    .map_err(map_write_error)?;

    sqlx::query(
        r#"
        INSERT INTO wiki_revisions (id, page_id, body_markdown, author_kind, author_id, change_summary)
        VALUES ($1, $2, $3, $4, $5, $6)
        "#,
    )
    .bind(&revision_id)
    .bind(&id)
    .bind(&payload.body_markdown)
    .bind(&payload.author_kind)
    .bind(&payload.author_id)
    .bind(&payload.change_summary)
    .execute(&mut *tx)
    .await
    .map_err(|_| Status::InternalServerError)?;

    refresh_links(
        &mut *tx,
        &id,
        PROJECT_MEMORY_SPACE_ID,
        &payload.body_markdown,
    )
    .await?;
    refresh_search(&mut *tx, &id, &payload.title, &payload.body_markdown).await?;
    resolve_links_to_page(&mut *tx, &id, PROJECT_MEMORY_SPACE_ID, &payload.slug).await?;

    tx.commit().await.map_err(|_| Status::InternalServerError)?;
    get_page_by_slug(pool.inner(), &payload.slug).await
}

#[get("/wiki/pages/<slug>")]
async fn get(pool: &State<DbPool>, slug: &str) -> Result<Json<WikiPage>, Status> {
    get_page_by_slug(pool.inner(), slug).await
}

#[put("/wiki/pages/<slug>", data = "<payload>")]
async fn update(
    pool: &State<DbPool>,
    slug: &str,
    payload: Json<UpsertWikiPageRequest>,
) -> Result<Json<WikiPage>, Status> {
    let payload = payload.into_inner();
    save_existing_page(pool.inner(), slug, &payload)
        .await
        .map(Json)
}

#[post("/wiki/pages/<slug>/revisions", data = "<payload>")]
async fn save_revision(
    pool: &State<DbPool>,
    slug: &str,
    payload: Json<UpsertWikiPageRequest>,
) -> Result<Json<WikiPage>, Status> {
    let payload = payload.into_inner();
    save_existing_page(pool.inner(), slug, &payload)
        .await
        .map(Json)
}

#[delete("/wiki/pages/<slug>")]
async fn archive(pool: &State<DbPool>, slug: &str) -> Status {
    let mut tx = match pool.inner().begin().await {
        Ok(tx) => tx,
        Err(_) => return Status::InternalServerError,
    };

    let page = match fetch_visible_page_conn(&mut *tx, slug).await {
        Ok(Some(page)) => page,
        Ok(None) => return Status::NotFound,
        Err(status) => return status,
    };

    let result = sqlx::query(
        r#"
        UPDATE wiki_pages
        SET archived_at = CURRENT_TIMESTAMP::text,
            updated_at = CURRENT_TIMESTAMP::text
        WHERE id = $1 AND archived_at IS NULL
        "#,
    )
    .bind(&page.id)
    .execute(&mut *tx)
    .await;

    let result = match result {
        Ok(result) => result,
        Err(_) => return Status::InternalServerError,
    };
    if result.rows_affected() == 0 {
        return Status::NotFound;
    }

    if let Err(status) = remove_page_from_indexes(&mut *tx, &page.id).await {
        return status;
    }

    match tx.commit().await {
        Ok(_) => Status::NoContent,
        Err(_) => Status::InternalServerError,
    }
}

#[get("/wiki/pages/<slug>/revisions")]
async fn revisions(pool: &State<DbPool>, slug: &str) -> Result<Json<Vec<WikiRevision>>, Status> {
    let page = fetch_visible_page(pool.inner(), slug)
        .await?
        .ok_or(Status::NotFound)?;

    sqlx::query_as::<_, WikiRevision>(
        "SELECT * FROM wiki_revisions WHERE page_id = $1 ORDER BY created_at DESC",
    )
    .bind(page.id)
    .fetch_all(pool.inner())
    .await
    .map(Json)
    .map_err(|_| Status::InternalServerError)
}

#[get("/wiki/pages/<slug>/links")]
async fn outgoing_links(
    pool: &State<DbPool>,
    slug: &str,
) -> Result<Json<Vec<WikiOutgoingLink>>, Status> {
    let page = fetch_visible_page(pool.inner(), slug)
        .await?
        .ok_or(Status::NotFound)?;

    sqlx::query_as::<_, WikiOutgoingLink>(
        r#"
        SELECT l.target_slug,
               l.link_text,
               target.id AS target_page_id,
               target.title AS target_title
        FROM wiki_links l
        LEFT JOIN wiki_pages target
          ON target.space_id = $1
         AND target.slug = l.target_slug
         AND target.archived_at IS NULL
        WHERE l.source_page_id = $2
        ORDER BY l.target_slug ASC, l.link_text ASC
        "#,
    )
    .bind(&page.space_id)
    .bind(&page.id)
    .fetch_all(pool.inner())
    .await
    .map(Json)
    .map_err(|_| Status::InternalServerError)
}

#[get("/wiki/pages/<slug>/backlinks")]
async fn backlinks(pool: &State<DbPool>, slug: &str) -> Result<Json<Vec<WikiBacklink>>, Status> {
    let page = fetch_visible_page(pool.inner(), slug)
        .await?
        .ok_or(Status::NotFound)?;

    let rows = sqlx::query_as::<_, WikiBacklink>(
        r#"
        SELECT source.id AS source_page_id,
               source.slug AS source_slug,
               source.title AS source_title,
               backlink.target_slug,
               backlink.link_text
        FROM wiki_backlinks backlink
        JOIN wiki_pages source
          ON source.id = backlink.source_page_id
         AND source.space_id = $1
         AND source.archived_at IS NULL
        WHERE backlink.target_slug = $2
        ORDER BY source.title ASC, backlink.link_text ASC
        "#,
    )
    .bind(&page.space_id)
    .bind(&page.slug)
    .fetch_all(pool.inner())
    .await
    .map_err(|_| Status::InternalServerError)?;

    Ok(Json(rows))
}

async fn save_existing_page(
    pool: &DbPool,
    slug: &str,
    request: &UpsertWikiPageRequest,
) -> Result<WikiPage, Status> {
    let payload = normalize_payload(request, "Updated page")?;
    let mut tx = pool
        .begin()
        .await
        .map_err(|_| Status::InternalServerError)?;
    let current = fetch_visible_page_conn(&mut *tx, slug)
        .await?
        .ok_or(Status::NotFound)?;

    let result = sqlx::query(
        r#"
        UPDATE wiki_pages
        SET slug = $1,
            title = $2,
            body_markdown = $3,
            updated_by = $4,
            updated_at = CURRENT_TIMESTAMP::text
        WHERE id = $5 AND archived_at IS NULL
        "#,
    )
    .bind(&payload.slug)
    .bind(&payload.title)
    .bind(&payload.body_markdown)
    .bind(&payload.author_id)
    .bind(&current.id)
    .execute(&mut *tx)
    .await
    .map_err(map_write_error)?;
    if result.rows_affected() == 0 {
        return Err(Status::NotFound);
    }

    let revision_id = Uuid::new_v4().to_string();
    sqlx::query(
        r#"
        INSERT INTO wiki_revisions (id, page_id, body_markdown, author_kind, author_id, change_summary)
        VALUES ($1, $2, $3, $4, $5, $6)
        "#,
    )
    .bind(&revision_id)
    .bind(&current.id)
    .bind(&payload.body_markdown)
    .bind(&payload.author_kind)
    .bind(&payload.author_id)
    .bind(&payload.change_summary)
    .execute(&mut *tx)
    .await
    .map_err(|_| Status::InternalServerError)?;

    refresh_links(
        &mut *tx,
        &current.id,
        &current.space_id,
        &payload.body_markdown,
    )
    .await?;
    refresh_search(
        &mut *tx,
        &current.id,
        &payload.title,
        &payload.body_markdown,
    )
    .await?;
    clear_resolved_links_to_page(&mut *tx, &current.id).await?;
    resolve_links_to_page(&mut *tx, &current.id, &current.space_id, &payload.slug).await?;

    tx.commit().await.map_err(|_| Status::InternalServerError)?;

    fetch_visible_page(pool, &payload.slug)
        .await?
        .ok_or(Status::NotFound)
}

async fn get_page_by_slug(pool: &DbPool, slug: &str) -> Result<Json<WikiPage>, Status> {
    fetch_visible_page(pool, slug)
        .await?
        .map(Json)
        .ok_or(Status::NotFound)
}

async fn fetch_visible_page(pool: &DbPool, slug: &str) -> Result<Option<WikiPage>, Status> {
    sqlx::query_as::<_, WikiPage>(
        "SELECT * FROM wiki_pages WHERE slug = $1 AND archived_at IS NULL",
    )
    .bind(slug)
    .fetch_optional(pool)
    .await
    .map_err(|_| Status::InternalServerError)
}

async fn fetch_visible_page_conn(
    conn: &mut DbConnection,
    slug: &str,
) -> Result<Option<WikiPage>, Status> {
    sqlx::query_as::<_, WikiPage>(
        "SELECT * FROM wiki_pages WHERE slug = $1 AND archived_at IS NULL",
    )
    .bind(slug)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|_| Status::InternalServerError)
}

async fn refresh_links(
    conn: &mut DbConnection,
    page_id: &str,
    space_id: &str,
    body: &str,
) -> Result<(), Status> {
    sqlx::query("DELETE FROM wiki_links WHERE source_page_id = $1")
        .bind(page_id)
        .execute(&mut *conn)
        .await
        .map_err(|_| Status::InternalServerError)?;

    sqlx::query("DELETE FROM wiki_backlinks WHERE source_page_id = $1")
        .bind(page_id)
        .execute(&mut *conn)
        .await
        .map_err(|_| Status::InternalServerError)?;

    for link in extract_wiki_link_targets(body) {
        sqlx::query(
            r#"
            INSERT INTO wiki_links (source_page_id, target_slug, target_page_id, link_text)
            VALUES (
              $1,
              $2,
              (SELECT id FROM wiki_pages WHERE space_id = $3 AND slug = $4 AND archived_at IS NULL),
              $5
            )
            ON CONFLICT DO NOTHING
            "#,
        )
        .bind(page_id)
        .bind(&link.slug)
        .bind(space_id)
        .bind(&link.slug)
        .bind(&link.link_text)
        .execute(&mut *conn)
        .await
        .map_err(|_| Status::InternalServerError)?;

        sqlx::query(
            r#"
            INSERT INTO wiki_backlinks (source_page_id, target_slug, link_text)
            VALUES ($1, $2, $3)
            ON CONFLICT DO NOTHING
            "#,
        )
        .bind(page_id)
        .bind(&link.slug)
        .bind(&link.link_text)
        .execute(&mut *conn)
        .await
        .map_err(|_| Status::InternalServerError)?;
    }
    Ok(())
}

async fn refresh_search(
    conn: &mut DbConnection,
    page_id: &str,
    title: &str,
    body: &str,
) -> Result<(), Status> {
    sqlx::query("DELETE FROM search_index WHERE entity_type = 'wiki_page' AND entity_id = $1")
        .bind(page_id)
        .execute(&mut *conn)
        .await
        .map_err(|_| Status::InternalServerError)?;
    sqlx::query(
        r#"
        INSERT INTO search_index (entity_type, entity_id, title, body)
        VALUES ('wiki_page', $1, $2, $3)
        ON CONFLICT (entity_type, entity_id) DO UPDATE SET
            title = excluded.title,
            body = excluded.body
        "#,
    )
    .bind(page_id)
    .bind(title)
    .bind(body)
    .execute(&mut *conn)
    .await
    .map_err(|_| Status::InternalServerError)?;
    Ok(())
}

async fn remove_page_from_indexes(conn: &mut DbConnection, page_id: &str) -> Result<(), Status> {
    sqlx::query("DELETE FROM search_index WHERE entity_type = 'wiki_page' AND entity_id = $1")
        .bind(page_id)
        .execute(&mut *conn)
        .await
        .map_err(|_| Status::InternalServerError)?;
    sqlx::query("DELETE FROM wiki_links WHERE source_page_id = $1")
        .bind(page_id)
        .execute(&mut *conn)
        .await
        .map_err(|_| Status::InternalServerError)?;
    sqlx::query("UPDATE wiki_links SET target_page_id = NULL WHERE target_page_id = $1")
        .bind(page_id)
        .execute(&mut *conn)
        .await
        .map_err(|_| Status::InternalServerError)?;

    sqlx::query("DELETE FROM wiki_backlinks WHERE source_page_id = $1")
        .bind(page_id)
        .execute(&mut *conn)
        .await
        .map_err(|_| Status::InternalServerError)?;

    Ok(())
}

async fn clear_resolved_links_to_page(
    conn: &mut DbConnection,
    page_id: &str,
) -> Result<(), Status> {
    sqlx::query("UPDATE wiki_links SET target_page_id = NULL WHERE target_page_id = $1")
        .bind(page_id)
        .execute(&mut *conn)
        .await
        .map_err(|_| Status::InternalServerError)?;
    Ok(())
}

async fn resolve_links_to_page(
    conn: &mut DbConnection,
    page_id: &str,
    space_id: &str,
    slug: &str,
) -> Result<(), Status> {
    sqlx::query(
        r#"
        UPDATE wiki_links
        SET target_page_id = $1
        WHERE target_slug = $2
          AND source_page_id IN (
            SELECT id FROM wiki_pages WHERE space_id = $3 AND archived_at IS NULL
          )
        "#,
    )
    .bind(page_id)
    .bind(slug)
    .bind(space_id)
    .execute(&mut *conn)
    .await
    .map_err(|_| Status::InternalServerError)?;
    Ok(())
}

fn normalize_payload(
    request: &UpsertWikiPageRequest,
    default_summary: &str,
) -> Result<WikiPayload, Status> {
    let title = request.title.trim();
    if title.is_empty() || request.body_markdown.trim().is_empty() {
        return Err(Status::BadRequest);
    }

    let slug = wiki_slug(title).ok_or(Status::BadRequest)?;
    let author_id = request
        .updated_by
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("system");
    let change_summary = request
        .change_summary
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(default_summary);

    Ok(WikiPayload {
        title: title.to_string(),
        slug,
        body_markdown: request.body_markdown.clone(),
        author_kind: author_kind(author_id).to_string(),
        author_id: author_id.to_string(),
        change_summary: change_summary.to_string(),
    })
}

fn author_kind(author_id: &str) -> &'static str {
    match author_id {
        "system" => "system",
        "human" | "owner" => "human",
        _ => "agent",
    }
}

fn map_write_error(error: sqlx::Error) -> Status {
    match &error {
        sqlx::Error::Database(database_error) if database_error.is_unique_violation() => {
            Status::Conflict
        }
        _ => Status::InternalServerError,
    }
}

pub fn routes() -> Vec<rocket::Route> {
    routes![
        list,
        create,
        get,
        update,
        archive,
        revisions,
        save_revision,
        outgoing_links,
        backlinks
    ]
}
