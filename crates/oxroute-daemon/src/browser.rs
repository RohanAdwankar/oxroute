//! One private Chromium profile per conversation, shared by the human and agent.
use crate::Failed;
use anyhow::{ensure, Context, Result};
use axum::{
    extract::{Path, State},
    http::header,
    routing::{get, post},
    Json, Router,
};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use oxroute_core::{
    model::{new_id, Event},
    Hub,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, path::PathBuf, process::Stdio, sync::Arc, time::Duration};
use tokio::{
    process::{Child, Command},
    sync::Mutex,
};
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

const KEY: &str = "browser-panes";
const WIDTH: u32 = 1280;
const HEIGHT: u32 = 800;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Info {
    id: String,
    name: String,
    agent_id: String,
    human: bool,
}
#[derive(Clone, Serialize, Deserialize)]
struct Record {
    info: Info,
    controller: String,
}
struct Live {
    _child: Child,
    socket: WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
    sequence: u64,
    port: u16,
    target: String,
}
struct Session {
    record: Record,
    live: Option<Live>,
    closed: bool,
}
pub struct Browsers {
    hub: Arc<Hub>,
    sessions: Mutex<HashMap<String, Arc<Mutex<Session>>>>,
}
type BrowserState = State<Arc<Browsers>>;

pub fn routes(hub: Arc<Hub>) -> Result<(Router, Arc<Browsers>)> {
    let records: Vec<Record> = hub
        .store
        .get(KEY)?
        .map(|s| serde_json::from_str(&s))
        .transpose()?
        .unwrap_or_default();
    // Restarting never silently returns control to an agent.
    let sessions = records
        .into_iter()
        .map(|mut record| {
            record.info.human = true;
            (
                record.info.id.clone(),
                Arc::new(Mutex::new(Session {
                    record,
                    live: None,
                    closed: false,
                })),
            )
        })
        .collect();
    let state = Arc::new(Browsers {
        hub,
        sessions: Mutex::new(sessions),
    });
    let router = Router::new()
        .route("/api/browsers", get(list).post(create))
        .route("/api/browsers/{id}", get(info).delete(close))
        .route("/api/browsers/{id}/frame", get(frame))
        .route("/api/browsers/{id}/snapshot", get(snapshot))
        .route("/api/browsers/{id}/action", post(action))
        .route("/api/browsers/{id}/claim", post(claim))
        .route("/api/browsers/{id}/control", post(control))
        .with_state(state.clone());
    Ok((router, state))
}

impl Browsers {
    pub async fn shutdown(&self) {
        let sessions: Vec<_> = self.sessions.lock().await.values().cloned().collect();
        futures_util::future::join_all(sessions.into_iter().map(|session| async move {
            let mut session = session.lock().await;
            session.closed = true;
            if let Some(live) = session.live.take() {
                live.shutdown().await;
            }
        }))
        .await;
    }
    async fn session(&self, id: &str) -> Result<Arc<Mutex<Session>>> {
        self.sessions
            .lock()
            .await
            .get(id)
            .cloned()
            .context("No such browser")
    }
    async fn save(&self) -> Result<()> {
        let sessions = self.sessions.lock().await;
        let mut records = Vec::new();
        for session in sessions.values() {
            records.push(session.lock().await.record.clone());
        }
        self.hub.store.set(KEY, &serde_json::to_string(&records)?)?;
        self.hub.emit(Event::Sync);
        Ok(())
    }
    fn profile(&self, id: &str) -> PathBuf {
        PathBuf::from(&self.hub.config.database)
            .parent()
            .unwrap()
            .join("browsers")
            .join(id)
    }
}

impl Session {
    fn authorize(&self, credentials: &Credentials) -> Result<()> {
        ensure!(!self.closed, "Browser session ended");
        if !credentials.controller.is_empty() {
            return self.owner(&credentials.controller);
        }
        ensure!(
            !self.record.info.human,
            "Human has control; wait for Resume agent"
        );
        ensure!(
            !credentials.agent_id.is_empty() && credentials.agent_id == self.record.info.agent_id,
            "This browser belongs to another conversation"
        );
        Ok(())
    }
    fn owner(&self, token: &str) -> Result<()> {
        ensure!(!self.closed, "Browser session ended");
        ensure!(
            !token.is_empty() && token == self.record.controller,
            "Browser owner authorization required"
        );
        Ok(())
    }
    async fn live(&mut self, profile: PathBuf) -> Result<&mut Live> {
        ensure!(!self.closed, "Browser session ended");
        if self.live.is_none() {
            self.live = Some(Live::launch(profile).await?);
        }
        Ok(self.live.as_mut().unwrap())
    }
}

impl Live {
    async fn shutdown(mut self) {
        // Explicit shutdown is required: the daemon exits without running Drop.
        let _ = self.call("Browser.close", json!({})).await;
        if tokio::time::timeout(Duration::from_secs(3), self._child.wait())
            .await
            .is_err()
        {
            let _ = self._child.kill().await;
        }
    }
    async fn launch(profile: PathBuf) -> Result<Self> {
        tokio::fs::create_dir_all(&profile).await?;
        let port_file = profile.join("DevToolsActivePort");
        if port_file.exists() {
            tokio::fs::remove_file(&port_file).await?;
        }
        let executable =
            std::env::var("OXROUTE_BROWSER_EXECUTABLE").unwrap_or_else(|_| "chromium".into());
        let mut command = Command::new(&executable);
        if std::env::var("OXROUTE_BROWSER_SANDBOX").as_deref() == Ok("false") {
            command.arg("--no-sandbox");
        }
        let mut child = command.args(["--headless=new", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", "--no-first-run", "--disable-dev-shm-usage", "--window-size=1280,800", "--restore-last-session"])
            .arg(format!("--user-data-dir={}", profile.display()))
            .arg("about:blank")
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .kill_on_drop(true).spawn().with_context(|| format!("Starting {executable}; set OXROUTE_BROWSER_EXECUTABLE to an installed Chromium executable"))?;
        let port = tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                if let Some(status) = child.try_wait()? { anyhow::bail!("Chromium exited ({status}); verify OXROUTE_BROWSER_EXECUTABLE and sandbox support"); }
                if let Ok(data) = tokio::fs::read_to_string(&port_file).await {
                    if let Some(port) = data.lines().next().and_then(|s| s.parse::<u16>().ok()) { return Ok::<_, anyhow::Error>(port); }
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }).await.context("Chromium startup timed out")??;
        let targets: Vec<Value> = reqwest::Client::new()
            .get(format!("http://127.0.0.1:{port}/json/list"))
            .send()
            .await?
            .json()
            .await?;
        let target = targets
            .iter()
            .find(|v| v["type"] == "page")
            .context("Chromium has no page")?;
        let (socket, _) = connect_async(
            target["webSocketDebuggerUrl"]
                .as_str()
                .context("Missing browser socket")?,
        )
        .await?;
        let mut live = Self {
            _child: child,
            socket,
            sequence: 0,
            port,
            target: target["id"].as_str().context("Missing page id")?.into(),
        };
        live.call(
            "Emulation.setDeviceMetricsOverride",
            json!({"width":WIDTH,"height":HEIGHT,"deviceScaleFactor":1,"mobile":false}),
        )
        .await?;
        live.call("Page.enable", json!({})).await?;
        Ok(live)
    }
    async fn select(&mut self, target: &str) -> Result<()> {
        let targets: Vec<Value> = reqwest::Client::new()
            .get(format!("http://127.0.0.1:{}/json/list", self.port))
            .send()
            .await?
            .json()
            .await?;
        let page = targets
            .iter()
            .find(|v| v["id"] == target && v["type"] == "page")
            .context("No such tab")?;
        let (socket, _) = connect_async(
            page["webSocketDebuggerUrl"]
                .as_str()
                .context("Missing tab socket")?,
        )
        .await?;
        self.socket = socket;
        self.target = target.into();
        self.call(
            "Emulation.setDeviceMetricsOverride",
            json!({"width":WIDTH,"height":HEIGHT,"deviceScaleFactor":1,"mobile":false}),
        )
        .await?;
        Ok(())
    }
    async fn metadata(&mut self) -> Result<Value> {
        let result = self.call("Target.getTargets", json!({})).await?;
        let tabs: Vec<Value> = result["targetInfos"]
            .as_array()
            .context("Missing browser tabs")?
            .iter()
            .filter(|tab| tab["type"] == "page")
            .map(|tab| json!({"id":tab["targetId"],"url":tab["url"],"title":tab["title"]}))
            .collect();
        if !tabs.iter().any(|tab| tab["id"] == self.target) {
            if let Some(target) = tabs.first().and_then(|tab| tab["id"].as_str()) {
                self.select(target).await?;
            }
        }
        Ok(json!({"target":self.target,"tabs":tabs}))
    }
    async fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        self.sequence += 1;
        let id = self.sequence;
        tokio::time::timeout(Duration::from_secs(10), async {
            self.socket
                .send(Message::Text(
                    json!({"id":id,"method":method,"params":params}).to_string(),
                ))
                .await?;
            while let Some(message) = self.socket.next().await {
                let message = message?;
                if !message.is_text() {
                    continue;
                }
                let response: Value = serde_json::from_str(message.to_text()?)?;
                if response["id"] != id {
                    continue;
                }
                ensure!(
                    response.get("error").is_none(),
                    "Browser: {}",
                    response["error"]
                );
                return Ok(response["result"].clone());
            }
            anyhow::bail!("Browser disconnected")
        })
        .await
        .context("Browser operation timed out")?
    }
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Credentials {
    #[serde(default)]
    agent_id: String,
    #[serde(default)]
    controller: String,
}

async fn list(State(state): BrowserState) -> Result<Json<Vec<Info>>, Failed> {
    let sessions = state.sessions.lock().await;
    let mut result = Vec::new();
    for session in sessions.values() {
        result.push(session.lock().await.record.info.clone());
    }
    Ok(Json(result))
}
async fn info(State(state): BrowserState, Path(id): Path<String>) -> Result<Json<Value>, Failed> {
    let session = state.session(&id).await?;
    let mut session = session.lock().await;
    let mut info = serde_json::to_value(&session.record.info)?;
    let metadata = session.live(state.profile(&id)).await?.metadata().await?;
    info.as_object_mut()
        .unwrap()
        .extend(metadata.as_object().unwrap().clone());
    Ok(Json(info))
}
async fn create(
    State(state): BrowserState,
    Json(body): Json<Credentials>,
) -> Result<Json<Info>, Failed> {
    (!body.agent_id.is_empty())
        .then_some(())
        .context("A browser needs a conversation")?;
    state
        .hub
        .store
        .agent(&body.agent_id)?
        .context("No such agent")?;
    let mut sessions = state.sessions.lock().await;
    for session in sessions.values() {
        let session = session.lock().await;
        if session.record.info.agent_id == body.agent_id {
            return Ok(Json(session.record.info.clone()));
        }
    }
    let info = Info {
        id: new_id("browser"),
        name: "Browser".into(),
        agent_id: body.agent_id,
        human: false,
    };
    let mut session = Session {
        record: Record {
            info: info.clone(),
            controller: new_id("control"),
        },
        live: None,
        closed: false,
    };
    session.live(state.profile(&info.id)).await?;
    sessions.insert(info.id.clone(), Arc::new(Mutex::new(session)));
    drop(sessions);
    state.save().await?;
    Ok(Json(info))
}
// Human-only adoption, following the terminal pane's controller credential model.
async fn claim(State(state): BrowserState, Path(id): Path<String>) -> Result<Json<Value>, Failed> {
    let session = state.session(&id).await?;
    let session = session.lock().await;
    Ok(Json(json!({"controller": session.record.controller})))
}
#[derive(Deserialize)]
struct Control {
    controller: String,
    human: bool,
}
async fn control(
    State(state): BrowserState,
    Path(id): Path<String>,
    Json(body): Json<Control>,
) -> Result<Json<Info>, Failed> {
    let session = state.session(&id).await?;
    let mut session = session.lock().await;
    session.owner(&body.controller)?;
    let resume = session.record.info.human && !body.human;
    session.record.info.human = body.human;
    let info = session.record.info.clone();
    drop(session);
    state.save().await?;
    if resume {
        let hub = state.hub.clone();
        let agent = info.agent_id.clone();
        let receipt = new_id("browser-resume");
        tokio::spawn(async move {
            let prompt = format!("The user clicked Resume agent for browser {id}. Inspect its current state and continue the browser task already authorized. The user may have changed the page. Check control before acting; this adds no permission to publish, send messages or perform unrelated actions.");
            if let Err(error) = hub
                .wake_once(&agent, &receipt, &prompt, "Browser returned to agent")
                .await
            {
                tracing::warn!(%error, "Could not resume browser agent");
            }
        });
    }
    Ok(Json(info))
}
async fn close(
    State(state): BrowserState,
    Path(id): Path<String>,
    Json(body): Json<Credentials>,
) -> Result<Json<Value>, Failed> {
    let session = state.session(&id).await?;
    let mut session = session.lock().await;
    session.owner(&body.controller)?;
    session.closed = true;
    if let Some(live) = session.live.take() {
        live.shutdown().await;
    }
    drop(session);
    state.sessions.lock().await.remove(&id);
    state.save().await?;
    Ok(Json(json!({"ok":true})))
}
async fn frame(
    State(state): BrowserState,
    Path(id): Path<String>,
) -> Result<([(header::HeaderName, &'static str); 2], Vec<u8>), Failed> {
    let session = state.session(&id).await?;
    let mut session = session.lock().await;
    let result = session
        .live(state.profile(&id))
        .await?
        .call(
            "Page.captureScreenshot",
            json!({"format":"jpeg","quality":75}),
        )
        .await?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(result["data"].as_str().context("Missing browser image")?)?;
    Ok((
        [
            (header::CONTENT_TYPE, "image/jpeg"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        bytes,
    ))
}
async fn snapshot(
    State(state): BrowserState,
    Path(id): Path<String>,
) -> Result<Json<Value>, Failed> {
    let session = state.session(&id).await?;
    let mut session = session.lock().await;
    let live = session.live(state.profile(&id)).await?;
    let page = live
        .call(
            "Runtime.evaluate",
            json!({"expression":"({url:location.href,title:document.title})","returnByValue":true}),
        )
        .await?;
    let tree = live.call("Accessibility.getFullAXTree", json!({})).await?;
    Ok(Json(
        json!({"browser":session.record.info,"page":page["result"]["value"],"nodes":tree["nodes"],"width":WIDTH,"height":HEIGHT}),
    ))
}
#[derive(Deserialize)]
struct Action {
    #[serde(flatten)]
    credentials: Credentials,
    #[serde(flatten)]
    input: Input,
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
enum Input {
    NewTab,
    SelectTab {
        target: String,
    },
    CloseTab {
        target: String,
    },
    Navigate {
        url: String,
    },
    Click {
        x: f64,
        y: f64,
    },
    Move {
        x: f64,
        y: f64,
    },
    Type {
        text: String,
    },
    Key {
        key: String,
        #[serde(default)]
        modifiers: u8,
    },
    Scroll {
        x: f64,
        y: f64,
        #[serde(rename = "deltaX", default)]
        delta_x: f64,
        #[serde(rename = "deltaY")]
        delta_y: f64,
    },
    Back,
    Forward,
    Reload,
}
async fn action(
    State(state): BrowserState,
    Path(id): Path<String>,
    Json(body): Json<Action>,
) -> Result<Json<Value>, Failed> {
    let session = state.session(&id).await?;
    let mut session = session.lock().await;
    // Authorization and execution share the same lock as takeover, so no agent
    // action can execute after the human receives the takeover acknowledgement.
    session.authorize(&body.credentials)?;
    if !body.credentials.controller.is_empty() {
        session
            .record
            .info
            .human
            .then_some(())
            .context("Take control before interacting")?;
    }
    let live = session.live(state.profile(&id)).await?;
    perform(live, body.input).await?;
    Ok(Json(json!({"ok":true})))
}
async fn perform(live: &mut Live, input: Input) -> Result<()> {
    match input {
        Input::NewTab => {
            let result = live
                .call("Target.createTarget", json!({"url":"about:blank"}))
                .await?;
            live.select(result["targetId"].as_str().context("Missing new tab")?)
                .await?;
        }
        Input::SelectTab { target } => live.select(&target).await?,
        Input::CloseTab { target } => {
            let tabs = live.metadata().await?;
            ensure!(
                tabs["tabs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|tab| tab["id"] == target),
                "No such tab"
            );
            ensure!(
                tabs["tabs"].as_array().unwrap().len() > 1,
                "Use End browser to close the last tab"
            );
            if target == live.target {
                let other = tabs["tabs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|tab| tab["id"] != target)
                    .unwrap();
                live.select(other["id"].as_str().unwrap()).await?;
            }
            live.call("Target.closeTarget", json!({"targetId":target}))
                .await?;
        }
        Input::Navigate { url } => {
            let parsed = reqwest::Url::parse(&url)?;
            ensure!(
                matches!(parsed.scheme(), "http" | "https") || url == "about:blank",
                "Use an http or https URL"
            );
            let result = live.call("Page.navigate", json!({"url":url})).await?;
            ensure!(
                result.get("errorText").is_none(),
                "Navigation: {}",
                result["errorText"]
            );
        }
        Input::Click { x, y } => {
            for kind in ["mousePressed", "mouseReleased"] {
                live.call(
                    "Input.dispatchMouseEvent",
                    json!({"type":kind,"x":x,"y":y,"button":"left","clickCount":1}),
                )
                .await?;
            }
        }
        Input::Move { x, y } => {
            live.call(
                "Input.dispatchMouseEvent",
                json!({"type":"mouseMoved","x":x,"y":y}),
            )
            .await?;
        }
        Input::Type { text } => {
            live.call("Input.insertText", json!({"text":text})).await?;
        }
        Input::Key { key, modifiers } => {
            let code = match key.as_str() {
                "Backspace" => 8,
                "Tab" => 9,
                "Enter" => 13,
                "Escape" => 27,
                " " => 32,
                "PageUp" => 33,
                "PageDown" => 34,
                "End" => 35,
                "Home" => 36,
                "ArrowLeft" => 37,
                "ArrowUp" => 38,
                "ArrowRight" => 39,
                "ArrowDown" => 40,
                "Delete" => 46,
                _ if key.len() == 1 => key.to_ascii_uppercase().as_bytes()[0] as u32,
                _ => anyhow::bail!("Unsupported key"),
            };
            for kind in ["keyDown", "keyUp"] {
                live.call("Input.dispatchKeyEvent", json!({"type":kind,"key":key,"windowsVirtualKeyCode":code,"modifiers":modifiers,"text":if key == "Enter" { "\r" } else { "" }})).await?;
            }
        }
        Input::Scroll {
            x,
            y,
            delta_x,
            delta_y,
        } => {
            live.call(
                "Input.dispatchMouseEvent",
                json!({"type":"mouseWheel","x":x,"y":y,"deltaX":delta_x,"deltaY":delta_y}),
            )
            .await?;
        }
        Input::Back | Input::Forward => {
            let history = live.call("Page.getNavigationHistory", json!({})).await?;
            let index = history["currentIndex"].as_i64().unwrap_or(0)
                + if matches!(input, Input::Back) { -1 } else { 1 };
            if let Some(entry) = index
                .try_into()
                .ok()
                .and_then(|i: usize| history["entries"].get(i))
            {
                live.call(
                    "Page.navigateToHistoryEntry",
                    json!({"entryId":entry["id"]}),
                )
                .await?;
            }
        }
        Input::Reload => {
            live.call("Page.reload", json!({})).await?;
        }
    }
    Ok(())
}
