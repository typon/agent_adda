use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;

const CODEX_MODEL_QUERY_TIMEOUT: Duration = Duration::from_secs(5);
const KNOWN_REASONING_EFFORTS: &[&str] = &["low", "medium", "high", "xhigh"];
const REQUEST_COMPRESSION_FEATURE: &str = "enable_request_compression";
const CODEX_SANDBOX_MODE_CONFIG: &str = "sandbox_mode=\"danger-full-access\"";
const BYPASS_CODEX_SANDBOX_FLAG: &str = "--dangerously-bypass-approvals-and-sandbox";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexCommandPlan {
    pub program: String,
    pub args: Vec<String>,
    pub stdin: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexRunRequest {
    pub agent_id: String,
    pub workspace: PathBuf,
    pub prompt: String,
    pub model: String,
    pub reasoning_effort: String,
}

impl CodexRunRequest {
    pub fn command_plan(&self, codex_bin: &str) -> CodexCommandPlan {
        self.command_plan_with_output(codex_bin, None)
    }

    pub fn command_plan_with_output(
        &self,
        codex_bin: &str,
        output_last_message: Option<&str>,
    ) -> CodexCommandPlan {
        let mut args = vec![
            "exec".to_string(),
            "--json".to_string(),
            "--enable".to_string(),
            REQUEST_COMPRESSION_FEATURE.to_string(),
            "--model".to_string(),
            self.model.clone(),
            "-c".to_string(),
            format!("reasoning.effort=\"{}\"", self.reasoning_effort),
            "-c".to_string(),
            CODEX_SANDBOX_MODE_CONFIG.to_string(),
            BYPASS_CODEX_SANDBOX_FLAG.to_string(),
            "--cd".to_string(),
            self.workspace.to_string_lossy().into_owned(),
        ];
        if let Some(path) = output_last_message {
            args.push("--output-last-message".to_string());
            args.push(path.to_string());
        }
        args.push("-".to_string());

        CodexCommandPlan {
            program: codex_bin.to_string(),
            args,
            stdin: self.prompt.clone(),
        }
    }

    pub fn resume_command_plan(&self, codex_bin: &str, session_id: &str) -> CodexCommandPlan {
        self.resume_command_plan_with_output(codex_bin, session_id, None)
    }

    pub fn resume_command_plan_with_output(
        &self,
        codex_bin: &str,
        session_id: &str,
        output_last_message: Option<&str>,
    ) -> CodexCommandPlan {
        let mut args = vec![
            "exec".to_string(),
            "resume".to_string(),
            "--json".to_string(),
            "--enable".to_string(),
            REQUEST_COMPRESSION_FEATURE.to_string(),
            "--model".to_string(),
            self.model.clone(),
            "-c".to_string(),
            format!("reasoning.effort=\"{}\"", self.reasoning_effort),
            "-c".to_string(),
            CODEX_SANDBOX_MODE_CONFIG.to_string(),
            BYPASS_CODEX_SANDBOX_FLAG.to_string(),
        ];
        if let Some(path) = output_last_message {
            args.push("--output-last-message".to_string());
            args.push(path.to_string());
        }
        args.push(session_id.to_string());
        args.push("-".to_string());

        CodexCommandPlan {
            program: codex_bin.to_string(),
            args,
            stdin: self.prompt.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct CodexReasoningEfforts {
    pub model: String,
    pub reasoning_efforts: Vec<String>,
    pub source: &'static str,
}

#[derive(Debug, Deserialize)]
struct CodexModelCatalog {
    models: Vec<CodexModelCatalogEntry>,
}

#[derive(Debug, Deserialize)]
struct CodexModelCatalogEntry {
    slug: String,
    supported_reasoning_levels: Option<Vec<CodexReasoningLevel>>,
}

#[derive(Debug, Deserialize)]
struct CodexReasoningLevel {
    effort: String,
}

pub fn is_known_reasoning_effort(value: &str) -> bool {
    KNOWN_REASONING_EFFORTS.contains(&value)
}

pub async fn query_reasoning_efforts(
    codex_bin: &str,
    codex_home: Option<&str>,
    model: &str,
) -> CodexReasoningEfforts {
    if let Ok(efforts) = query_codex_model_catalog(codex_bin, codex_home, model).await {
        if !efforts.is_empty() {
            return CodexReasoningEfforts {
                model: model.to_string(),
                reasoning_efforts: efforts,
                source: "codex-debug-models",
            };
        }
    }

    CodexReasoningEfforts {
        model: model.to_string(),
        reasoning_efforts: Vec::new(),
        source: "unavailable",
    }
}

async fn query_codex_model_catalog(
    codex_bin: &str,
    codex_home: Option<&str>,
    model: &str,
) -> Result<Vec<String>, CodexCatalogError> {
    let mut command = Command::new(codex_bin);
    command.args(["debug", "models"]).kill_on_drop(true);
    if let Some(codex_home) = codex_home.map(str::trim).filter(|value| !value.is_empty()) {
        command.env("CODEX_HOME", codex_home);
    }

    let output = timeout(CODEX_MODEL_QUERY_TIMEOUT, command.output())
        .await
        .map_err(|_| CodexCatalogError)?
        .map_err(|_| CodexCatalogError)?;

    if !output.status.success() {
        return Err(CodexCatalogError);
    }

    let catalog: CodexModelCatalog =
        serde_json::from_slice(&output.stdout).map_err(|_| CodexCatalogError)?;

    let Some(entry) = catalog.models.into_iter().find(|entry| entry.slug == model) else {
        return Err(CodexCatalogError);
    };
    let Some(levels) = entry.supported_reasoning_levels else {
        return Err(CodexCatalogError);
    };

    let mut efforts = Vec::with_capacity(levels.len());
    for level in levels {
        let effort = level.effort.trim();
        if is_known_reasoning_effort(effort) && !efforts.iter().any(|known| known == effort) {
            efforts.push(effort.to_string());
        }
    }

    Ok(efforts)
}

#[derive(Debug)]
struct CodexCatalogError;

#[cfg(test)]
mod tests {
    use super::CodexRunRequest;
    use std::path::PathBuf;

    #[test]
    fn command_plan_uses_current_codex_exec_flags() {
        let request = CodexRunRequest {
            agent_id: "agent".to_string(),
            workspace: PathBuf::from("/tmp/workspace"),
            prompt: "compile dataset".to_string(),
            model: "gpt-5.5".to_string(),
            reasoning_effort: "high".to_string(),
        };

        let command = request.command_plan("codex");

        assert_eq!(command.program, "codex");
        assert!(command.args.contains(&"exec".to_string()));
        assert!(command.args.contains(&"--json".to_string()));
        assert!(command.args.contains(&"--enable".to_string()));
        assert!(
            command
                .args
                .contains(&"enable_request_compression".to_string())
        );
        assert!(
            command
                .args
                .contains(&"--dangerously-bypass-approvals-and-sandbox".to_string())
        );
        assert!(
            command
                .args
                .contains(&"sandbox_mode=\"danger-full-access\"".to_string())
        );
        assert!(!command.args.contains(&"--sandbox".to_string()));
        assert!(!command.args.contains(&"--ask-for-approval".to_string()));
        assert_eq!(command.args.last().map(String::as_str), Some("-"));
    }

    #[test]
    fn resume_command_plan_uses_current_codex_resume_flags() {
        let request = CodexRunRequest {
            agent_id: "agent".to_string(),
            workspace: PathBuf::from("/tmp/workspace"),
            prompt: "compile dataset".to_string(),
            model: "gpt-5.5".to_string(),
            reasoning_effort: "high".to_string(),
        };

        let command = request.resume_command_plan("codex", "019dcd0f-5121-76c1-98b3-6526c38dd711");

        assert_eq!(command.program, "codex");
        assert_eq!(
            command.args,
            vec![
                "exec",
                "resume",
                "--json",
                "--enable",
                "enable_request_compression",
                "--model",
                "gpt-5.5",
                "-c",
                "reasoning.effort=\"high\"",
                "-c",
                "sandbox_mode=\"danger-full-access\"",
                "--dangerously-bypass-approvals-and-sandbox",
                "019dcd0f-5121-76c1-98b3-6526c38dd711",
                "-"
            ]
        );
        assert!(!command.args.contains(&"--cd".to_string()));
        assert!(!command.args.contains(&"--sandbox".to_string()));
        assert!(!command.args.contains(&"--ask-for-approval".to_string()));
    }
}
