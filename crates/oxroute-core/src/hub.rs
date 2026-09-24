//! Where signals, agents and surfaces meet.
//!
//! The hub is the only thing that knows about all three. A source pushes a
//! `Signal` in; the hub decides which agent it belongs to, runs a turn on
//! whichever harness that agent uses, and pushes the result back out to every
//! surface at once -- the thread it came from, the web UI, the TUI.
//!
//! Two rules shape everything here:
//!
//! * **A conversation is serialized, the fleet is not.** Turns in one thread
//!   queue behind each other; independent threads run at the same time.
//! * **A surface is never privileged.** Answering in Slack, the TUI or the
//!   browser takes the same path, so no behaviour hides in one of them.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

use tokio::sync::{broadcast, mpsc, Mutex as AsyncMutex, Notify};

use crate::agent::claude::ClaudeHarness;
use crate::agent::codex::CodexHarness;
use crate::agent::{Harness, HarnessEvent, SessionSpec};
use crate::config::{free_bytes, Config, Mode};
use crate::dashboard;
use crate::model::*;
use crate::naming;
use crate::progress::{Progress, MAX_BYTES};
use crate::source::{Posted, Source, SourceEvent};
use crate::store::{ActiveTurn, Store};

const ERROR_REPLY: &str = "That request could not be completed.";
const LOW_STORAGE_REPLY: &str = "Disk is critically low. This request was not started.";
/// Wait this long before posting a progress message. Most turns that answer
/// instantly should never produce one at all.
const PROGRESS_DELAY: std::time::Duration = std::time::Duration::from_secs(2);
const PROGRESS_INTERVAL: std::time::Duration = std::time::Duration::from_secs(3);
const DASHBOARD_KEY: &str = "dashboard";
const MODE_KEY: &str = "mode";

/// What to do with a signal waiting in the inbox.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Routing {
    /// Send it to agents that already exist. More than one is allowed: the
    /// same fact often matters to several.
    Existing { agent_ids: Vec<String> },
    /// Spin up a new agent for it.
    Spawn {
        #[serde(default)]
        backend: Option<String>,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        cwd: Option<String>,
    },
    /// Not worth an agent's attention.
    Discard,
}

/// A turn currently running, and everything watching it.
///
/// The locks here are `std::sync::Mutex` rather than tokio's on purpose.
/// Every one of them is held for a field read or a field write with no await
/// in between, and the harness event pump touches them from a context where
/// waiting on an async lock could park the only thread the runtime has.
struct Live {
    session: String,
    turn_id: Mutex<Option<String>>,
    /// Fires once the harness has told us the turn id, which is what steering
    /// and interrupting both need.
    ready: Notify,
    is_ready: AtomicBool,
    done: Notify,
    is_done: AtomicBool,
    status: Mutex<Option<String>>,
    answer: Mutex<Option<String>>,
    progress: Mutex<Progress>,
    artifacts: Mutex<HashSet<String>>,
    artifact_dir: PathBuf,
    /// Set when a person stopped it, so the failure path stays quiet.
    stopped: AtomicBool,
    target: Option<Target>,
    posted: Mutex<Option<Posted>>,
    /// A side turn's output belongs to the caller, not the timeline.
    quiet: bool,
}

impl Live {
    fn new(session: String, artifact_dir: PathBuf, target: Option<Target>, quiet: bool) -> Self {
        Live {
            session,
            turn_id: Mutex::new(None),
            ready: Notify::new(),
            is_ready: AtomicBool::new(false),
            done: Notify::new(),
            is_done: AtomicBool::new(false),
            status: Mutex::new(None),
            answer: Mutex::new(None),
            progress: Mutex::new(Progress::new()),
            artifacts: Mutex::new(HashSet::new()),
            artifact_dir,
            stopped: AtomicBool::new(false),
            target,
            posted: Mutex::new(None),
            quiet,
        }
    }

    fn mark_ready(&self, turn_id: String) {
        *self.turn_id.lock().unwrap() = Some(turn_id);
        self.is_ready.store(true, Ordering::SeqCst);
        self.ready.notify_waiters();
    }

    fn turn_id(&self) -> Option<String> {
        self.turn_id.lock().unwrap().clone()
    }

    /// End the turn. The first status to arrive wins, so the caller can call
    /// this unconditionally to release anything still waiting without
    /// overwriting what the harness actually said.
    fn finish(&self, status: String) {
        {
            let mut slot = self.status.lock().unwrap();
            if slot.is_none() {
                *slot = Some(status);
            }
        }
        self.is_done.store(true, Ordering::SeqCst);
        self.is_ready.store(true, Ordering::SeqCst);
        self.ready.notify_waiters();
        self.done.notify_waiters();
    }

    fn status(&self) -> String {
        self.status.lock().unwrap().clone().unwrap_or_default()
    }

    fn done(&self) -> bool {
        self.is_done.load(Ordering::SeqCst)
    }

    /// Wait for the turn id. Bounded, because a harness that never reports
    /// one must not wedge the message that is waiting to steer.
    async fn wait_ready(&self) {
        if self.is_ready.load(Ordering::SeqCst) {
            return;
        }
        let _ = tokio::time::timeout(std::time::Duration::from_secs(120), async {
            loop {
                // Register before re-checking, or a notify between the two
                // is missed and this waits forever.
                let waiter = self.ready.notified();
                if self.is_ready.load(Ordering::SeqCst) {
                    return;
                }
                waiter.await;
            }
        })
        .await;
    }

    /// Wait for the turn to end. Deliberately unbounded: a turn may
    /// legitimately run for hours, and the stall watch is what notices when
    /// one should not be.
    async fn wait_done(&self) {
        loop {
            let waiter = self.done.notified();
            if self.is_done.load(Ordering::SeqCst) {
                return;
            }
            waiter.await;
        }
    }
}

pub struct Hub {
    pub config: Config,
    pub store: Arc<Store>,
    /// One per backend. A map rather than two fields so a test -- or a third
    /// harness later -- can be dropped in without the hub changing shape.
    harnesses: HashMap<Backend, Arc<dyn Harness>>,
    sources: HashMap<String, Arc<dyn Source>>,
    events: broadcast::Sender<Event>,
    /// Session handle -> agent id. The harnesses speak in their own ids.
    sessions: AsyncMutex<HashMap<String, String>>,
    live: AsyncMutex<HashMap<String, Arc<Live>>>,
    /// One per agent, so its turns run in order.
    locks: AsyncMutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    naming: AsyncMutex<HashSet<String>>,
}

impl Hub {
    pub fn new(config: Config, store: Store) -> Arc<Self> {
        let codex = Arc::new(CodexHarness::new(&config));
        let claude = Arc::new(ClaudeHarness::new(&config));
        let harnesses: HashMap<Backend, Arc<dyn Harness>> = HashMap::from([
            (Backend::Codex, codex as Arc<dyn Harness>),
            (Backend::ClaudeCode, claude as Arc<dyn Harness>),
        ]);
        Arc::new(Hub {
            harnesses,
            config,
            store: Arc::new(store),
            sources: HashMap::new(),
            events: broadcast::channel(4096).0,
            sessions: AsyncMutex::new(HashMap::new()),
            live: AsyncMutex::new(HashMap::new()),
            locks: AsyncMutex::new(HashMap::new()),
            naming: AsyncMutex::new(HashSet::new()),
        })
    }

    pub fn with_source(self: &mut Arc<Self>, source: Arc<dyn Source>) {
        let hub = Arc::get_mut(self).expect("sources are registered before the hub is shared");
        hub.sources.insert(source.name().to_string(), source);
    }

    /// Replace the harness for one backend. Registration happens before the
    /// hub is shared, so this cannot race a running turn.
    pub fn with_harness(self: &mut Arc<Self>, harness: Arc<dyn Harness>) {
        let hub = Arc::get_mut(self).expect("harnesses are registered before the hub is shared");
        hub.harnesses.insert(harness.backend(), harness);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }

    pub fn emit(&self, event: Event) {
        let _ = self.events.send(event);
    }

    pub fn source(&self, name: &str) -> Option<Arc<dyn Source>> {
        self.sources.get(name).cloned()
    }

    fn harness(&self, backend: Backend) -> Arc<dyn Harness> {
        self.harnesses
            .get(&backend)
            .cloned()
            .expect("every backend is registered when the hub is built")
    }

    pub fn mode(&self) -> Mode {
        self.store
            .get(MODE_KEY)
            .ok()
            .flatten()
            .map(|v| Mode::parse(&v))
            .unwrap_or(Mode::Ask)
    }

    pub fn set_mode(&self, mode: Mode) -> Result<()> {
        self.store.set(MODE_KEY, mode.as_str())?;
        self.emit(Event::Sync);
        Ok(())
    }

    // -- lifecycle -------------------------------------------------------

    /// Start every background task: the harness pumps, the sources, the stall
    /// watch. Returns once they are running.
    pub async fn start(self: &Arc<Self>) -> Result<()> {
        tokio::fs::create_dir_all(&self.config.artifacts).await.ok();
        tokio::fs::create_dir_all(&self.config.attachments).await.ok();

        for harness in self.harnesses.values() {
            self.pump(harness.events());
        }

        // Codex lives outside this process. Rebuild the local watchers for
        // turns that kept running while this daemon was replaced.
        self.restore_turns().await;

        // Anything without a durable live turn really was orphaned.
        let orphaned = self.store.recover(now())?;
        for agent in &orphaned {
            self.announce_stall(agent, "oxroute restarted").await;
        }

        let (tx, rx) = mpsc::unbounded_channel();
        for source in self.sources.values() {
            let source = source.clone();
            let tx = tx.clone();
            tokio::spawn(async move {
                if let Err(error) = source.run(tx).await {
                    tracing::error!(source = source.name(), %error, "source stopped");
                }
            });
        }
        self.clone().consume(rx);
        self.clone().watch_stalls();
        self.refresh_dashboard().await;
        Ok(())
    }

    async fn restore_turns(self: &Arc<Self>) {
        let Ok(saved) = self.store.active_turns() else { return };
        for saved in saved {
            let Some(agent) = self.store.agent(&saved.agent_id).ok().flatten() else {
                let _ = self.store.clear_active_turn(&saved.agent_id);
                continue;
            };
            let harness = self.harness(agent.backend);
            let turn = Arc::new(Live::new(
                saved.session_id.clone(),
                saved.artifact_dir,
                saved.target,
                false,
            ));
            if !saved.turn_id.is_empty() {
                turn.mark_ready(saved.turn_id);
            }
            self.sessions
                .lock()
                .await
                .insert(saved.session_id.clone(), agent.id.clone());
            self.live.lock().await.insert(agent.id.clone(), turn.clone());

            let spec = SessionSpec {
                model: agent.model.clone(),
                cwd: agent.cwd.clone(),
                resume: Some(saved.session_id.clone()),
                ephemeral: false,
            };
            match harness.recover(&saved.session_id, &spec).await {
                Ok(Some(snapshot)) => {
                    if !snapshot.id.is_empty() {
                        turn.mark_ready(snapshot.id.clone());
                        let _ = self.store.set_active_turn_id(&agent.id, &snapshot.id);
                    }
                    Self::hydrate(&turn, &snapshot.items);
                    if snapshot.status != "inProgress" {
                        turn.finish(snapshot.status);
                    }
                    let hub = self.clone();
                    tokio::spawn(async move {
                        let lock = hub.lock_for(&agent.id).await;
                        let _held = lock.lock().await;
                        if let Err(error) = hub.settle_turn(&agent, turn, harness).await {
                            tracing::error!(agent = agent.id, %error, "recovered turn failed");
                        }
                    });
                }
                Ok(None) | Err(_) => {
                    self.live.lock().await.remove(&agent.id);
                    self.sessions.lock().await.remove(&saved.session_id);
                    let _ = self.store.clear_active_turn(&agent.id);
                }
            }
        }
    }

    fn hydrate(turn: &Live, items: &[serde_json::Value]) {
        for item in items {
            turn.progress.lock().unwrap().observe(item);
            match item.get("type").and_then(serde_json::Value::as_str) {
                Some("agentMessage") => {
                    if let Some(text) = item.get("text").and_then(serde_json::Value::as_str) {
                        let final_answer = item.get("phase").and_then(serde_json::Value::as_str)
                            == Some("final_answer");
                        let mut answer = turn.answer.lock().unwrap();
                        if final_answer || answer.is_none() {
                            *answer = Some(text.to_string());
                        }
                    }
                }
                Some("imageGeneration") => {
                    if let Some(path) = item.get("savedPath").and_then(serde_json::Value::as_str) {
                        turn.artifacts.lock().unwrap().insert(path.to_string());
                    }
                }
                _ => {}
            }
        }
    }

    /// Fold one harness's event stream into the hub's.
    fn pump(self: &Arc<Self>, mut events: broadcast::Receiver<HarnessEvent>) {
        let hub = self.clone();
        tokio::spawn(async move {
            loop {
                match events.recv().await {
                    Ok(event) => hub.on_harness_event(event).await,
                    // A lagging subscriber has missed activity, not results:
                    // every turn outcome is also awaited directly.
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!(missed = n, "harness events dropped");
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    fn consume(self: Arc<Self>, mut rx: mpsc::UnboundedReceiver<SourceEvent>) {
        tokio::spawn(async move {
            while let Some(event) = rx.recv().await {
                match event {
                    SourceEvent::Arrived(signal) => {
                        let hub = self.clone();
                        // Each signal gets its own task; a slow turn in one
                        // thread must not hold up another thread's message.
                        tokio::spawn(async move {
                            if let Err(error) = hub.accept(*signal).await {
                                tracing::error!(%error, "handling a signal failed");
                            }
                        });
                    }
                    SourceEvent::Command { name, user, reply } => {
                        let answer = self.command(&name, &user).await;
                        let _ = reply.send(answer);
                    }
                }
            }
        });
    }

    fn watch_stalls(self: Arc<Self>) {
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(std::time::Duration::from_secs(30));
            ticker.tick().await;
            loop {
                ticker.tick().await;
                let at = now();
                let reason = dashboard::stalled_reason(self.config.stall_timeout);
                match self
                    .store
                    .stall_inactive(at - self.config.stall_timeout, at, &reason)
                {
                    Ok(stalled) => {
                        for agent in &stalled {
                            self.announce_stall(agent, &reason).await;
                        }
                        if !stalled.is_empty() {
                            self.emit(Event::Sync);
                        }
                    }
                    Err(error) => tracing::error!(%error, "stall sweep failed"),
                }
                self.refresh_dashboard().await;
            }
        });
    }

    // -- harness events --------------------------------------------------

    async fn on_harness_event(&self, event: HarnessEvent) {
        if let HarnessEvent::Down { message } = &event {
            // The process holding every Codex thread has gone. Fail what was
            // running rather than leaving turns waiting on a dead pipe.
            let live: Vec<Arc<Live>> = self.live.lock().await.values().cloned().collect();
            for turn in live {
                turn.finish("systemError".into());
            }
            self.emit(Event::Notice {
                text: format!("harness down: {message}"),
            });
            return;
        }

        let Some(session) = event.session() else { return };
        let Some(agent_id) = self.sessions.lock().await.get(session).cloned() else {
            return;
        };

        match event {
            HarnessEvent::TurnStarted { turn_id, .. } => {
                if let Some(turn) = self.live.lock().await.get(&agent_id) {
                    turn.mark_ready(turn_id);
                }
                let _ = self.store.touch_agent(&agent_id, None, now());
                self.emit(Event::TurnStarted { agent_id });
            }
            HarnessEvent::Item { item, .. } => {
                let _ = self.store.touch_agent(&agent_id, None, now());
                let activity = {
                    let live = self.live.lock().await;
                    let Some(turn) = live.get(&agent_id) else { return };
                    let mut progress = turn.progress.lock().unwrap();
                    progress.observe(&item);
                    progress.activity()
                };
                let _ = self.store.touch_agent(&agent_id, Some(&activity), now());
                // A finished piece of work is worth keeping; the rest is
                // just the status line moving.
                if item.get("type").and_then(serde_json::Value::as_str) == Some("toolResult") {
                    let item_id = item.get("id").and_then(serde_json::Value::as_str).unwrap_or("");
                    let output = crate::progress::item_output(&item);
                    if !item_id.is_empty() && !output.is_empty() {
                        if let Ok(Some(entry)) =
                            self.store.set_work_output(&agent_id, item_id, &output)
                        {
                            self.emit(Event::Timeline { entry: Box::new(entry) });
                        }
                    }
                }
                if let Some(summary) = crate::progress::summarize(&item) {
                    self.record_work(&agent_id, summary);
                }
                self.emit(Event::Progress {
                    agent_id,
                    text: activity,
                });
            }
            HarnessEvent::Message {
                text, final_answer, ..
            } => {
                {
                    let live = self.live.lock().await;
                    let Some(turn) = live.get(&agent_id) else { return };
                    let mut answer = turn.answer.lock().unwrap();
                    // The phase-marked final answer wins; otherwise the first
                    // thing it said stands in, which is all Claude Code gives.
                    if final_answer || answer.is_none() {
                        *answer = Some(text.clone());
                    }
                }
                // Narration as it happens. The final answer is recorded when
                // the turn ends, so recording it here too would double it.
                if !final_answer {
                    self.record(&agent_id, EntryKind::Said, &text, "", "");
                }
            }
            HarnessEvent::Artifact { path, .. } => {
                if let Some(turn) = self.live.lock().await.get(&agent_id) {
                    turn.artifacts.lock().unwrap().insert(path);
                }
            }
            HarnessEvent::TurnFinished { status, .. } => {
                if let Some(turn) = self.live.lock().await.get(&agent_id) {
                    turn.finish(status);
                }
            }
            HarnessEvent::Named { name, .. } => {
                if !naming::placeholder(&name) {
                    let _ = self.store.rename_agent(&agent_id, &name);
                    self.emit(Event::Sync);
                }
            }
            HarnessEvent::SessionError { message, .. } => {
                self.stall(&agent_id, &message).await;
                if let Some(turn) = self.live.lock().await.get(&agent_id) {
                    turn.finish("systemError".into());
                }
            }
            HarnessEvent::Down { .. } => {}
        }
    }

    /// Write one line to an agent's timeline and push it to every surface.
    ///
    /// Persisting and broadcasting belong together: a surface that reloads
    /// and a surface that is following the stream must end up with the same
    /// timeline, and they will not if only one of the two happens.
    fn record(
        &self,
        agent_id: &str,
        kind: EntryKind,
        text: &str,
        detail: &str,
        origin: &str,
    ) -> Option<Entry> {
        match self.store.add_entry(agent_id, now(), kind, text, detail, origin) {
            Ok(entry) => {
                self.emit(Event::Timeline {
                    entry: Box::new(entry.clone()),
                });
                Some(entry)
            }
            Err(error) => {
                tracing::error!(%error, "could not record a timeline entry");
                None
            }
        }
    }

    fn record_work(&self, agent_id: &str, summary: crate::progress::Summary) -> Option<Entry> {
        match self.store.add_work_entry(
            agent_id,
            now(),
            &summary.label,
            &summary.detail,
            &summary.output,
            &summary.item_id,
        ) {
            Ok(entry) => {
                self.emit(Event::Timeline { entry: Box::new(entry.clone()) });
                Some(entry)
            }
            Err(error) => {
                tracing::error!(%error, "could not record tool activity");
                None
            }
        }
    }

    fn record_fork(&self, parent: &str, child: &str) {
        self.record(
            child,
            EntryKind::ForkedFrom,
            "Forked from session",
            parent,
            "",
        );
        self.record(parent, EntryKind::Forked, "Session forked", child, "");
    }

    // -- signals ---------------------------------------------------------

    /// A signal arrived. Decide where it goes and get it there.
    pub async fn accept(self: &Arc<Self>, signal: Signal) -> Result<()> {
        if !self.store.put_signal(&signal)? {
            // Sources redeliver. That is normal, not an error.
            return Ok(());
        }
        // Slack messages never need a routing decision: a root starts an
        // agent and a reply follows its binding. Mark them settled before
        // surfaces hear about them so they never flash under "Waiting".
        if signal.source == crate::source::slack::SOURCE {
            self.store.resolve_signal(&signal.id, "routing", &[])?;
        }
        self.emit(Event::SignalReceived {
            signal: Box::new(signal.clone()),
        });

        let target = signal.target();
        let bound = self
            .store
            .bound_agent(&signal.source, &signal.conversation, &signal.thread_key)?;
        let parsed = parse_message(
            &signal.text,
            !signal.root,
            !signal.attachments.is_empty(),
            &self.config.model_aliases(),
        );

        // Directives first: they are about the wiring, not about the work.
        if let Some(directive) = parsed.directive.clone() {
            return self.apply_directive(&signal, bound.as_deref(), directive).await;
        }

        if free_bytes(&self.config.artifacts) < self.config.min_free_bytes {
            self.resolve(&signal, LOW_STORAGE_REPLY, &[]).await;
            self.say(&target, LOW_STORAGE_REPLY).await;
            return Ok(());
        }

        let Some(agent_id) = bound else {
            return self.route_new(signal, parsed).await;
        };

        let Some(agent) = self.store.agent(&agent_id)? else {
            // The binding outlived the agent. Treat it as a new arrival
            // rather than dropping the message.
            self.store
                .unbind(&signal.source, &signal.conversation, &signal.thread_key)?;
            return self.route_new(signal, parsed).await;
        };

        // Keep the deep link pointing at the newest message in the thread.
        if let Some(source) = self.source(&signal.source) {
            if let Ok(link) = source.permalink(&signal.conversation, &signal.external_id).await {
                if !link.is_empty() {
                    let _ = self.store.set_agent_permalink(&agent.id, &link);
                }
            }
        }

        let inputs = self.inputs_for(&signal).await?;
        if inputs.is_empty() {
            return Ok(());
        }

        if parsed.side {
            return self.side_turn(&signal, &agent, inputs).await;
        }

        // Steering only makes sense when something is actually running and the
        // user did not explicitly ask to queue.
        if !parsed.queued && self.steer(&agent, &signal, inputs.clone(), true).await? {
            self.resolve(&signal, &format!("steered {}", agent.name), &[agent.id.clone()])
                .await;
            return Ok(());
        }

        self.resolve(&signal, &format!("sent to {}", agent.name), &[agent.id.clone()])
            .await;
        self.clone().deliver(agent, inputs, Some(signal)).await;
        Ok(())
    }

    /// A signal with nowhere to go yet.
    async fn route_new(self: &Arc<Self>, signal: Signal, _parsed: Parsed) -> Result<()> {
        if self.mode() == Mode::Ask && signal.source != crate::source::slack::SOURCE {
            // Hold it. Somebody will say where it goes, from whichever
            // surface they happen to be looking at.
            self.emit(Event::Sync);
            if let Some(item) = self.store.inbox_item(&signal.id)? {
                self.emit(Event::InboxChanged {
                    item: Box::new(item),
                });
            }
            self.say(&signal.target(), "Waiting in the oxroute inbox.").await;
            return Ok(());
        }
        let agent = self.spawn(&signal, None, None, None).await?;
        let inputs = self.inputs_for(&signal).await?;
        if inputs.is_empty() {
            return Ok(());
        }
        self.resolve(&signal, &format!("started {}", agent.name), &[agent.id.clone()])
            .await;
        self.clone().deliver(agent, inputs, Some(signal)).await;
        Ok(())
    }

    /// Send a waiting signal somewhere. This is what the inbox's buttons do,
    /// in every surface.
    pub async fn route(self: &Arc<Self>, signal_id: &str, routing: Routing) -> Result<()> {
        let item = self
            .store
            .inbox_item(signal_id)?
            .context("no such signal")?;
        if item.state == InboxState::Done {
            anyhow::bail!("that signal has already been routed");
        }
        let signal = item.signal;

        let agents = match routing {
            Routing::Discard => {
                self.resolve(&signal, "discarded", &[]).await;
                return Ok(());
            }
            Routing::Spawn {
                backend,
                model,
                cwd,
            } => {
                vec![
                    self.spawn(&signal, backend.as_deref(), model.as_deref(), cwd.as_deref())
                        .await?,
                ]
            }
            Routing::Existing { agent_ids } => {
                let mut out = Vec::new();
                for id in agent_ids {
                    out.push(self.store.agent(&id)?.with_context(|| format!("no agent {id}"))?);
                }
                if out.is_empty() {
                    anyhow::bail!("name at least one agent, or discard it");
                }
                // Routing a thread to an existing agent rewires it, so later
                // replies in that thread land in the same place.
                self.store.bind(
                    &signal.source,
                    &signal.conversation,
                    &signal.thread_key,
                    &out[0].id,
                )?;
                out
            }
        };

        let inputs = self.inputs_for(&signal).await?;
        if inputs.is_empty() {
            anyhow::bail!("that signal has nothing in it to send");
        }
        let names = agents.iter().map(|a| a.name.clone()).collect::<Vec<_>>().join(", ");
        let ids = agents.iter().map(|a| a.id.clone()).collect::<Vec<_>>();
        self.resolve(&signal, &format!("sent to {names}"), &ids).await;

        for agent in agents {
            // Only the thread's own agent answers back into the thread; a
            // fan-out target would be replying to a conversation it is not in.
            let carry = self
                .store
                .bound_agent(&signal.source, &signal.conversation, &signal.thread_key)?
                .as_deref()
                == Some(agent.id.as_str());
            let signal = carry.then(|| signal.clone());
            self.clone().deliver(agent, inputs.clone(), signal).await;
        }
        Ok(())
    }

    /// Type straight at an agent, from any surface, bypassing the inbox.
    pub async fn say_to(self: &Arc<Self>, agent_id: &str, text: &str) -> Result<()> {
        self.say_to_with_images(agent_id, text, vec![]).await
    }

    pub async fn say_to_with_images(
        self: &Arc<Self>,
        agent_id: &str,
        text: &str,
        images: Vec<String>,
    ) -> Result<()> {
        anyhow::ensure!(!text.trim().is_empty() || !images.is_empty(), "nothing to say");
        let agent = self.store.agent(agent_id)?.context("no such agent")?;
        let image_names = images
            .iter()
            .filter_map(|path| std::path::Path::new(path).file_name())
            .map(|name| name.to_string_lossy())
            .collect::<Vec<_>>()
            .join(", ");
        let shown = match (text.trim().is_empty(), images.is_empty()) {
            (false, true) => text.to_string(),
            (false, false) => format!("{text}\n\nAttached: {image_names}"),
            (true, false) => format!("Attached: {image_names}"),
            (true, true) => unreachable!(),
        };
        let mut inputs = Vec::with_capacity(images.len() + 1);
        if !text.trim().is_empty() {
            inputs.push(TurnInput::text(text));
        }
        inputs.extend(images.iter().cloned().map(|path| TurnInput::LocalImage { path }));
        self.record(&agent.id, EntryKind::You, &shown, "", "");
        let (target, opened) = match self.home_target(&agent.id).await {
            Some(target) => (Some(target), false),
            None => {
                let (target, permalink) = self.open_current_thread(&shown).await?;
                for binding in self.store.bindings_for(&agent.id)? {
                    if binding.source == target.source && binding.conversation != target.conversation
                    {
                        self.store.unbind(
                            &binding.source,
                            &binding.conversation,
                            &binding.thread_key,
                        )?;
                    }
                }
                self.store.bind(
                    &target.source,
                    &target.conversation,
                    &target.thread_key,
                    &agent.id,
                )?;
                if !permalink.is_empty() {
                    self.store.set_agent_permalink(&agent.id, &permalink)?;
                }
                (Some(target), true)
            }
        };

        // A question submitted from the web or TUI is part of the Slack
        // conversation too. Mirror it before the answer so the thread keeps
        // the complete exchange instead of showing an unexplained response.
        if let Some(target) = target
            .as_ref()
            .filter(|target| !opened && target.source == crate::source::slack::SOURCE)
        {
            self.say(target, &format!("Question from Oxroute UI:\n{shown}"))
                .await;
            if let Some(source) = self.source(&target.source) {
                let _ = source.upload(target, &images).await;
            }
        }

        let pseudo = Signal {
            id: new_id("sig"),
            source: "direct".into(),
            conversation: String::new(),
            thread_key: String::new(),
            external_id: new_id("msg"),
            author: self.config.owner.clone(),
            label: "you".into(),
            text: shown,
            attachments: vec![],
            at: now(),
            root: false,
        };
        if self.steer(&agent, &pseudo, inputs.clone(), false).await? {
            return Ok(());
        }
        self.clone().deliver_to(agent, inputs, None, target).await;
        Ok(())
    }

    // -- directives ------------------------------------------------------

    async fn apply_directive(
        self: &Arc<Self>,
        signal: &Signal,
        bound: Option<&str>,
        directive: Directive,
    ) -> Result<()> {
        let target = signal.target();
        let reply = match directive {
            Directive::Model(alias) => match self.config.resolve_model(&alias) {
                None => format!("I don't know a model called {alias}."),
                Some(choice) => match bound {
                    Some(id) => {
                        self.store.set_agent_model(id, &choice.id)?;
                        format!("Using {}.", choice.label)
                    }
                    // Nothing to set it on yet, so remember it for the agent
                    // this thread is about to get.
                    None => {
                        self.store.set(
                            &format!("model:{}:{}", signal.conversation, signal.thread_key),
                            &choice.id,
                        )?;
                        format!("Using {} for this thread.", choice.label)
                    }
                },
            },
            Directive::Kill => match bound {
                None => "This thread is not connected to an agent.".into(),
                Some(id) => {
                    if self.interrupt(id).await? {
                        "Stopped this turn.".into()
                    } else {
                        "This agent is not running.".into()
                    }
                }
            },
            Directive::Clean => match bound {
                None => "This thread is not connected to an agent.".into(),
                Some(id) => {
                    if self.live.lock().await.contains_key(id) {
                        "This agent is running. Reply `kill`, then `clean`.".into()
                    } else {
                        self.store
                            .unbind(&signal.source, &signal.conversation, &signal.thread_key)?;
                        self.emit(Event::Sync);
                        "Started clean. Your next reply opens a new session with no prior \
                         history."
                            .into()
                    }
                }
            },
            Directive::Fork => match bound {
                None => "This thread is not connected to an agent.".into(),
                Some(id) => match self.fork(id).await {
                    Ok(agent) => format!("Forked into {}.", agent.name),
                    Err(error) => format!("Could not fork: {error}"),
                },
            },
            Directive::Rename(title) => {
                if title.is_empty() {
                    "Use `rename \"<new title>\"`.".into()
                } else {
                    match bound {
                        None => "This thread is not connected to an agent.".into(),
                        Some(id) => {
                            self.rename(id, &title).await?;
                            format!("Renamed to {title}.")
                        }
                    }
                }
            }
        };

        self.resolve(signal, "directive", &[]).await;
        self.say(&target, &reply).await;
        Ok(())
    }

    pub async fn interrupt(self: &Arc<Self>, agent_id: &str) -> Result<bool> {
        let turn = self.live.lock().await.get(agent_id).cloned();
        let Some(turn) = turn else { return Ok(false) };
        turn.wait_ready().await;
        let Some(turn_id) = turn.turn_id() else { return Ok(false) };
        if turn.done() {
            return Ok(false);
        }
        let agent = self.store.agent(agent_id)?.context("no such agent")?;
        turn.stopped.store(true, Ordering::SeqCst);
        if let Err(error) = self
            .harness(agent.backend)
            .interrupt(&turn.session, &turn_id)
            .await
        {
            turn.stopped.store(false, Ordering::SeqCst);
            return Err(error);
        }
        self.stall(agent_id, "stopped").await;
        Ok(true)
    }

    pub async fn rename(self: &Arc<Self>, agent_id: &str, title: &str) -> Result<()> {
        let agent = self.store.agent(agent_id)?.context("no such agent")?;
        self.store.rename_agent(agent_id, title)?;
        if !agent.session_id.is_empty() {
            let _ = self.harness(agent.backend).set_name(&agent.session_id, title).await;
        }
        // Retitling the thread only works where we opened it; where we did
        // not, the name still changes everywhere else.
        for binding in self.store.bindings_for(agent_id)? {
            if let Some(source) = self.source(&binding.source) {
                let target =
                    Target::new(&binding.source, &binding.conversation, &binding.thread_key);
                let _ = source.retitle(&target, title).await;
            }
        }
        self.emit(Event::Sync);
        self.refresh_dashboard().await;
        Ok(())
    }

    pub fn archive(&self, agent_id: &str, archived: bool) -> Result<()> {
        let agent = self.store.agent(agent_id)?.context("no such agent")?;
        if archived && agent.status == AgentStatus::Working {
            anyhow::bail!("stop the active turn before archiving this session");
        }
        self.store.set_agent_archived(agent_id, archived)?;
        self.emit(Event::Sync);
        Ok(())
    }

    pub fn pin(&self, agent_id: &str, pinned: bool) -> Result<()> {
        self.store.set_agent_pinned(agent_id, pinned)?;
        self.emit(Event::Sync);
        Ok(())
    }

    /// Branch an agent's history into a new agent and give it a source thread.
    pub async fn fork(self: &Arc<Self>, agent_id: &str) -> Result<Agent> {
        self.fork_agent(agent_id).await
    }

    /// Branch an agent beside its parent in the web UI. It still gets a
    /// source thread so the same conversation exists on both surfaces.
    pub async fn fork_local(self: &Arc<Self>, agent_id: &str) -> Result<Agent> {
        self.fork_agent(agent_id).await
    }

    async fn fork_agent(self: &Arc<Self>, agent_id: &str) -> Result<Agent> {
        let agent = self.store.agent(agent_id)?.context("no such agent")?;
        let harness = self.harness(agent.backend);
        if !harness.capabilities().fork {
            anyhow::bail!("{} cannot fork a session", agent.backend);
        }
        let spec = SessionSpec {
            model: agent.model.clone(),
            cwd: agent.cwd.clone(),
            resume: None,
            ephemeral: false,
        };
        let session = harness.fork(&agent.session_id, &spec, false).await?;
        let title = format!("{} fork", agent.name);

        let mut forked = Agent {
            id: new_id("agent"),
            name: title.clone(),
            session_id: session.clone(),
            status: AgentStatus::Complete,
            activity: String::new(),
            permalink: String::new(),
            last_activity: now(),
            updated_at: now(),
            stall_reason: None,
            stall_alerted: false,
            pinned: false,
            ..agent.clone()
        };

        let binding = self.home_binding(agent_id);
        let (source_name, conversation) = match binding {
            Some(binding) => (binding.source, binding.conversation),
            None => {
                let (source, conversation, _) = self
                    .dashboard_location()
                    .context("no current source conversation")?;
                (source, conversation)
            }
        };
        let source = self
            .source(&source_name)
            .with_context(|| format!("source {source_name} is not configured"))?;
        let (thread_key, permalink) = source.open_thread(&conversation, &title).await?;
        forked.permalink = permalink;
        self.store.save_agent(&forked)?;
        self.store.copy_timeline(agent_id, &forked.id)?;
        self.store
            .bind(&source_name, &conversation, &thread_key, &forked.id)?;
        self.sessions.lock().await.insert(session, forked.id.clone());
        self.record_fork(agent_id, &forked.id);
        self.emit(Event::Sync);
        Ok(forked)
    }

    /// Fold a completed leaf fork into its direct parent and retire the child.
    pub async fn merge(self: &Arc<Self>, agent_id: &str) -> Result<Agent> {
        let child = self.store.agent(agent_id)?.context("no such agent")?;
        if child.status == AgentStatus::Working {
            anyhow::bail!("stop the fork's active turn before merging it");
        }
        if !self.store.fork_children(agent_id)?.is_empty() {
            anyhow::bail!("merge or archive this fork's child panes first");
        }
        let parent_id = self
            .store
            .fork_parent(agent_id)?
            .context("this session is not a fork")?;
        let parent = self
            .store
            .agent(&parent_id)?
            .context("the parent session no longer exists")?;
        if parent.status == AgentStatus::Working {
            anyhow::bail!("stop the parent's active turn before merging into it");
        }
        if parent.backend != child.backend {
            anyhow::bail!("a fork can only merge into the same backend");
        }

        let timeline = self.store.timeline(agent_id, usize::MAX)?;
        let fork_at = timeline
            .iter()
            .rposition(|entry| entry.kind == EntryKind::ForkedFrom && entry.detail == parent_id)
            .context("the direct fork point is missing")?;
        let mut pending = None;
        let mut exchanges = Vec::new();
        for entry in &timeline[fork_at + 1..] {
            match entry.kind {
                EntryKind::Received | EntryKind::You => pending = Some(entry.text.clone()),
                EntryKind::Said => {
                    if let Some(question) = pending.take() {
                        exchanges.push((question, entry.text.clone()));
                    }
                }
                _ => {}
            }
        }
        if !exchanges.is_empty() {
            self.harness(parent.backend)
                .inject(&parent.session_id, &exchanges)
                .await?;
        }
        self.record(
            &parent.id,
            EntryKind::Merged,
            "Fork merged",
            &child.id,
            "",
        );
        self.record(
            &child.id,
            EntryKind::MergedInto,
            "Merged into parent",
            &parent.id,
            "",
        );
        self.store.set_agent_archived(&child.id, true)?;
        self.emit(Event::Sync);
        Ok(parent)
    }

    async fn command(self: &Arc<Self>, name: &str, user: &str) -> String {
        if user != self.config.owner {
            return "not authorized".into();
        }
        match name {
            "nuke" => {
                let live: Vec<String> = self.live.lock().await.keys().cloned().collect();
                let mut stopped = 0;
                for agent_id in live {
                    if self.interrupt(&agent_id).await.unwrap_or(false) {
                        stopped += 1;
                    }
                }
                // Anything that did not stop cleanly is still marked down, so
                // the dashboard does not keep claiming it is working.
                let hanging: Vec<Arc<Live>> = self.live.lock().await.values().cloned().collect();
                for turn in hanging {
                    turn.finish("nuked".into());
                }
                format!("stopped {stopped} running turns")
            }
            "mode" => {
                let next = if self.mode() == Mode::Auto { Mode::Ask } else { Mode::Auto };
                let _ = self.set_mode(next);
                match next {
                    Mode::Ask => "New non-Slack signals now wait in the inbox.".into(),
                    Mode::Auto => "New non-Slack signals now start an agent on their own.".into(),
                }
            }
            other => format!("unknown command /{other}"),
        }
    }

    // -- turns -----------------------------------------------------------

    /// Everything the harness should see for this signal.
    async fn inputs_for(&self, signal: &Signal) -> Result<Vec<TurnInput>> {
        let parsed = parse_message(
            &signal.text,
            !signal.root,
            !signal.attachments.is_empty(),
            &self.config.model_aliases(),
        );
        let mut inputs = Vec::new();
        if !parsed.text.is_empty() {
            inputs.push(TurnInput::text(&parsed.text));
        }
        if !signal.attachments.is_empty() {
            let Some(source) = self.source(&signal.source) else {
                anyhow::bail!("no source {} to fetch attachments from", signal.source);
            };
            let directory = self
                .config
                .attachments
                .join(&signal.conversation)
                .join(&signal.thread_key)
                .join(&signal.external_id);
            match source
                .fetch(&signal.attachments, &directory.to_string_lossy())
                .await
            {
                Ok(fetched) => inputs.extend(fetched),
                Err(error) => {
                    self.say(&signal.target(), &error.to_string()).await;
                    return Ok(Vec::new());
                }
            }
        }
        Ok(inputs)
    }

    async fn steer(
        &self,
        agent: &Agent,
        signal: &Signal,
        inputs: Vec<TurnInput>,
        record: bool,
    ) -> Result<bool> {
        // Ask the harness, not the enum. A capability declared in two places
        // is a capability that will eventually disagree with itself, and the
        // harness is the half that actually has to do the work.
        if !self.harness(agent.backend).capabilities().steer {
            return Ok(false);
        }
        let turn = self.live.lock().await.get(&agent.id).cloned();
        let Some(turn) = turn else { return Ok(false) };
        turn.wait_ready().await;
        let Some(turn_id) = turn.turn_id() else { return Ok(false) };
        if turn.done() {
            return Ok(false);
        }
        match self
            .harness(agent.backend)
            .steer(&turn.session, &turn_id, &signal.external_id, inputs)
            .await
        {
            Ok(()) => {
                if record {
                    self.record(
                        &agent.id,
                        EntryKind::Received,
                        &signal.text,
                        "steered into the running turn",
                        &origin_of(signal),
                    );
                }
                self.emit(Event::Sync);
                Ok(true)
            }
            // A turn that ended between the check and the call is a race, not
            // a failure: fall back to starting a new one.
            Err(_) if turn.done() => Ok(false),
            Err(error) => Err(error),
        }
    }

    /// Run a turn and deal with everything that comes out of it.
    async fn deliver(self: Arc<Self>, agent: Agent, inputs: Vec<TurnInput>, signal: Option<Signal>) {
        let target = match &signal {
            Some(s) if self.source(&s.source).is_some() => Some(s.target()),
            _ => self.home_target(&agent.id).await,
        };
        self.deliver_to(agent, inputs, signal, target).await;
    }

    async fn deliver_to(
        self: Arc<Self>,
        agent: Agent,
        inputs: Vec<TurnInput>,
        signal: Option<Signal>,
        target: Option<Target>,
    ) {
        let hub = self.clone();
        tokio::spawn(async move {
            let lock = hub.lock_for(&agent.id).await;
            let _held = lock.lock().await;
            if let Err(error) = hub.run_turn(&agent, inputs, signal, target.clone()).await {
                tracing::error!(agent = agent.id, %error, "turn failed");
                let _ = hub.store.stall_agent(&agent.id, "turn failed", now());
                if let Some(target) = target {
                    hub.say(&target, ERROR_REPLY).await;
                }
                hub.emit(Event::Sync);
                hub.refresh_dashboard().await;
            }
        });
    }

    async fn lock_for(&self, agent_id: &str) -> Arc<AsyncMutex<()>> {
        self.locks
            .lock()
            .await
            .entry(agent_id.to_string())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }

    async fn run_turn(
        self: &Arc<Self>,
        agent: &Agent,
        mut inputs: Vec<TurnInput>,
        signal: Option<Signal>,
        target: Option<Target>,
    ) -> Result<()> {
        let harness = self.harness(agent.backend);
        let spec = SessionSpec {
            model: agent.model.clone(),
            cwd: agent.cwd.clone(),
            resume: Some(agent.session_id.clone()).filter(|s| !s.is_empty()),
            ephemeral: false,
        };
        let session = harness.open(&spec).await?;
        if session != agent.session_id {
            self.store.set_agent_session(&agent.id, &session)?;
        }
        self.sessions.lock().await.insert(session.clone(), agent.id.clone());

        // Side answers earned while this agent was busy get folded in before
        // its next turn, so it never contradicts something it already said.
        let pending = self.store.pending_context(&agent.id)?;
        if !pending.is_empty() && harness.capabilities().inject {
            let exchanges: Vec<(String, String)> = pending
                .iter()
                .map(|(_, q, a)| (format!("btw {q}"), a.clone()))
                .collect();
            if harness.inject(&session, &exchanges).await.is_ok() {
                let ids: Vec<i64> = pending.iter().map(|(id, _, _)| *id).collect();
                self.store.clear_context(&ids)?;
            }
        }

        let artifact_dir = self.config.artifacts.join(&agent.id).join(new_id("turn"));
        tokio::fs::create_dir_all(&artifact_dir).await?;
        inputs.push(TurnInput::text(format!(
            "Place every image, video, or other file you want returned to the user in \
             {}",
            artifact_dir.display(),
        )));
        inputs.push(TurnInput::text(format!(
            "Oxroute has a shared task list. When the user asks you to read or change it, \
             use GET/POST http://{}/api/tasks and PUT/DELETE \
             http://{}/api/tasks/<id>. Task JSON is {{\"text\": string, \"done\": bool, \
             \"agentId\": string}}. This session's agent id is {}. Do not change tasks unless the \
             user asks you to.",
            self.config.listen,
            self.config.listen,
            agent.id,
        )));

        if let Some(signal) = &signal {
            self.record(
                &agent.id,
                EntryKind::Received,
                &signal.text,
                "",
                &origin_of(signal),
            );
        }

        let turn = Arc::new(Live::new(
            session.clone(),
            artifact_dir.clone(),
            target.clone(),
            false,
        ));
        self.store.save_active_turn(&ActiveTurn {
            agent_id: agent.id.clone(),
            session_id: session.clone(),
            turn_id: String::new(),
            artifact_dir,
            target: target.clone(),
        })?;
        self.live.lock().await.insert(agent.id.clone(), turn.clone());
        self.store.set_agent_status(&agent.id, AgentStatus::Working, now())?;
        self.emit(Event::Sync);
        self.refresh_dashboard().await;

        match harness.start(&session, inputs).await {
            Ok(turn_id) if !turn_id.is_empty() => {
                turn.mark_ready(turn_id.clone());
                self.store.set_active_turn_id(&agent.id, &turn_id)?;
            }
            Ok(_) => {}
            Err(error) => {
                tracing::error!(agent = agent.id, %error, "could not start turn");
                turn.finish("failed".into());
            }
        }
        self.settle_turn(agent, turn, harness).await
    }

    async fn settle_turn(
        self: &Arc<Self>,
        agent: &Agent,
        turn: Arc<Live>,
        harness: Arc<dyn Harness>,
    ) -> Result<()> {
        let reporter = self.clone().report(turn.clone());
        turn.wait_done().await;
        let outcome = if turn.stopped.load(Ordering::SeqCst) {
            Ok(None)
        } else {
            let status = turn.status();
            let answer = turn.answer.lock().unwrap().clone();
            match (status.as_str(), answer) {
                ("completed", Some(text)) if !text.is_empty() => Ok(Some(text)),
                (other, _) => Err(anyhow::anyhow!("the turn ended with {other}")),
            }
        };

        // Whatever happened, stop reporting and let go of the turn. The
        // first status wins, so this only matters when the harness never
        // reported one at all.
        turn.finish("failed".into());
        reporter.abort();
        self.clear_progress(&turn).await;
        self.live.lock().await.remove(&agent.id);
        self.store.clear_active_turn(&agent.id)?;

        if !turn.stopped.load(Ordering::SeqCst) {
            self.hand_back_artifacts(&turn, turn.target.as_ref()).await;
        }
        let _ = harness.release(&turn.session).await;

        let answer = match outcome {
            Ok(None) => return Ok(()),
            Ok(Some(text)) => text,
            Err(error) => {
                self.store.stall_agent(&agent.id, "turn failed", now())?;
                self.emit(Event::Sync);
                self.refresh_dashboard().await;
                if let Some(target) = &turn.target {
                    self.say(target, ERROR_REPLY).await;
                }
                return Err(error);
            }
        };

        // Claude Code's closing `result` frame usually repeats the last
        // thing it said. Showing it twice makes the agent look confused.
        let repeated = self
            .store
            .last_entry(&agent.id)?
            .is_some_and(|last| last.kind == EntryKind::Said && last.text == answer);
        if !repeated {
            self.record(&agent.id, EntryKind::Said, &answer, "", "");
        }
        self.store.set_agent_status(&agent.id, AgentStatus::Complete, now())?;

        if let Some(target) = &turn.target {
            let permalink = self.say(target, &answer).await;
            if !permalink.is_empty() {
                let _ = self.store.set_agent_permalink(&agent.id, &permalink);
            }
        }
        self.emit(Event::TurnFinished {
            agent_id: agent.id.clone(),
            status: "completed".into(),
        });
        self.emit(Event::Sync);
        self.refresh_dashboard().await;
        self.clone().name_agent(agent.id.clone(), turn.target.clone(), true);
        Ok(())
    }

    /// A question answered off to the side, in parallel, without disturbing
    /// the turn that is running. The answer is folded back into the main
    /// session before its next turn, so nothing is lost.
    async fn side_turn(
        self: &Arc<Self>,
        signal: &Signal,
        agent: &Agent,
        inputs: Vec<TurnInput>,
    ) -> Result<()> {
        let harness = self.harness(agent.backend);
        if !harness.capabilities().fork || agent.session_id.is_empty() {
            self.say(
                &signal.target(),
                "This agent cannot answer a side question. Ask it directly instead.",
            )
            .await;
            return Ok(());
        }

        let spec = SessionSpec {
            model: agent.model.clone(),
            cwd: agent.cwd.clone(),
            resume: None,
            ephemeral: true,
        };
        let session = harness.fork(&agent.session_id, &spec, true).await?;
        let question = inputs
            .iter()
            .filter_map(TurnInput::as_text)
            .collect::<Vec<_>>()
            .join("\n\n");

        let scratch = Agent {
            id: new_id("side"),
            session_id: session.clone(),
            ..agent.clone()
        };
        self.sessions.lock().await.insert(session.clone(), scratch.id.clone());

        let turn = Arc::new(Live::new(
            session.clone(),
            self.config.artifacts.join(&scratch.id),
            Some(signal.target()),
            true,
        ));
        self.live.lock().await.insert(scratch.id.clone(), turn.clone());

        let result = async {
            harness.start(&session, inputs).await?;
            turn.wait_done().await;
            let answer = turn.answer.lock().unwrap().clone();
            answer.context("the side question produced no answer")
        }
        .await;

        self.live.lock().await.remove(&scratch.id);
        self.sessions.lock().await.remove(&session);
        let _ = harness.release(&session).await;

        let answer = match result {
            Ok(answer) => answer,
            Err(error) => {
                tracing::warn!(%error, "side question failed");
                self.say(&signal.target(), ERROR_REPLY).await;
                return Ok(());
            }
        };

        self.store
            .queue_context(&agent.id, &signal.external_id, &question, &answer)?;
        self.resolve(signal, "answered on the side", &[agent.id.clone()]).await;
        self.say(&signal.target(), &answer).await;
        Ok(())
    }

    /// Post, then keep rewriting, one message showing live activity, and take
    /// it away when the turn ends.
    fn report(self: Arc<Self>, turn: Arc<Live>) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let Some(target) = turn.target.clone() else { return };
            if turn.quiet {
                return;
            }
            let Some(source) = self.source(&target.source) else { return };

            tokio::time::sleep(PROGRESS_DELAY).await;
            loop {
                if turn.done() {
                    return;
                }
                if !turn.progress.lock().unwrap().is_empty() {
                    break;
                }
                tokio::time::sleep(PROGRESS_INTERVAL).await;
            }

            let text = turn.progress.lock().unwrap().render(MAX_BYTES);
            match source.post_status(&target, &text).await {
                Ok(posted) => *turn.posted.lock().unwrap() = Some(posted),
                Err(error) => {
                    tracing::warn!(%error, "could not post progress");
                    return;
                }
            }

            while !turn.done() {
                tokio::time::sleep(PROGRESS_INTERVAL).await;
                let text = {
                    let mut progress = turn.progress.lock().unwrap();
                    if !progress.take_dirty() {
                        continue;
                    }
                    progress.render(MAX_BYTES)
                };
                let posted = turn.posted.lock().unwrap().clone();
                if let Some(posted) = posted {
                    if let Err(error) = source.update_status(&posted, &text).await {
                        tracing::warn!(%error, "could not update progress");
                    }
                }
            }
        })
    }

    async fn clear_progress(&self, turn: &Arc<Live>) {
        let posted = turn.posted.lock().unwrap().take();
        let (Some(posted), Some(target)) = (posted, turn.target.clone()) else {
            return;
        };
        if let Some(source) = self.source(&target.source) {
            if let Err(error) = source.clear_status(&posted).await {
                tracing::warn!(%error, "could not clear progress");
            }
        }
    }

    /// Anything the agent left in its artifact directory goes back to the
    /// human, plus anything it named explicitly along the way.
    async fn hand_back_artifacts(&self, turn: &Arc<Live>, target: Option<&Target>) {
        let Some(target) = target else { return };
        let Some(source) = self.source(&target.source) else { return };

        let mut paths: Vec<String> = turn.artifacts.lock().unwrap().iter().cloned().collect();
        let mut stack = vec![turn.artifact_dir.clone()];
        while let Some(dir) = stack.pop() {
            let Ok(mut entries) = tokio::fs::read_dir(&dir).await else { continue };
            while let Ok(Some(entry)) = entries.next_entry().await {
                let Ok(meta) = entry.metadata().await else { continue };
                if meta.is_dir() {
                    stack.push(entry.path());
                } else if meta.is_file() {
                    paths.push(entry.path().to_string_lossy().to_string());
                }
            }
        }
        paths.sort();
        paths.dedup();
        if paths.is_empty() {
            return;
        }
        if let Err(error) = source.upload(target, &paths).await {
            tracing::warn!(%error, "could not hand back artifacts");
        }
    }

    // -- agents ----------------------------------------------------------

    async fn spawn(
        self: &Arc<Self>,
        signal: &Signal,
        backend: Option<&str>,
        model: Option<&str>,
        cwd: Option<&str>,
    ) -> Result<Agent> {
        // A model chosen before the agent existed still applies to it.
        let remembered = self
            .store
            .get(&format!("model:{}:{}", signal.conversation, signal.thread_key))
            .ok()
            .flatten();
        let model = model
            .map(str::to_string)
            .or(remembered)
            .unwrap_or_else(|| self.config.default_model.clone());
        let model = self
            .config
            .resolve_model(&model)
            .map(|c| c.id.clone())
            .unwrap_or(model);
        let backend = backend
            .and_then(Backend::parse)
            .unwrap_or_else(|| self.config.backend_for(&model));

        let slack_home = if signal.source == "you" {
            Some(self.open_current_thread(&signal.text).await?)
        } else {
            None
        };
        let permalink = match &slack_home {
            Some((_, permalink)) => permalink.clone(),
            None => match self.source(&signal.source) {
                Some(source) => source
                    .permalink(&signal.conversation, &signal.thread_key)
                    .await
                    .unwrap_or_default(),
                None => String::new(),
            },
        };

        let agent = Agent {
            id: new_id("agent"),
            name: naming::provisional(&signal.text),
            backend,
            model,
            session_id: String::new(),
            cwd: cwd.unwrap_or(&self.config.workspace).to_string(),
            status: AgentStatus::Working,
            activity: String::new(),
            permalink,
            last_activity: now(),
            updated_at: now(),
            stall_reason: None,
            stall_alerted: false,
            pinned: false,
        };
        self.store.save_agent(&agent)?;
        self.store.bind(
            &signal.source,
            &signal.conversation,
            &signal.thread_key,
            &agent.id,
        )?;
        if let Some((target, _)) = slack_home {
            self.store.bind(
                &target.source,
                &target.conversation,
                &target.thread_key,
                &agent.id,
            )?;
        }
        self.emit(Event::AgentChanged {
            agent: Box::new(agent.clone()),
        });
        self.clone()
            .name_agent(agent.id.clone(), Some(signal.target()), false);
        Ok(agent)
    }

    /// Ask a small model for a short title, in the background.
    ///
    /// Never blocks a turn: a name is a nicety and the work matters more.
    fn name_agent(self: Arc<Self>, agent_id: String, target: Option<Target>, recent: bool) {
        tokio::spawn(async move {
            // One namer per agent at a time, or a burst of turns produces a
            // burst of naming calls that race each other.
            if !self.naming.lock().await.insert(agent_id.clone()) {
                return;
            }
            let outcome = self.name_once(&agent_id, target, recent).await;
            self.naming.lock().await.remove(&agent_id);
            if let Err(error) = outcome {
                tracing::debug!(agent = agent_id, %error, "naming failed");
            }
        });
    }

    async fn name_once(
        self: &Arc<Self>,
        agent_id: &str,
        target: Option<Target>,
        recent: bool,
    ) -> Result<()> {
        let agent = self.store.agent(agent_id)?.context("no such agent")?;
        let body = match (&target, recent) {
            (Some(target), true) => {
                let source = self.source(&target.source).context("no such source")?;
                naming::conversation(&source.history(target, 8).await.unwrap_or_default())
            }
            _ => {
                let entries = self.store.timeline(agent_id, 8)?;
                let messages: Vec<(String, String)> = entries
                    .iter()
                    .filter_map(|e| match e.kind {
                        EntryKind::Received | EntryKind::You => {
                            Some(("user".to_string(), e.text.clone()))
                        }
                        EntryKind::Said => Some(("assistant".to_string(), e.text.clone())),
                        _ => None,
                    })
                    .collect();
                if recent {
                    naming::conversation(&messages)
                } else {
                    messages.first().map(|(_, t)| t.clone()).unwrap_or_default()
                }
            }
        };
        if body.trim().is_empty() {
            return Ok(());
        }

        let harness = self.harness(agent.backend);
        // Naming runs on whichever harness the agent uses; one that has no
        // cheap path simply keeps the provisional title.
        let response = harness
            .oneshot(&naming::prompt(&body, recent), naming::schema(), &agent.cwd)
            .await?;
        let title = naming::parse(&response);
        if title.is_empty() {
            return Ok(());
        }
        self.rename(agent_id, &title).await
    }

    // -- talking back ----------------------------------------------------

    /// Where this agent normally answers, when a message did not come with a
    /// thread of its own.
    async fn home_target(&self, agent_id: &str) -> Option<Target> {
        self.home_binding(agent_id)
            .map(|b| Target::new(b.source, b.conversation, b.thread_key))
    }

    fn home_binding(&self, agent_id: &str) -> Option<Binding> {
        let bindings = self
            .store
            .bindings_for(agent_id)
            .ok()?
            .into_iter()
            .filter(|b| self.sources.contains_key(&b.source))
            .collect::<Vec<_>>();
        if let Some((source, conversation, _)) = self.dashboard_location() {
            if let Some(binding) = bindings
                .iter()
                .find(|binding| binding.source == source && binding.conversation == conversation)
            {
                return Some(binding.clone());
            }
            if bindings.iter().any(|binding| binding.source == source) {
                return None;
            }
        }
        bindings.into_iter().next()
    }

    /// Say something in a thread, and return the permalink if there is one.
    pub async fn say(&self, target: &Target, text: &str) -> String {
        let Some(source) = self.source(&target.source) else {
            return String::new();
        };
        match source.reply(target, text).await {
            Ok(permalink) => permalink,
            Err(error) => {
                tracing::error!(source = target.source, %error, "could not reply");
                String::new()
            }
        }
    }

    async fn resolve(&self, signal: &Signal, outcome: &str, agent_ids: &[String]) {
        if let Err(error) = self.store.resolve_signal(&signal.id, outcome, agent_ids) {
            tracing::error!(%error, "could not record a routing outcome");
        }
        if let Ok(Some(item)) = self.store.inbox_item(&signal.id) {
            self.emit(Event::InboxChanged {
                item: Box::new(item),
            });
        }
    }

    async fn stall(&self, agent_id: &str, reason: &str) {
        match self.store.stall_agent(agent_id, reason, now()) {
            Ok(true) => {
                if let Ok(Some(agent)) = self.store.agent(agent_id) {
                    self.announce_stall(&agent, reason).await;
                }
            }
            Ok(false) => {}
            Err(error) => tracing::error!(%error, "could not record a stall"),
        }
        self.emit(Event::Sync);
        self.refresh_dashboard().await;
    }

    async fn announce_stall(&self, agent: &Agent, reason: &str) {
        self.emit(Event::Notice {
            text: format!("{} stalled: {reason}", agent.name),
        });
        let Some((source_name, conversation, message_id)) = self.dashboard_location() else {
            return;
        };
        let Some(source) = self.source(&source_name) else { return };
        let target = Target::new(source_name, conversation, message_id);
        let _ = source
            .reply(&target, &dashboard::alert(&self.config.owner, agent, reason))
            .await;
    }

    fn dashboard_location(&self) -> Option<(String, String, String)> {
        let raw = self.store.get(DASHBOARD_KEY).ok().flatten()?;
        let mut parts = raw.splitn(3, '\u{1f}');
        Some((
            parts.next()?.to_string(),
            parts.next()?.to_string(),
            parts.next()?.to_string(),
        ))
    }

    async fn open_current_thread(&self, text: &str) -> Result<(Target, String)> {
        let (source_name, conversation, _) = self
            .dashboard_location()
            .context("no current source conversation")?;
        let source = self
            .source(&source_name)
            .with_context(|| format!("source {source_name} is not configured"))?;
        let (thread_key, permalink) = source.open_thread(&conversation, text).await?;
        Ok((
            Target::new(source_name, conversation, thread_key),
            permalink,
        ))
    }

    /// Keep the one dashboard message current. Posted on first use into
    /// whichever conversation is actually in play.
    pub async fn refresh_dashboard(&self) {
        let Ok(agents) = self.store.agents(dashboard::COMPLETED_SHOWN) else { return };
        let text = dashboard::render(&agents, now());

        if let Some((source_name, conversation, message_id)) = self.dashboard_location() {
            if let Some(source) = self.source(&source_name) {
                let posted = Posted {
                    conversation,
                    id: message_id,
                };
                if source.update_status(&posted, &text).await.is_ok() {
                    return;
                }
            }
        }

        // No dashboard yet. Put it wherever an agent already lives.
        let Some(agent) = agents.first() else { return };
        let Ok(bindings) = self.store.bindings_for(&agent.id) else { return };
        let Some(binding) = bindings.into_iter().find(|b| self.sources.contains_key(&b.source))
        else {
            return;
        };
        let Some(source) = self.source(&binding.source) else { return };
        let target = Target::new(&binding.source, &binding.conversation, String::new());
        if let Ok(posted) = source.post_status(&target, &text).await {
            let _ = self.store.set(
                DASHBOARD_KEY,
                &format!("{}\u{1f}{}\u{1f}{}", binding.source, posted.conversation, posted.id),
            );
        }
    }

    // -- reading ---------------------------------------------------------

    pub fn snapshot(&self, inbox_limit: usize) -> Result<Snapshot> {
        let agents = self.store.agents(dashboard::COMPLETED_SHOWN)?;
        let archived = self.store.archived_agents()?;
        let mut inbox = self.store.inbox(inbox_limit)?;
        for item in &mut inbox {
            item.suggested = self
                .store
                .bound_agent(
                    &item.signal.source,
                    &item.signal.conversation,
                    &item.signal.thread_key,
                )
                .ok()
                .flatten();
        }
        Ok(Snapshot {
            mode: self.mode().as_str().to_string(),
            default_model: self.config.default_model.clone(),
            agents,
            archived,
            messages: self.store.message_previews()?,
            inbox,
            tasks: self.store.tasks()?,
            sources: self.sources.keys().cloned().collect(),
            models: self
                .config
                .models
                .iter()
                .map(|(alias, choice)| ModelInfo {
                    alias: alias.clone(),
                    id: choice.id.clone(),
                    label: choice.label.clone(),
                    backend: choice.backend,
                })
                .collect(),
        })
    }

    pub fn tasks(&self) -> Result<Vec<TaskItem>> {
        self.store.tasks()
    }

    pub fn create_task(&self, text: &str, agent_id: &str) -> Result<TaskItem> {
        let text = text.trim();
        anyhow::ensure!(!text.is_empty(), "a task cannot be empty");
        if !agent_id.is_empty() {
            anyhow::ensure!(self.store.agent(agent_id)?.is_some(), "no such agent");
        }
        let at = now();
        let task = TaskItem {
            id: new_id("task"),
            text: text.into(),
            done: false,
            agent_id: agent_id.into(),
            created_at: at,
            updated_at: at,
        };
        self.store.save_task(&task)?;
        self.emit(Event::Sync);
        Ok(task)
    }

    pub fn update_task(&self, id: &str, text: &str, done: bool, agent_id: &str) -> Result<TaskItem> {
        let text = text.trim();
        anyhow::ensure!(!text.is_empty(), "a task cannot be empty");
        if !agent_id.is_empty() {
            anyhow::ensure!(self.store.agent(agent_id)?.is_some(), "no such agent");
        }
        let created_at = self
            .store
            .tasks()?
            .into_iter()
            .find(|task| task.id == id)
            .context("no such task")?
            .created_at;
        let task = TaskItem {
            id: id.into(),
            text: text.into(),
            done,
            agent_id: agent_id.into(),
            created_at,
            updated_at: now(),
        };
        self.store.save_task(&task)?;
        self.emit(Event::Sync);
        Ok(task)
    }

    pub fn delete_task(&self, id: &str) -> Result<()> {
        self.store.delete_task(id)?;
        self.emit(Event::Sync);
        Ok(())
    }

    pub fn timeline(&self, agent_id: &str, limit: usize) -> Result<Vec<Entry>> {
        self.store.timeline(agent_id, limit)
    }

    pub async fn search(&self, query: &str, managed_limit: usize, native_limit: usize) -> Result<SearchResults> {
        let managed = self.store.search(query, managed_limit)?;
        let mut other = Vec::new();
        for harness in self.harnesses.values() {
            match harness.search_sessions(query, native_limit).await {
                Ok(sessions) => {
                    other.extend(sessions);
                }
                Err(error) => tracing::debug!(backend = %harness.backend(), %error, "native session search failed"),
            }
        }
        other.sort_by(|a, b| b.updated_at.total_cmp(&a.updated_at));
        other.truncate(native_limit);
        Ok(SearchResults { managed, other })
    }

    pub async fn continue_session(
        self: &Arc<Self>,
        backend: Backend,
        session_id: &str,
    ) -> Result<Agent> {
        let native = self
            .harness(backend)
            .find_session(session_id)
            .await?
            .context("no such native session")?;
        let model = if native.model.is_empty()
            || !self
                .config
                .models
                .values()
                .any(|choice| choice.backend == backend && choice.id == native.model)
        {
            if self
                .config
                .models
                .values()
                .any(|choice| choice.backend == backend && choice.id == self.config.default_model)
            {
                self.config.default_model.clone()
            } else {
                self.config
                    .models
                    .values()
                    .find(|choice| choice.backend == backend)
                    .map(|choice| choice.id.clone())
                    .unwrap_or_else(|| self.config.default_model.clone())
            }
        } else {
            native.model.clone()
        };
        let location = match backend {
            Backend::Codex => "~/.codex/sessions",
            Backend::ClaudeCode => "~/.claude/projects",
        };
        let prompt = format!(
            "Read the local {backend} session {session_id} directly from {location}, recover its \
             context, and continue the work from there. Do not use web search to find the session. \
             Do not modify the old session."
        );
        let cwd = if native.cwd.is_empty() {
            self.config.workspace.clone()
        } else {
            native.cwd
        };
        let (target, permalink) = self.open_current_thread(&prompt).await?;
        let signal = Signal {
            id: new_id("sig"),
            source: target.source.clone(),
            conversation: target.conversation.clone(),
            thread_key: target.thread_key.clone(),
            external_id: target.thread_key.clone(),
            author: self.config.owner.clone(),
            label: "continued session".into(),
            text: prompt.clone(),
            attachments: vec![],
            at: now(),
            root: true,
        };
        let mut agent = self
            .spawn(&signal, Some(backend.as_str()), Some(&model), Some(&cwd))
            .await?;
        if !permalink.is_empty() {
            self.store.set_agent_permalink(&agent.id, &permalink)?;
            agent.permalink = permalink.clone();
        }
        self.clone()
            .deliver(agent.clone(), vec![TurnInput::text(&prompt)], Some(signal))
            .await;
        Ok(agent)
    }

    pub async fn native_preview(
        &self,
        backend: Backend,
        session_id: &str,
        limit: usize,
    ) -> Result<Vec<ConversationLine>> {
        self.harness(backend).session_preview(session_id, limit).await
    }
}

/// Everything a surface needs to draw itself once.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub mode: String,
    /// The model a new agent gets when nobody picks one. An id, matching one
    /// of `models[].id`.
    pub default_model: String,
    pub agents: Vec<Agent>,
    pub archived: Vec<Agent>,
    /// Latest human or agent text by agent id. Tool activity stays in
    /// `Agent::activity` for watch surfaces.
    pub messages: HashMap<String, String>,
    pub inbox: Vec<InboxItem>,
    pub tasks: Vec<TaskItem>,
    pub sources: Vec<String>,
    pub models: Vec<ModelInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub alias: String,
    pub id: String,
    pub label: String,
    pub backend: Backend,
}

/// Where a line came from, for the reader.
///
/// Something you typed has no provenance worth printing -- "you local" is
/// two words saying nothing. Only an outside source earns a label, and the
/// author only when it is not you.
fn origin_of(signal: &Signal) -> String {
    if matches!(signal.source.as_str(), "you" | "direct") {
        return String::new();
    }
    let mut bits = vec![signal.source.clone()];
    if !signal.label.is_empty() {
        bits.push(signal.label.clone());
    }
    bits.join(" ")
}
