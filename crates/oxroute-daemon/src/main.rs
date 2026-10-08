//! The oxroute daemon.
//!
//! It runs the hub and puts an HTTP + SSE API in front of it. The web UI and
//! the TUI are both clients of this API and nothing else, which is what keeps
//! them honestly equivalent: a surface cannot grow a private capability
//! without adding an endpoint everything else can also call.
//!
//! ```text
//! oxrouted             run the daemon
//! oxrouted migrate     import the Slack bot's state, then exit
//! oxrouted doctor      say what is configured and what is missing
//! ```

use std::collections::HashMap;
mod git;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Multipart, Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::stream::Stream;
use serde::Deserialize;
use serde_json::json;
use tokio::sync::broadcast;

use oxroute_core::config::Mode;
use oxroute_core::hub::Routing;
use oxroute_core::source::slack::SlackSource;
use oxroute_core::{Config, Hub, Store};

mod diagram;

const INBOX_LIMIT: usize = 200;
const TIMELINE_LIMIT: usize = 500;
const SEARCH_LIMIT: usize = 200;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("OXROUTE_LOG")
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    match std::env::args().nth(1).as_deref() {
        Some("migrate") => migrate(),
        Some("doctor") => doctor(),
        Some("--help" | "-h" | "help") => {
            println!("{}", HELP);
            Ok(())
        }
        Some(other) => {
            eprintln!("unknown command {other}\n\n{HELP}");
            std::process::exit(2);
        }
        None => serve().await,
    }
}

const HELP: &str = "\
oxrouted -- the oxroute daemon

  oxrouted             run the daemon
  oxrouted migrate     import the Slack bot's state, then exit
  oxrouted doctor      say what is configured and what is missing

Configuration is environment variables; see deploy/oxroute.env.example.";

fn migrate() -> Result<()> {
    let config = Config::from_env()?;
    let store = Store::open(&config.database)?;
    let legacy = oxroute_core::migrate::legacy_database()
        .context("found no codex-slack database to import (set CODEX_SLACK_DATABASE)")?;
    let force = std::env::args().any(|a| a == "--force");
    let report = oxroute_core::migrate::import(&store, &legacy, &config.workspace, force)?;
    println!("imported from {}: {report}", legacy.display());
    Ok(())
}

fn doctor() -> Result<()> {
    let config = Config::from_env()?;
    // A bare name is resolved the way the OS will resolve it, so `doctor`
    // does not report a perfectly good PATH install as missing.
    let resolve = |name: &str| -> Option<std::path::PathBuf> {
        let direct = std::path::Path::new(name);
        if direct.is_absolute() {
            return direct.exists().then(|| direct.to_path_buf());
        }
        std::env::var_os("PATH").and_then(|path| {
            std::env::split_paths(&path)
                .map(|dir| dir.join(name))
                .find(|candidate| candidate.is_file())
        })
    };
    let report = |name: &str| match resolve(name) {
        Some(found) => format!("{name} ({})", found.display()),
        None => format!("{name} (MISSING)"),
    };
    println!(
        "config          {}",
        match &config.source {
            Some(path) => path.display().to_string(),
            None => format!(
                "none at {} (using defaults and the environment)",
                oxroute_core::Config::default_path().display()
            ),
        }
    );
    println!("workspace       {}", config.workspace_path().display());
    println!("database        {}", config.database.display());
    println!("codex           {}", report(&config.codex_binary));
    println!("codex server    {}", config.codex_url);
    println!("claude          {}", report(&config.claude_binary));
    println!("owner           {}", config.owner);
    println!("listen          {}", config.listen);
    println!(
        "slack           {}",
        match (&config.slack_app_token, &config.slack_bot_token) {
            (Some(_), Some(_)) => "app + bot token set",
            (None, None) => "not configured (daemon runs without it)",
            _ => "INCOMPLETE: needs both an app token and a bot token",
        }
    );
    println!("default model   {}  [{}]", config.default_model, config.default_backend);
    println!(
        "models          {}",
        config
            .models
            .iter()
            .map(|(alias, c)| format!("{alias}={} [{}]", c.id, c.backend))
            .collect::<Vec<_>>()
            .join(", ")
    );
    println!(
        "diagram         {} (in each agent's directory: {})",
        config.diagram_path,
        config.diagram_for("").display()
    );
    match oxroute_core::migrate::legacy_database() {
        Some(path) => println!("codex-slack     {} (run `oxrouted migrate`)", path.display()),
        None => println!("codex-slack     nothing to import"),
    }
    Ok(())
}

/// Whatever a supervisor uses to say stop. `dev.sh` sends a plain `kill`,
/// which is SIGTERM, so listening only for ctrl-c meant every reload killed
/// the daemon where it stood.
async fn stop_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = match signal(SignalKind::terminate()) {
            Ok(term) => term,
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
                return;
            }
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}

async fn serve() -> Result<()> {
    let config = Config::from_env()?;
    let store = Store::open(&config.database)
        .with_context(|| format!("opening {}", config.database.display()))?;

    // A migration nobody remembered to run is worse than one that runs
    // itself: the Slack threads simply stop resuming their sessions.
    if let Some(legacy) = oxroute_core::migrate::legacy_database() {
        match oxroute_core::migrate::import(&store, &legacy, &config.workspace, false) {
            Ok(report) if !report.skipped => {
                tracing::info!(from = %legacy.display(), "imported codex-slack state: {report}");
            }
            Ok(_) => {}
            Err(error) => tracing::warn!(%error, "could not import codex-slack state"),
        }
    }

    let listen = config.listen.clone();
    let slack = match (config.slack_app_token.clone(), config.slack_bot_token.clone()) {
        (Some(app), Some(bot)) => Some(Arc::new(SlackSource::new(app, bot, &config.owner))),
        _ => {
            tracing::warn!("slack is not configured; running with no sources");
            None
        }
    };

    let mut hub = Hub::new(config, store);
    if let Some(slack) = slack {
        hub.with_source(slack);
    }
    hub.start().await?;

    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/state", get(state))
        .route("/api/events", get(events))
        .route("/api/agents/{id}", get(agent))
        .route("/api/search", get(search))
        .route("/api/search/native", get(search_native))
        .route("/api/continue", post(continue_session))
        .route("/api/native-preview", get(native_preview))
        .route("/api/signal", post(ingest))
        .route("/api/route", post(route))
        .route("/api/say", post(say))
        .route("/api/agents/{id}/reviews", post(create_review))
        .route("/api/agents/{id}/reviews/{review}", get(get_review))
        .route("/api/agents/{id}/reviews/{review}/approve", post(approve_review))
        .route("/api/say-attachments", post(say_attachments))
        .route("/api/interrupt", post(interrupt))
        .route("/api/fork", post(fork))
        .route("/api/fork-in-chat", post(fork_in_chat))
        .route("/api/merge", post(merge))
        .route("/api/rename", post(rename))
        .route("/api/archive", post(archive))
        .route("/api/pin", post(pin))
        .route("/api/react", post(react))
        .route("/api/tasks", get(tasks).post(create_task))
        .route("/api/tasks/{id}", axum::routing::put(update_task).delete(delete_task))
        .route("/api/tasks/{id}/hand-off", post(hand_off_task))
        .route("/api/task-notes", get(task_notes))
        .route("/api/tasks/{id}/notes", post(add_task_note))
        .route("/api/tasks/{id}/move", post(move_task))
        .route("/api/tasks/{id}/correction", post(correct_task))
        .route("/api/task-attachments", post(create_task_with_attachments))
        .route("/api/task-diagram.svg", get(task_diagram))
        .route("/api/mode", post(mode))
        .route("/api/agents/{id}/tags", get(tags).post(change_tags))
        .route("/api/agents/{id}/model", post(change_model))
        .route("/api/boards", get(boards).post(create_board))
        .route(
            "/api/boards/{id}",
            get(arrange).put(update_board).delete(delete_board),
        )
        .route("/api/boards/{id}/move", post(move_card))
        .route("/api/agents/{id}/diagram", get(diagram_view))
        .route("/api/agents/{id}/diagram/preview", post(diagram_preview))
        .route("/api/agents/{id}/diagram/send", post(diagram_send))
        .route("/api/agents/{id}/diagram/create", post(diagram_create))
        .route("/api/diagram/render", post(diagram_render))
        .route("/api/attachments/{name}", get(attachment))
        // The web UI is served by Next on its own port in development and
        // proxied in production, so anything on this host may call in.
        .layer(DefaultBodyLimit::max(25 * 1024 * 1024))
        .layer(tower_http::cors::CorsLayer::permissive())
        .with_state(hub.clone());

    let listener = tokio::net::TcpListener::bind(&listen)
        .await
        .with_context(|| format!("binding {listen}"))?;
    tracing::info!("oxroute listening on http://{listen}");
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            stop_signal().await;
            // A turn cannot be picked up again once this process is gone:
            // the harness dies with it, the work it did stands, and the
            // answer it was about to give is never recorded. So a restart
            // waits for what is running -- which is what makes rebuilding
            // during a turn survivable.
            let running = hub.turns_in_flight().await;
            if running > 0 {
                tracing::info!("waiting for {running} turn(s) to finish before stopping");
            }
            let abandoned = hub.wait_for_turns(Duration::from_secs(180)).await;
            if abandoned > 0 {
                tracing::warn!("stopping with {abandoned} turn(s) still running");
            }
            tracing::info!("shutting down");
            // Open event streams would otherwise hold the door: the turns
            // are done and every write is already committed.
            std::process::exit(0);
        })
        .await?;
    Ok(())
}

type Hubs = State<Arc<Hub>>;

/// Anything that goes wrong becomes a message a surface can show, rather than
/// a bare status a person has to guess at.
struct Failed(anyhow::Error);

impl IntoResponse for Failed {
    fn into_response(self) -> axum::response::Response {
        tracing::warn!(error = ?self.0, "request failed");
        // The whole chain, not the outermost sentence: "reading
        // docs/architecture.mmd" is not a reason, and it is what the person
        // staring at the screen would otherwise be given.
        (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("{:#}", self.0) })),
        )
            .into_response()
    }
}

impl<E: Into<anyhow::Error>> From<E> for Failed {
    fn from(error: E) -> Self {
        Failed(error.into())
    }
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") }))
}

async fn state(State(hub): Hubs) -> Result<Json<oxroute_core::Snapshot>, Failed> {
    Ok(Json(hub.snapshot(INBOX_LIMIT)?))
}

async fn agent(
    State(hub): Hubs,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, Failed> {
    let agent = hub
        .store
        .agent(&id)?
        .context("no such agent")
        .map_err(Failed)?;
    Ok(Json(json!({
        "agent": agent,
        "timeline": hub.timeline(&id, TIMELINE_LIMIT)?,
        "delivery": agent.delivery(),
    })))
}

#[derive(Deserialize)]
struct SearchQuery {
    #[serde(default)]
    q: String,
}

async fn search(
    State(hub): Hubs,
    Query(query): Query<SearchQuery>,
) -> Result<Json<Vec<oxroute_core::SearchGroup>>, Failed> {
    Ok(Json(hub.search(&query.q, SEARCH_LIMIT)?))
}

/// The harnesses' own sessions, asked for separately so the list you are
/// reading appears while they are still being looked for.
async fn search_native(
    State(hub): Hubs,
    Query(query): Query<SearchQuery>,
) -> Result<Json<Vec<oxroute_core::NativeSession>>, Failed> {
    Ok(Json(hub.search_native(&query.q, SEARCH_LIMIT).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContinueBody {
    backend: oxroute_core::Backend,
    session_id: String,
}

async fn continue_session(
    State(hub): Hubs,
    Json(body): Json<ContinueBody>,
) -> Result<Json<oxroute_core::Agent>, Failed> {
    Ok(Json(hub.continue_session(body.backend, &body.session_id).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativePreviewQuery {
    backend: oxroute_core::Backend,
    session_id: String,
}

async fn native_preview(
    State(hub): Hubs,
    Query(query): Query<NativePreviewQuery>,
) -> Result<Json<Vec<oxroute_core::ConversationLine>>, Failed> {
    Ok(Json(hub.native_preview(query.backend, &query.session_id, 16).await?))
}

/// Everything the hub emits, as it happens.
///
/// A client that falls behind is told to resync rather than being fed a
/// backlog it cannot use: the snapshot is cheap and always correct.
async fn events(State(hub): Hubs) -> Sse<impl Stream<Item = Result<SseEvent, std::convert::Infallible>>> {
    let stream = async_stream::stream! {
        let mut events = hub.subscribe();
        yield Ok(SseEvent::default().json_data(json!({ "type": "sync" })).unwrap());
        loop {
            match events.recv().await {
                Ok(event) => {
                    if let Ok(frame) = SseEvent::default().json_data(&event) {
                        yield Ok(frame);
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    yield Ok(SseEvent::default().json_data(json!({ "type": "sync" })).unwrap());
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    };
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}

/// A signal pushed in over HTTP.
///
/// This is the seam a webhook source would sit behind, and until one exists
/// it is how you drive oxroute without Slack -- for a local run, for a smoke
/// test on the VM, or for anything that can manage a POST.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignalBody {
    text: String,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    conversation: Option<String>,
    /// Replies that share a thread key reach the same agent, exactly as a
    /// Slack thread does.
    #[serde(default)]
    thread_key: Option<String>,
    #[serde(default)]
    label: Option<String>,
}

async fn ingest(
    State(hub): Hubs,
    Json(body): Json<SignalBody>,
) -> Result<Json<serde_json::Value>, Failed> {
    if body.text.trim().is_empty() {
        return Err(Failed(anyhow::anyhow!("a signal needs some text")));
    }
    let external_id = oxroute_core::model::new_id("msg");
    let thread_key = body.thread_key.unwrap_or_else(|| external_id.clone());
    let signal = oxroute_core::Signal {
        id: oxroute_core::model::new_id("sig"),
        source: body.source.unwrap_or_else(|| "webhook".into()),
        conversation: body.conversation.unwrap_or_else(|| "default".into()),
        root: thread_key == external_id,
        thread_key,
        external_id,
        author: hub.config.owner.clone(),
        label: body.label.unwrap_or_default(),
        text: body.text,
        attachments: vec![],
        at: oxroute_core::model::now(),
    };
    let id = signal.id.clone();
    hub.accept(signal).await?;
    Ok(Json(json!({ "signal": id })))
}

#[derive(Deserialize)]
struct RouteBody {
    signal: String,
    #[serde(flatten)]
    routing: Routing,
}

async fn route(
    State(hub): Hubs,
    Json(body): Json<RouteBody>,
) -> Result<Json<oxroute_core::Snapshot>, Failed> {
    hub.route(&body.signal, body.routing).await?;
    Ok(Json(hub.snapshot(INBOX_LIMIT)?))
}

#[derive(Deserialize)]
struct SayBody {
    agent: String,
    text: String,
    /// Wait for the running turn rather than stopping it.
    #[serde(default)]
    queued: bool,
}

#[derive(Deserialize)]
struct ReviewBody { repository: String, base: String, remote: String, title: String, description: String }

#[derive(Clone, serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangeReview {
    id: String,
    agent_id: String,
    title: String,
    description: String,
    snapshot: git::Snapshot,
    approved_at: Option<f64>,
}

fn review_record(hub: &Hub, agent_id: &str, id: &str) -> anyhow::Result<(ChangeReview, String)> {
    let data = hub.store.get(&format!("review:{id}"))?.context("no such review")?;
    let review: ChangeReview = serde_json::from_str(&data)?;
    anyhow::ensure!(review.agent_id == agent_id, "Review belongs to another session");
    Ok((review, data))
}

async fn review_response(review: ChangeReview) -> anyhow::Result<serde_json::Value> {
    let files = git::files(&review.snapshot).await?;
    let status = if !git::current(&review.snapshot).await.unwrap_or(false) { "stale" }
        else if review.approved_at.is_some() { "approved" } else { "pending" };
    let mut response = serde_json::to_value(review).expect("review is serializable");
    response["status"] = json!(status);
    response["snapshot"]["files"] = serde_json::to_value(files)?;
    Ok(response)
}

async fn create_review(State(hub): Hubs, Path(agent_id): Path<String>, Json(body): Json<ReviewBody>) -> Result<Json<serde_json::Value>, Failed> {
    hub.store.agent(&agent_id)?.context("no such agent")?;
    if body.title.trim().is_empty() || body.title.len() > 300 || body.description.len() > 32_000 {
        return Err(anyhow::anyhow!("Provide a concise PR title and description").into());
    }
    let snapshot = git::capture(std::path::Path::new(&hub.config.workspace), &body.repository, &body.base, &body.remote).await?;
    let review = ChangeReview { id: oxroute_core::model::new_id("review"), agent_id, title: body.title, description: body.description, snapshot, approved_at: None };
    let entry = hub.store.add_review(&review.agent_id, &review.id, &review.title, &serde_json::to_string(&review)?)?;
    hub.emit(oxroute_core::model::Event::Timeline { entry: Box::new(entry) });
    Ok(Json(review_response(review).await?))
}

async fn get_review(State(hub): Hubs, Path((agent_id, id)): Path<(String, String)>) -> Result<Json<serde_json::Value>, Failed> {
    Ok(Json(review_response(review_record(&hub, &agent_id, &id)?.0).await?))
}

async fn approve_review(State(hub): Hubs, Path((agent_id, id)): Path<(String, String)>) -> Result<Json<serde_json::Value>, Failed> {
    let (mut review, before) = review_record(&hub, &agent_id, &id)?;
    if !git::current(&review.snapshot).await? {
        return Err(anyhow::anyhow!("This revision changed. Ask the agent to present a new review before publishing.").into());
    }
    if review.approved_at.is_none() {
        review.approved_at = Some(oxroute_core::model::now());
        let after = serde_json::to_string(&review)?;
        let key = format!("review:{id}");
        if hub.store.replace_value(&key, &before, &after)? {
            let snapshot = &review.snapshot;
            let authorization = format!("I approve local review {id}: {}. You may publish commit {} from {} to remote {} ({}) as branch {}, against base {} at {}. Recheck this review's status immediately before pushing, and use the review's stored title and description for the PR. No merge or deployment is authorized.",
                review.title, snapshot.head_commit, snapshot.repository, snapshot.remote, snapshot.remote_url, snapshot.branch, snapshot.base_ref, snapshot.base_commit);
            let detail = format!("review-approval:{}", json!({
                "id": id, "title": review.title, "commit": snapshot.head_commit,
                "branch": snapshot.branch, "base": snapshot.base_ref,
            }));
            if let Err(error) = hub.say_to_annotated(&agent_id, &authorization, vec![], true, &detail).await {
                hub.store.replace_value(&key, &after, &before)?;
                return Err(error.into());
            }
        }
    }
    Ok(Json(review_response(review_record(&hub, &agent_id, &id)?.0).await?))
}

async fn say(State(hub): Hubs, Json(body): Json<SayBody>) -> Result<Json<serde_json::Value>, Failed> {
    if body.text.trim().is_empty() {
        return Err(Failed(anyhow::anyhow!("nothing to say")));
    }
    hub.say_to_with_attachments(&body.agent, &body.text, vec![], body.queued).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn say_attachments(
    State(hub): Hubs,
    mut form: Multipart,
) -> Result<Json<serde_json::Value>, Failed> {
    let mut agent = String::new();
    let mut text = String::new();
    let mut queued = false;
    let mut images = Vec::new();
    while let Some(field) = form.next_field().await? {
        match field.name() {
            Some("agent") => agent = field.text().await?,
            Some("text") => text = field.text().await?,
            Some("queued") => queued = field.text().await? == "true",
            Some("files") => images.push(keep_file(&hub.config.attachments, field).await?),
            _ => {}
        }
    }
    if agent.is_empty() {
        return Err(Failed(anyhow::anyhow!("an agent is required")));
    }
    hub.say_to_with_attachments(&agent, &text, images, queued).await?;
    Ok(Json(json!({ "ok": true })))
}

/// Stage an uploaded file without interpreting its contents.
///
/// The name it is stored under is ours, not the browser's, so a file cannot
/// name a place outside that directory or overwrite another upload.
async fn keep_file(directory: &std::path::Path, field: axum::extract::multipart::Field<'_>) -> Result<String> {
    let given = std::path::Path::new(field.file_name().unwrap_or("file"))
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("file");
    let name = format!("{}-{given}", oxroute_core::model::new_id("web"));
    let path = directory.join(&name);
    tokio::fs::write(&path, field.bytes().await?).await?;
    Ok(path.to_string_lossy().to_string())
}

#[derive(Deserialize)]
struct AgentBody {
    agent: String,
}

async fn interrupt(
    State(hub): Hubs,
    Json(body): Json<AgentBody>,
) -> Result<Json<serde_json::Value>, Failed> {
    let stopped = hub.interrupt(&body.agent).await?;
    Ok(Json(json!({ "stopped": stopped })))
}

async fn fork(
    State(hub): Hubs,
    Json(body): Json<AgentBody>,
) -> Result<Json<serde_json::Value>, Failed> {
    let forked = hub.fork(&body.agent).await?;
    Ok(Json(json!({ "agent": forked })))
}

async fn fork_in_chat(
    State(hub): Hubs,
    Json(body): Json<AgentBody>,
) -> Result<Json<serde_json::Value>, Failed> {
    let forked = hub.fork_in_chat(&body.agent).await?;
    Ok(Json(json!({ "agent": forked })))
}

async fn merge(
    State(hub): Hubs,
    Json(body): Json<AgentBody>,
) -> Result<Json<serde_json::Value>, Failed> {
    let parent = hub.merge(&body.agent).await?;
    Ok(Json(json!({ "agent": parent })))
}

#[derive(Deserialize)]
struct RenameBody {
    agent: String,
    name: String,
}

async fn rename(
    State(hub): Hubs,
    Json(body): Json<RenameBody>,
) -> Result<Json<serde_json::Value>, Failed> {
    let name = body.name.trim();
    if name.is_empty() {
        return Err(Failed(anyhow::anyhow!("a name cannot be empty")));
    }
    hub.rename(&body.agent, name).await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct ArchiveBody {
    agent: String,
    archived: bool,
}

async fn archive(
    State(hub): Hubs,
    Json(body): Json<ArchiveBody>,
) -> Result<Json<oxroute_core::Snapshot>, Failed> {
    hub.archive(&body.agent, body.archived)?;
    Ok(Json(hub.snapshot(INBOX_LIMIT)?))
}

#[derive(Deserialize)]
struct ReactBody {
    entry: i64,
    /// `up`, `down`, or empty to take it back.
    reaction: String,
}

async fn react(State(hub): Hubs, Json(body): Json<ReactBody>) -> Result<StatusCode, Failed> {
    hub.react(body.entry, &body.reaction)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct PinBody {
    agent: String,
    pinned: bool,
}

async fn pin(
    State(hub): Hubs,
    Json(body): Json<PinBody>,
) -> Result<Json<oxroute_core::Snapshot>, Failed> {
    hub.pin(&body.agent, body.pinned)?;
    Ok(Json(hub.snapshot(INBOX_LIMIT)?))
}

async fn tasks(State(hub): Hubs) -> Result<Json<Vec<oxroute_core::TaskItem>>, Failed> {
    Ok(Json(hub.tasks()?))
}

async fn task_diagram(State(hub): Hubs) -> Result<Response, Failed> {
    let svg = render_task_diagram(&hub.tasks()?)?;
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, "image/svg+xml")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(svg))?)
}

fn render_task_diagram(tasks: &[oxroute_core::TaskItem]) -> Result<String> {
    use oxdraw::{
        Diagram, DiagramKind, Direction, Edge, EdgeArrowDirection, EdgeKind, LayoutOverrides, Node,
        NodeShape, NodeStyleOverride,
    };

    anyhow::ensure!(!tasks.is_empty(), "no tasks to draw");
    let mut nodes = HashMap::new();
    let mut order = Vec::new();
    let mut ids = HashMap::new();
    let mut styles = HashMap::new();
    for (index, task) in tasks.iter().enumerate() {
        let id = format!("task_{index}");
        let state = match task.status {
            oxroute_core::TaskStatus::Incomplete => "incomplete",
            oxroute_core::TaskStatus::Done => "done, for review",
            oxroute_core::TaskStatus::Complete => "complete",
            oxroute_core::TaskStatus::WaitingForHuman => "waiting for human",
            oxroute_core::TaskStatus::Blocked => "blocked",
        };
        let text: String = task.text.chars().take(54).collect();
        let label = format!("{state}\n{text}");
        let width = (label.chars().count() as f32 * 6.8 + 52.0).clamp(180.0, 330.0);
        nodes.insert(id.clone(), Node {
            label,
            shape: NodeShape::Rectangle,
            image: None,
            width,
            height: 62.0,
        });
        let (fill, stroke, color) = match task.status {
            oxroute_core::TaskStatus::Incomplete => ("#f7f4ef", "#81786d", "#28231f"),
            oxroute_core::TaskStatus::Done => ("#f3eff9", "#8a4fc0", "#4b2a6b"),
            oxroute_core::TaskStatus::Complete => ("#e3eee8", "#2f886c", "#1e5c48"),
            oxroute_core::TaskStatus::WaitingForHuman => ("#f5ead7", "#b66a0a", "#7a4706"),
            oxroute_core::TaskStatus::Blocked => ("#f2dfdc", "#a6493d", "#6f3028"),
        };
        styles.insert(id.clone(), NodeStyleOverride {
            fill: Some(fill.into()),
            stroke: Some(stroke.into()),
            text: Some(color.into()),
            ..Default::default()
        });
        ids.insert(task.id.as_str(), id.clone());
        order.push(id);
    }
    let edges = tasks.iter().filter_map(|task| {
        let from = ids.get(task.blocked_by_task_id.as_str())?;
        let to = ids.get(task.id.as_str())?;
        Some(Edge {
            from: from.clone(),
            to: to.clone(),
            label: Some("blocks".into()),
            kind: EdgeKind::Solid,
            arrow: EdgeArrowDirection::Forward,
        })
    }).collect();
    let diagram = Diagram {
        kind: DiagramKind::Flowchart,
        direction: Direction::TopDown,
        nodes,
        order,
        edges,
        subgraphs: vec![],
        node_membership: HashMap::new(),
    };
    diagram.render_svg("#fbf9f6", Some(&LayoutOverrides {
        node_styles: styles,
        ..Default::default()
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateTaskBody {
    text: String,
    #[serde(default)]
    agent_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HandOffBody {
    /// Branch the agent that has the task, rather than starting a new one.
    #[serde(default)]
    fork: bool,
    #[serde(default)]
    model: Option<String>,
}

async fn hand_off_task(
    State(hub): Hubs,
    Path(id): Path<String>,
    Json(body): Json<HandOffBody>,
) -> Result<Json<oxroute_core::TaskItem>, Failed> {
    Ok(Json(hub.hand_off_task(&id, body.fork, body.model.as_deref()).await?))
}

#[derive(Deserialize)]
struct NoteBody {
    text: String,
    /// The agent writing it; empty when a person is.
    #[serde(default, rename = "agentId")]
    agent_id: String,
}

async fn task_notes(State(hub): Hubs) -> Result<Json<Vec<oxroute_core::TaskNote>>, Failed> {
    Ok(Json(hub.task_notes()?))
}

async fn add_task_note(
    State(hub): Hubs,
    Path(id): Path<String>,
    Json(body): Json<NoteBody>,
) -> Result<Json<oxroute_core::TaskNote>, Failed> {
    Ok(Json(hub.add_task_note(&id, &body.text, &body.agent_id)?))
}

#[derive(Deserialize)]
struct MoveTaskBody {
    /// The task to put it after; absent means the top of the list.
    #[serde(default)]
    after: Option<String>,
}

async fn move_task(
    State(hub): Hubs,
    Path(id): Path<String>,
    Json(body): Json<MoveTaskBody>,
) -> Result<Json<Vec<oxroute_core::TaskItem>>, Failed> {
    Ok(Json(hub.move_task(&id, body.after.as_deref())?))
}

/// A task made in a composer, with whatever was attached to it.
async fn create_task_with_attachments(
    State(hub): Hubs,
    mut form: Multipart,
) -> Result<Json<oxroute_core::TaskItem>, Failed> {
    let mut text = String::new();
    let mut agent_id = String::new();
    let mut images = Vec::new();
    while let Some(field) = form.next_field().await? {
        match field.name() {
            Some("text") => text = field.text().await?,
            Some("agentId") => agent_id = field.text().await?,
            Some("files") => images.push(keep_file(&hub.config.attachments, field).await?),
            _ => {}
        }
    }
    let names = images
        .iter()
        .filter_map(|path| std::path::Path::new(path).file_name())
        .map(|name| name.to_string_lossy().to_string())
        .collect();
    Ok(Json(hub.create_task(&text, &agent_id, names).await?))
}

/// Saying no to finished work, with whatever you drew or dropped on it:
/// the words go to the agent the way anything said in the composer does.
async fn correct_task(
    State(hub): Hubs,
    Path(id): Path<String>,
    mut form: Multipart,
) -> Result<Json<oxroute_core::TaskItem>, Failed> {
    let mut text = String::new();
    let mut images = Vec::new();
    while let Some(field) = form.next_field().await? {
        match field.name() {
            Some("text") => text = field.text().await?,
            Some("files") => images.push(keep_file(&hub.config.attachments, field).await?),
            _ => {}
        }
    }
    Ok(Json(hub.correct_task(&id, &text, images).await?))
}

async fn create_task(
    State(hub): Hubs,
    Json(body): Json<CreateTaskBody>,
) -> Result<Json<oxroute_core::TaskItem>, Failed> {
    Ok(Json(hub.create_task(&body.text, &body.agent_id, vec![]).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateTaskBody {
    text: String,
    status: oxroute_core::TaskStatus,
    /// Why it moved. Required when the status changes.
    #[serde(default)]
    note: Option<String>,
    /// A person signing the work off. Only they can mark a task complete.
    #[serde(default)]
    approved: bool,
    #[serde(default)]
    blocked_by_task_id: String,
    #[serde(default)]
    agent_id: String,
}

async fn update_task(
    State(hub): Hubs,
    Path(id): Path<String>,
    Json(body): Json<UpdateTaskBody>,
) -> Result<Json<oxroute_core::TaskItem>, Failed> {
    Ok(Json(hub.update_task(
        &id,
        &body.text,
        body.status,
        &body.blocked_by_task_id,
        &body.agent_id,
        body.note.as_deref(),
        body.approved,
    )
    .await?))
}

async fn delete_task(
    State(hub): Hubs,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, Failed> {
    hub.delete_task(&id)?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct ModeBody {
    mode: String,
}

async fn mode(
    State(hub): Hubs,
    Json(body): Json<ModeBody>,
) -> Result<Json<oxroute_core::Snapshot>, Failed> {
    hub.set_mode(Mode::parse(&body.mode))?;
    Ok(Json(hub.snapshot(INBOX_LIMIT)?))
}

// -- tags and boards ---------------------------------------------------------

async fn tags(State(hub): Hubs, Path(id): Path<String>) -> Result<Json<Vec<String>>, Failed> {
    hub.store.agent(&id)?.context("no such agent").map_err(Failed)?;
    Ok(Json(hub.store.tags(&id)?))
}

#[derive(Deserialize)]
struct TagsBody {
    #[serde(default)]
    add: Vec<String>,
    #[serde(default)]
    remove: Vec<String>,
    /// Replaces any tag with the same key.
    #[serde(default)]
    set: Vec<String>,
}

async fn change_tags(
    State(hub): Hubs,
    Path(id): Path<String>,
    Json(body): Json<TagsBody>,
) -> Result<Json<Vec<String>>, Failed> {
    Ok(Json(hub.tag(&id, &body.add, &body.remove, &body.set)?))
}

#[derive(Deserialize)]
struct ModelBody {
    /// An alias or a model id; both resolve the same way.
    model: String,
}

async fn change_model(
    State(hub): Hubs,
    Path(id): Path<String>,
    Json(body): Json<ModelBody>,
) -> Result<Json<serde_json::Value>, Failed> {
    let model = hub.set_model(&id, &body.model)?;
    Ok(Json(json!({ "model": model })))
}

async fn boards(State(hub): Hubs) -> Result<Json<Vec<oxroute_core::tags::Board>>, Failed> {
    Ok(Json(hub.boards()?))
}

/// A board as sent: every setting is optional, so `{"name": "Ideas"}` or
/// `{"columns": "stage"}` alone makes one.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoardBody {
    #[serde(default)]
    name: String,
    #[serde(default)]
    columns: String,
    #[serde(default)]
    column_order: Vec<String>,
    #[serde(default)]
    rows: String,
    #[serde(default)]
    row_order: Vec<String>,
    #[serde(default)]
    filters: Vec<String>,
    #[serde(default)]
    selected: Vec<String>,
    #[serde(default)]
    sort: String,
}

impl From<BoardBody> for oxroute_core::tags::Board {
    fn from(body: BoardBody) -> Self {
        oxroute_core::tags::Board {
            id: String::new(),
            name: body.name,
            columns: body.columns,
            column_order: body.column_order,
            rows: body.rows,
            row_order: body.row_order,
            filters: body.filters,
            selected: body.selected,
            sort: body.sort,
            created_at: 0.0,
            updated_at: 0.0,
        }
    }
}

async fn create_board(
    State(hub): Hubs,
    Json(body): Json<BoardBody>,
) -> Result<Json<oxroute_core::tags::Board>, Failed> {
    Ok(Json(hub.create_board(body.into())?))
}

async fn update_board(
    State(hub): Hubs,
    Path(id): Path<String>,
    Json(body): Json<BoardBody>,
) -> Result<Json<oxroute_core::tags::Board>, Failed> {
    Ok(Json(hub.update_board(&id, body.into())?))
}

async fn delete_board(
    State(hub): Hubs,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, Failed> {
    hub.delete_board(&id)?;
    Ok(Json(json!({ "ok": true })))
}

async fn arrange(
    State(hub): Hubs,
    Path(id): Path<String>,
) -> Result<Json<oxroute_core::tags::Arranged>, Failed> {
    Ok(Json(hub.arrange(&id)?))
}

/// A card dropped on a cell. Each value is null for the lane of sessions
/// without that key.
#[derive(Deserialize)]
struct MoveBody {
    agent: String,
    #[serde(default)]
    column: Option<String>,
    #[serde(default)]
    row: Option<String>,
}

async fn move_card(
    State(hub): Hubs,
    Path(id): Path<String>,
    Json(body): Json<MoveBody>,
) -> Result<Json<Vec<String>>, Failed> {
    Ok(Json(hub.move_card(&id, &body.agent, body.column.as_deref(), body.row.as_deref())?))
}

/// An agent's diagram: where it is, and the directory its code is in.
fn diagram_of(hub: &Hub, id: &str) -> Result<(oxroute_core::Agent, std::path::PathBuf)> {
    let agent = hub.store.agent(id)?.context("no such agent")?;
    let path = hub.config.diagram_for(&agent.cwd);
    Ok((agent, path))
}

/// Where an agent's code is: the repository it works in, or failing that
/// the directory it works in.
fn workdir(hub: &Hub, agent: &oxroute_core::Agent) -> String {
    let here = if agent.cwd.is_empty() {
        hub.config.workspace_path()
    } else {
        std::path::PathBuf::from(&agent.cwd)
    };
    oxroute_core::config::repository_of(&here)
        .unwrap_or(here)
        .display()
        .to_string()
}

/// An agent's diagram as the composer draws it: the picture, and where
/// every box is so a click on the picture can find it.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagramPayload {
    /// False when the agent's repository has no diagram yet. The rest is
    /// then empty, and the composer offers to have the agent draw one.
    exists: bool,
    file: String,
    #[serde(flatten)]
    drawn: Option<diagram::Drawn>,
    /// Seconds since the epoch the file last changed. The agent editing it
    /// changes this, which is how the composer knows to redraw.
    modified: f64,
}

fn diagram_payload(hub: &Hub, id: &str, edits: &[diagram::Edit]) -> Result<DiagramPayload> {
    let (_, path) = diagram_of(hub, id)?;
    let Ok(metadata) = std::fs::metadata(&path) else {
        return Ok(DiagramPayload {
            exists: false,
            file: path.display().to_string(),
            drawn: None,
            modified: 0.0,
        });
    };
    let file = diagram::DiagramFile::read(&path)?;
    Ok(DiagramPayload {
        exists: true,
        file: path.display().to_string(),
        drawn: Some(diagram::draw(&file, edits)?),
        modified: metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64())
            .unwrap_or_default(),
    })
}

async fn diagram_view(
    State(hub): Hubs,
    Path(id): Path<String>,
) -> Result<Json<DiagramPayload>, Failed> {
    Ok(Json(diagram_payload(&hub, &id, &[])?))
}

#[derive(Deserialize)]
struct PreviewBody {
    #[serde(default)]
    edits: Vec<diagram::Edit>,
}

async fn diagram_preview(
    State(hub): Hubs,
    Path(id): Path<String>,
    Json(body): Json<PreviewBody>,
) -> Result<Json<DiagramPayload>, Failed> {
    Ok(Json(diagram_payload(&hub, &id, &body.edits)?))
}

#[derive(Deserialize)]
struct SendBody {
    edits: Vec<diagram::Edit>,
    #[serde(default)]
    note: String,
    /// Wait for the running turn rather than stopping it.
    #[serde(default)]
    queued: bool,
}

/// Draw a change instead of describing it: write it into the diagram, then
/// send the agent a brief on what changed and where that code is.
///
/// The file is written first. A diagram that changed with nobody told is
/// visible and easy to recover; an agent told about a change the file does
/// not have would be building to a spec that does not exist.
async fn diagram_send(
    State(hub): Hubs,
    Path(id): Path<String>,
    Json(body): Json<SendBody>,
) -> Result<Json<DiagramPayload>, Failed> {
    if body.edits.is_empty() {
        return Err(Failed(anyhow::anyhow!("there are no changes to send")));
    }
    let (agent, path) = diagram_of(&hub, &id)?;
    let root = workdir(&hub, &agent);
    let file = diagram::DiagramFile::read(&path)?;
    let brief = diagram::describe(&file, &body.edits, &path, std::path::Path::new(&root), &body.note)?;
    diagram::write(&path, &diagram::rewrite(&file, &body.edits)?)?;
    hub.say_to_with_attachments(&id, &brief, vec![], body.queued).await.map_err(|error| {
        Failed(error.context("the diagram is saved, but the agent could not be told"))
    })?;
    Ok(Json(diagram_payload(&hub, &id, &[])?))
}

/// No diagram yet: ask the agent to draw one, in the format the composer
/// reads. Where it lands is `[diagram] path`; whether that is inside a
/// checkout is not this code's business.
#[derive(Deserialize)]
struct CreateDiagramBody {
    /// What to draw. Empty means the whole architecture.
    #[serde(default)]
    about: String,
}

async fn diagram_create(
    State(hub): Hubs,
    Path(id): Path<String>,
    Json(body): Json<CreateDiagramBody>,
) -> Result<Json<serde_json::Value>, Failed> {
    let (agent, path) = diagram_of(&hub, &id)?;
    let root = workdir(&hub, &agent);
    let request = diagram::create_request(&path, std::path::Path::new(&root), &body.about);
    let said = match body.about.trim() {
        "" => "Asked for a diagram of the architecture".to_string(),
        about => format!("Asked for a diagram of {about}"),
    };
    hub.ask_quietly(&id, &request, &said).await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct RenderBody {
    source: String,
    /// Boxes the change added, coloured as the editor showed them.
    #[serde(default)]
    added: Vec<String>,
}

/// Draw a diagram someone sent, for the timeline to show as a picture.
async fn diagram_render(Json(body): Json<RenderBody>) -> Result<Json<serde_json::Value>, Failed> {
    let file = diagram::DiagramFile::parse(&body.source)?;
    Ok(Json(json!({ "svg": diagram::draw_marked(&file, &body.added)?.svg })))
}

/// Something sent to or handed back from a surface, so the timeline can
/// show it: a picture, or a recording to press play on.
///
/// Only a bare file name inside the attachments directory: anything with a
/// separator, or a leading dot, is refused before the disk is touched.
async fn attachment(
    State(hub): Hubs,
    Path(name): Path<String>,
    headers: HeaderMap,
) -> Result<Response, Failed> {
    let Some(kind) = attachment_type(&name) else {
        return Ok((StatusCode::NOT_FOUND, "no such attachment").into_response());
    };
    let Ok(bytes) = tokio::fs::read(hub.config.attachments.join(&name)).await else {
        return Ok((StatusCode::NOT_FOUND, "no such attachment").into_response());
    };
    let mut whole = Response::builder()
        .header(header::CONTENT_TYPE, kind)
        .header(header::CACHE_CONTROL, "private, max-age=86400")
        .header(header::ACCEPT_RANGES, "bytes");
    if !kind.starts_with("image/") && !kind.starts_with("video/") {
        whole = whole.header(header::CONTENT_DISPOSITION, "attachment");
    }

    // A video is watched by asking for parts of it. Without this a player
    // can show the first frame and nothing else.
    let Some(range) = headers.get(header::RANGE).and_then(|value| value.to_str().ok()) else {
        return Ok(whole.body(Body::from(bytes))?);
    };
    let Some((from, to)) = wanted(range, bytes.len()) else {
        return Ok((StatusCode::RANGE_NOT_SATISFIABLE, "no such range").into_response());
    };
    Ok(whole
        .status(StatusCode::PARTIAL_CONTENT)
        .header(
            header::CONTENT_RANGE,
            format!("bytes {from}-{to}/{}", bytes.len()),
        )
        .body(Body::from(bytes[from..=to].to_vec()))?)
}

/// The slice a player asked for, as `bytes=from-to`. An open end means the
/// rest of the file.
fn wanted(range: &str, size: usize) -> Option<(usize, usize)> {
    let (from, to) = range.strip_prefix("bytes=")?.split_once('-')?;
    let from: usize = from.parse().ok()?;
    let to = match to.trim() {
        "" => size.checked_sub(1)?,
        end => end.parse().ok()?,
    };
    let to = to.min(size.checked_sub(1)?);
    (from <= to).then_some((from, to))
}

/// The content type of an attachment worth serving, or `None`.
///
/// Only a bare file name: anything with a separator or a leading dot is
/// refused before the disk is touched, so no name reaches outside the
/// attachments directory. Unknown file types are served as binary downloads.
fn attachment_type(name: &str) -> Option<&'static str> {
    let plain = !name.is_empty()
        && !name.starts_with('.')
        && !name.contains(['/', '\\'])
        && std::path::Path::new(name).file_name().and_then(|n| n.to_str()) == Some(name);
    if !plain {
        return None;
    }
    Some(oxroute_core::model::attachment_mime(name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxroute_core::{Backend, TaskItem, TaskStatus};

    struct ReviewHarness;

    #[async_trait::async_trait]
    impl oxroute_core::agent::Harness for ReviewHarness {
        fn backend(&self) -> Backend { Backend::Codex }
        fn capabilities(&self) -> oxroute_core::agent::Capabilities { oxroute_core::agent::Capabilities { fork: false, inject: false, resume: true } }
        fn events(&self) -> tokio::sync::broadcast::Receiver<oxroute_core::agent::HarnessEvent> { tokio::sync::broadcast::channel(16).1 }
        async fn open(&self, _: &oxroute_core::agent::SessionSpec) -> Result<String> { Ok("fixture-session".into()) }
        async fn start(&self, _: &str, _: Vec<oxroute_core::model::TurnInput>) -> Result<String> { Ok("fixture-turn".into()) }
        async fn interrupt(&self, _: &str, _: &str) -> Result<()> { Ok(()) }
    }

    #[tokio::test]
    async fn local_review_http_lifecycle_never_publishes_and_persists_approval() {
        let root = std::env::temp_dir().join(oxroute_core::model::new_id("review-api"));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let command = |args: Vec<&str>| {
            let output = std::process::Command::new("git").arg("-C").arg(&root).args(args).output().unwrap();
            assert!(output.status.success());
        };
        command(vec!["init", "-b", "main"]);
        command(vec!["config", "user.name", "Fixture"]);
        command(vec!["config", "user.email", "fixture@example.invalid"]);
        command(vec!["remote", "add", "origin", "https://example.invalid/proposed.git"]);
        tokio::fs::write(root.join("settings.txt"), "original\n").await.unwrap();
        command(vec!["add", "settings.txt"]);
        command(vec!["commit", "-m", "Initial"]);
        command(vec!["checkout", "-b", "proposal"]);
        tokio::fs::write(root.join("settings.txt"), "proposed\n").await.unwrap();
        command(vec!["commit", "-am", "Propose"]);
        let config_path = root.join("config.toml");
        tokio::fs::write(&config_path, "owner = 'fixture'\n").await.unwrap();
        let mut config = Config::load_from(&config_path).unwrap();
        config.workspace = root.to_string_lossy().into();
        config.artifacts = root.join("artifacts");
        config.attachments = root.join("attachments");
        config.min_free_bytes = 0;
        config.database = root.join("state.sqlite");
        let store = Store::open(&config.database).unwrap();
        let agent_id = "review-fixture";
        store.save_agent(&oxroute_core::Agent {
            id: agent_id.into(), name: "Review fixture".into(), backend: Backend::Codex, model: config.default_model.clone(),
            session_id: String::new(), cwd: config.workspace.clone(), status: oxroute_core::model::AgentStatus::Complete,
            activity: String::new(), permalink: String::new(), last_activity: 0.0, updated_at: 0.0,
            stall_reason: None, stall_alerted: false, pinned: false,
        }).unwrap();
        let mut hub = Hub::new(config, store);
        hub.with_harness(Arc::new(ReviewHarness));
        let router = Router::new().route("/api/agents/{id}/reviews", post(create_review))
            .route("/api/agents/{id}/reviews/{review}", get(get_review))
            .route("/api/agents/{id}/reviews/{review}/approve", post(approve_review)).with_state(hub.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let client = reqwest::Client::new();
        let url = format!("http://{address}/api/agents/{agent_id}/reviews");
        let created = client.post(&url).json(&json!({ "repository": root, "base": "main", "remote": "origin", "title": "Proposed change", "description": "Review before publication" }))
            .send().await.unwrap();
        assert!(created.status().is_success(), "{}", created.text().await.unwrap());
        let review: serde_json::Value = created.json().await.unwrap();
        assert_eq!(review["status"], "pending");
        let id = review["id"].as_str().unwrap();
        let endpoint = format!("{url}/{id}");
        let card = hub.store.timeline(agent_id, 10).unwrap();
        assert_eq!(card.len(), 1);
        assert_eq!(card[0].kind, oxroute_core::model::EntryKind::Review);
        assert_eq!(card[0].detail, id);
        // SQLite keeps identity and consent, not duplicated Git content.
        let reopened = Store::open(hub.store.path()).unwrap();
        let saved: serde_json::Value = serde_json::from_str(&reopened.get(&format!("review:{id}")).unwrap().unwrap()).unwrap();
        assert!(saved["snapshot"].get("files").is_none());
        assert_eq!(saved["snapshot"]["headCommit"], review["snapshot"]["headCommit"]);
        assert_eq!(client.get(&endpoint).send().await.unwrap().json::<serde_json::Value>().await.unwrap()["snapshot"], review["snapshot"]);
        assert!(!client.get(format!("http://{address}/api/agents/other/reviews/{id}")).send().await.unwrap().status().is_success());
        for _ in 0..2 {
            let approved = client.post(format!("{endpoint}/approve")).send().await.unwrap();
            assert!(approved.status().is_success(), "{}", approved.text().await.unwrap());
            assert_eq!(approved.json::<serde_json::Value>().await.unwrap()["status"], "approved");
        }
        assert_eq!(hub.store.timeline(agent_id, 10).unwrap().iter().filter(|entry| entry.kind == oxroute_core::model::EntryKind::You).count(), 1);
        let timeline = reopened.timeline(agent_id, 10).unwrap();
        let approval = timeline.iter().find(|entry| entry.kind == oxroute_core::model::EntryKind::You).unwrap();
        let metadata: serde_json::Value = serde_json::from_str(approval.detail.strip_prefix("review-approval:").unwrap()).unwrap();
        assert_eq!(metadata["id"], id);
        assert_eq!(metadata["commit"], review["snapshot"]["headCommit"]);
        assert!(approval.text.contains(review["snapshot"]["headCommit"].as_str().unwrap()));
        assert!(approval.text.contains("No merge or deployment is authorized."));
        let stored: ChangeReview = serde_json::from_str(&reopened.get(&format!("review:{id}")).unwrap().unwrap()).unwrap();
        assert!(stored.approved_at.is_some());
        tokio::fs::write(root.join("settings.txt"), "revised\n").await.unwrap();
        command(vec!["commit", "-am", "Revise"]);
        let stale = client.get(&endpoint).send().await.unwrap().json::<serde_json::Value>().await.unwrap();
        assert_eq!(stale["status"], "stale");
        assert_eq!(stale["snapshot"], review["snapshot"]);
        assert!(!client.post(format!("{endpoint}/approve")).send().await.unwrap().status().is_success());
        tokio::fs::remove_dir_all(&root).await.unwrap();
        let missing = client.get(&endpoint).send().await.unwrap();
        assert!(!missing.status().is_success());
        assert!(missing.text().await.unwrap().contains("worktree was removed"));
        assert!(!client.post(format!("{endpoint}/approve")).send().await.unwrap().status().is_success());
        server.abort();
    }

    #[tokio::test]
    async fn uploads_preserve_arbitrary_bytes_without_overwriting() {
        let directory = std::env::temp_dir().join(oxroute_core::model::new_id("upload-test"));
        tokio::fs::create_dir_all(&directory).await.unwrap();
        let destination = directory.clone();
        let router = Router::new().route("/", post(move |mut form: Multipart| {
            let directory = destination.clone();
            async move {
                let field = form.next_field().await.unwrap().unwrap();
                Json(keep_file(&directory, field).await.unwrap())
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let client = reqwest::Client::new();
        let mut paths = Vec::new();
        for bytes in [vec![0, 255, 17], vec![8, 0, 91]] {
            let part = reqwest::multipart::Part::bytes(bytes.clone()).file_name("../payload.bin");
            let response = client.post(format!("http://{address}/"))
                .multipart(reqwest::multipart::Form::new().part("files", part))
                .send().await.unwrap();
            let path = response.json::<String>().await.unwrap();
            assert!(std::path::Path::new(&path).starts_with(&directory));
            assert_eq!(tokio::fs::read(&path).await.unwrap(), bytes);
            paths.push(path);
        }
        assert_ne!(paths[0], paths[1]);
        server.abort();
        tokio::fs::remove_dir_all(&directory).await.unwrap();
    }

    fn task(id: &str, text: &str, status: TaskStatus, blocker: &str) -> TaskItem {
        TaskItem {
            id: id.into(),
            text: text.into(),
            status,
            blocked_by_task_id: blocker.into(),
            agent_id: String::new(),
            position: 0.0,
            images: vec![],
            created_at: 1.0,
            updated_at: 1.0,
        }
    }

    #[test]
    fn only_bare_attachment_names_are_served() {
        assert_eq!(attachment_type("web-msg_1-sketch.png"), Some("image/png"));
        assert_eq!(attachment_type("photo.JPG"), Some("image/jpeg"));
        assert_eq!(attachment_type("art_1-demo.mp4"), Some("video/mp4"));
        assert_eq!(attachment_type("art_1-demo.webm"), Some("video/webm"));
        assert_eq!(attachment_type("notes.txt"), Some("application/octet-stream"));
        assert_eq!(attachment_type("report.xlsx"), Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));
        for refused in ["../config.toml", "..", ".env.png", "a/b.png", "a\\b.mp4", ""] {
            assert_eq!(attachment_type(refused), None, "{refused} was served");
        }
    }

    /// A player asks for a slice at a time, and the last one runs off the end.
    #[test]
    fn a_range_is_read_as_the_slice_it_asks_for() {
        assert_eq!(wanted("bytes=0-99", 500), Some((0, 99)));
        assert_eq!(wanted("bytes=400-", 500), Some((400, 499)));
        assert_eq!(wanted("bytes=0-999", 500), Some((0, 499)));
        assert_eq!(wanted("bytes=500-600", 500), None);
        assert_eq!(wanted("pages=1-2", 500), None);
    }

    #[test]
    fn oxdraw_task_diagram_colors_states_and_connects_blockers() {
        let svg = render_task_diagram(&[
            task("first", "prepare data", TaskStatus::WaitingForHuman, ""),
            task("second", "run report", TaskStatus::Blocked, "first"),
        ]).unwrap();
        assert!(svg.contains("waiting for human"));
        assert!(svg.contains("blocked"));
        assert!(svg.contains("#f5ead7"));
        assert!(svg.contains("#f2dfdc"));
        assert!(svg.contains("blocks"));
        assert!(svg.contains("marker-end=\"url(#arrow-end)\""));
    }
}
