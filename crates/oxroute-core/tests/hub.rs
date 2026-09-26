//! End-to-end tests for the hub, against a fake harness and a fake source.
//!
//! These are the tests that matter. The hub is the only place where a signal,
//! a binding and a turn meet, and nearly every behaviour worth keeping is a
//! property of how those three interact rather than of any one of them.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Result;
use async_trait::async_trait;
use oxroute_core::agent::{Capabilities, Harness, HarnessEvent, RecoveredTurn, SessionSpec};
use oxroute_core::config::{Choice, Config, Mode};
use oxroute_core::hub::Routing;
use oxroute_core::model::*;
use oxroute_core::source::{Inbox, Posted, Source};
use oxroute_core::{Hub, Store};
use oxroute_core::store::ActiveTurn;
use serde_json::Value;
use tokio::sync::broadcast;

// -- a harness that answers instantly ------------------------------------

#[derive(Default)]
struct Calls {
    started: Vec<(String, Vec<TurnInput>)>,
    /// When each turn began, so a test can tell serialized from concurrent.
    start_times: Vec<std::time::Instant>,
    steered: Vec<(String, String)>,
    interrupted: Vec<String>,
    forked: Vec<(String, bool)>,
    injected: Vec<(String, usize)>,
}

struct FakeHarness {
    events: broadcast::Sender<HarnessEvent>,
    calls: Arc<Mutex<Calls>>,
    sessions: Mutex<usize>,
    /// When set, `start` reports the turn and then goes quiet, so a test can
    /// look at an agent mid-turn.
    hang: bool,
    /// When set, the turn writes a file into the directory it was given,
    /// exactly as an agent producing a chart would.
    leave_artifacts: bool,
    /// When set, the answer streams first and the closing frame repeats it,
    /// which is what Claude Code does.
    narrates: bool,
    /// Whether this harness can fold input into a running turn. Claude Code
    /// cannot, and that path deserves its own coverage.
    can_steer: bool,
    /// How long a turn takes. A turn that ends instantly cannot show whether
    /// the next one waited for it.
    delay: Duration,
    /// Which backend this stands in for. It has to match what the agent's
    /// model implies, or the hub would look the harness up under the other
    /// one and find the real thing.
    backend: Backend,
    recovery: Mutex<Option<RecoveredTurn>>,
    native: Arc<Mutex<Vec<NativeSession>>>,
}

impl FakeHarness {
    fn new(calls: Arc<Mutex<Calls>>, hang: bool) -> Self {
        FakeHarness {
            events: broadcast::channel(256).0,
            calls,
            sessions: Mutex::new(0),
            hang,
            leave_artifacts: false,
            narrates: false,
            can_steer: true,
            delay: Duration::ZERO,
            backend: Backend::Codex,
            recovery: Mutex::new(None),
            native: Arc::new(Mutex::new(vec![])),
        }
    }
}

#[async_trait]
impl Harness for FakeHarness {
    fn backend(&self) -> Backend {
        self.backend
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            steer: self.can_steer,
            fork: true,
            inject: true,
            resume: true,
        }
    }

    fn events(&self) -> broadcast::Receiver<HarnessEvent> {
        self.events.subscribe()
    }

    async fn open(&self, spec: &SessionSpec) -> Result<String> {
        if let Some(existing) = spec.resume.as_deref().filter(|s| !s.is_empty()) {
            return Ok(existing.to_string());
        }
        let mut n = self.sessions.lock().unwrap();
        *n += 1;
        Ok(format!("session-{n}"))
    }

    async fn start(&self, session: &str, inputs: Vec<TurnInput>) -> Result<String> {
        {
            let mut calls = self.calls.lock().unwrap();
            calls.started.push((session.to_string(), inputs));
            calls.start_times.push(std::time::Instant::now());
        }
        let turn = format!("turn-{session}");
        let _ = self.events.send(HarnessEvent::TurnStarted {
            session: session.to_string(),
            turn_id: turn.clone(),
        });
        if self.leave_artifacts {
            if let Some(directory) = artifact_directory(&self.calls.lock().unwrap().started) {
                std::fs::create_dir_all(&directory).unwrap();
                std::fs::write(format!("{directory}/chart.png"), b"not really a png").unwrap();
            }
        }
        if !self.hang {
            let events = self.events.clone();
            let session = session.to_string();
            let delay = self.delay;
            let narrates = self.narrates;
            tokio::spawn(async move {
                if !delay.is_zero() {
                    tokio::time::sleep(delay).await;
                }
                if narrates {
                    let _ = events.send(HarnessEvent::Message {
                        session: session.clone(),
                        text: "done".into(),
                        final_answer: false,
                    });
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                let _ = events.send(HarnessEvent::Message {
                    session: session.clone(),
                    text: "done".into(),
                    final_answer: true,
                });
                let _ = events.send(HarnessEvent::TurnFinished {
                    session,
                    status: "completed".into(),
                });
            });
        }
        Ok(turn)
    }

    async fn steer(&self, session: &str, turn: &str, _id: &str, _i: Vec<TurnInput>) -> Result<()> {
        self.calls
            .lock()
            .unwrap()
            .steered
            .push((session.into(), turn.into()));
        Ok(())
    }

    async fn interrupt(&self, session: &str, _turn: &str) -> Result<()> {
        self.calls.lock().unwrap().interrupted.push(session.into());
        let _ = self.events.send(HarnessEvent::TurnFinished {
            session: session.to_string(),
            status: "interrupted".into(),
        });
        Ok(())
    }

    async fn fork(&self, session: &str, _spec: &SessionSpec, exclude: bool) -> Result<String> {
        self.calls
            .lock()
            .unwrap()
            .forked
            .push((session.into(), exclude));
        let mut n = self.sessions.lock().unwrap();
        *n += 1;
        let forked = format!("session-{n}");
        if exclude {
            // A side question answers immediately, as its whole point is to
            // come back while the main turn is still going.
            let events = self.events.clone();
            let session = forked.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(10)).await;
                let _ = events.send(HarnessEvent::Message {
                    session: session.clone(),
                    text: "port 8080".into(),
                    final_answer: true,
                });
                let _ = events.send(HarnessEvent::TurnFinished {
                    session,
                    status: "completed".into(),
                });
            });
        }
        Ok(forked)
    }

    async fn inject(&self, session: &str, exchanges: &[(String, String)]) -> Result<()> {
        self.calls
            .lock()
            .unwrap()
            .injected
            .push((session.into(), exchanges.len()));
        Ok(())
    }

    async fn recover(&self, _session: &str, _spec: &SessionSpec) -> Result<Option<RecoveredTurn>> {
        Ok(self.recovery.lock().unwrap().clone())
    }

    async fn search_sessions(&self, query: &str, limit: usize) -> Result<Vec<NativeSession>> {
        let query = query.to_lowercase();
        Ok(self
            .native
            .lock()
            .unwrap()
            .iter()
            .filter(|session| {
                session.name.to_lowercase().contains(&query)
                    || session.preview.to_lowercase().contains(&query)
            })
            .take(limit)
            .cloned()
            .collect())
    }

    async fn find_session(&self, session: &str) -> Result<Option<NativeSession>> {
        Ok(self
            .native
            .lock()
            .unwrap()
            .iter()
            .find(|candidate| candidate.session_id == session)
            .cloned())
    }

    async fn oneshot(&self, _prompt: &str, _schema: Value, _cwd: &str) -> Result<String> {
        // Naming is a nicety. A harness that cannot name leaves the
        // provisional title standing, which the tests assert on.
        anyhow::bail!("no naming in the fake harness")
    }
}

/// The hub tells an agent where to leave files it wants handed back. Read
/// that instruction out of the last turn's inputs.
fn artifact_directory(started: &[(String, Vec<TurnInput>)]) -> Option<String> {
    let instruction = started
        .last()?
        .1
        .iter()
        .filter_map(TurnInput::as_text)
        .find(|text| text.contains("returned to the user in "))?;
    instruction.rsplit(' ').next().map(str::to_string)
}

// -- a source that records instead of posting ----------------------------

#[derive(Default)]
struct Posts {
    replies: Vec<(String, String)>,
    cleared: usize,
    uploads: Vec<Vec<String>>,
    threads: Vec<String>,
    retitled: Vec<String>,
}

struct FakeSource {
    posts: Arc<Mutex<Posts>>,
    next_thread: Mutex<usize>,
    fail_open: Arc<AtomicBool>,
}

#[async_trait]
impl Source for FakeSource {
    fn name(&self) -> &str {
        "slack"
    }

    async fn run(&self, _inbox: Inbox) -> Result<()> {
        // A real source blocks here for the life of the process.
        std::future::pending::<()>().await;
        Ok(())
    }

    async fn reply(&self, target: &Target, text: &str) -> Result<String> {
        self.posts
            .lock()
            .unwrap()
            .replies
            .push((target.thread_key.clone(), text.to_string()));
        Ok(format!("https://example/{}", target.thread_key))
    }

    async fn post_status(&self, _target: &Target, _text: &str) -> Result<Posted> {
        Ok(Posted {
            conversation: "D1".into(),
            id: "status".into(),
        })
    }

    async fn clear_status(&self, _posted: &Posted) -> Result<()> {
        self.posts.lock().unwrap().cleared += 1;
        Ok(())
    }

    async fn upload(&self, _target: &Target, paths: &[String]) -> Result<()> {
        self.posts.lock().unwrap().uploads.push(paths.to_vec());
        Ok(())
    }

    async fn open_thread(&self, _conversation: &str, title: &str) -> Result<(String, String)> {
        if self.fail_open.load(Ordering::Relaxed) {
            anyhow::bail!("source unavailable");
        }
        let mut n = self.next_thread.lock().unwrap();
        *n += 1;
        self.posts.lock().unwrap().threads.push(title.to_string());
        Ok((format!("thread-{n}"), format!("https://example/thread-{n}")))
    }

    async fn retitle(&self, _target: &Target, title: &str) -> Result<()> {
        self.posts.lock().unwrap().retitled.push(title.to_string());
        Ok(())
    }

    async fn permalink(&self, _conversation: &str, external_id: &str) -> Result<String> {
        Ok(format!("https://example/{external_id}"))
    }
}

// -- scaffolding ---------------------------------------------------------

struct World {
    hub: Arc<Hub>,
    calls: Arc<Mutex<Calls>>,
    posts: Arc<Mutex<Posts>>,
    /// The harness's own event channel, so a test can play the part of an
    /// agent reporting what it is doing mid-turn.
    harness: broadcast::Sender<HarnessEvent>,
    native: Arc<Mutex<Vec<NativeSession>>>,
    fail_open: Arc<AtomicBool>,
}

impl World {
    /// Report a piece of tool activity on the agent's live session.
    async fn harness_item(&self, agent_id: &str, item: Value) {
        let session = self.hub.store.agent(agent_id).unwrap().unwrap().session_id;
        let _ = self.harness.send(HarnessEvent::Item { session, item });
    }
}

/// How the fake harness should behave for one test.
#[derive(Clone)]
struct Harnessed {
    /// Whether a source is registered at all. A machine that only uses the
    /// web UI has none, and that is not a broken machine.
    source: bool,
    hang: bool,
    leave_artifacts: bool,
    narrates: bool,
    can_steer: bool,
    delay: Duration,
    backend: Backend,
}

impl Default for Harnessed {
    fn default() -> Self {
        Harnessed {
            source: true,
            hang: false,
            leave_artifacts: false,
            narrates: false,
            can_steer: true,
            delay: Duration::ZERO,
            backend: Backend::Codex,
        }
    }
}

async fn world(mode: Mode, hang: bool) -> World {
    build(mode, Harnessed { hang, ..Default::default() }).await
}

async fn world_leaving_artifacts(mode: Mode) -> World {
    build(
        mode,
        Harnessed {
            leave_artifacts: true,
            ..Default::default()
        },
    )
    .await
}

/// A world whose harness cannot steer and whose turns take a moment, which
/// is the shape of Claude Code and the only one where queueing is visible.
async fn queueing_world() -> World {
    build(
        Mode::Auto,
        Harnessed {
            can_steer: false,
            delay: Duration::from_millis(200),
            backend: Backend::ClaudeCode,
            ..Default::default()
        },
    )
    .await
}

async fn build(mode: Mode, options: Harnessed) -> World {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let posts = Arc::new(Mutex::new(Posts::default()));
    let scratch = std::env::temp_dir().join(format!(
        "oxroute-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));

    let choice = |id: &str, label: &str| Choice {
        id: id.into(),
        label: label.into(),
        backend: Backend::Codex,
    };
    let config = Config {
        source: None,
        workspace: scratch.to_string_lossy().to_string(),
        codex_binary: "codex".into(),
        claude_binary: "claude".into(),
        codex_url: "ws://127.0.0.1:8788".into(),
        codex_effort: "medium".into(),
        title_model: "title".into(),
        claude_permission_mode: "bypassPermissions".into(),
        database: PathBuf::from(":memory:"),
        attachments: scratch.join("attachments"),
        artifacts: scratch.join("artifacts"),
        default_backend: options.backend,
        // The default model has to name the backend under test, or the hub
        // reaches for the harness this test did not replace.
        default_model: match options.backend {
            Backend::Codex => "gpt-6-sol".into(),
            Backend::ClaudeCode => "claude-opus-5".into(),
        },
        models: BTreeMap::from([
            ("sol".to_string(), choice("gpt-6-sol", "Sol")),
            ("astra".to_string(), choice("gpt-6-astra", "Astra")),
            (
                "opus".to_string(),
                Choice {
                    id: "claude-opus-5".into(),
                    label: "Opus".into(),
                    backend: Backend::ClaudeCode,
                },
            ),
        ]),
        stall_timeout: 600.0,
        min_free_bytes: 0,
        slack_app_token: None,
        slack_bot_token: None,
        owner: "U_ME".into(),
        listen: "127.0.0.1:0".into(),
        diagram_path: "docs/architecture.mmd".into(),
    };

    let harness = FakeHarness {
        leave_artifacts: options.leave_artifacts,
        narrates: options.narrates,
        can_steer: options.can_steer,
        delay: options.delay,
        backend: options.backend,
        ..FakeHarness::new(calls.clone(), options.hang)
    };
    let harness_events = harness.events.clone();
    let native = harness.native.clone();
    let fail_open = Arc::new(AtomicBool::new(false));

    let mut hub = Hub::new(config, Store::in_memory().unwrap());
    hub.with_harness(Arc::new(harness));
    if options.source {
        hub.with_source(Arc::new(FakeSource {
            posts: posts.clone(),
            next_thread: Mutex::new(0),
            fail_open: fail_open.clone(),
        }));
    }
    hub.start().await.unwrap();
    hub.set_mode(mode).unwrap();

    World {
        hub,
        calls,
        posts,
        harness: harness_events,
        native,
        fail_open,
    }
}

fn signal(thread: &str, ts: &str, text: &str) -> Signal {
    signal_from("slack", thread, ts, text)
}

fn signal_from(source: &str, thread: &str, ts: &str, text: &str) -> Signal {
    Signal {
        id: new_id("sig"),
        source: source.into(),
        conversation: "D1".into(),
        thread_key: thread.into(),
        external_id: ts.into(),
        author: "U_ME".into(),
        label: "dm".into(),
        text: text.into(),
        attachments: vec![],
        at: now(),
        root: thread == ts,
    }
}

/// Turns run on their own tasks, so a test waits for an outcome instead of
/// assuming one has happened by the time `accept` returns.
async fn settle(check: impl Fn() -> bool) -> bool {
    for _ in 0..600 {
        if check() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    false
}

// -- the tests -----------------------------------------------------------

#[tokio::test]
async fn a_new_thread_starts_an_agent_and_answers_in_place() {
    let w = world(Mode::Auto, false).await;
    w.hub.accept(signal("100.0", "100.0", "drain the pool")).await.unwrap();

    assert!(
        settle(|| !w.posts.lock().unwrap().replies.is_empty()).await,
        "the thread never got an answer"
    );

    let agents = w.hub.store.agents(10).unwrap();
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0].status, AgentStatus::Complete);
    // No naming harness, so the provisional title stands.
    assert_eq!(agents[0].name, "drain the pool");
    assert_eq!(
        w.posts.lock().unwrap().replies.clone(),
        vec![("100.0".to_string(), "done".to_string())]
    );

    // The turn carried the prompt plus the artifact instruction, and nothing
    // it was not given.
    let started = w.calls.lock().unwrap().started.clone();
    assert_eq!(started.len(), 1);
    let texts: Vec<&str> = started[0].1.iter().filter_map(TurnInput::as_text).collect();
    assert_eq!(texts[0], "drain the pool");
    assert!(texts[1].contains("returned to the user"));
}

#[tokio::test]
async fn a_reply_resumes_the_same_agent_rather_than_starting_another() {
    let w = world(Mode::Auto, false).await;
    w.hub.accept(signal("100.0", "100.0", "first")).await.unwrap();
    assert!(settle(|| w.calls.lock().unwrap().started.len() == 1).await);

    w.hub.accept(signal("100.0", "101.0", "second")).await.unwrap();
    assert!(settle(|| w.calls.lock().unwrap().started.len() == 2).await);

    assert_eq!(w.hub.store.agents(10).unwrap().len(), 1);
    let started = w.calls.lock().unwrap().started.clone();
    // Same session both times: the thread resumed, it did not restart.
    assert_eq!(started[0].0, started[1].0);
}

#[tokio::test]
async fn slack_threads_route_immediately_even_when_the_inbox_mode_is_ask() {
    let w = world(Mode::Ask, false).await;
    w.hub.accept(signal("100.0", "100.0", "first")).await.unwrap();
    assert!(settle(|| w.calls.lock().unwrap().started.len() == 1).await);

    w.hub.accept(signal("100.0", "101.0", "second")).await.unwrap();
    assert!(settle(|| w.calls.lock().unwrap().started.len() == 2).await);

    let started = w.calls.lock().unwrap().started.clone();
    assert_eq!(started[0].0, started[1].0);
    assert_eq!(w.hub.store.agents(10).unwrap().len(), 1);
    assert!(w.hub.store.inbox(10).unwrap().iter().all(|item| item.state == InboxState::Done));
}

#[tokio::test]
async fn an_independent_thread_gets_its_own_agent() {
    let w = world(Mode::Auto, false).await;
    w.hub.accept(signal("100.0", "100.0", "one")).await.unwrap();
    w.hub.accept(signal("200.0", "200.0", "two")).await.unwrap();
    assert!(settle(|| w.calls.lock().unwrap().started.len() == 2).await);
    assert_eq!(w.hub.store.agents(10).unwrap().len(), 2);

    let sessions: std::collections::HashSet<String> = w
        .calls
        .lock()
        .unwrap()
        .started
        .iter()
        .map(|(s, _)| s.clone())
        .collect();
    assert_eq!(sessions.len(), 2);
}

#[tokio::test]
async fn ask_mode_holds_a_non_slack_signal_until_someone_says_where_it_goes() {
    let w = world(Mode::Ask, false).await;
    w.hub
        .accept(signal_from("webhook", "100.0", "100.0", "is this worth doing"))
        .await
        .unwrap();

    assert!(w.hub.store.agents(10).unwrap().is_empty(), "nothing should have started");

    let inbox = w.hub.store.inbox(10).unwrap();
    assert_eq!(inbox.len(), 1);
    assert_eq!(inbox[0].state, InboxState::Waiting);

    w.hub
        .route(
            &inbox[0].signal.id,
            Routing::Spawn {
                backend: None,
                model: None,
                cwd: None,
            },
        )
        .await
        .unwrap();

    assert!(settle(|| w.hub.store.agents(10).unwrap().len() == 1).await);
    assert_eq!(w.hub.store.inbox(10).unwrap()[0].state, InboxState::Done);
}

#[tokio::test]
async fn a_signal_can_be_discarded_without_reaching_anything() {
    let w = world(Mode::Ask, false).await;
    w.hub
        .accept(signal_from("webhook", "100.0", "100.0", "anyone want coffee"))
        .await
        .unwrap();
    let id = w.hub.store.inbox(10).unwrap()[0].signal.id.clone();

    w.hub.route(&id, Routing::Discard).await.unwrap();

    let item = w.hub.store.inbox_item(&id).unwrap().unwrap();
    assert_eq!(item.state, InboxState::Done);
    assert_eq!(item.outcome, "discarded");
    assert!(w.hub.store.agents(10).unwrap().is_empty());
    assert!(w.calls.lock().unwrap().started.is_empty());
}

#[tokio::test]
async fn a_waiting_signal_can_be_routed_to_an_agent_that_already_exists() {
    let w = world(Mode::Auto, false).await;
    w.hub.accept(signal("100.0", "100.0", "the first task")).await.unwrap();
    assert!(settle(|| w.hub.store.agents(10).unwrap().len() == 1).await);
    let existing = w.hub.store.agents(10).unwrap()[0].id.clone();

    w.hub.set_mode(Mode::Ask).unwrap();
    w.hub
        .accept(signal_from("webhook", "200.0", "200.0", "related news"))
        .await
        .unwrap();
    let waiting = w
        .hub
        .store
        .inbox(10)
        .unwrap()
        .into_iter()
        .find(|i| i.state == InboxState::Waiting)
        .unwrap();

    w.hub
        .route(
            &waiting.signal.id,
            Routing::Existing {
                agent_ids: vec![existing.clone()],
            },
        )
        .await
        .unwrap();

    assert!(settle(|| w.calls.lock().unwrap().started.len() == 2).await);
    // No new agent, and the second thread now answers into the first one.
    assert_eq!(w.hub.store.agents(10).unwrap().len(), 1);
    assert_eq!(
        w.hub.store.bound_agent("webhook", "D1", "200.0").unwrap(),
        Some(existing)
    );
}

#[tokio::test]
async fn a_follow_up_steers_a_turn_that_is_still_running() {
    let w = world(Mode::Auto, true).await;
    w.hub.accept(signal("100.0", "100.0", "start something long")).await.unwrap();
    assert!(settle(|| w.calls.lock().unwrap().started.len() == 1).await);

    w.hub.accept(signal("100.0", "101.0", "actually, also do this")).await.unwrap();
    assert!(settle(|| w.calls.lock().unwrap().steered.len() == 1).await);

    // Steering folds in; it must not have started a second turn.
    assert_eq!(w.calls.lock().unwrap().started.len(), 1);
}

#[tokio::test]
async fn an_ampersand_queues_instead_of_steering() {
    let w = world(Mode::Auto, true).await;
    w.hub.accept(signal("100.0", "100.0", "start something long")).await.unwrap();
    assert!(settle(|| w.calls.lock().unwrap().started.len() == 1).await);

    w.hub.accept(signal("100.0", "101.0", "& do this afterwards")).await.unwrap();
    tokio::time::sleep(Duration::from_millis(150)).await;
    // It waits behind the running turn rather than joining it.
    assert!(w.calls.lock().unwrap().steered.is_empty());
}

#[tokio::test]
async fn kill_stops_the_turn_and_keeps_the_session() {
    let w = world(Mode::Auto, true).await;
    w.hub.accept(signal("100.0", "100.0", "long job")).await.unwrap();
    assert!(settle(|| w.calls.lock().unwrap().started.len() == 1).await);

    w.hub.accept(signal("100.0", "101.0", "kill")).await.unwrap();
    assert!(settle(|| w.calls.lock().unwrap().interrupted.len() == 1).await);

    assert!(settle(|| w.hub.store.agents(10).unwrap()[0].status == AgentStatus::Stalled).await);
    // The session survives, so a later reply picks up where it left off.
    assert!(!w.hub.store.agents(10).unwrap()[0].session_id.is_empty());
    assert!(w
        .posts
        .lock()
        .unwrap()
        .replies
        .iter()
        .any(|(_, text)| text.contains("Stopped")));
}

#[tokio::test]
async fn clean_detaches_the_thread_so_the_next_reply_starts_fresh() {
    let w = world(Mode::Auto, false).await;
    w.hub.accept(signal("100.0", "100.0", "first task")).await.unwrap();
    assert!(settle(|| w.calls.lock().unwrap().started.len() == 1).await);

    w.hub.accept(signal("100.0", "101.0", "clean")).await.unwrap();
    assert!(settle(|| w.hub.store.bound_agent("slack", "D1", "100.0").unwrap().is_none()).await);

    w.hub.accept(signal("100.0", "102.0", "a new direction")).await.unwrap();
    assert!(settle(|| w.calls.lock().unwrap().started.len() == 2).await);

    let started = w.calls.lock().unwrap().started.clone();
    assert_ne!(started[0].0, started[1].0, "clean should open a new session");
    assert_eq!(w.hub.store.agents(10).unwrap().len(), 2);
}

#[tokio::test]
async fn a_model_word_selects_a_model_and_does_not_become_a_prompt() {
    let w = world(Mode::Auto, false).await;
    w.hub.accept(signal("100.0", "100.0", "first task")).await.unwrap();
    assert!(settle(|| w.calls.lock().unwrap().started.len() == 1).await);

    w.hub.accept(signal("100.0", "101.0", "astra")).await.unwrap();
    assert!(settle(|| w.hub.store.agents(10).unwrap()[0].model == "gpt-6-astra").await);

    // Choosing a model is not work: it must not have run a turn.
    assert_eq!(w.calls.lock().unwrap().started.len(), 1);
    assert!(w
        .posts
        .lock()
        .unwrap()
        .replies
        .iter()
        .any(|(_, text)| text == "Using Astra."));
}

#[tokio::test]
async fn fork_branches_into_a_new_agent_and_a_new_thread() {
    let w = world(Mode::Auto, false).await;
    w.hub.accept(signal("100.0", "100.0", "the original")).await.unwrap();
    assert!(settle(|| w.calls.lock().unwrap().started.len() == 1).await);
    let original = w.hub.store.agents(10).unwrap()[0].id.clone();
    let original_timeline = w.hub.timeline(&original, 50).unwrap();
    assert!(!original_timeline.is_empty());

    w.hub.accept(signal("100.0", "101.0", "fork")).await.unwrap();
    assert!(settle(|| w.hub.store.agents(10).unwrap().len() == 2).await);

    let forked = w.calls.lock().unwrap().forked.clone();
    assert_eq!(forked.len(), 1);
    // A real fork keeps the history; only a side question excludes it.
    assert!(!forked[0].1);
    // The branch lives in its own thread, wired to the new agent.
    let forked = w.hub.store.bound_agent("slack", "D1", "thread-1").unwrap().unwrap();
    let mut forked_timeline = w.hub.timeline(&forked, 50).unwrap();
    let parent = forked_timeline.pop().unwrap();
    assert_eq!(parent.kind, EntryKind::ForkedFrom);
    assert_eq!(parent.text, "Forked from session");
    assert_eq!(parent.detail, original);
    assert_eq!(
        forked_timeline.iter()
            .map(|entry| (&entry.kind, entry.text.as_str(), entry.detail.as_str()))
            .collect::<Vec<_>>(),
        original_timeline
            .iter()
            .map(|entry| (&entry.kind, entry.text.as_str(), entry.detail.as_str()))
            .collect::<Vec<_>>()
    );
    let notice = w.hub.timeline(&original, 1).unwrap().pop().unwrap();
    assert_eq!(notice.kind, EntryKind::Forked);
    assert_eq!(notice.text, "Session forked");
    assert_eq!(notice.detail, forked);
}

#[tokio::test]
async fn local_forks_nest_and_open_source_threads() {
    let w = world(Mode::Auto, false).await;
    w.hub.accept(signal("100.0", "100.0", "the original")).await.unwrap();
    assert!(settle(|| w.hub.store.agents(10).unwrap()[0].status == AgentStatus::Complete).await);
    let original = w.hub.store.agents(10).unwrap()[0].id.clone();

    w.hub.tag(&original, &["stage:building".into()], &[], &[]).unwrap();
    let child = w.hub.fork(&original).await.unwrap();
    let grandchild = w.hub.fork(&child.id).await.unwrap();
    // A branch of the work sits where the work sits.
    assert_eq!(w.hub.store.tags(&grandchild.id).unwrap(), ["stage:building"]);

    assert_eq!(
        w.posts.lock().unwrap().threads,
        vec!["the original fork", "the original fork fork"]
    );
    assert_eq!(w.hub.store.bindings_for(&child.id).unwrap().len(), 1);
    assert_eq!(w.hub.store.bindings_for(&grandchild.id).unwrap().len(), 1);
    assert_eq!(w.hub.store.fork_parent(&child.id).unwrap().as_deref(), Some(original.as_str()));
    assert_eq!(
        w.hub.store.fork_parent(&grandchild.id).unwrap().as_deref(),
        Some(child.id.as_str())
    );
}

#[tokio::test]
async fn a_leaf_fork_merges_its_new_exchanges_into_the_parent() {
    let w = world(Mode::Auto, false).await;
    w.hub.accept(signal("100.0", "100.0", "the original")).await.unwrap();
    assert!(settle(|| w.hub.store.agents(10).unwrap()[0].status == AgentStatus::Complete).await);
    let parent = w.hub.store.agents(10).unwrap()[0].clone();
    let child = w.hub.fork(&parent.id).await.unwrap();
    w.hub
        .store
        .add_entry(&child.id, now(), EntryKind::You, "try another design", "", "")
        .unwrap();
    w.hub
        .store
        .add_entry(&child.id, now(), EntryKind::Said, "the alternate works", "", "")
        .unwrap();

    let merged = w.hub.merge(&child.id).await.unwrap();

    assert_eq!(merged.id, parent.id);
    assert_eq!(
        w.calls.lock().unwrap().injected,
        vec![(parent.session_id.clone(), 1)]
    );
    assert!(w
        .hub
        .store
        .archived_agents()
        .unwrap()
        .iter()
        .any(|agent| agent.id == child.id));
    let parent_notice = w.hub.timeline(&parent.id, 1).unwrap().pop().unwrap();
    assert_eq!(parent_notice.kind, EntryKind::Merged);
    assert_eq!(parent_notice.detail, child.id);
    let child_notice = w.hub.timeline(&child.id, 1).unwrap().pop().unwrap();
    assert_eq!(child_notice.kind, EntryKind::MergedInto);
    assert_eq!(child_notice.detail, parent.id);
}

#[tokio::test]
async fn a_fork_with_an_open_child_cannot_merge() {
    let w = world(Mode::Auto, false).await;
    w.hub.accept(signal("100.0", "100.0", "the original")).await.unwrap();
    assert!(settle(|| w.hub.store.agents(10).unwrap()[0].status == AgentStatus::Complete).await);
    let original = w.hub.store.agents(10).unwrap()[0].id.clone();
    let child = w.hub.fork(&original).await.unwrap();
    w.hub.fork(&child.id).await.unwrap();

    assert!(w
        .hub
        .merge(&child.id)
        .await
        .unwrap_err()
        .to_string()
        .contains("child panes"));
}

#[tokio::test]
async fn native_sessions_remain_searchable_after_they_are_added_to_oxroute() {
    let w = world(Mode::Auto, false).await;
    w.hub.accept(signal("100.0", "100.0", "work on fwgenie in oxroute")).await.unwrap();
    assert!(settle(|| !w.hub.store.search("fwgenie", 20).unwrap().is_empty()).await);
    w.native.lock().unwrap().push(NativeSession {
        backend: Backend::Codex,
        session_id: "native-fwgenie".into(),
        name: "Finish fwgenie".into(),
        preview: "work through the remaining generator issue".into(),
        cwd: "/work/fwgenie".into(),
        model: "gpt-6-astra".into(),
        updated_at: 42.0,
    });

    assert_eq!(w.hub.search("fwgenie", 20).unwrap().len(), 1);
    assert_eq!(w.hub.search_native("fwgenie", 20).await.unwrap().len(), 1);
}

#[tokio::test]
async fn continuing_a_native_session_starts_a_fresh_agent_in_a_fresh_thread() {
    let w = world(Mode::Auto, false).await;
    w.hub
        .store
        .set("dashboard", "slack\u{1f}D1\u{1f}status")
        .unwrap();
    w.native.lock().unwrap().push(NativeSession {
        backend: Backend::Codex,
        session_id: "native-fwgenie".into(),
        name: "Finish fwgenie".into(),
        preview: String::new(),
        cwd: "/work/fwgenie".into(),
        model: "gpt-6-astra".into(),
        updated_at: 42.0,
    });

    let continued = w
        .hub
        .continue_session(Backend::Codex, "native-fwgenie")
        .await
        .unwrap();
    assert!(settle(|| !w.calls.lock().unwrap().started.is_empty()).await);

    let saved = w.hub.store.agent(&continued.id).unwrap().unwrap();
    assert_eq!(saved.session_id, "session-1");
    assert_ne!(saved.session_id, "native-fwgenie");
    assert_eq!(saved.cwd, "/work/fwgenie");
    assert_eq!(saved.model, "gpt-6-astra");
    assert_eq!(saved.permalink, "https://example/thread-1");
    let bindings = w.hub.store.bindings_for(&saved.id).unwrap();
    assert_eq!(bindings.len(), 1);
    assert_eq!(bindings[0].conversation, "D1");
    assert_eq!(bindings[0].thread_key, "thread-1");
    let prompt = w.calls.lock().unwrap().started[0]
        .1
        .iter()
        .filter_map(TurnInput::as_text)
        .next()
        .unwrap()
        .to_string();
    assert!(prompt.contains("native-fwgenie"));
    assert!(prompt.contains("~/.codex/sessions"));
    assert!(prompt.contains("Do not use web search"));
    assert_eq!(w.posts.lock().unwrap().threads, vec![prompt]);
    assert_eq!(w.hub.search_native("fwgenie", 20).await.unwrap().len(), 1);
}

#[tokio::test]
async fn the_same_native_session_can_be_continued_more_than_once() {
    let w = world(Mode::Auto, false).await;
    w.hub
        .store
        .set("dashboard", "slack\u{1f}D1\u{1f}status")
        .unwrap();
    w.native.lock().unwrap().push(NativeSession {
        backend: Backend::Codex,
        session_id: "native-repeatable".into(),
        name: "Repeatable".into(),
        preview: String::new(),
        cwd: "/work/repeatable".into(),
        model: "gpt-6-sol".into(),
        updated_at: 42.0,
    });

    let first = w
        .hub
        .continue_session(Backend::Codex, "native-repeatable")
        .await
        .unwrap();
    assert!(settle(|| w.calls.lock().unwrap().started.len() == 1).await);
    let second = w
        .hub
        .continue_session(Backend::Codex, "native-repeatable")
        .await
        .unwrap();
    assert!(settle(|| w.calls.lock().unwrap().started.len() == 2).await);

    assert_ne!(first.id, second.id);
    assert_ne!(
        w.hub.store.agent(&first.id).unwrap().unwrap().session_id,
        w.hub.store.agent(&second.id).unwrap().unwrap().session_id
    );
    assert_eq!(w.posts.lock().unwrap().threads.len(), 2);
}

#[tokio::test]
async fn continuing_without_a_current_source_conversation_still_works() {
    // Slack is a mirror, not a prerequisite. With nowhere to echo to, a
    // continued session lives in the UI, which is a complete way to use
    // oxroute rather than a degraded one.
    let w = world(Mode::Auto, false).await;
    w.native.lock().unwrap().push(NativeSession {
        backend: Backend::Codex,
        session_id: "native-local".into(),
        name: "Local only".into(),
        preview: String::new(),
        cwd: "/work/local".into(),
        model: "gpt-6-sol".into(),
        updated_at: 42.0,
    });

    let agent = w
        .hub
        .continue_session(Backend::Codex, "native-local")
        .await
        .expect("no source conversation must not stop the work");

    assert_eq!(w.hub.store.agents(20).unwrap().len(), 1);
    assert_eq!(agent.cwd, "/work/local");
    // It is bound somewhere local rather than to a Slack thread that does
    // not exist, and has no permalink to offer.
    assert!(agent.permalink.is_empty());
    let bindings = w.hub.store.bindings_for(&agent.id).unwrap();
    assert!(
        bindings.iter().all(|binding| binding.source != "slack"),
        "nothing should be bound to slack: {bindings:?}"
    );
}

#[tokio::test]
async fn an_agent_can_be_started_from_the_ui_with_no_source_configured() {
    // The case that was broken: on a laptop with no Slack app, pressing
    // "start a new agent" refused with "no current source conversation".
    let w = world(Mode::Ask, false).await;
    let mut typed = signal("500.0", "500.0", "look into the flaky test");
    typed.source = "you".into();
    w.hub.accept(typed).await.unwrap();

    let waiting = w
        .hub
        .store
        .inbox(10)
        .unwrap()
        .into_iter()
        .find(|item| item.state == InboxState::Waiting)
        .expect("a typed note waits in ask mode");

    w.hub
        .route(
            &waiting.signal.id,
            Routing::Spawn { backend: None, model: None, cwd: None },
        )
        .await
        .expect("starting an agent must not need somewhere to mirror to");

    assert!(settle(|| w.hub.store.agents(10).unwrap().len() == 1).await);
    assert!(settle(|| !w.calls.lock().unwrap().started.is_empty()).await);
}

#[tokio::test]
async fn a_broken_mirror_is_visible_without_blocking_local_work() {
    let w = world(Mode::Ask, false).await;
    w.hub
        .store
        .set("dashboard", "slack\u{1f}D1\u{1f}status")
        .unwrap();
    w.fail_open.store(true, Ordering::Relaxed);
    let mut events = w.hub.subscribe();

    let mut typed = signal("501.0", "501.0", "inspect the failed build");
    typed.source = "you".into();
    w.hub.accept(typed).await.unwrap();
    let waiting = w
        .hub
        .store
        .inbox(10)
        .unwrap()
        .into_iter()
        .find(|item| item.state == InboxState::Waiting)
        .unwrap();
    w.hub
        .route(
            &waiting.signal.id,
            Routing::Spawn { backend: None, model: None, cwd: None },
        )
        .await
        .expect("a mirror failure must not stop the work");

    let notice = std::iter::from_fn(|| events.try_recv().ok()).find_map(|event| match event {
        Event::Notice { text } => Some(text),
        _ => None,
    });
    assert_eq!(
        notice.as_deref(),
        Some("slack mirror failed: source unavailable. Continuing locally.")
    );
    assert!(settle(|| !w.calls.lock().unwrap().started.is_empty()).await);
}

#[tokio::test]
async fn continuing_an_unconfigured_native_model_uses_the_configured_backend_default() {
    let w = world(Mode::Auto, false).await;
    w.hub
        .store
        .set("dashboard", "slack\u{1f}D1\u{1f}status")
        .unwrap();
    w.native.lock().unwrap().push(NativeSession {
        backend: Backend::Codex,
        session_id: "native-invalid-model".into(),
        name: "Release work".into(),
        preview: String::new(),
        cwd: "/work/release".into(),
        model: "gpt-5.6-sol".into(),
        updated_at: 42.0,
    });

    let continued = w
        .hub
        .continue_session(Backend::Codex, "native-invalid-model")
        .await
        .unwrap();

    assert_eq!(continued.model, "gpt-6-sol");
}

#[tokio::test]
async fn an_unknown_native_session_cannot_be_continued() {
    let w = world(Mode::Auto, false).await;
    assert!(w
        .hub
        .continue_session(Backend::Codex, "missing")
        .await
        .unwrap_err()
        .to_string()
        .contains("no such"));
}

#[tokio::test]
async fn a_codex_turn_is_reattached_after_the_daemon_restarts() {
    let base = world(Mode::Auto, false).await;
    let config = base.hub.config.clone();
    let store = Store::in_memory().unwrap();
    let agent = Agent {
        id: "agent-recovered".into(),
        name: "long task".into(),
        backend: Backend::Codex,
        model: "gpt-6-sol".into(),
        session_id: "session-live".into(),
        cwd: config.workspace.clone(),
        status: AgentStatus::Working,
        activity: "working".into(),
        permalink: String::new(),
        last_activity: now(),
        updated_at: now(),
        stall_reason: None,
        stall_alerted: false,
        pinned: false,
    };
    store.save_agent(&agent).unwrap();
    store.bind("slack", "D1", "100.0", &agent.id).unwrap();
    store
        .save_active_turn(&ActiveTurn {
            agent_id: agent.id.clone(),
            session_id: agent.session_id.clone(),
            turn_id: "turn-live".into(),
            artifact_dir: config.artifacts.join(&agent.id).join("turn-live"),
            target: Some(Target::new("slack", "D1", "100.0")),
        })
        .unwrap();

    let calls = Arc::new(Mutex::new(Calls::default()));
    let harness = FakeHarness {
        recovery: Mutex::new(Some(RecoveredTurn {
            id: "turn-live".into(),
            status: "inProgress".into(),
            items: vec![],
        })),
        ..FakeHarness::new(calls.clone(), true)
    };
    let events = harness.events.clone();
    let posts = Arc::new(Mutex::new(Posts::default()));
    let mut hub = Hub::new(config, store);
    hub.with_harness(Arc::new(harness));
    hub.with_source(Arc::new(FakeSource {
        posts: posts.clone(),
        next_thread: Mutex::new(0),
        fail_open: Arc::new(AtomicBool::new(false)),
    }));
    hub.start().await.unwrap();

    let _ = events.send(HarnessEvent::Message {
        session: agent.session_id.clone(),
        text: "finished after reload".into(),
        final_answer: true,
    });
    let _ = events.send(HarnessEvent::TurnFinished {
        session: agent.session_id.clone(),
        status: "completed".into(),
    });

    assert!(settle(|| hub.store.agent(&agent.id).unwrap().unwrap().status == AgentStatus::Complete).await);
    assert!(calls.lock().unwrap().started.is_empty(), "the turn was started twice");
    assert!(hub.store.active_turns().unwrap().is_empty());
    assert!(hub
        .timeline(&agent.id, 10)
        .unwrap()
        .iter()
        .any(|entry| entry.kind == EntryKind::Said && entry.text == "finished after reload"));
    assert!(posts
        .lock()
        .unwrap()
        .replies
        .iter()
        .any(|(thread, text)| thread == "100.0" && text == "finished after reload"));
}

#[tokio::test]
async fn a_side_question_forks_without_history_and_is_folded_back_in() {
    let w = world(Mode::Auto, false).await;
    w.hub.accept(signal("100.0", "100.0", "the main task")).await.unwrap();
    assert!(settle(|| w.calls.lock().unwrap().started.len() == 1).await);
    let agent = w.hub.store.agents(10).unwrap()[0].id.clone();

    w.hub.accept(signal("100.0", "101.0", "btw what port is it on")).await.unwrap();
    assert!(settle(|| !w.hub.store.pending_context(&agent).unwrap().is_empty()).await);

    let forked = w.calls.lock().unwrap().forked.clone();
    assert_eq!(forked.len(), 1);
    assert!(forked[0].1, "a side question excludes the history");
    // The side agent is scratch: it must not join the fleet.
    assert_eq!(w.hub.store.agents(10).unwrap().len(), 1);

    // The next real turn splices the exchange in before running.
    w.hub.accept(signal("100.0", "102.0", "carry on")).await.unwrap();
    assert!(settle(|| !w.calls.lock().unwrap().injected.is_empty()).await);
    assert!(settle(|| w.hub.store.pending_context(&agent).unwrap().is_empty()).await);
}

#[tokio::test]
async fn rename_reaches_the_store_and_the_thread() {
    let w = world(Mode::Auto, false).await;
    w.hub.accept(signal("100.0", "100.0", "something")).await.unwrap();
    assert!(settle(|| w.calls.lock().unwrap().started.len() == 1).await);

    w.hub
        .accept(signal("100.0", "101.0", "rename \"ship the migration\""))
        .await
        .unwrap();
    assert!(settle(|| w.hub.store.agents(10).unwrap()[0].name == "ship the migration").await);
    assert!(w
        .posts
        .lock()
        .unwrap()
        .retitled
        .contains(&"ship the migration".to_string()));
}

#[tokio::test]
async fn typing_at_an_agent_from_another_surface_answers_in_its_thread() {
    let w = world(Mode::Auto, false).await;
    w.hub.accept(signal("100.0", "100.0", "the task")).await.unwrap();
    assert!(settle(|| w.calls.lock().unwrap().started.len() == 1).await);
    let agent = w.hub.store.agents(10).unwrap()[0].id.clone();

    // This is what the TUI and the web UI do.
    w.hub.say_to(&agent, "one more thing").await.unwrap();
    assert!(settle(|| w.calls.lock().unwrap().started.len() == 2).await);
    assert!(settle(|| w.posts.lock().unwrap().replies.len() >= 3).await);

    // It lands in the Slack thread, not into nowhere.
    assert!(w
        .posts
        .lock()
        .unwrap()
        .replies
        .iter()
        .all(|(thread, _)| thread == "100.0"));
    assert!(w
        .posts
        .lock()
        .unwrap()
        .replies
        .iter()
        .any(|(_, text)| text == "Question from Oxroute UI:\none more thing"));

    let timeline = w.hub.timeline(&agent, 50).unwrap();
    let direct: Vec<_> = timeline
        .iter()
        .filter(|entry| entry.text == "one more thing")
        .collect();
    assert_eq!(direct.len(), 1);
    assert_eq!(direct[0].kind, EntryKind::You);
}

#[tokio::test]
async fn an_agent_started_in_the_ui_also_lives_in_slack() {
    let w = world(Mode::Auto, false).await;
    w.hub
        .store
        .set("dashboard", "slack\u{1f}D1\u{1f}status")
        .unwrap();

    w.hub
        .accept(signal_from("you", "local", "local", "publish the release"))
        .await
        .unwrap();
    assert!(settle(|| w.hub.store.agents(10).unwrap()[0].status == AgentStatus::Complete).await);

    let agent = w.hub.store.agents(10).unwrap().remove(0);
    assert_eq!(agent.permalink, "https://example/thread-1");
    assert_eq!(w.posts.lock().unwrap().threads, vec!["publish the release"]);
    assert!(w
        .posts
        .lock()
        .unwrap()
        .replies
        .iter()
        .any(|(thread, text)| thread == "thread-1" && text == "done"));
    assert!(w
        .hub
        .store
        .bindings_for(&agent.id)
        .unwrap()
        .iter()
        .any(|binding| binding.source == "slack" && binding.thread_key == "thread-1"));
}

#[tokio::test]
async fn an_agent_with_an_old_slack_binding_gets_a_current_home_on_its_next_ui_message() {
    let w = world(Mode::Auto, false).await;
    w.hub.accept(signal("100.0", "100.0", "the original")).await.unwrap();
    assert!(settle(|| w.hub.store.agents(10).unwrap()[0].status == AgentStatus::Complete).await);
    let agent = w.hub.store.agents(10).unwrap().remove(0);
    w.hub
        .store
        .set("dashboard", "slack\u{1f}D2\u{1f}status")
        .unwrap();

    w.hub.say_to(&agent.id, "finish the release").await.unwrap();
    assert!(settle(|| w.calls.lock().unwrap().started.len() == 2).await);
    assert!(settle(|| {
        w.posts
            .lock()
            .unwrap()
            .replies
            .iter()
            .any(|(thread, text)| thread == "thread-1" && text == "done")
    })
    .await);

    assert_eq!(w.posts.lock().unwrap().threads, vec!["finish the release"]);
    assert!(!w
        .posts
        .lock()
        .unwrap()
        .replies
        .iter()
        .any(|(_, text)| text.starts_with("Question from Oxroute UI:")));
    let bindings = w.hub.store.bindings_for(&agent.id).unwrap();
    assert_eq!(bindings.len(), 1);
    assert_eq!(bindings[0].source, "slack");
    assert_eq!(bindings[0].conversation, "D2");
    assert_eq!(bindings[0].thread_key, "thread-1");
}

#[tokio::test]
async fn ui_images_reach_the_agent_and_its_slack_thread() {
    let w = world(Mode::Auto, false).await;
    w.hub.accept(signal("100.0", "100.0", "the task")).await.unwrap();
    assert!(settle(|| w.hub.store.agents(10).unwrap()[0].status == AgentStatus::Complete).await);
    let agent = w.hub.store.agents(10).unwrap()[0].id.clone();

    w.hub
        .say_to_with_images(&agent, "inspect this", vec!["/tmp/chart.png".into()], false)
        .await
        .unwrap();
    assert!(settle(|| w.calls.lock().unwrap().started.len() == 2).await);

    let calls = w.calls.lock().unwrap();
    assert!(calls.started[1]
        .1
        .iter()
        .any(|input| matches!(input, TurnInput::LocalImage { path } if path == "/tmp/chart.png")));
    drop(calls);
    assert!(w.posts
        .lock()
        .unwrap()
        .uploads
        .iter()
        .any(|paths| paths == &["/tmp/chart.png"]));
    assert!(w.posts
        .lock()
        .unwrap()
        .replies
        .iter()
        .any(|(_, text)| text.contains("Question from Oxroute UI:\ninspect this")));
}

#[tokio::test]
async fn a_redelivered_message_is_not_run_twice() {
    let w = world(Mode::Auto, false).await;
    let once = signal("100.0", "100.0", "do the thing");
    w.hub.accept(once.clone()).await.unwrap();
    assert!(settle(|| w.calls.lock().unwrap().started.len() == 1).await);

    // Same external id, fresh oxroute id: what a redelivery looks like after
    // a socket drops mid-acknowledgement.
    w.hub
        .accept(Signal {
            id: new_id("sig"),
            ..once
        })
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(w.calls.lock().unwrap().started.len(), 1);
}

#[tokio::test]
async fn artifacts_left_behind_are_handed_back() {
    let w = world_leaving_artifacts(Mode::Auto).await;
    w.hub.accept(signal("100.0", "100.0", "make me a chart")).await.unwrap();

    assert!(settle(|| !w.posts.lock().unwrap().uploads.is_empty()).await);
    let uploads = w.posts.lock().unwrap().uploads.clone();
    assert_eq!(uploads.len(), 1);
    assert!(uploads[0][0].ends_with("chart.png"));
}

#[tokio::test]
async fn an_interrupted_turn_hands_nothing_back() {
    // Stopping a turn is the user saying they do not want the result. Files
    // it happened to write on the way are not an answer.
    let w = world(Mode::Auto, true).await;
    w.hub.accept(signal("100.0", "100.0", "make me a chart")).await.unwrap();
    assert!(settle(|| !w.calls.lock().unwrap().started.is_empty()).await);

    let directory = artifact_directory(&w.calls.lock().unwrap().started).unwrap();
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(format!("{directory}/chart.png"), b"not really a png").unwrap();

    let agent = w.hub.store.agents(10).unwrap()[0].id.clone();
    assert!(w.hub.interrupt(&agent).await.unwrap());

    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(w.posts.lock().unwrap().uploads.is_empty());
}

#[tokio::test]
async fn a_directive_on_a_thread_with_no_agent_says_so_rather_than_failing() {
    let w = world(Mode::Auto, false).await;
    w.hub.accept(signal("900.0", "901.0", "kill")).await.unwrap();

    assert!(
        settle(|| w
            .posts
            .lock()
            .unwrap()
            .replies
            .iter()
            .any(|(thread, text)| thread == "900.0" && text.contains("not connected")))
        .await
    );
    assert!(w.hub.store.agents(10).unwrap().is_empty());
}

/// The TUI and the web UI both build this JSON by hand. If the field names
/// move, routing silently stops working from both of them at once.
#[test]
fn the_routing_payload_the_surfaces_send_still_parses() {
    let existing: Routing =
        serde_json::from_str(r#"{"action":"existing","agentIds":["a1","a2"]}"#).unwrap();
    match existing {
        Routing::Existing { agent_ids } => assert_eq!(agent_ids, ["a1", "a2"]),
        other => panic!("expected Existing, got {other:?}"),
    }

    let spawn: Routing =
        serde_json::from_str(r#"{"action":"spawn","model":"astra"}"#).unwrap();
    match spawn {
        Routing::Spawn { model, backend, cwd } => {
            assert_eq!(model.as_deref(), Some("astra"));
            // Everything but the action is optional, so the surfaces can send
            // only what the person actually chose.
            assert!(backend.is_none() && cwd.is_none());
        }
        other => panic!("expected Spawn, got {other:?}"),
    }

    assert!(matches!(
        serde_json::from_str::<Routing>(r#"{"action":"discard"}"#).unwrap(),
        Routing::Discard
    ));
}

#[tokio::test]
async fn a_harness_that_cannot_steer_queues_behind_the_running_turn() {
    // This is the Claude Code path. A second message must not start a second
    // turn on the same session, and must not be dropped either: it waits.
    let w = queueing_world().await;
    w.hub.accept(signal("100.0", "100.0", "the first thing")).await.unwrap();
    assert!(settle(|| w.calls.lock().unwrap().started.len() == 1).await);

    w.hub.accept(signal("100.0", "101.0", "the second thing")).await.unwrap();
    assert!(settle(|| w.calls.lock().unwrap().started.len() == 2).await);

    let calls = w.calls.lock().unwrap();
    // No steering, because the harness said it could not.
    assert!(calls.steered.is_empty());
    // One agent, one session, two turns in order.
    assert_eq!(calls.started[0].0, calls.started[1].0);
    let gap = calls.start_times[1].duration_since(calls.start_times[0]);
    assert!(
        gap >= Duration::from_millis(180),
        "the second turn started {gap:?} in, so it did not wait for the first"
    );
    drop(calls);
    assert_eq!(w.hub.store.agents(10).unwrap().len(), 1);
}

#[tokio::test]
async fn tool_activity_reaches_the_timeline_rather_than_only_flashing_past() {
    let w = world(Mode::Auto, true).await;
    w.hub.accept(signal("100.0", "100.0", "do some work")).await.unwrap();
    assert!(settle(|| !w.calls.lock().unwrap().started.is_empty()).await);
    let agent = w.hub.store.agents(10).unwrap()[0].id.clone();

    // What a harness reports while it is working.
    w.harness_item(
        &agent,
        serde_json::json!({
            "id": "i1", "type": "commandExecution", "status": "completed",
            "command": "kubectl get pods -n staging",
            "aggregatedOutput": "api-0 Running\nworker-0 Running",
        }),
    )
    .await;

    assert!(
        settle(|| w
            .hub
            .timeline(&agent, 50)
            .unwrap()
            .iter()
            .any(|e| e.kind == EntryKind::Worked
                && e.detail.contains("kubectl")
                && e.output.contains("worker-0 Running")))
            .await,
        "the command and its output never reached the timeline"
    );
}

#[tokio::test]
async fn a_separate_tool_result_updates_the_matching_timeline_entry() {
    let w = world(Mode::Auto, true).await;
    w.hub.accept(signal("100.0", "100.0", "inspect two things")).await.unwrap();
    assert!(settle(|| !w.calls.lock().unwrap().started.is_empty()).await);
    let agent = w.hub.store.agents(10).unwrap()[0].id.clone();

    for (id, command) in [("first", "inspect alpha"), ("second", "inspect beta")] {
        w.harness_item(
            &agent,
            serde_json::json!({
                "id": id, "type": "toolCall", "status": "completed",
                "tool": "Shell", "arguments": { "command": command },
            }),
        )
        .await;
    }
    assert!(settle(|| {
        w.hub
            .timeline(&agent, 50)
            .unwrap()
            .iter()
            .filter(|entry| entry.kind == EntryKind::Worked)
            .count()
            == 2
    })
    .await);

    w.harness_item(
        &agent,
        serde_json::json!({
            "id": "first", "type": "toolResult", "status": "completed",
            "aggregatedOutput": "alpha output",
        }),
    )
    .await;

    assert!(settle(|| {
        let entries = w.hub.timeline(&agent, 50).unwrap();
        entries.iter().any(|entry| entry.detail == "inspect alpha" && entry.output == "alpha output")
            && entries.iter().any(|entry| entry.detail == "inspect beta" && entry.output.is_empty())
    })
    .await);
}

#[tokio::test]
async fn something_you_typed_carries_no_provenance_label() {
    let w = world(Mode::Auto, false).await;
    w.hub
        .store
        .set("dashboard", "slack\u{1f}D1\u{1f}status")
        .unwrap();
    let mut typed = signal("100.0", "100.0", "an idea of my own");
    typed.source = "you".into();
    typed.author = "local".into();
    w.hub.accept(typed).await.unwrap();

    assert!(settle(|| !w.hub.store.agents(10).unwrap().is_empty()).await);
    let agent = w.hub.store.agents(10).unwrap()[0].id.clone();
    assert!(settle(|| !w.hub.timeline(&agent, 10).unwrap().is_empty()).await);

    let received = w
        .hub
        .timeline(&agent, 10)
        .unwrap()
        .into_iter()
        .find(|e| e.kind == EntryKind::Received)
        .unwrap();
    // "you local" is two words saying nothing.
    assert_eq!(received.origin, "");
}

#[tokio::test]
async fn an_agent_is_handed_its_own_open_work_when_a_turn_ends() {
    let w = world(Mode::Auto, false).await;
    w.hub.accept(signal("100.0", "100.0", "drain the pool")).await.unwrap();
    assert!(settle(|| w.calls.lock().unwrap().started.len() == 1).await);
    let agent = w.hub.store.agents(10).unwrap()[0].clone();

    w.hub
        .store
        .save_task(&TaskItem {
            id: "task_1".into(),
            text: "scrub the tiles".into(),
            status: TaskStatus::Incomplete,
            blocked_by_task_id: String::new(),
            agent_id: agent.id.clone(),
            position: 0.0,
            images: vec![],
            created_at: now(),
            updated_at: now(),
        })
        .unwrap();

    w.hub.accept(signal("100.0", "101.0", "carry on")).await.unwrap();

    // The turn that answers "carry on" is followed by one nobody asked for,
    // because the agent still has work of its own.
    assert!(
        settle(|| w.calls.lock().unwrap().started.len() == 3).await,
        "the agent stopped with its own work still open"
    );
    let started = w.calls.lock().unwrap().started.clone();
    let texts: Vec<&str> = started[2].1.iter().filter_map(TurnInput::as_text).collect();
    assert!(texts[0].contains("still has open work"));
    assert!(texts[0].contains("scrub the tiles"));

    // And it stops there: that turn left the list exactly as it found it,
    // so asking again would only repeat itself.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(w.calls.lock().unwrap().started.len(), 3);
}

#[tokio::test]
async fn an_agent_with_nothing_open_is_left_alone() {
    let w = world(Mode::Auto, false).await;
    w.hub.accept(signal("100.0", "100.0", "drain the pool")).await.unwrap();
    assert!(settle(|| w.calls.lock().unwrap().started.len() == 1).await);
    let agent = w.hub.store.agents(10).unwrap()[0].clone();

    for (id, status) in [
        ("task_done", TaskStatus::Complete),
        ("task_blocked", TaskStatus::WaitingForHuman),
    ] {
        w.hub
            .store
            .save_task(&TaskItem {
                id: id.into(),
                text: id.into(),
                status,
                blocked_by_task_id: String::new(),
                agent_id: agent.id.clone(),
                position: 0.0,
                images: vec![],
                created_at: now(),
                updated_at: now(),
            })
            .unwrap();
    }

    w.hub.accept(signal("100.0", "101.0", "carry on")).await.unwrap();
    assert!(settle(|| w.calls.lock().unwrap().started.len() == 2).await);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(w.calls.lock().unwrap().started.len(), 2);
}

#[tokio::test]
async fn a_fork_works_with_no_source_to_put_a_thread_in() {
    let w = build(Mode::Auto, Harnessed { source: false, ..Harnessed::default() }).await;
    w.hub.accept(signal("100.0", "100.0", "the original")).await.unwrap();
    assert!(settle(|| w.hub.store.agents(10).unwrap()[0].status == AgentStatus::Complete).await);
    let original = w.hub.store.agents(10).unwrap()[0].id.clone();

    // A pane is somewhere to work; it does not need a conversation.
    let child = w.hub.fork(&original).await.unwrap();
    assert_eq!(w.hub.store.fork_parent(&child.id).unwrap().as_deref(), Some(original.as_str()));
    assert!(w.hub.store.bindings_for(&child.id).unwrap().is_empty());
}

#[tokio::test]
async fn a_queued_message_waits_for_the_turn_instead_of_folding_into_it() {
    // A harness that can steer, and a turn long enough to steer into.
    let w = build(
        Mode::Auto,
        Harnessed { delay: Duration::from_millis(300), ..Harnessed::default() },
    )
    .await;
    w.hub.accept(signal("100.0", "100.0", "the first thing")).await.unwrap();
    assert!(settle(|| w.calls.lock().unwrap().started.len() == 1).await);
    let agent = w.hub.store.agents(10).unwrap()[0].id.clone();

    w.hub.say_to_with_images(&agent, "while you work", vec![], true).await.unwrap();
    assert!(settle(|| w.calls.lock().unwrap().started.len() == 2).await);

    // It ran as its own turn, and nothing was folded into the first one.
    assert!(w.calls.lock().unwrap().steered.is_empty());
    let started = w.calls.lock().unwrap().started.clone();
    let texts: Vec<&str> = started[1].1.iter().filter_map(TurnInput::as_text).collect();
    // The message arrives as written: queuing is said in the request, not
    // smuggled into the text with a prefix.
    assert_eq!(texts[0], "while you work");
}

#[tokio::test]
async fn an_ordinary_message_still_folds_into_a_running_turn() {
    let w = build(
        Mode::Auto,
        Harnessed { delay: Duration::from_millis(300), ..Harnessed::default() },
    )
    .await;
    w.hub.accept(signal("100.0", "100.0", "the first thing")).await.unwrap();
    assert!(settle(|| w.calls.lock().unwrap().started.len() == 1).await);
    let agent = w.hub.store.agents(10).unwrap()[0].id.clone();

    w.hub.say_to(&agent, "actually, like this").await.unwrap();
    assert!(settle(|| !w.calls.lock().unwrap().steered.is_empty()).await);
    assert_eq!(w.calls.lock().unwrap().started.len(), 1);
}

#[tokio::test]
async fn a_task_can_be_handed_to_an_agent_that_does_not_exist_yet() {
    let w = world(Mode::Auto, false).await;
    let task = w.hub.create_task("paint the shed", "", vec![]).await.unwrap();

    // Starting an agent on a task gives it the task, and the task follows.
    let moved = w.hub.hand_off_task(&task.id, false, None).await.unwrap();
    let agents = w.hub.store.agents(10).unwrap();
    assert_eq!(agents.len(), 1);
    assert_eq!(moved.agent_id, agents[0].id);
    assert!(settle(|| !w.calls.lock().unwrap().started.is_empty()).await);
    let started = w.calls.lock().unwrap().started.clone();
    let texts: Vec<&str> = started[0].1.iter().filter_map(TurnInput::as_text).collect();
    assert_eq!(texts[0], "paint the shed");

    // Forking branches whoever has it, and the task goes to the branch.
    let forked = w.hub.hand_off_task(&moved.id, true, None).await.unwrap();
    assert_ne!(forked.agent_id, moved.agent_id);
    assert_eq!(
        w.hub.store.fork_parent(&forked.agent_id).unwrap().as_deref(),
        Some(moved.agent_id.as_str())
    );
}

#[tokio::test]
async fn a_task_nobody_has_cannot_be_forked() {
    let w = world(Mode::Auto, false).await;
    let task = w.hub.create_task("paint the shed", "", vec![]).await.unwrap();
    // There is no session to branch, and inventing one would not be a fork.
    assert!(w.hub.hand_off_task(&task.id, true, None).await.is_err());
}

#[tokio::test]
async fn a_task_changes_status_only_with_a_note_saying_why() {
    let w = world(Mode::Auto, false).await;
    let task = w.hub.create_task("paint the shed", "", vec![]).await.unwrap();

    // A claim about work with nothing said about it is refused.
    assert!(w
        .hub
        .update_task(&task.id, &task.text, TaskStatus::Complete, "", "", None, true)
        .is_err());
    assert_eq!(w.hub.tasks().unwrap()[0].status, TaskStatus::Incomplete);

    let done = w
        .hub
        .update_task(&task.id, &task.text, TaskStatus::Complete, "", "", Some("painted in a1b2c3d"), true)
        .unwrap();
    assert_eq!(done.status, TaskStatus::Complete);
    let notes = w.hub.task_notes().unwrap();
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].task_id, task.id);
    assert_eq!(notes[0].text, "painted in a1b2c3d");

    // Editing anything else about a settled task needs no fresh account.
    assert!(w
        .hub
        .update_task(&task.id, "paint the shed blue", TaskStatus::Complete, "", "", None, true)
        .is_ok());
    assert_eq!(w.hub.task_notes().unwrap().len(), 1);
}

#[tokio::test]
async fn notes_go_when_the_task_does() {
    let w = world(Mode::Auto, false).await;
    let task = w.hub.create_task("paint the shed", "", vec![]).await.unwrap();
    w.hub.add_task_note(&task.id, "started on it", "").unwrap();
    assert_eq!(w.hub.task_notes().unwrap().len(), 1);

    w.hub.delete_task(&task.id).unwrap();
    assert!(w.hub.task_notes().unwrap().is_empty());
}

#[tokio::test]
async fn an_agent_is_told_who_else_is_in_its_working_directory() {
    let w = world(Mode::Auto, false).await;
    w.hub.accept(signal("100.0", "100.0", "the first")).await.unwrap();
    assert!(settle(|| w.calls.lock().unwrap().started.len() == 1).await);

    // Alone in the tree, there is nobody to mention.
    let first = w.calls.lock().unwrap().started[0].1.clone();
    let texts: Vec<&str> = first.iter().filter_map(TurnInput::as_text).collect();
    assert!(!texts.iter().any(|text| text.contains("Other sessions are working in")));

    // A second agent shares the workspace, so each is told about the other.
    w.hub.accept(signal("200.0", "200.0", "the second")).await.unwrap();
    assert!(settle(|| w.calls.lock().unwrap().started.len() == 2).await);
    let second = w.calls.lock().unwrap().started[1].1.clone();
    let texts: Vec<&str> = second.iter().filter_map(TurnInput::as_text).collect();
    let shared = texts
        .iter()
        .find(|text| text.contains("Other sessions are working in"))
        .expect("the second agent was not told about the first");
    assert!(shared.contains("the first"));
    assert!(shared.contains("git worktree"));
}

#[tokio::test]
async fn the_task_list_is_a_queue_that_can_be_rearranged() {
    let w = world(Mode::Auto, false).await;
    let order = || {
        w.hub.tasks().unwrap().into_iter().map(|task| task.text).collect::<Vec<_>>()
    };
    for text in ["first", "second", "third"] {
        w.hub.create_task(text, "", vec![]).await.unwrap();
    }
    // A new task joins the end of the queue rather than the front.
    assert_eq!(order(), vec!["first", "second", "third"]);

    // Moving one says what to do before what.
    let third = w.hub.tasks().unwrap()[2].id.clone();
    w.hub.move_task(&third, None).unwrap();
    assert_eq!(order(), vec!["third", "first", "second"]);

    let first = w.hub.tasks().unwrap()[1].id.clone();
    let second = w.hub.tasks().unwrap()[2].id.clone();
    w.hub.move_task(&first, Some(&second)).unwrap();
    assert_eq!(order(), vec!["third", "second", "first"]);

    // Editing a task leaves it where it is.
    w.hub
        .update_task(&second, "second, reworded", TaskStatus::Incomplete, "", "", None, true)
        .unwrap();
    assert_eq!(order(), vec!["third", "second, reworded", "first"]);
}

// -- tags and boards -------------------------------------------------------

fn words(tags: &[&str]) -> Vec<String> {
    tags.iter().map(|t| t.to_string()).collect()
}

async fn two_sessions(w: &World) -> (String, String) {
    w.hub.accept(signal("100.0", "100.0", "first idea")).await.unwrap();
    w.hub.accept(signal("200.0", "200.0", "second idea")).await.unwrap();
    assert!(settle(|| w.hub.store.agents(10).unwrap().len() == 2).await);
    let agents = w.hub.store.agents(10).unwrap();
    let id = |name: &str| agents.iter().find(|a| a.name == name).unwrap().id.clone();
    (id("first idea"), id("second idea"))
}

#[tokio::test]
async fn tags_set_add_and_remove_and_show_in_the_snapshot() {
    let w = world(Mode::Auto, false).await;
    let (first, _) = two_sessions(&w).await;
    w.hub.tag(&first, &words(&["Stage: Idea", "track:oss"]), &[], &[]).unwrap();
    let now = w.hub.tag(&first, &words(&["track:business"]), &[], &words(&["stage:building"])).unwrap();
    assert_eq!(now, ["stage:building", "track:business", "track:oss"]);
    assert_eq!(w.hub.snapshot(10).unwrap().tags[&first], now);
    let error = w.hub.tag(&first, &words(&["stage:"]), &[], &[]).unwrap_err().to_string();
    assert!(error.contains("is not a tag"), "{error}");
    assert!(w.hub.tag("nobody", &words(&["x"]), &[], &[]).is_err());
}

#[tokio::test]
async fn a_board_is_its_settings_and_moving_a_card_is_setting_one_tag() {
    let w = world(Mode::Auto, false).await;
    let (first, second) = two_sessions(&w).await;
    w.hub.tag(&first, &words(&["stage:idea", "priority:p2"]), &[], &[]).unwrap();
    w.hub.tag(&second, &words(&["stage:building", "priority:p1"]), &[], &[]).unwrap();

    let board = w
        .hub
        .create_board(oxroute_core::tags::Board {
            id: String::new(),
            name: String::new(),
            columns: "stage".into(),
            column_order: words(&["idea", "building", "shipped"]),
            rows: String::new(),
            row_order: vec![],
            filters: words(&["priority"]),
            selected: vec![],
            sort: String::new(),
            created_at: 0.0,
            updated_at: 0.0,
        })
        .unwrap();
    assert_eq!(board.name, "Board 1");
    assert_eq!(w.hub.snapshot(10).unwrap().boards.len(), 1);

    let laid = w.hub.arrange(&board.id).unwrap();
    // The cards in a column of the first row.
    let column = |laid: &oxroute_core::tags::Arranged, value: &str| {
        let at = laid.columns.iter().position(|c| c.as_deref() == Some(value)).unwrap();
        laid.rows[0].cells[at].clone()
    };
    assert_eq!(column(&laid, "idea"), vec![first.clone()]);
    assert_eq!(column(&laid, "building"), vec![second.clone()]);

    // Drag the first card to an empty column.
    let tags = w.hub.move_card(&board.id, &first, Some("shipped"), None).unwrap();
    assert_eq!(tags, ["priority:p2", "stage:shipped"]);
    assert_eq!(column(&w.hub.arrange(&board.id).unwrap(), "shipped"), vec![first.clone()]);

    // And off every column, to the one for sessions with no stage.
    w.hub.move_card(&board.id, &first, None, None).unwrap();
    let laid = w.hub.arrange(&board.id).unwrap();
    assert_eq!(laid.columns.last().unwrap(), &None);
    assert_eq!(laid.rows[0].cells.last().unwrap(), &vec![first.clone()]);

    // With rows as well, a drop names a cell and sets both tags.
    let mut grid = board.clone();
    grid.rows = "project".into();
    grid.row_order = words(&["agents", "compilers"]);
    w.hub.update_board(&board.id, grid).unwrap();
    let tags = w.hub.move_card(&board.id, &first, Some("idea"), Some("compilers")).unwrap();
    assert_eq!(tags, ["priority:p2", "project:compilers", "stage:idea"]);
    let laid = w.hub.arrange(&board.id).unwrap();
    let compilers = laid.rows.iter().find(|r| r.value.as_deref() == Some("compilers")).unwrap();
    assert_eq!(compilers.cells[0], vec![first.clone()]);

    // Rearranging is replacing the settings, whoever does it.
    let mut rearranged = board.clone();
    rearranged.name = "Priorities".into();
    rearranged.columns = "priority".into();
    rearranged.rows = String::new();
    rearranged.selected = words(&["stage:building"]);
    let saved = w.hub.update_board(&board.id, rearranged).unwrap();
    assert_eq!(saved.created_at, board.created_at);
    let laid = w.hub.arrange(&board.id).unwrap();
    assert_eq!((laid.shown, laid.total), (1, 2));
    assert_eq!(column(&laid, "p1"), vec![second.clone()]);

    w.hub.delete_board(&board.id).unwrap();
    assert!(w.hub.arrange(&board.id).is_err());
}

#[tokio::test]
async fn a_thread_can_tag_its_own_session() {
    let w = world(Mode::Auto, false).await;
    w.hub.accept(signal("100.0", "100.0", "an idea")).await.unwrap();
    assert!(settle(|| !w.hub.store.agents(10).unwrap().is_empty()).await);
    let agent = w.hub.store.agents(10).unwrap()[0].id.clone();

    w.hub.accept(signal("100.0", "101.0", "tag stage:idea priority:p2")).await.unwrap();
    assert!(settle(|| w.hub.store.tags(&agent).unwrap().len() == 2).await);
    w.hub.accept(signal("100.0", "102.0", "untag priority")).await.unwrap();
    assert!(settle(|| w.hub.store.tags(&agent).unwrap() == ["stage:idea"]).await);
    assert!(w
        .posts
        .lock()
        .unwrap()
        .replies
        .iter()
        .any(|(_, text)| text == "Tagged: stage:idea"));
}

#[tokio::test]
async fn every_turn_tells_the_agent_how_to_tag_itself() {
    let w = world(Mode::Auto, false).await;
    w.hub.accept(signal("100.0", "100.0", "do the thing")).await.unwrap();
    assert!(settle(|| w.calls.lock().unwrap().started.len() == 1).await);
    let agent = w.hub.store.agents(10).unwrap()[0].id.clone();
    let started = w.calls.lock().unwrap().started.clone();
    let told = started[0]
        .1
        .iter()
        .filter_map(TurnInput::as_text)
        .find(|text| text.contains("/api/agents/"))
        .expect("no tagging instruction")
        .to_string();
    assert!(told.contains(&format!("/api/agents/{agent}/tags")), "{told}");
    assert!(told.contains("/api/boards"));
}

#[tokio::test]
async fn a_question_the_interface_asks_does_not_look_like_one_you_asked() {
    let w = world(Mode::Auto, false).await;
    w.hub.accept(signal("100.0", "100.0", "the original")).await.unwrap();
    assert!(settle(|| w.calls.lock().unwrap().started.len() == 1).await);
    let agent = w.hub.store.agents(10).unwrap()[0].id.clone();
    let before = w.hub.timeline(&agent, usize::MAX).unwrap().len();

    w.hub
        .ask_quietly(&agent, "Draw the architecture, at length", "Asked for a diagram")
        .await
        .unwrap();
    assert!(settle(|| w.calls.lock().unwrap().started.len() == 2).await);

    // The agent was asked in full.
    let started = w.calls.lock().unwrap().started.clone();
    let texts: Vec<&str> = started[1].1.iter().filter_map(TurnInput::as_text).collect();
    assert_eq!(texts[0], "Draw the architecture, at length");

    // The conversation says one was asked, not what the form said.
    let added: Vec<Entry> =
        w.hub.timeline(&agent, usize::MAX).unwrap().into_iter().skip(before).collect();
    let asked: Vec<&Entry> = added.iter().filter(|entry| entry.kind == EntryKind::Notice).collect();
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0].text, "Asked for a diagram");
    assert!(!added.iter().any(|entry| entry.kind == EntryKind::You));
    assert!(!added.iter().any(|entry| entry.text.contains("at length")));
}

#[tokio::test]
async fn work_given_to_an_idle_agent_sets_it_going() {
    let w = world(Mode::Auto, false).await;
    w.hub.accept(signal("100.0", "100.0", "the original")).await.unwrap();
    assert!(settle(|| w.hub.store.agents(10).unwrap()[0].status == AgentStatus::Complete).await);
    let agent = w.hub.store.agents(10).unwrap()[0].id.clone();
    let turns = w.calls.lock().unwrap().started.len();

    w.hub.create_task("paint the shed", &agent, vec![]).await.unwrap();
    // It is told about the work, and then carries on with it, so what
    // matters is that the first turn it takes is about the task.
    assert!(settle(|| w.calls.lock().unwrap().started.len() > turns).await);
    let started = w.calls.lock().unwrap().started.clone();
    let texts: Vec<&str> = started[turns].1.iter().filter_map(TurnInput::as_text).collect();
    assert!(texts[0].contains("paint the shed"));
}

#[tokio::test]
async fn work_given_to_a_busy_agent_waits_for_the_turn_it_is_in() {
    let w = build(
        Mode::Auto,
        Harnessed { delay: Duration::from_millis(400), ..Harnessed::default() },
    )
    .await;
    w.hub.accept(signal("100.0", "100.0", "the original")).await.unwrap();
    assert!(settle(|| w.calls.lock().unwrap().started.len() == 1).await);
    let agent = w.hub.store.agents(10).unwrap()[0].id.clone();

    // Mid-turn: nothing is said now, because the turn that is running is
    // handed whatever is open when it ends.
    w.hub.create_task("paint the shed", &agent, vec![]).await.unwrap();
    assert_eq!(w.calls.lock().unwrap().started.len(), 1);
    assert!(settle(|| w.calls.lock().unwrap().started.len() == 2).await);
    let started = w.calls.lock().unwrap().started.clone();
    let texts: Vec<&str> = started[1].1.iter().filter_map(TurnInput::as_text).collect();
    assert!(texts[0].contains("still has open work"));
}

#[tokio::test]
async fn a_task_nobody_has_starts_nothing() {
    let w = world(Mode::Auto, false).await;
    w.hub.accept(signal("100.0", "100.0", "the original")).await.unwrap();
    assert!(settle(|| w.hub.store.agents(10).unwrap()[0].status == AgentStatus::Complete).await);
    let turns = w.calls.lock().unwrap().started.len();

    w.hub.create_task("paint the shed", "", vec![]).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(w.calls.lock().unwrap().started.len(), turns);
}

#[tokio::test]
async fn an_agent_that_stopped_without_finishing_is_handed_its_work_again() {
    let w = world(Mode::Auto, false).await;
    w.hub.accept(signal("100.0", "100.0", "the original")).await.unwrap();
    assert!(settle(|| w.hub.store.agents(10).unwrap()[0].status == AgentStatus::Complete).await);
    let agent = w.hub.store.agents(10).unwrap()[0].id.clone();

    // Work it was given while something else was running, so no turn ended
    // with it open and nothing has offered it since.
    w.hub
        .store
        .save_task(&TaskItem {
            id: "task_left".into(),
            text: "paint the shed".into(),
            status: TaskStatus::Incomplete,
            blocked_by_task_id: String::new(),
            agent_id: agent.clone(),
            position: 0.0,
            images: vec![],
            created_at: now(),
            updated_at: now(),
        })
        .unwrap();
    // And it is stalled, as a restart or an interrupt leaves it.
    w.hub.store.stall_agent(&agent, "oxroute restarted", now()).unwrap();
    let turns = w.calls.lock().unwrap().started.len();

    w.hub.hand_out_open_work().await;
    assert!(settle(|| w.calls.lock().unwrap().started.len() > turns).await);
    let started = w.calls.lock().unwrap().started.clone();
    let texts: Vec<&str> = started[turns].1.iter().filter_map(TurnInput::as_text).collect();
    assert!(texts[0].contains("paint the shed"));
}

#[tokio::test]
async fn an_agent_is_not_pestered_about_a_list_that_has_not_moved() {
    let w = world(Mode::Auto, false).await;
    w.hub.accept(signal("100.0", "100.0", "the original")).await.unwrap();
    assert!(settle(|| w.hub.store.agents(10).unwrap()[0].status == AgentStatus::Complete).await);
    let agent = w.hub.store.agents(10).unwrap()[0].id.clone();
    w.hub.create_task("paint the shed", &agent, vec![]).await.unwrap();
    // Let it be told, and let the chain that follows run itself out.
    let mut settled = 0;
    while settled != w.calls.lock().unwrap().started.len() {
        settled = w.calls.lock().unwrap().started.len();
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    // The fake never touches its task, so every later look finds the same
    // list and says nothing.
    for _ in 0..3 {
        w.hub.hand_out_open_work().await;
        tokio::time::sleep(Duration::from_millis(120)).await;
    }
    assert_eq!(w.calls.lock().unwrap().started.len(), settled);
}

#[tokio::test]
async fn machinery_handing_over_work_leaves_no_line_behind() {
    let w = world(Mode::Auto, false).await;
    w.hub.accept(signal("100.0", "100.0", "the original")).await.unwrap();
    assert!(settle(|| w.hub.store.agents(10).unwrap()[0].status == AgentStatus::Complete).await);
    let agent = w.hub.store.agents(10).unwrap()[0].id.clone();
    let before = w.hub.timeline(&agent, usize::MAX).unwrap().len();

    // No line asked for, none written: being given work is not something
    // anybody said.
    w.hub.ask_quietly(&agent, "carry on with this", "").await.unwrap();
    assert!(settle(|| w.calls.lock().unwrap().started.len() > 1).await);
    let added: Vec<Entry> =
        w.hub.timeline(&agent, usize::MAX).unwrap().into_iter().skip(before).collect();
    assert!(!added.iter().any(|entry| entry.kind == EntryKind::Notice));
}

#[tokio::test]
async fn stopping_waits_for_a_turn_and_gives_up_on_one_that_never_ends() {
    // Nothing running: there is nothing to wait for.
    let quiet = world(Mode::Auto, false).await;
    assert_eq!(quiet.hub.wait_for_turns(Duration::from_millis(500)).await, 0);

    // A turn that never finishes is waited on, and then left.
    let w = world(Mode::Auto, true).await;
    w.hub.accept(signal("100.0", "100.0", "the original")).await.unwrap();
    assert!(settle(|| w.calls.lock().unwrap().started.len() == 1).await);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(w.hub.turns_in_flight().await, 1);
    let waited = std::time::Instant::now();
    assert_eq!(w.hub.wait_for_turns(Duration::from_millis(600)).await, 1);
    assert!(waited.elapsed() >= Duration::from_millis(600));
}

#[tokio::test]
async fn an_agent_says_done_and_a_person_says_complete() {
    let w = world(Mode::Auto, false).await;
    let task = w.hub.create_task("paint the shed", "", vec![]).await.unwrap();

    // What an agent can do when it has finished.
    let done = w
        .hub
        .update_task(&task.id, &task.text, TaskStatus::Done, "", "", Some("painted in a1b2c3d"), false)
        .unwrap();
    assert_eq!(done.status, TaskStatus::Done);

    // And what it cannot: deciding that the work was any good.
    assert!(w
        .hub
        .update_task(&task.id, &task.text, TaskStatus::Complete, "", "", Some("looks fine to me"), false)
        .is_err());
    assert_eq!(w.hub.tasks().unwrap()[0].status, TaskStatus::Done);

    // A person looking at it can.
    let approved = w
        .hub
        .update_task(&task.id, &task.text, TaskStatus::Complete, "", "", Some("approved"), true)
        .unwrap();
    assert_eq!(approved.status, TaskStatus::Complete);
}

#[tokio::test]
async fn saying_no_to_finished_work_sends_the_reason_and_reopens_it() {
    let w = world(Mode::Auto, false).await;
    w.hub.accept(signal("100.0", "100.0", "the original")).await.unwrap();
    assert!(settle(|| w.hub.store.agents(10).unwrap()[0].status == AgentStatus::Complete).await);
    let agent = w.hub.store.agents(10).unwrap()[0].id.clone();
    let task = w.hub.create_task("paint the shed", &agent, vec![]).await.unwrap();
    w.hub
        .update_task(&task.id, &task.text, TaskStatus::Done, "", &agent, Some("painted it"), false)
        .unwrap();
    let turns = w.calls.lock().unwrap().started.len();

    // Saying what is wrong is saying something, so it can carry a picture
    // of what is wrong with it.
    let shown = w.hub.config.attachments.join("trim.png");
    std::fs::create_dir_all(&w.hub.config.attachments).unwrap();
    std::fs::write(&shown, b"png").unwrap();
    let back = w
        .hub
        .correct_task(
            &task.id,
            "the trim is still bare",
            vec![shown.to_string_lossy().to_string()],
        )
        .await
        .unwrap();

    // It is work again, the agent was told why, and the reason is kept.
    assert_eq!(back.status, TaskStatus::Incomplete);
    // The correction reaches it; whether the carry-on loop also has
    // something to say is not this test's business.
    assert!(
        settle(|| {
            w.calls.lock().unwrap().started[turns..].iter().any(|(_, inputs)| {
                inputs
                    .iter()
                    .filter_map(TurnInput::as_text)
                    .any(|text| text.contains("the trim is still bare") && text.contains("paint the shed"))
            })
        })
        .await,
        "the agent was never told what was wrong",
    );
    assert!(
        w.calls.lock().unwrap().started[turns..].iter().any(|(_, inputs)| inputs
            .iter()
            .any(|input| matches!(input, TurnInput::LocalImage { path } if path.ends_with("trim.png")))),
        "the picture never went with it",
    );
    assert!(w
        .hub
        .task_notes()
        .unwrap()
        .iter()
        .any(|note| note.text == "the trim is still bare"));
}

#[tokio::test]
async fn an_answer_is_written_down_once_even_with_an_attachment_after_it() {
    // Claude Code streams an answer and then repeats it in the frame that
    // closes the turn; anything recorded in between must not hide that.
    let w = build(
        Mode::Auto,
        Harnessed { source: false, narrates: true, leave_artifacts: true, ..Harnessed::default() },
    )
    .await;
    w.hub.accept(signal("100.0", "100.0", "draw me something")).await.unwrap();
    assert!(settle(|| w.hub.store.agents(10).unwrap()[0].status == AgentStatus::Complete).await);
    let agent = w.hub.store.agents(10).unwrap()[0].id.clone();

    let said = w
        .hub
        .timeline(&agent, 50)
        .unwrap()
        .into_iter()
        .filter(|entry| entry.kind == EntryKind::Said && entry.text == "done")
        .count();
    assert_eq!(said, 1, "the same answer was written down twice");
}

#[tokio::test]
async fn a_picture_an_agent_made_reaches_a_surface_with_no_source() {
    // No Slack, no thread: the web UI is the only place it could show up.
    let w = build(
        Mode::Auto,
        Harnessed { source: false, leave_artifacts: true, ..Harnessed::default() },
    )
    .await;
    w.hub.accept(signal("100.0", "100.0", "draw me something")).await.unwrap();
    assert!(settle(|| w.hub.store.agents(10).unwrap()[0].status == AgentStatus::Complete).await);
    let agent = w.hub.store.agents(10).unwrap()[0].id.clone();

    let attached = w
        .hub
        .timeline(&agent, usize::MAX)
        .unwrap()
        .into_iter()
        .find(|entry| entry.text.starts_with("Attached: "))
        .expect("the picture was never mentioned in the timeline");
    let name = attached.text.trim_start_matches("Attached: ").to_string();

    // And the file is where the attachments route serves from.
    assert!(w.hub.config.attachments.join(&name).exists(), "{name} was not kept");
}
