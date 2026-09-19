//! The nouns. A Signal arrives, an Agent runs, a Binding ties them together.
//!
//! Everything above this module is a surface (Slack, the web UI, the TUI) and
//! everything below it is a harness (Codex, Claude Code). Neither side names
//! the other: a Slack message and an Outlook mail both become a `Signal`, and
//! a Codex thread and a Claude session both become an `Agent`.

use serde::{Deserialize, Serialize};

/// Seconds since the epoch. One clock, so the store, the dashboard and the UI
/// all agree on what "stalled for ten minutes" means.
pub fn now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

pub fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", uuid::Uuid::new_v4().simple())
}

/// Which harness runs an agent.
///
/// The difference that leaks into the UI is steering: Codex can fold input
/// into a turn that is already running, Claude Code queues it instead. We
/// declare that rather than discovering it, so the surface can say which will
/// happen before you press send.
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

    /// What the harness that normally runs this backend can do.
    ///
    /// The hub always asks the live harness instead; this is here so a
    /// surface can label a button without holding one, and the two are only
    /// allowed to differ in tests.
    pub fn can_steer(self) -> bool {
        matches!(self, Backend::Codex)
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

/// How the next send reaches an agent. The surface shows this before you send,
/// so a busy Claude Code agent never silently swallows an urgent message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Delivery {
    /// The agent is idle; this context is what sets it going.
    Start,
    /// The agent is working and the backend can fold input into the live turn.
    Steer,
    /// The agent is working and the backend cannot steer, so it waits.
    Queue,
}

impl Delivery {
    pub fn as_str(self) -> &'static str {
        match self {
            Delivery::Start => "start",
            Delivery::Steer => "steer",
            Delivery::Queue => "queue",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    Working,
    Stalled,
    Complete,
}

impl AgentStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentStatus::Working => "working",
            AgentStatus::Stalled => "stalled",
            AgentStatus::Complete => "complete",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "working" => AgentStatus::Working,
            "stalled" => AgentStatus::Stalled,
            _ => AgentStatus::Complete,
        }
    }

    /// Dashboard order: what needs you, then what is stuck, then what is done.
    pub fn rank(self) -> u8 {
        match self {
            AgentStatus::Working => 0,
            AgentStatus::Stalled => 1,
            AgentStatus::Complete => 2,
        }
    }
}

/// A file that came in with a signal, before we have fetched it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub name: String,
    pub mimetype: String,
    /// Source-specific handle. For Slack this is the private download URL,
    /// which only the source that produced it knows how to authenticate.
    pub url: String,
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

/// Where a reply goes. A surface hands one of these back to itself; the hub
/// only carries it around.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub source: String,
    pub conversation: String,
    pub thread_key: String,
}

impl Target {
    pub fn new(
        source: impl Into<String>,
        conversation: impl Into<String>,
        thread_key: impl Into<String>,
    ) -> Self {
        Target {
            source: source.into(),
            conversation: conversation.into(),
            thread_key: thread_key.into(),
        }
    }
}

/// A control word the user typed instead of a prompt.
///
/// These are parsed in core rather than in the Slack adapter, because the
/// whole point of oxroute is that `kill` means the same thing whether you
/// typed it in Slack, the TUI or the web UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Directive {
    /// Stop the running turn, keep the session.
    Kill,
    /// Keep the conversation, start the next turn from a fresh session.
    Clean,
    /// Branch this agent's history into a new agent and a new thread.
    Fork,
    /// Set this agent's display name by hand.
    Rename(String),
    /// Select the model for subsequent turns.
    Model(String),
}

/// What is left of a message once a directive has been taken off the front.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parsed {
    pub directive: Option<Directive>,
    pub text: String,
    /// `&` prefix: do not steer the running turn, run this after it.
    pub queued: bool,
    /// `btw` prefix: answer from an ephemeral fork, in parallel, without
    /// disturbing the turn that is running.
    pub side: bool,
}

/// Strip the control words off a message.
///
/// `models` is the set of model aliases this deployment accepts, passed in so
/// that adding a model is configuration and not a code change.
pub fn parse_message(raw: &str, in_thread: bool, has_files: bool, models: &[&str]) -> Parsed {
    let text = raw.trim();
    let mut parsed = Parsed {
        directive: None,
        text: text.to_string(),
        queued: false,
        side: false,
    };

    if let Some(rest) = text.strip_prefix('&') {
        parsed.queued = true;
        parsed.text = rest.trim_start().to_string();
        return parsed;
    }

    let folded = text.to_lowercase();
    if !has_files && models.contains(&folded.as_str()) {
        parsed.directive = Some(Directive::Model(folded));
        parsed.text = String::new();
        return parsed;
    }

    // The remaining directives only make sense as a reply to something.
    if !in_thread || has_files {
        return parsed;
    }

    match folded.as_str() {
        "kill" => {
            parsed.directive = Some(Directive::Kill);
            parsed.text = String::new();
            return parsed;
        }
        "clean" => {
            parsed.directive = Some(Directive::Clean);
            parsed.text = String::new();
            return parsed;
        }
        "fork" | "/fork" => {
            parsed.directive = Some(Directive::Fork);
            parsed.text = String::new();
            return parsed;
        }
        _ => {}
    }

    let mut words = text.splitn(2, char::is_whitespace);
    let head = words.next().unwrap_or("").to_lowercase();
    let tail = words.next().unwrap_or("").trim();
    match head.as_str() {
        "rename" => {
            parsed.directive = Some(Directive::Rename(unquote(tail)));
            parsed.text = String::new();
        }
        "btw" | "/btw" => {
            parsed.side = true;
            parsed.text = tail.to_string();
        }
        _ => {}
    }
    parsed
}

fn unquote(value: &str) -> String {
    let title = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let bytes: Vec<char> = title.chars().collect();
    if bytes.len() > 1 && bytes[0] == bytes[bytes.len() - 1] && (bytes[0] == '"' || bytes[0] == '\'')
    {
        return bytes[1..bytes.len() - 1].iter().collect::<String>().trim().to_string();
    }
    title
}

/// One thing that arrived from the outside world.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Signal {
    pub id: String,
    /// Which adapter produced it: `slack`, `email`, `webhook`.
    pub source: String,
    /// The room it arrived in. A Slack channel id, a mailbox.
    pub conversation: String,
    /// What makes replies belong together. A Slack thread root timestamp, an
    /// email conversation id. Two signals with the same key reach the same
    /// agent without asking.
    pub thread_key: String,
    /// The adapter's own id for this message, so we can reply to it exactly.
    pub external_id: String,
    pub author: String,
    /// Human-facing provenance: `#infra @dana`.
    pub label: String,
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
    pub at: f64,
    /// True when this signal opened the thread rather than continuing one.
    pub root: bool,
}

impl Signal {
    pub fn target(&self) -> Target {
        Target::new(&self.source, &self.conversation, &self.thread_key)
    }

    /// Rough token count. Enough to reason about what we are putting in.
    pub fn tokens(&self) -> usize {
        (self.text.len() / 4).max(1)
    }
}

/// A long-running agent and the session behind it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub id: String,
    /// Short task title, kept fresh by the namer.
    pub name: String,
    pub backend: Backend,
    pub model: String,
    /// The harness's own session handle: a Codex `threadId`, a Claude
    /// `session_id`. Empty until the first turn opens one.
    #[serde(default)]
    pub session_id: String,
    pub cwd: String,
    pub status: AgentStatus,
    /// One line on what it is doing right now.
    #[serde(default)]
    pub activity: String,
    /// Deep link back into the surface that spawned it.
    #[serde(default)]
    pub permalink: String,
    pub last_activity: f64,
    pub updated_at: f64,
    #[serde(default)]
    pub stall_reason: Option<String>,
    #[serde(default)]
    pub stall_alerted: bool,
}

impl Agent {
    pub fn delivery(&self) -> Delivery {
        if self.status != AgentStatus::Working {
            Delivery::Start
        } else if self.backend.can_steer() {
            Delivery::Steer
        } else {
            Delivery::Queue
        }
    }
}

/// Which agent a conversation is wired to.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub source: String,
    pub conversation: String,
    pub thread_key: String,
    pub agent_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    /// Context we put into the agent.
    Received,
    /// The agent produced text for a human.
    Said,
    /// The agent ran commands, edited files, searched.
    Worked,
    /// The agent is blocked on an answer.
    Asked,
    /// You said something directly.
    You,
    /// oxroute itself reporting.
    Notice,
}

impl EntryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            EntryKind::Received => "received",
            EntryKind::Said => "said",
            EntryKind::Worked => "worked",
            EntryKind::Asked => "asked",
            EntryKind::You => "you",
            EntryKind::Notice => "notice",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "received" => EntryKind::Received,
            "said" => EntryKind::Said,
            "worked" => EntryKind::Worked,
            "asked" => EntryKind::Asked,
            "you" => EntryKind::You,
            _ => EntryKind::Notice,
        }
    }
}

/// One line in an agent's timeline: what came in and what it did, together.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: i64,
    pub agent_id: String,
    pub at: f64,
    pub kind: EntryKind,
    pub text: String,
    /// The command, the path, the tool name.
    #[serde(default)]
    pub detail: String,
    /// Where it came from: `slack #infra @dana`.
    #[serde(default)]
    pub origin: String,
}

/// What state a signal is in once it has reached the inbox.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InboxState {
    /// Nobody has decided where this goes.
    Waiting,
    /// Routed, one way or another.
    Done,
}

impl InboxState {
    pub fn as_str(self) -> &'static str {
        match self {
            InboxState::Waiting => "waiting",
            InboxState::Done => "done",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "waiting" => InboxState::Waiting,
            _ => InboxState::Done,
        }
    }
}

/// A signal plus what happened to it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxItem {
    pub signal: Signal,
    pub state: InboxState,
    /// Human-readable: `sent to migrate-staging-nodepool`, `discarded`.
    #[serde(default)]
    pub outcome: String,
    /// Agents this was delivered to.
    #[serde(default)]
    pub agent_ids: Vec<String>,
    /// The agent this thread is already wired to, if any. Pre-ticked in the UI.
    #[serde(default)]
    pub suggested: Option<String>,
}

/// Everything the hub pushes out. Surfaces subscribe and re-render.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Event {
    /// The whole world changed enough that a client should refetch.
    Sync,
    SignalReceived { signal: Box<Signal> },
    InboxChanged { item: Box<InboxItem> },
    AgentChanged { agent: Box<Agent> },
    Timeline { entry: Box<Entry> },
    /// Live tool activity during a turn. Replaces the previous progress for
    /// this agent rather than appending.
    Progress { agent_id: String, text: String },
    TurnStarted { agent_id: String },
    TurnFinished { agent_id: String, status: String },
    Notice { text: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    const MODELS: &[&str] = &["sol", "astra"];

    #[test]
    fn a_bare_message_is_just_text() {
        let parsed = parse_message("fix the auth test", true, false, MODELS);
        assert_eq!(parsed.directive, None);
        assert_eq!(parsed.text, "fix the auth test");
        assert!(!parsed.queued && !parsed.side);
    }

    #[test]
    fn ampersand_queues_and_never_looks_like_a_directive() {
        let parsed = parse_message("&kill", true, false, MODELS);
        assert!(parsed.queued);
        assert_eq!(parsed.directive, None);
        assert_eq!(parsed.text, "kill");
    }

    #[test]
    fn directives_need_a_thread() {
        assert_eq!(parse_message("kill", false, false, MODELS).directive, None);
        assert_eq!(
            parse_message("kill", true, false, MODELS).directive,
            Some(Directive::Kill)
        );
    }

    #[test]
    fn a_model_alias_selects_a_model_even_at_top_level() {
        assert_eq!(
            parse_message("Astra", false, false, MODELS).directive,
            Some(Directive::Model("astra".into()))
        );
    }

    #[test]
    fn files_suppress_directives_so_a_caption_is_never_a_command() {
        assert_eq!(parse_message("kill", true, true, MODELS).directive, None);
        assert_eq!(parse_message("sol", true, true, MODELS).directive, None);
    }

    #[test]
    fn rename_takes_a_quoted_title() {
        assert_eq!(
            parse_message("rename \"ship the migration\"", true, false, MODELS).directive,
            Some(Directive::Rename("ship the migration".into()))
        );
    }

    #[test]
    fn btw_is_a_side_question_not_a_directive() {
        let parsed = parse_message("btw what port is it on", true, false, MODELS);
        assert!(parsed.side);
        assert_eq!(parsed.directive, None);
        assert_eq!(parsed.text, "what port is it on");
    }

    /// `app/lib/types.ts` is hand-written against these names. A rename here
    /// would break the web UI silently, at runtime, in a way no compiler on
    /// either side would catch -- so it breaks this test instead.
    #[test]
    fn the_wire_names_the_web_ui_reads_do_not_move() {
        let signal = Signal {
            id: "s".into(),
            source: "slack".into(),
            conversation: "D1".into(),
            thread_key: "1.0".into(),
            external_id: "2.0".into(),
            author: "U".into(),
            label: "dm".into(),
            text: "hi".into(),
            attachments: vec![],
            at: 1.0,
            root: true,
        };
        let encoded = serde_json::to_value(&signal).unwrap();
        for key in ["threadKey", "externalId", "attachments", "root"] {
            assert!(encoded.get(key).is_some(), "Signal lost {key}");
        }

        let agent = Agent {
            id: "a".into(),
            name: "n".into(),
            backend: Backend::ClaudeCode,
            model: "m".into(),
            session_id: "s".into(),
            cwd: "/".into(),
            status: AgentStatus::Working,
            activity: String::new(),
            permalink: String::new(),
            last_activity: 0.0,
            updated_at: 0.0,
            stall_reason: None,
            stall_alerted: false,
        };
        let encoded = serde_json::to_value(&agent).unwrap();
        for key in ["sessionId", "lastActivity", "updatedAt", "stallReason", "stallAlerted"] {
            assert!(encoded.get(key).is_some(), "Agent lost {key}");
        }
        assert_eq!(encoded["backend"], "claude-code");
        assert_eq!(encoded["status"], "working");

        let event = Event::Progress {
            agent_id: "a".into(),
            text: "running".into(),
        };
        let encoded = serde_json::to_value(&event).unwrap();
        assert_eq!(encoded["type"], "progress");
        assert_eq!(encoded["agentId"], "a");

        let item = InboxItem {
            signal,
            state: InboxState::Waiting,
            outcome: String::new(),
            agent_ids: vec!["a".into()],
            suggested: Some("a".into()),
        };
        let encoded = serde_json::to_value(&item).unwrap();
        assert!(encoded.get("agentIds").is_some());
        assert!(encoded.get("suggested").is_some());
        assert_eq!(encoded["state"], "waiting");
    }

    #[test]
    fn claude_code_queues_where_codex_steers() {
        let mut agent = Agent {
            id: "a".into(),
            name: "n".into(),
            backend: Backend::Codex,
            model: "m".into(),
            session_id: String::new(),
            cwd: "/".into(),
            status: AgentStatus::Working,
            activity: String::new(),
            permalink: String::new(),
            last_activity: 0.0,
            updated_at: 0.0,
            stall_reason: None,
            stall_alerted: false,
        };
        assert_eq!(agent.delivery(), Delivery::Steer);
        agent.backend = Backend::ClaudeCode;
        assert_eq!(agent.delivery(), Delivery::Queue);
        agent.status = AgentStatus::Complete;
        assert_eq!(agent.delivery(), Delivery::Start);
    }
}
