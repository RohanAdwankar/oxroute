//! One review record for every kind of reviewed subject.
//!
//! The kind owns what is reviewed, whether it is still current and what an
//! approval authorizes. Everything else (decision, feedback, status, storage)
//! is shared.

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

use crate::git;

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "subject", rename_all = "lowercase")]
pub enum Subject {
    Git(git::Snapshot),
    File(File),
}

#[derive(Clone, Serialize, Deserialize)]
pub struct File {
    pub name: String,
    pub sha256: String,
    pub extension: String,
    pub pages: usize,
    pub text: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub status: String,
    pub at: f64,
    pub request_id: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Feedback {
    pub request_id: String,
    pub at: f64,
    pub revision: String,
    pub text: String,
    #[serde(default)]
    pub annotations: Vec<serde_json::Value>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub id: String,
    pub agent_id: String,
    pub title: String,
    pub description: String,
    #[serde(flatten)]
    pub subject: Subject,
    pub decision: Option<Decision>,
    #[serde(default)]
    pub stale_notified: bool,
    #[serde(default)]
    pub feedback: Vec<Feedback>,
}

impl Review {
    pub fn new(id: String, agent_id: String, title: String, description: String, subject: Subject) -> Self {
        Self { id, agent_id, title, description, subject, decision: None, stale_notified: false, feedback: vec![] }
    }

    pub fn git(&self) -> Result<&git::Snapshot> {
        match &self.subject { Subject::Git(snapshot) => Ok(snapshot), _ => bail!("Not a Git review") }
    }

    pub fn git_mut(&mut self) -> Result<&mut git::Snapshot> {
        match &mut self.subject { Subject::Git(snapshot) => Ok(snapshot), _ => bail!("Not a Git review") }
    }

    pub fn file(&self) -> Result<&File> {
        match &self.subject { Subject::File(file) => Ok(file), _ => bail!("Not a file review") }
    }

    /// The exact subject revision a decision applies to.
    pub fn revision(&self) -> &str {
        match &self.subject { Subject::Git(snapshot) => &snapshot.head_commit, Subject::File(file) => &file.sha256 }
    }

    pub async fn is_current(&self) -> Result<bool> {
        match &self.subject { Subject::Git(snapshot) => git::current(snapshot).await, Subject::File(_) => Ok(true) }
    }

    /// Stale outranks any decision; otherwise the latest decision wins.
    pub fn status(&self, current: bool) -> &str {
        if !current { "stale" } else { self.decision.as_ref().map_or("pending", |decision| decision.status.as_str()) }
    }
}
