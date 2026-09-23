//! The seam between oxroute and whatever is actually running the agents.
//!
//! oxroute wants five things from a harness and nothing else:
//!
//! ```text
//! open        attach to a session, or make one
//! start       run a turn
//! steer       fold input into a turn already running, if it can
//! interrupt   stop a turn without losing the session
//! events      a stream of what it is doing
//! ```
//!
//! Everything else -- the wire format, whether the model is Claude or GPT,
//! how approvals work -- belongs to the harness. Nothing above this module
//! imports a concrete one.

pub mod claude;
pub mod codex;

use anyhow::Result;
use async_trait::async_trait;
use serde_json::Value;

use crate::model::{Backend, ConversationLine, NativeSession, TurnInput};

/// What a harness can actually do. Declared, not discovered: the UI says how
/// a send will land *before* you press it, so a busy agent that cannot be
/// steered never silently swallows an urgent message.
#[derive(Debug, Clone, Copy)]
pub struct Capabilities {
    /// Accept input while a turn is running.
    pub steer: bool,
    /// Branch a session's history into a new one.
    pub fork: bool,
    /// Splice turns into a session's history without running them.
    pub inject: bool,
    /// Reattach to a session after oxroute restarts.
    pub resume: bool,
}

/// How a session should be opened.
#[derive(Debug, Clone)]
pub struct SessionSpec {
    pub model: String,
    pub cwd: String,
    /// Resume this session instead of opening a new one.
    pub resume: Option<String>,
    /// Vanishes when the turn ends; used for side questions.
    pub ephemeral: bool,
}

#[derive(Debug, Clone)]
pub struct RecoveredTurn {
    pub id: String,
    pub status: String,
    pub items: Vec<Value>,
}

/// What a harness tells us, in oxroute's vocabulary rather than its own.
#[derive(Debug, Clone)]
pub enum HarnessEvent {
    /// A turn is running. `turn_id` is what `interrupt` and `steer` need.
    TurnStarted { session: String, turn_id: String },
    /// Raw item activity, kept untranslated because the progress view wants
    /// the harness's own detail and a lowest common denominator would throw
    /// away the thing that makes it worth watching.
    Item { session: String, item: Value },
    /// Text meant for a person. `final_answer` distinguishes the answer from
    /// the commentary a model emits along the way.
    Message {
        session: String,
        text: String,
        final_answer: bool,
    },
    /// A file the agent wants handed back.
    Artifact { session: String, path: String },
    TurnFinished { session: String, status: String },
    /// The harness renamed the session itself.
    Named { session: String, name: String },
    /// This session is wedged. Distinct from a turn that merely failed.
    SessionError { session: String, message: String },
    /// The harness process itself went away; every session on it is suspect.
    Down { message: String },
}

impl HarnessEvent {
    pub fn session(&self) -> Option<&str> {
        match self {
            HarnessEvent::TurnStarted { session, .. }
            | HarnessEvent::Item { session, .. }
            | HarnessEvent::Message { session, .. }
            | HarnessEvent::Artifact { session, .. }
            | HarnessEvent::TurnFinished { session, .. }
            | HarnessEvent::Named { session, .. }
            | HarnessEvent::SessionError { session, .. } => Some(session),
            HarnessEvent::Down { .. } => None,
        }
    }
}

#[async_trait]
pub trait Harness: Send + Sync {
    fn backend(&self) -> Backend;
    fn capabilities(&self) -> Capabilities;

    /// Everything this harness is doing. The hub subscribes once at startup
    /// and folds the stream into its own.
    fn events(&self) -> tokio::sync::broadcast::Receiver<HarnessEvent>;

    /// Open or reattach to a session. Returns the harness's own handle for it.
    async fn open(&self, spec: &SessionSpec) -> Result<String>;

    /// Run a turn. Returns the turn id.
    async fn start(&self, session: &str, inputs: Vec<TurnInput>) -> Result<String>;

    /// Fold input into a turn that is already running.
    async fn steer(
        &self,
        session: &str,
        turn_id: &str,
        message_id: &str,
        inputs: Vec<TurnInput>,
    ) -> Result<()>;

    async fn interrupt(&self, session: &str, turn_id: &str) -> Result<()>;

    /// Branch a session. `exclude_turns` copies the setup but not the history,
    /// which is what a side question wants.
    async fn fork(
        &self,
        session: &str,
        spec: &SessionSpec,
        exclude_turns: bool,
    ) -> Result<String> {
        let _ = (session, spec, exclude_turns);
        anyhow::bail!("{} cannot fork a session", self.backend())
    }

    /// Splice a question and its answer into history without running a turn.
    async fn inject(&self, session: &str, exchanges: &[(String, String)]) -> Result<()> {
        let _ = (session, exchanges);
        anyhow::bail!("{} cannot inject history", self.backend())
    }

    /// Tell the harness what to call this session, where it keeps its own name.
    async fn set_name(&self, session: &str, name: &str) -> Result<()> {
        let _ = (session, name);
        Ok(())
    }

    /// Stop watching a session. Best-effort tidying, never fatal.
    async fn release(&self, session: &str) -> Result<()> {
        let _ = session;
        Ok(())
    }

    /// Reattach to a turn that outlived oxroute and return its current state.
    async fn recover(&self, _session: &str, _spec: &SessionSpec) -> Result<Option<RecoveredTurn>> {
        Ok(None)
    }

    /// Search sessions that exist in the harness's native history.
    async fn search_sessions(&self, _query: &str, _limit: usize) -> Result<Vec<NativeSession>> {
        Ok(vec![])
    }

    /// Resolve one native session again at import time rather than trusting
    /// metadata supplied by a browser.
    async fn find_session(&self, _session: &str) -> Result<Option<NativeSession>> {
        Ok(None)
    }

    async fn session_preview(&self, _session: &str, _limit: usize) -> Result<Vec<ConversationLine>> {
        Ok(vec![])
    }

    /// Ask the harness to answer a one-shot prompt on a throwaway session.
    /// Used for naming; a harness that cannot do it cheaply should say so.
    async fn oneshot(&self, _prompt: &str, _schema: Value, _cwd: &str) -> Result<String> {
        anyhow::bail!("{} has no cheap one-shot path", self.backend())
    }
}
