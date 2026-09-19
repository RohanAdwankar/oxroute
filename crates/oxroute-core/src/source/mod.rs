//! The seam between oxroute and wherever context comes from.
//!
//! A Slack DM, an Outlook mail and a webhook POST are the same shape once
//! they are past this module: something arrived, in a conversation, possibly
//! continuing a thread, possibly with files attached. What differs is how you
//! answer it, and that stays behind the trait.
//!
//! Sources vary in what they can do -- Slack can edit a message it already
//! posted, email cannot -- so the optional parts have defaults that say no
//! rather than pretending.

pub mod slack;

use anyhow::Result;
use async_trait::async_trait;
use tokio::sync::{mpsc, oneshot};

use crate::model::{Attachment, Signal, Target, TurnInput};

/// A handle on a message we posted and may want to revise or remove. Used for
/// the live progress message, which is rewritten every few seconds and then
/// taken away when the turn ends.
#[derive(Debug, Clone)]
pub struct Posted {
    pub conversation: String,
    pub id: String,
}

/// What a source hands to the hub.
pub enum SourceEvent {
    Arrived(Box<Signal>),
    /// An out-of-band control word, like a slash command. The hub answers on
    /// the channel and the source decides how to show it.
    Command {
        name: String,
        user: String,
        reply: oneshot::Sender<String>,
    },
}

pub type Inbox = mpsc::UnboundedSender<SourceEvent>;

#[async_trait]
pub trait Source: Send + Sync {
    fn name(&self) -> &str;

    /// Run until the process ends, pushing everything that arrives.
    async fn run(&self, inbox: Inbox) -> Result<()>;

    /// Say something in a thread. Returns a permalink when the source has
    /// such a thing.
    async fn reply(&self, target: &Target, text: &str) -> Result<String>;

    /// Post a message we intend to rewrite and then delete.
    async fn post_status(&self, target: &Target, text: &str) -> Result<Posted>;

    async fn update_status(&self, posted: &Posted, text: &str) -> Result<()> {
        let _ = (posted, text);
        Ok(())
    }

    async fn clear_status(&self, posted: &Posted) -> Result<()> {
        let _ = posted;
        Ok(())
    }

    /// Fetch what came attached, into `directory`, as harness inputs.
    async fn fetch(&self, attachments: &[Attachment], directory: &str) -> Result<Vec<TurnInput>> {
        let _ = (attachments, directory);
        Ok(Vec::new())
    }

    /// Hand files back to the human.
    async fn upload(&self, target: &Target, paths: &[String]) -> Result<()> {
        let _ = (target, paths);
        anyhow::bail!("{} cannot take files back", self.name())
    }

    /// Open a fresh thread in the same conversation. This is what `fork`
    /// needs: a new place for the branched agent to live.
    async fn open_thread(&self, conversation: &str, title: &str) -> Result<(String, String)> {
        let _ = (conversation, title);
        anyhow::bail!("{} cannot open a thread", self.name())
    }

    /// Rewrite the opening message of a thread, so a rename shows up where a
    /// person is actually looking.
    async fn retitle(&self, target: &Target, title: &str) -> Result<()> {
        let _ = (target, title);
        Ok(())
    }

    /// The conversation so far, as `(role, text)`, oldest first. The namer
    /// reads this to keep a title honest as the task drifts.
    async fn history(&self, target: &Target, limit: usize) -> Result<Vec<(String, String)>> {
        let _ = (target, limit);
        Ok(Vec::new())
    }

    /// A link a person can click to get back to a specific message.
    async fn permalink(&self, conversation: &str, external_id: &str) -> Result<String> {
        let _ = (conversation, external_id);
        Ok(String::new())
    }
}
