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
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Multipart, Path, Query, State};
use axum::http::{header, StatusCode};
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
        "github          {}",
        match &config.github_token {
            Some(_) => format!("token set ({})", config.github_api),
            None => "no token (boards read snapshots, cards cannot move)".into(),
        }
    );
    for view in &config.views {
        let detail = match &view.kind {
            oxroute_core::config::ViewKind::Board(board) => {
                let mut bits = Vec::new();
                if let Some(repo) = &board.repo {
                    bits.push(repo.clone());
                }
                if let Some(snapshot) = &board.snapshot {
                    bits.push(if snapshot.exists() {
                        snapshot.display().to_string()
                    } else {
                        format!("{} (MISSING)", snapshot.display())
                    });
                }
                bits.join(", ")
            }
        };
        println!("view {:<10} {} [{}] {detail}", view.id, view.name, view.kind.as_str());
    }
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
        .route("/api/continue", post(continue_session))
        .route("/api/native-preview", get(native_preview))
        .route("/api/signal", post(ingest))
        .route("/api/route", post(route))
        .route("/api/say", post(say))
        .route("/api/say-images", post(say_images))
        .route("/api/interrupt", post(interrupt))
        .route("/api/fork", post(fork))
        .route("/api/fork-local", post(fork_local))
        .route("/api/merge", post(merge))
        .route("/api/rename", post(rename))
        .route("/api/archive", post(archive))
        .route("/api/pin", post(pin))
        .route("/api/tasks", get(tasks).post(create_task))
        .route("/api/tasks/{id}", axum::routing::put(update_task).delete(delete_task))
        .route("/api/task-diagram.svg", get(task_diagram))
        .route("/api/mode", post(mode))
        .route("/api/views/{id}/board", get(board))
        .route("/api/views/{id}/board/move", post(move_card))
        .route("/api/views/{id}/board/start", post(start_card))
        .route("/api/views/{id}/unlink", post(unlink))
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
        .with_state(hub);

    let listener = tokio::net::TcpListener::bind(&listen)
        .await
        .with_context(|| format!("binding {listen}"))?;
    tracing::info!("oxroute listening on http://{listen}");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            tracing::info!("shutting down");
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
        tracing::warn!(error = %self.0, "request failed");
        (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": self.0.to_string() })),
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
) -> Result<Json<oxroute_core::SearchResults>, Failed> {
    Ok(Json(hub.search(&query.q, SEARCH_LIMIT, SEARCH_LIMIT).await?))
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
}

async fn say(State(hub): Hubs, Json(body): Json<SayBody>) -> Result<Json<serde_json::Value>, Failed> {
    if body.text.trim().is_empty() {
        return Err(Failed(anyhow::anyhow!("nothing to say")));
    }
    hub.say_to(&body.agent, &body.text).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn say_images(
    State(hub): Hubs,
    mut form: Multipart,
) -> Result<Json<serde_json::Value>, Failed> {
    let mut agent = String::new();
    let mut text = String::new();
    let mut images = Vec::new();
    while let Some(field) = form.next_field().await? {
        match field.name() {
            Some("agent") => agent = field.text().await?,
            Some("text") => text = field.text().await?,
            Some("images") => {
                let mimetype = field.content_type().unwrap_or_default().to_string();
                if !mimetype.starts_with("image/") {
                    return Err(Failed(anyhow::anyhow!("only image files are supported")));
                }
                let name = std::path::Path::new(field.file_name().unwrap_or("image"))
                    .file_name()
                    .and_then(|name| name.to_str())
                    .filter(|name| !name.is_empty())
                    .unwrap_or("image");
                let path = hub
                    .config
                    .attachments
                    .join(format!("{}-{name}", oxroute_core::model::new_id("web")));
                tokio::fs::write(&path, field.bytes().await?).await?;
                images.push(path.to_string_lossy().to_string());
            }
            _ => {}
        }
    }
    if agent.is_empty() {
        return Err(Failed(anyhow::anyhow!("an agent is required")));
    }
    hub.say_to_with_images(&agent, &text, images).await?;
    Ok(Json(json!({ "ok": true })))
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

async fn fork_local(
    State(hub): Hubs,
    Json(body): Json<AgentBody>,
) -> Result<Json<serde_json::Value>, Failed> {
    let forked = hub.fork_local(&body.agent).await?;
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

async fn create_task(
    State(hub): Hubs,
    Json(body): Json<CreateTaskBody>,
) -> Result<Json<oxroute_core::TaskItem>, Failed> {
    Ok(Json(hub.create_task(&body.text, &body.agent_id)?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateTaskBody {
    text: String,
    status: oxroute_core::TaskStatus,
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
    )?))
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

// -- views -------------------------------------------------------------------

#[derive(Deserialize)]
struct BoardQuery {
    #[serde(default)]
    refresh: bool,
}

async fn board(
    State(hub): Hubs,
    Path(id): Path<String>,
    Query(query): Query<BoardQuery>,
) -> Result<Json<oxroute_core::board::Board>, Failed> {
    Ok(Json(hub.board(&id, query.refresh).await?))
}

#[derive(Deserialize)]
struct MoveBody {
    number: u64,
    lane: String,
}

async fn move_card(
    State(hub): Hubs,
    Path(id): Path<String>,
    Json(body): Json<MoveBody>,
) -> Result<Json<oxroute_core::board::Board>, Failed> {
    Ok(Json(hub.move_card(&id, body.number, &body.lane).await?))
}

#[derive(Deserialize)]
struct StartBody {
    number: u64,
    #[serde(default)]
    model: Option<String>,
    /// An agent already running, instead of a new one.
    #[serde(default)]
    agent: Option<String>,
}

async fn start_card(
    State(hub): Hubs,
    Path(id): Path<String>,
    Json(body): Json<StartBody>,
) -> Result<Json<serde_json::Value>, Failed> {
    let agent = hub
        .start_on_card(&id, body.number, body.model.as_deref(), body.agent.as_deref())
        .await?;
    Ok(Json(json!({ "agent": agent })))
}

#[derive(Deserialize)]
struct UnlinkBody {
    item: String,
    agent: String,
}

async fn unlink(
    State(hub): Hubs,
    Path(id): Path<String>,
    Json(body): Json<UnlinkBody>,
) -> Result<Json<serde_json::Value>, Failed> {
    hub.unlink(&id, &body.item, &body.agent)?;
    Ok(Json(json!({ "ok": true })))
}

/// An agent's diagram: where it is, and the directory its code is in.
fn diagram_of(hub: &Hub, id: &str) -> Result<(oxroute_core::Agent, std::path::PathBuf)> {
    let agent = hub.store.agent(id)?.context("no such agent")?;
    let path = hub.config.diagram_for(&agent.cwd);
    Ok((agent, path))
}

fn workdir(hub: &Hub, agent: &oxroute_core::Agent) -> String {
    if agent.cwd.is_empty() {
        hub.config.workspace_path().display().to_string()
    } else {
        agent.cwd.clone()
    }
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
    hub.say_to(&id, &brief).await.map_err(|error| {
        Failed(error.context("the diagram is saved, but the agent could not be told"))
    })?;
    Ok(Json(diagram_payload(&hub, &id, &[])?))
}

/// A repository with no diagram yet: ask its agent to draw one, in the
/// format the composer reads.
async fn diagram_create(
    State(hub): Hubs,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, Failed> {
    let (agent, path) = diagram_of(&hub, &id)?;
    let root = workdir(&hub, &agent);
    hub.say_to(&id, &diagram::create_request(&path, std::path::Path::new(&root)))
        .await?;
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

/// An image sent from a surface, so the timeline can show what was sent.
///
/// Only a bare file name inside the attachments directory: anything with a
/// separator, or a leading dot, is refused before the disk is touched.
async fn attachment(State(hub): Hubs, Path(name): Path<String>) -> Result<Response, Failed> {
    let Some(kind) = image_type(&name) else {
        return Ok((StatusCode::NOT_FOUND, "no such image").into_response());
    };
    match tokio::fs::read(hub.config.attachments.join(&name)).await {
        Ok(bytes) => Ok(Response::builder()
            .header(header::CONTENT_TYPE, kind)
            .header(header::CACHE_CONTROL, "private, max-age=86400")
            .body(Body::from(bytes))?),
        Err(_) => Ok((StatusCode::NOT_FOUND, "no such image").into_response()),
    }
}

/// The content type of an attachment worth serving, or `None`.
///
/// Only a bare image file name: anything with a separator or a leading dot
/// is refused before the disk is touched, so no name reaches outside the
/// attachments directory.
fn image_type(name: &str) -> Option<&'static str> {
    let plain = !name.is_empty()
        && !name.starts_with('.')
        && !name.contains(['/', '\\'])
        && std::path::Path::new(name).file_name().and_then(|n| n.to_str()) == Some(name);
    if !plain {
        return None;
    }
    match name.rsplit('.').next()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxroute_core::{TaskItem, TaskStatus};

    fn task(id: &str, text: &str, status: TaskStatus, blocker: &str) -> TaskItem {
        TaskItem {
            id: id.into(),
            text: text.into(),
            status,
            blocked_by_task_id: blocker.into(),
            agent_id: String::new(),
            created_at: 1.0,
            updated_at: 1.0,
        }
    }

    /// Just enough of GitHub to page through issues and take a PATCH.
    async fn fake_github() -> (String, Arc<std::sync::Mutex<Vec<serde_json::Value>>>) {
        use axum::extract::{Path as P, Query as Q};
        let patches = Arc::new(std::sync::Mutex::new(Vec::new()));
        let issue = |number: u64, labels: &[&str], state: &str| {
            json!({
                "number": number, "title": format!("issue {number}"), "state": state,
                "html_url": format!("https://github.com/o/r/issues/{number}"),
                "labels": labels.iter().map(|l| json!({ "name": l })).collect::<Vec<_>>(),
                "body": "", "updated_at": "2026-09-25T00:00:00Z"
            })
        };
        let page_one: Vec<_> = (1..=100)
            .map(|n| issue(n, &["status:idea", "priority:p2"], "open"))
            .collect();
        let page_two = vec![issue(101, &["status:idea", "track:oss"], "open"), json!({
            "number": 102, "title": "a pull request", "state": "open", "pull_request": {}
        })];
        let seen = patches.clone();
        let app = Router::new()
            .route(
                "/repos/o/r/issues",
                get(move |Q(q): Q<HashMap<String, String>>| {
                    let page = if q.get("page").map(String::as_str) == Some("1") {
                        page_one.clone()
                    } else {
                        page_two.clone()
                    };
                    async move { Json(serde_json::Value::Array(page)) }
                }),
            )
            .route(
                "/repos/o/r/issues/{n}",
                get(move |P(n): P<u64>| async move {
                    Json(issue(n, &["status:idea", "track:oss", "added-since"], "open"))
                })
                .patch(move |P(n): P<u64>, Json(body): Json<serde_json::Value>| {
                    let seen = seen.clone();
                    async move {
                        seen.lock().unwrap().push(body.clone());
                        let labels: Vec<&str> = body["labels"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|l| l.as_str().unwrap())
                            .collect();
                        let state = body.get("state").and_then(|s| s.as_str()).unwrap_or("open");
                        Json(issue(n, &labels, state))
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{address}"), patches)
    }

    #[tokio::test]
    async fn a_board_pages_through_github_and_a_move_rewrites_one_label() {
        use oxroute_core::board::GitHub;
        let (api, patches) = fake_github().await;
        let github = GitHub::new(&api, Some("token".into()));
        let issues = github.issues("o/r").await.unwrap();
        // Two pages, and the pull request is not a card.
        assert_eq!(issues.len(), 101);

        let moved = github.set_lane("o/r", &issues[0], "in-progress").await.unwrap();
        assert!(moved.labels.contains(&"status:in-progress".to_string()));
        assert!(!moved.labels.contains(&"status:idea".to_string()));
        // A label added on GitHub after the board was fetched survives.
        assert!(moved.labels.contains(&"added-since".to_string()));

        let done = github.set_lane("o/r", &issues[0], "completed").await.unwrap();
        assert!(!done.open, "moving to done closes the issue");
        let patches = patches.lock().unwrap();
        assert_eq!(patches[1]["state"], "closed");
        assert_eq!(patches[1]["state_reason"], "completed");
        assert!(patches[0].get("state").is_none(), "an open issue staying open is not reopened");
    }

    #[test]
    fn only_a_bare_image_name_is_served_from_attachments() {
        assert_eq!(image_type("web-msg_1-sketch.png"), Some("image/png"));
        assert_eq!(image_type("photo.JPG"), Some("image/jpeg"));
        for refused in ["../config.toml", "..", ".env.png", "a/b.png", "a\\b.png", "notes.txt", ""] {
            assert_eq!(image_type(refused), None, "{refused} was served");
        }
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
