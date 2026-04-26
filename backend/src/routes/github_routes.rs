use crate::db::DbPool;
use crate::github;
use rocket::State;
use rocket::http::Status;
use rocket::serde::json::Json;
use serde::Serialize;
use sqlx::FromRow;
use std::path::Path;
use uuid::Uuid;

const CHECK_DEFINITIONS: &[(&str, &str)] = &[
    ("gh_auth", "GitHub CLI auth"),
    ("github_repo", "GitHub repository"),
    ("codex_binary", "Codex CLI binary"),
    ("codex_home", "Codex home"),
    ("workspace_path", "Workspace path"),
];

#[derive(Debug, Serialize)]
struct GithubApiStatus {
    authenticated: bool,
    detail: String,
}

#[derive(Debug, Serialize)]
struct OnboardingStatus {
    checks: Vec<OnboardingCheck>,
}

#[derive(Debug, Serialize, Clone)]
struct OnboardingCheck {
    check_key: String,
    label: String,
    status: String,
    detail: Option<String>,
    checked_at: Option<String>,
}

#[derive(Debug, FromRow)]
struct StoredOnboardingCheck {
    check_key: String,
    status: String,
    detail: String,
    checked_at: String,
}

#[get("/github/status")]
async fn status(pool: &State<DbPool>) -> Result<Json<GithubApiStatus>, Status> {
    let status = github::auth_status().await;
    save_check(
        pool.inner(),
        "gh_auth",
        status.authenticated,
        &status.detail,
    )
    .await?;

    Ok(Json(GithubApiStatus {
        authenticated: status.authenticated,
        detail: status.detail,
    }))
}

#[get("/onboarding/checks")]
async fn onboarding_checks(pool: &State<DbPool>) -> Result<Json<OnboardingStatus>, Status> {
    Ok(Json(OnboardingStatus {
        checks: load_onboarding_checks(pool.inner()).await?,
    }))
}

#[post("/onboarding/checks/run")]
async fn run_onboarding_checks_from_settings(
    pool: &State<DbPool>,
) -> Result<Json<OnboardingStatus>, Status> {
    run_onboarding_checks(pool.inner()).await
}

async fn run_onboarding_checks(pool: &DbPool) -> Result<Json<OnboardingStatus>, Status> {
    let mut checks = Vec::with_capacity(CHECK_DEFINITIONS.len());

    let gh = github::auth_status().await;
    save_check(pool, "gh_auth", gh.authenticated, &gh.detail).await?;
    checks.push(check_from_parts("gh_auth", gh.authenticated, gh.detail));

    let repo = setting_or_default(pool, "github_repo", "").await?;
    let repo_check = if repo.is_empty() {
        github::CommandCheck {
            ok: false,
            detail: "github_repo setting is empty".to_string(),
        }
    } else {
        github::repo_status(&repo).await
    };
    save_check(pool, "github_repo", repo_check.ok, &repo_check.detail).await?;
    checks.push(check_from_parts(
        "github_repo",
        repo_check.ok,
        repo_check.detail,
    ));

    let codex_binary = setting_or_default(pool, "codex_binary_path", "codex").await?;
    let codex_check = github::codex_binary_status(&codex_binary).await;
    save_check(pool, "codex_binary", codex_check.ok, &codex_check.detail).await?;
    checks.push(check_from_parts(
        "codex_binary",
        codex_check.ok,
        codex_check.detail,
    ));

    let default_codex_home = default_codex_home();
    let codex_home = setting_or_default(pool, "codex_home", &default_codex_home).await?;
    let codex_home_check = path_status("codex_home", Path::new(&codex_home));
    save_check(
        pool,
        "codex_home",
        codex_home_check.ok,
        &codex_home_check.detail,
    )
    .await?;
    checks.push(check_from_parts(
        "codex_home",
        codex_home_check.ok,
        codex_home_check.detail,
    ));

    let default_workspace = default_workspace_path();
    let workspace = setting_or_default(pool, "workspace_path", &default_workspace).await?;
    let workspace_check = github::workspace_status(Path::new(&workspace));
    save_check(
        pool,
        "workspace_path",
        workspace_check.ok,
        &workspace_check.detail,
    )
    .await?;
    checks.push(check_from_parts(
        "workspace_path",
        workspace_check.ok,
        workspace_check.detail,
    ));

    Ok(Json(OnboardingStatus { checks }))
}

async fn load_onboarding_checks(pool: &DbPool) -> Result<Vec<OnboardingCheck>, Status> {
    let stored = sqlx::query_as::<_, StoredOnboardingCheck>(
        "SELECT check_name AS check_key,
                status,
                detail,
                updated_at AS checked_at
         FROM onboarding_checks
         ORDER BY updated_at DESC",
    )
    .fetch_all(pool)
    .await
    .map_err(|_| Status::InternalServerError)?;

    let mut checks = Vec::with_capacity(CHECK_DEFINITIONS.len());
    for (key, label) in CHECK_DEFINITIONS {
        if let Some(row) = stored.iter().find(|row| row.check_key == *key) {
            checks.push(OnboardingCheck {
                check_key: (*key).to_string(),
                label: (*label).to_string(),
                status: row.status.clone(),
                detail: non_empty_detail(&row.detail),
                checked_at: Some(row.checked_at.clone()),
            });
        } else {
            checks.push(OnboardingCheck {
                check_key: (*key).to_string(),
                label: (*label).to_string(),
                status: "pending".to_string(),
                detail: None,
                checked_at: None,
            });
        }
    }

    Ok(checks)
}

async fn save_check(pool: &DbPool, key: &str, ok: bool, detail: &str) -> Result<(), Status> {
    let id = Uuid::new_v4().to_string();
    let status = if ok { "passed" } else { "failed" };

    sqlx::query(
        r#"
        INSERT INTO onboarding_checks (id, check_name, status, detail, updated_at)
        VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP::text)
        ON CONFLICT(check_name) DO UPDATE SET
            status = excluded.status,
            detail = excluded.detail,
            updated_at = CURRENT_TIMESTAMP::text
        "#,
    )
    .bind(id)
    .bind(key)
    .bind(status)
    .bind(detail)
    .execute(pool)
    .await
    .map_err(|_| Status::InternalServerError)?;

    Ok(())
}

async fn setting_or_default(
    pool: &DbPool,
    key: &str,
    default_value: &str,
) -> Result<String, Status> {
    let value: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = $1")
        .bind(key)
        .fetch_optional(pool)
        .await
        .map_err(|_| Status::InternalServerError)?;

    if let Some(value) = value {
        let value = value.trim();
        if !value.is_empty() {
            return Ok(value.to_string());
        }
    }

    Ok(default_value.to_string())
}

fn default_codex_home() -> String {
    std::env::var("CODEX_HOME")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            std::env::var("HOME")
                .ok()
                .map(|home| format!("{}/.codex", home.trim_end_matches('/')))
        })
        .unwrap_or_default()
}

fn default_workspace_path() -> String {
    std::env::var("AGENT_ADDA_WORKSPACE_ROOT")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_default()
}

fn check_from_parts(key: &str, ok: bool, detail: String) -> OnboardingCheck {
    OnboardingCheck {
        check_key: key.to_string(),
        label: label_for_check(key).to_string(),
        status: if ok { "passed" } else { "failed" }.to_string(),
        detail: non_empty_detail(&detail),
        checked_at: None,
    }
}

fn label_for_check(key: &str) -> &'static str {
    CHECK_DEFINITIONS
        .iter()
        .find(|(candidate, _)| *candidate == key)
        .map(|(_, label)| *label)
        .unwrap_or("Onboarding check")
}

fn non_empty_detail(detail: &str) -> Option<String> {
    let detail = detail.trim();
    if detail.is_empty() {
        None
    } else {
        Some(detail.to_string())
    }
}

fn path_status(setting_key: &str, path: &Path) -> github::CommandCheck {
    if path.as_os_str().is_empty() {
        return github::CommandCheck {
            ok: false,
            detail: format!("{setting_key} setting is empty"),
        };
    }
    if !path.exists() {
        return github::CommandCheck {
            ok: false,
            detail: format!("{setting_key} path does not exist: {}", path.display()),
        };
    }
    if !path.is_dir() {
        return github::CommandCheck {
            ok: false,
            detail: format!("{setting_key} path is not a directory: {}", path.display()),
        };
    }

    github::CommandCheck {
        ok: true,
        detail: format!("{setting_key} path exists: {}", path.display()),
    }
}

pub fn routes() -> Vec<rocket::Route> {
    routes![
        status,
        onboarding_checks,
        run_onboarding_checks_from_settings
    ]
}

#[cfg(test)]
mod tests {
    use super::routes;
    use crate::db::DbPool;
    use crate::db::init_database;
    use rocket::http::Status;
    use rocket::local::asynchronous::Client;
    use serde_json::Value;
    use std::ffi::OsString;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::OnceLock;
    use tempfile::TempDir;
    use tokio::sync::Mutex;

    static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    struct TestApp {
        _db_dir: TempDir,
        pool: DbPool,
        client: Client,
    }

    struct PathGuard {
        previous_path: Option<OsString>,
    }

    impl Drop for PathGuard {
        fn drop(&mut self) {
            unsafe {
                match &self.previous_path {
                    Some(path) => std::env::set_var("PATH", path),
                    None => std::env::remove_var("PATH"),
                }
            }
        }
    }

    #[rocket::async_test]
    async fn onboarding_checks_start_pending() {
        let app = test_app().await;

        let response = app.client.get("/api/v1/onboarding/checks").dispatch().await;

        assert_eq!(response.status(), Status::Ok);
        let body = response.into_json::<Value>().await.expect("json body");
        let checks = checks(&body);
        assert_eq!(
            check_keys(checks),
            vec![
                "gh_auth",
                "github_repo",
                "codex_binary",
                "codex_home",
                "workspace_path"
            ]
        );
        for check in checks {
            assert_eq!(check["status"].as_str(), Some("pending"));
            assert!(check["detail"].is_null());
            assert!(check["checked_at"].is_null());
        }
    }

    #[rocket::async_test]
    async fn onboarding_checks_run_with_fake_tools_and_persist() {
        let _env_guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().await;
        let tool_dir = tempfile::tempdir().expect("tool tempdir");
        let _path_guard = prepend_path(tool_dir.path());
        write_executable(
            tool_dir.path(),
            "gh",
            r#"#!/bin/sh
if [ "$1" = "auth" ]; then
  echo "fake gh authenticated"
  exit 0
fi
if [ "$1" = "repo" ]; then
  echo "fake repo visible: $3"
  exit 0
fi
echo "unexpected gh args: $*" >&2
exit 1
"#,
        );
        let codex_path = write_executable(
            tool_dir.path(),
            "codex",
            r#"#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "fake codex 5.5.0"
  exit 0
fi
echo "unexpected codex args: $*" >&2
exit 1
"#,
        );
        let codex_home = tempfile::tempdir().expect("codex home");
        let workspace = tempfile::tempdir().expect("workspace");
        let app = test_app().await;
        store_setting(
            &app.pool,
            "codex_binary_path",
            codex_path.to_string_lossy().as_ref(),
        )
        .await;
        store_setting(
            &app.pool,
            "codex_home",
            codex_home.path().to_string_lossy().as_ref(),
        )
        .await;
        store_setting(
            &app.pool,
            "workspace_path",
            workspace.path().to_string_lossy().as_ref(),
        )
        .await;
        store_setting(&app.pool, "github_repo", "agent/adda").await;

        let response = app
            .client
            .post("/api/v1/onboarding/checks/run")
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::Ok);
        let body = response.into_json::<Value>().await.expect("json body");
        assert_check(&body, "gh_auth", "passed", "fake gh authenticated");
        assert_check(
            &body,
            "github_repo",
            "passed",
            "fake repo visible: agent/adda",
        );
        assert_check(&body, "codex_binary", "passed", "fake codex 5.5.0");
        assert_check(&body, "codex_home", "passed", "codex_home path exists:");
        assert_check(&body, "workspace_path", "passed", "workspace path exists:");

        let stored = app.client.get("/api/v1/onboarding/checks").dispatch().await;
        assert_eq!(stored.status(), Status::Ok);
        let stored_body = stored.into_json::<Value>().await.expect("json body");
        for key in [
            "gh_auth",
            "github_repo",
            "codex_binary",
            "codex_home",
            "workspace_path",
        ] {
            let check = check_by_key(&stored_body, key);
            assert_eq!(check["status"].as_str(), Some("passed"));
            assert!(
                check["checked_at"]
                    .as_str()
                    .is_some_and(|value| !value.is_empty())
            );
        }
    }

    async fn test_app() -> TestApp {
        let db_dir = tempfile::tempdir().expect("database tempdir");
        let _db_path = db_dir.path().join("agent_adda_test.db");
        let database_url = std::env::var("AGENT_ADDA_TEST_DATABASE_URL").unwrap_or_else(|_| {
            "postgres://agent_adda:agent_adda@127.0.0.1:15432/agent_adda_test".to_string()
        });
        let pool = init_database(&database_url)
            .await
            .expect("database initializes");
        let rocket = rocket::build()
            .manage(pool.clone())
            .mount("/api/v1", routes());
        let client = Client::tracked(rocket).await.expect("rocket client");

        TestApp {
            _db_dir: db_dir,
            pool,
            client,
        }
    }

    async fn store_setting(pool: &DbPool, key: &str, value: &str) {
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
        .await
        .expect("store setting");
    }

    fn prepend_path(path: &Path) -> PathGuard {
        let previous_path = std::env::var_os("PATH");
        let mut paths = vec![path.to_path_buf()];
        if let Some(previous_path) = previous_path.as_ref() {
            paths.extend(std::env::split_paths(previous_path));
        }
        let next_path = std::env::join_paths(paths).expect("join PATH");
        unsafe {
            std::env::set_var("PATH", next_path);
        }

        PathGuard { previous_path }
    }

    fn write_executable(dir: &Path, name: &str, script: &str) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, script).expect("write fake executable");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let mut permissions = fs::metadata(&path)
                .expect("fake executable metadata")
                .permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&path, permissions).expect("chmod fake executable");
        }

        path
    }

    fn checks(body: &Value) -> &[Value] {
        body["checks"].as_array().expect("checks array")
    }

    fn check_keys(checks: &[Value]) -> Vec<&str> {
        checks
            .iter()
            .map(|check| check["check_key"].as_str().expect("check key"))
            .collect()
    }

    fn assert_check(body: &Value, key: &str, status: &str, detail_fragment: &str) {
        let check = check_by_key(body, key);
        assert_eq!(check["status"].as_str(), Some(status));
        assert!(
            check["detail"]
                .as_str()
                .is_some_and(|detail| detail.contains(detail_fragment)),
            "detail for {key:?} should contain {detail_fragment:?}: {check:?}"
        );
    }

    fn check_by_key<'a>(body: &'a Value, key: &str) -> &'a Value {
        checks(body)
            .iter()
            .find(|check| check["check_key"].as_str() == Some(key))
            .unwrap_or_else(|| panic!("missing check {key}"))
    }
}
