use crate::codex::CodexRunRequest;
use serde::Serialize;
use std::path::PathBuf;
use uuid::Uuid;

const PROMPT_SUMMARY_MAX_CHARS: usize = 180;

#[derive(Debug, Clone, Serialize)]
pub struct AgentRunPlan {
    pub run_id: String,
    pub agent_id: String,
    pub model: String,
    pub reasoning_effort: String,
    pub workspace: PathBuf,
    pub prompt_hash: String,
    pub prompt_summary: String,
    pub status: String,
}

pub fn plan_agent_run_with_summary(
    agent_id: &str,
    workspace: PathBuf,
    prompt: String,
    summary_source: &str,
    model: String,
    reasoning_effort: String,
) -> (AgentRunPlan, CodexRunRequest) {
    let run_id = Uuid::new_v4().to_string();
    let prompt_hash = prompt_hash(&prompt);
    let prompt_summary = prompt_summary(summary_source);

    let request = CodexRunRequest {
        agent_id: agent_id.to_string(),
        workspace: workspace.clone(),
        prompt,
        model: model.clone(),
        reasoning_effort: reasoning_effort.clone(),
    };

    (
        AgentRunPlan {
            run_id,
            agent_id: agent_id.to_string(),
            model,
            reasoning_effort,
            workspace,
            prompt_hash,
            prompt_summary,
            status: "planned".to_string(),
        },
        request,
    )
}

pub fn prompt_hash(prompt: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in prompt.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }

    format!("{hash:016x}")
}

pub fn prompt_summary(prompt: &str) -> String {
    let mut summary = String::with_capacity(PROMPT_SUMMARY_MAX_CHARS);
    let mut in_space = true;
    let mut pushed = 0;
    let mut truncated = false;

    for ch in prompt.trim().chars() {
        if ch.is_whitespace() {
            in_space = true;
            continue;
        }

        if in_space && pushed > 0 {
            if pushed == PROMPT_SUMMARY_MAX_CHARS {
                truncated = true;
                break;
            }
            summary.push(' ');
            pushed += 1;
        }

        if pushed == PROMPT_SUMMARY_MAX_CHARS {
            truncated = true;
            break;
        }

        summary.push(ch);
        pushed += 1;
        in_space = false;
    }

    if truncated {
        if summary.chars().count() >= 3 {
            for _ in 0..3 {
                summary.pop();
            }
        }
        summary.push_str("...");
    }

    summary
}

#[cfg(test)]
mod tests {
    use super::{PROMPT_SUMMARY_MAX_CHARS, prompt_hash, prompt_summary};

    #[test]
    fn prompt_hash_is_stable_for_same_input() {
        assert_eq!(
            prompt_hash("build the run lifecycle"),
            prompt_hash("build the run lifecycle")
        );
        assert_ne!(
            prompt_hash("build the run lifecycle"),
            prompt_hash("build the run lifecycle ")
        );
    }

    #[test]
    fn prompt_summary_collapses_whitespace_and_bounds_output() {
        assert_eq!(
            prompt_summary("  queue\n\nthis\t run   now  "),
            "queue this run now"
        );

        let long_prompt = "x".repeat(PROMPT_SUMMARY_MAX_CHARS + 20);
        let summary = prompt_summary(&long_prompt);
        assert_eq!(summary.len(), PROMPT_SUMMARY_MAX_CHARS);
        assert!(summary.ends_with("..."));
    }
}
