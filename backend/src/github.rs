use serde::Serialize;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;

const COMMAND_TIMEOUT_SECS: u64 = 8;
const DETAIL_LIMIT: usize = 4000;

#[derive(Debug, Serialize, Clone)]
pub struct CommandCheck {
    pub ok: bool,
    pub detail: String,
}

#[derive(Debug, Serialize)]
pub struct GithubStatus {
    pub authenticated: bool,
    pub detail: String,
}

pub async fn auth_status() -> GithubStatus {
    let check = run_bounded("gh", &["auth", "status"]).await;
    GithubStatus {
        authenticated: check.ok,
        detail: check.detail,
    }
}

pub async fn repo_status(repo: &str) -> CommandCheck {
    let repo = repo.trim();
    if !is_plausible_repo(repo) {
        return failed("github_repo must be set as owner/name");
    }

    run_bounded("gh", &["repo", "view", repo]).await
}

pub async fn codex_binary_status(binary: &str) -> CommandCheck {
    let binary = binary.trim();
    if binary.is_empty() {
        return failed("codex_binary_path setting is empty");
    }
    if looks_like_path(binary) && !Path::new(binary).exists() {
        return failed("codex binary path does not exist");
    }

    run_bounded(binary, &["--version"]).await
}

pub fn workspace_status(path: &Path) -> CommandCheck {
    if path.as_os_str().is_empty() {
        return failed("workspace_path setting is empty");
    }
    if !path.exists() {
        return failed("workspace path does not exist");
    }
    if !path.is_dir() {
        return failed("workspace path is not a directory");
    }

    CommandCheck {
        ok: true,
        detail: format!("workspace path exists: {}", path.display()),
    }
}

async fn run_bounded(program: &str, args: &[&str]) -> CommandCheck {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return failed(&format!("failed to start {program}: {error}"));
        }
    };

    match timeout(
        Duration::from_secs(COMMAND_TIMEOUT_SECS),
        child.wait_with_output(),
    )
    .await
    {
        Ok(Ok(output)) => {
            let detail_bytes = if output.status.success() || output.stderr.is_empty() {
                &output.stdout
            } else {
                &output.stderr
            };
            CommandCheck {
                ok: output.status.success(),
                detail: bounded_output(detail_bytes),
            }
        }
        Ok(Err(error)) => failed(&format!("failed to wait for {program}: {error}")),
        Err(_) => failed(&format!(
            "{program} timed out after {COMMAND_TIMEOUT_SECS}s"
        )),
    }
}

fn bounded_output(bytes: &[u8]) -> String {
    let output = String::from_utf8_lossy(bytes);
    let output = output.trim();
    if output.is_empty() {
        return "(no output)".to_string();
    }

    let mut bounded = String::new();
    for character in output.chars().take(DETAIL_LIMIT) {
        bounded.push(character);
    }
    if output.chars().count() > DETAIL_LIMIT {
        bounded.push_str("\n...truncated");
    }
    bounded
}

fn failed(detail: &str) -> CommandCheck {
    CommandCheck {
        ok: false,
        detail: detail.to_string(),
    }
}

fn is_plausible_repo(repo: &str) -> bool {
    let Some((owner, name)) = repo.split_once('/') else {
        return false;
    };
    !owner.is_empty()
        && !name.is_empty()
        && repo.len() <= 200
        && repo.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | '/')
        })
}

fn looks_like_path(value: &str) -> bool {
    value.contains('/') || value.contains('\\')
}
