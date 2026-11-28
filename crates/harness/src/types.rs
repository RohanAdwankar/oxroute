//! Types shared by every harness and whatever drives them.

use serde::{Deserialize, Serialize};

pub fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", uuid::Uuid::new_v4().simple())
}

/// Which harness runs an agent.
///
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Backend {
    Codex,
    ClaudeCode,
}

impl Backend {
    pub fn as_str(self) -> &'static str {
        match self {
            Backend::Codex => "codex",
            Backend::ClaudeCode => "claude-code",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "codex" => Some(Backend::Codex),
            "claude-code" | "claude" => Some(Backend::ClaudeCode),
            _ => None,
        }
    }

    pub fn can_fork(self) -> bool {
        matches!(self, Backend::Codex)
    }
}

impl std::fmt::Display for Backend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One piece of input for a turn, in the harness's vocabulary.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TurnInput {
    Text { text: String },
    LocalImage { path: String },
}

impl TurnInput {
    pub fn text(value: impl Into<String>) -> Self {
        TurnInput::Text { text: value.into() }
    }

    pub fn as_text(&self) -> Option<&str> {
        match self {
            TurnInput::Text { text } => Some(text),
            TurnInput::LocalImage { .. } => None,
        }
    }
}

/// A conversation owned by a native harness but not yet managed by oxroute.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeSession {
    pub backend: Backend,
    pub session_id: String,
    pub name: String,
    pub preview: String,
    pub cwd: String,
    pub model: String,
    pub updated_at: f64,
}


#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationLine {
    pub role: String,
    pub text: String,
}
