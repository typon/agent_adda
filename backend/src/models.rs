use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub service: &'static str,
}

#[derive(Debug, Deserialize)]
pub struct CreateAgentRequest {
    pub name: String,
    pub role: String,
    pub description: String,
}

#[derive(Debug, Serialize, FromRow)]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub role: String,
    pub description: String,
    pub profile: String,
    pub system_prompt: String,
    pub status: String,
    pub model: String,
    pub reasoning_effort: String,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct Conversation {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub topic: String,
    pub created_at: String,
    pub archived_at: Option<String>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub author_kind: String,
    pub author_id: String,
    pub body: String,
    pub run_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateMessageRequest {
    pub author_kind: String,
    pub author_id: String,
    pub body: String,
    pub delivery_mode: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpsertWikiPageRequest {
    pub title: String,
    pub body_markdown: String,
    pub updated_by: Option<String>,
    pub change_summary: Option<String>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct WikiPage {
    pub id: String,
    pub space_id: String,
    pub slug: String,
    pub title: String,
    pub body_markdown: String,
    pub rendered_hash: String,
    pub created_by: String,
    pub updated_by: String,
    pub created_at: String,
    pub updated_at: String,
    pub archived_at: Option<String>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct WikiRevision {
    pub id: String,
    pub page_id: String,
    pub body_markdown: String,
    pub author_kind: String,
    pub author_id: String,
    pub run_id: Option<String>,
    pub change_summary: String,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct SearchRequest {
    pub query: String,
}

#[derive(Debug, Serialize, FromRow)]
pub struct SearchResult {
    pub entity_type: String,
    pub entity_id: String,
    pub title: String,
    pub body: String,
}

#[derive(Debug, Serialize, FromRow)]
pub struct Setting {
    pub key: String,
    pub value: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct UpsertSettingRequest {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateSettingRequest {
    pub value: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InitializeOnboardingRequest {
    pub project_name: Option<String>,
    pub project_summary: Option<String>,
    pub workspace_path: Option<String>,
    pub github_repo: Option<String>,
    pub codex_binary_path: Option<String>,
    pub codex_home: Option<String>,
    pub default_model: Option<String>,
    pub default_reasoning_effort: Option<String>,
    #[serde(default)]
    pub tasks: Vec<String>,
    #[serde(default)]
    pub extra_roles: Vec<OnboardingExtraRoleRequest>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OnboardingExtraRoleRequest {
    pub name: String,
    pub role: Option<String>,
    pub description: Option<String>,
}
