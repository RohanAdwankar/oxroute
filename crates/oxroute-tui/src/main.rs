//! The oxroute terminal UI.
//!
//! Same shape as the web UI, because it is the same state: the inbox is the
//! left column, the fleet is the main view, and one item is one decision --
//! send it to agents that already exist, start a new one for it, or discard.
//!
//! It holds no state the daemon does not have. Every key press is an API
//! call, and the screen is redrawn from the event stream, so a routing
//! decision made here shows up in the browser without either of them knowing
//! the other exists.

mod client;
mod theme;
mod ui;

use std::collections::BTreeSet;

use anyhow::Result;
use crossterm::event::{
    Event as TermEvent, EventStream, KeyCode, KeyEvent, KeyEventKind, KeyModifiers,
};
use futures_util::StreamExt;
use oxroute_core::model::{Event, InboxState};
use oxroute_core::Snapshot;

use client::{AgentView, Client};

const DEFAULT_DAEMON: &str = "http://127.0.0.1:8787";

/// Which column the keys act on.
#[derive(PartialEq, Eq, Clone, Copy)]
pub enum Focus {
    Inbox,
    Fleet,
}

/// What the main column is showing.
#[derive(Clone)]
pub enum View {
    /// Every agent, as a list.
    Fleet,
    /// One agent's timeline.
    Agent(String),
    /// Where does this signal go? The fleet, with ticks.
    Routing { signal: String },
}

/// A line of text being typed.
#[derive(Clone)]
pub struct Prompt {
    pub label: String,
    pub value: String,
    pub action: PromptAction,
}

#[derive(Clone)]
pub enum PromptAction {
    Say(String),
    Rename(String),
    /// Start an agent for this signal, on whichever model is typed.
    Spawn(String),
    /// Add something you thought of to the inbox.
    Note,
}

pub struct App {
    client: Client,
    pub snapshot: Snapshot,
    pub view: View,
    pub focus: Focus,
    pub inbox_cursor: usize,
    pub fleet_cursor: usize,
    pub timeline_scroll: u16,
    /// Ticked agents, while routing.
    pub ticked: BTreeSet<String>,
    pub detail: Option<AgentView>,
    pub prompt: Option<Prompt>,
    pub notice: Option<(String, std::time::Instant)>,
    pub help: bool,
    quit: bool,
}

impl App {
    async fn new(client: Client) -> Result<Self> {
        let snapshot = client.snapshot().await?;
        Ok(App {
            client,
            snapshot,
            view: View::Fleet,
            focus: Focus::Inbox,
            inbox_cursor: 0,
            fleet_cursor: 0,
            timeline_scroll: 0,
            ticked: BTreeSet::new(),
            detail: None,
            prompt: None,
            notice: None,
            help: false,
            quit: false,
        })
    }

    pub fn note(&mut self, text: impl Into<String>) {
        self.notice = Some((text.into(), std::time::Instant::now()));
    }

    /// The notice bar clears itself; a message that stays forever stops being
    /// read.
    pub fn live_notice(&self) -> Option<&str> {
        self.notice.as_ref().and_then(|(text, at)| {
            (at.elapsed() < std::time::Duration::from_secs(6)).then_some(text.as_str())
        })
    }

    pub fn waiting(&self) -> Vec<&oxroute_core::InboxItem> {
        self.snapshot
            .inbox
            .iter()
            .filter(|i| i.state == InboxState::Waiting)
            .collect()
    }

    pub fn inbox_selection(&self) -> Option<&oxroute_core::InboxItem> {
        self.snapshot.inbox.get(self.inbox_cursor)
    }

    pub fn fleet_selection(&self) -> Option<&oxroute_core::Agent> {
        self.snapshot.agents.get(self.fleet_cursor)
    }

    async fn resync(&mut self) {
        match self.client.snapshot().await {
            Ok(snapshot) => {
                self.snapshot = snapshot;
                self.inbox_cursor = self.inbox_cursor.min(self.snapshot.inbox.len().saturating_sub(1));
                self.fleet_cursor = self.fleet_cursor.min(self.snapshot.agents.len().saturating_sub(1));
            }
            Err(error) => self.note(format!("daemon: {error}")),
        }
        if let View::Agent(id) = self.view.clone() {
            match self.client.agent(&id).await {
                Ok(detail) => self.detail = Some(detail),
                Err(error) => self.note(format!("agent: {error}")),
            }
        }
    }

    async fn open_agent(&mut self, id: String) {
        match self.client.agent(&id).await {
            Ok(detail) => {
                self.detail = Some(detail);
                self.view = View::Agent(id);
                self.timeline_scroll = 0;
                self.focus = Focus::Fleet;
            }
            Err(error) => self.note(format!("agent: {error}")),
        }
    }

    // -- keys ------------------------------------------------------------

    async fn key(&mut self, key: KeyEvent) {
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
            self.quit = true;
            return;
        }
        if self.prompt.is_some() {
            self.prompt_key(key).await;
            return;
        }
        if self.help {
            self.help = false;
            return;
        }

        match key.code {
            KeyCode::Char('q') => self.quit = true,
            KeyCode::Char('?') => self.help = true,
            KeyCode::Tab => {
                self.focus = match self.focus {
                    Focus::Inbox => Focus::Fleet,
                    Focus::Fleet => Focus::Inbox,
                }
            }
            KeyCode::Esc => self.escape(),
            KeyCode::Char('j') | KeyCode::Down => self.move_cursor(1),
            KeyCode::Char('k') | KeyCode::Up => self.move_cursor(-1),
            KeyCode::Char('g') => self.set_cursor(0),
            KeyCode::Char('G') => self.set_cursor(usize::MAX),
            KeyCode::Enter => self.enter().await,
            KeyCode::Char(' ') => self.tick(),
            KeyCode::Char('n') => self.spawn(),
            KeyCode::Char('a') => {
                // An idea of your own becomes an ordinary signal and queues
                // with everything else, so it is routed by the same decision.
                self.prompt = Some(Prompt {
                    label: "add to inbox".into(),
                    value: String::new(),
                    action: PromptAction::Note,
                });
            }
            KeyCode::Char('d') => self.discard().await,
            KeyCode::Char('x') => self.interrupt().await,
            KeyCode::Char('f') => self.fork().await,
            KeyCode::Char('r') => self.begin_rename(),
            KeyCode::Char('i') => self.begin_say(),
            KeyCode::Char('m') => self.toggle_mode().await,
            KeyCode::Char('R') => self.resync().await,
            _ => {}
        }
    }

    async fn prompt_key(&mut self, key: KeyEvent) {
        let Some(prompt) = self.prompt.as_mut() else { return };
        match key.code {
            KeyCode::Esc => self.prompt = None,
            KeyCode::Backspace => {
                prompt.value.pop();
            }
            KeyCode::Char(c) => prompt.value.push(c),
            KeyCode::Enter => {
                let prompt = self.prompt.take().expect("checked above");
                let value = prompt.value.trim().to_string();
                if value.is_empty() {
                    return;
                }
                let outcome = match prompt.action {
                    PromptAction::Say(agent) => self.client.say(&agent, &value).await,
                    PromptAction::Rename(agent) => self.client.rename(&agent, &value).await,
                    PromptAction::Note => self.client.note(&value).await,
                    PromptAction::Spawn(signal) => {
                        let spawned = self.client.route_spawn(&signal, Some(&value)).await;
                        if spawned.is_ok() {
                            self.view = View::Fleet;
                            self.focus = Focus::Inbox;
                            self.ticked.clear();
                        }
                        spawned
                    }
                };
                match outcome {
                    Ok(()) => self.resync().await,
                    Err(error) => self.note(error.to_string()),
                }
            }
            _ => {}
        }
    }

    fn escape(&mut self) {
        match self.view {
            View::Fleet => self.focus = Focus::Inbox,
            _ => {
                self.view = View::Fleet;
                self.ticked.clear();
                self.detail = None;
            }
        }
    }

    fn move_cursor(&mut self, delta: isize) {
        if let View::Agent(_) = self.view {
            if self.focus == Focus::Fleet {
                self.timeline_scroll = self
                    .timeline_scroll
                    .saturating_add_signed(delta.clamp(-1, 1) as i16);
                return;
            }
        }
        let (cursor, len) = match self.focus {
            Focus::Inbox => (&mut self.inbox_cursor, self.snapshot.inbox.len()),
            Focus::Fleet => (&mut self.fleet_cursor, self.snapshot.agents.len()),
        };
        if len == 0 {
            return;
        }
        let next = (*cursor as isize + delta).clamp(0, len as isize - 1);
        *cursor = next as usize;
    }

    fn set_cursor(&mut self, to: usize) {
        let (cursor, len) = match self.focus {
            Focus::Inbox => (&mut self.inbox_cursor, self.snapshot.inbox.len()),
            Focus::Fleet => (&mut self.fleet_cursor, self.snapshot.agents.len()),
        };
        *cursor = to.min(len.saturating_sub(1));
    }

    async fn enter(&mut self) {
        match (self.focus, self.view.clone()) {
            // A waiting item is a question: where does this go? Answering it
            // is the whole interface.
            (Focus::Inbox, _) => {
                let Some(item) = self.inbox_selection() else { return };
                if item.state != InboxState::Waiting {
                    // A settled item is history; jump to where it went.
                    if let Some(agent) = item.agent_ids.first().cloned() {
                        self.open_agent(agent).await;
                    }
                    return;
                }
                let signal = item.signal.id.clone();
                self.ticked = item.suggested.iter().cloned().collect();
                self.view = View::Routing { signal };
                self.focus = Focus::Fleet;
            }
            (Focus::Fleet, View::Routing { signal }) => {
                if self.ticked.is_empty() {
                    self.note("tick an agent with space, or press n for a new one");
                    return;
                }
                let agents: Vec<String> = self.ticked.iter().cloned().collect();
                match self.client.route_existing(&signal, &agents).await {
                    Ok(()) => {
                        self.view = View::Fleet;
                        self.focus = Focus::Inbox;
                        self.ticked.clear();
                        self.resync().await;
                    }
                    Err(error) => self.note(error.to_string()),
                }
            }
            (Focus::Fleet, _) => {
                let Some(agent) = self.fleet_selection().map(|a| a.id.clone()) else { return };
                self.open_agent(agent).await;
            }
        }
    }

    fn tick(&mut self) {
        if !matches!(self.view, View::Routing { .. }) {
            return;
        }
        let Some(agent) = self.fleet_selection().map(|a| a.id.clone()) else { return };
        if !self.ticked.remove(&agent) {
            self.ticked.insert(agent);
        }
    }

    /// Start a new agent. From the inbox that means "this signal deserves its
    /// own agent"; anywhere else there is nothing to start one *about*.
    ///
    /// Which model is asked rather than assumed, because the model also picks
    /// the harness, and Codex and Claude Code behave differently enough that
    /// guessing would be rude.
    fn spawn(&mut self) {
        let signal = match &self.view {
            View::Routing { signal } => signal.clone(),
            _ => match self.inbox_selection() {
                Some(item) if item.state == InboxState::Waiting => item.signal.id.clone(),
                _ => {
                    self.note("select a waiting signal first");
                    return;
                }
            },
        };
        let choices = self
            .snapshot
            .models
            .iter()
            .map(|m| m.alias.as_str())
            .collect::<Vec<_>>()
            .join("/");
        let default = self
            .snapshot
            .models
            .iter()
            .find(|m| m.id == self.snapshot.default_model)
            .or_else(|| self.snapshot.models.first())
            .map(|m| m.alias.clone())
            .unwrap_or_default();
        self.prompt = Some(Prompt {
            label: format!("new agent on [{choices}]"),
            value: default,
            action: PromptAction::Spawn(signal),
        });
    }

    async fn discard(&mut self) {
        let signal = match &self.view {
            View::Routing { signal } => signal.clone(),
            _ => match self.inbox_selection() {
                Some(item) if item.state == InboxState::Waiting => item.signal.id.clone(),
                _ => return,
            },
        };
        match self.client.discard(&signal).await {
            Ok(()) => {
                self.view = View::Fleet;
                self.focus = Focus::Inbox;
                self.ticked.clear();
                self.resync().await;
            }
            Err(error) => self.note(error.to_string()),
        }
    }

    fn current_agent(&self) -> Option<String> {
        match &self.view {
            View::Agent(id) => Some(id.clone()),
            _ => self.fleet_selection().map(|a| a.id.clone()),
        }
    }

    async fn interrupt(&mut self) {
        let Some(agent) = self.current_agent() else { return };
        match self.client.interrupt(&agent).await {
            Ok(()) => {
                self.note("stopped");
                self.resync().await;
            }
            Err(error) => self.note(error.to_string()),
        }
    }

    async fn fork(&mut self) {
        let Some(agent) = self.current_agent() else { return };
        match self.client.fork(&agent).await {
            Ok(()) => {
                self.note("forked");
                self.resync().await;
            }
            Err(error) => self.note(error.to_string()),
        }
    }

    fn begin_rename(&mut self) {
        let Some(agent) = self.current_agent() else { return };
        let current = self
            .snapshot
            .agents
            .iter()
            .find(|a| a.id == agent)
            .map(|a| a.name.clone())
            .unwrap_or_default();
        self.prompt = Some(Prompt {
            label: "rename".into(),
            value: current,
            action: PromptAction::Rename(agent),
        });
    }

    fn begin_say(&mut self) {
        let Some(agent) = self.current_agent() else { return };
        self.prompt = Some(Prompt {
            label: "say".into(),
            value: String::new(),
            action: PromptAction::Say(agent),
        });
    }

    async fn toggle_mode(&mut self) {
        let next = if self.snapshot.mode == "auto" { "ask" } else { "auto" };
        match self.client.set_mode(next).await {
            Ok(()) => {
                self.resync().await;
                self.note(match next {
                    "ask" => "new threads wait in the inbox",
                    _ => "new threads start an agent on their own",
                });
            }
            Err(error) => self.note(error.to_string()),
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let base = std::env::args()
        .nth(1)
        .or_else(|| std::env::var("OXROUTE_DAEMON").ok())
        .unwrap_or_else(|| DEFAULT_DAEMON.into());
    if matches!(base.as_str(), "-h" | "--help" | "help") {
        println!(
            "oxroute -- the terminal UI\n\n  oxroute [daemon-url]\n\n\
             Defaults to {DEFAULT_DAEMON}, or $OXROUTE_DAEMON."
        );
        return Ok(());
    }

    let client = Client::new(&base);
    let mut app = App::new(client.clone()).await.map_err(|error| {
        anyhow::anyhow!("could not reach the oxroute daemon at {base}: {error}")
    })?;

    let mut terminal = ratatui::init();
    let outcome = run(&mut terminal, &mut app, client).await;
    ratatui::restore();
    outcome
}

async fn run(
    terminal: &mut ratatui::DefaultTerminal,
    app: &mut App,
    client: Client,
) -> Result<()> {
    let mut keys = EventStream::new();
    let mut events = client.follow();
    // Redraw on a slow tick as well, so elapsed times and the notice bar stay
    // honest when nothing is happening.
    let mut tick = tokio::time::interval(std::time::Duration::from_millis(500));

    loop {
        terminal.draw(|frame| ui::draw(frame, app))?;
        tokio::select! {
            Some(event) = keys.next() => {
                match event? {
                    // Windows terminals report release as well as press;
                    // acting on both would double every key.
                    TermEvent::Key(key) if key.kind == KeyEventKind::Press => {
                        app.key(key).await
                    }
                    TermEvent::Resize(_, _) => {}
                    _ => {}
                }
            }
            Some(event) = events.recv() => {
                match event {
                    // Anything structural is cheapest to handle by asking
                    // again; the snapshot is small and always right.
                    Event::Sync
                    | Event::InboxChanged { .. }
                    | Event::AgentChanged { .. }
                    | Event::SignalReceived { .. }
                    | Event::TurnStarted { .. }
                    | Event::TurnFinished { .. } => app.resync().await,
                    Event::Timeline { .. } => {
                        if matches!(app.view, View::Agent(_)) {
                            app.resync().await;
                        }
                    }
                    Event::Progress { agent_id, text } => {
                        if let Some(agent) = app
                            .snapshot
                            .agents
                            .iter_mut()
                            .find(|a| a.id == agent_id)
                        {
                            agent.activity = text;
                        }
                    }
                    Event::Notice { text } => app.note(text),
                }
            }
            _ = tick.tick() => {}
        }
        if app.quit {
            return Ok(());
        }
    }
}
