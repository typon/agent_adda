use anyhow::Result;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{PgConnection, PgPool, Postgres};
use std::str::FromStr;

pub type Db = Postgres;
pub type DbConnection = PgConnection;
pub type DbPool = PgPool;

pub async fn init_database(database_url: &str) -> Result<DbPool> {
    let options = PgConnectOptions::from_str(database_url)?;
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect_with(options)
        .await?;

    sqlx::migrate!("./migrations").run(&pool).await?;
    refresh_search_index(&pool).await?;
    Ok(pool)
}

async fn refresh_search_index(pool: &DbPool) -> Result<()> {
    let mut tx = pool.begin().await?;

    sqlx::query("DELETE FROM search_index WHERE entity_type IN ('wiki_page', 'message')")
        .execute(&mut *tx)
        .await?;

    sqlx::query(
        r#"
        INSERT INTO search_index (entity_type, entity_id, title, body)
        SELECT 'wiki_page', id, title, body_markdown
        FROM wiki_pages
        WHERE archived_at IS NULL
        "#,
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO search_index (entity_type, entity_id, title, body)
        SELECT 'message',
               messages.id,
               'Message in ' || conversations.name,
               messages.body
        FROM messages
        JOIN conversations ON conversations.id = messages.conversation_id
        "#,
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}
