//! End-to-end tests for the hub, against a fake harness and a fake source.
//!
//! These are the tests that matter. The hub is the only place where a signal,
//! a binding and a turn meet, and nearly every behaviour worth keeping is a
//! property of how those three interact rather than of any one of them.

use std::collections::BTreeMap;
use std::path::PathBuf;
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
}

impl FakeHarness {
    fn new(calls: Arc<Mutex<Calls>>, hang: bool) -> Self {
        FakeHarness {
            events: broadcast::channel(256).0,
            calls,
            sessions: Mutex::new(0),
            hang,
            leave_artifacts: false,
            can_steer: true,
            delay: Duration::ZERO,
            backend: Backend::Codex,
            recovery: Mutex::new(None),
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
            tokio::spawn(async move {
                if !delay.is_zero() {
                    tokio::time::sleep(delay).await;
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
}

impl World {
    /// Report a piece of tool activity on the agent's live session.
    async fn harness_item(&self, agent_id: &str, item: Value) {
        let session = self.hub.store.agent(agent_id).unwrap().unwrap().session_id;
        let _ = self.harness.send(HarnessEvent::Item { session, item });
    }
}

/// How the fake harness should behave for one test.
#[derive(Clone, Copy)]
struct Harnessed {
    hang: bool,
    leave_artifacts: bool,
    can_steer: bool,
    delay: Duration,
    backend: Backend,
}

impl Default for Harnessed {
    fn default() -> Self {
        Harnessed {
            hang: false,
            leave_artifacts: false,
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
            Backend::Codex => "gpt-5.6-sol".into(),
            Backend::ClaudeCode => "claude-opus-5".into(),
        },
        models: BTreeMap::from([
            ("sol".to_string(), choice("gpt-5.6-sol", "Sol")),
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
    };

    let harness = FakeHarness {
        leave_artifacts: options.leave_artifacts,
        can_steer: options.can_steer,
        delay: options.delay,
        backend: options.backend,
        ..FakeHarness::new(calls.clone(), options.hang)
    };
    let harness_events = harness.events.clone();

    let mut hub = Hub::new(config, Store::in_memory().unwrap());
    hub.with_harness(Arc::new(harness));
    hub.with_source(Arc::new(FakeSource {
        posts: posts.clone(),
        next_thread: Mutex::new(0),
    }));
    hub.start().await.unwrap();
    hub.set_mode(mode).unwrap();

    World {
        hub,
        calls,
        posts,
        harness: harness_events,
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
async fn a_codex_turn_is_reattached_after_the_daemon_restarts() {
    let base = world(Mode::Auto, false).await;
    let config = base.hub.config.clone();
    let store = Store::in_memory().unwrap();
    let agent = Agent {
        id: "agent-recovered".into(),
        name: "long task".into(),
        backend: Backend::Codex,
        model: "gpt-5.6-sol".into(),
        session_id: "session-live".into(),
        cwd: config.workspace.clone(),
        status: AgentStatus::Working,
        activity: "working".into(),
        permalink: String::new(),
        last_activity: now(),
        updated_at: now(),
        stall_reason: None,
        stall_alerted: false,
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
    assert!(timeline.iter().any(|e| e.kind == EntryKind::You));
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
