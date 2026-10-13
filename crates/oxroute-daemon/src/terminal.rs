use crate::Failed;
use anyhow::{Context, Result};
use axum::{
    extract::{Path, Query, State},
    routing::{get, post},
    Json, Router,
};
use oxroute_core::{
    model::{new_id, Event},
    Hub,
};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    io::{Read, Write},
    sync::{Arc, Mutex},
};

const KEY: &str = "terminal-panes";
const LIMIT: usize = 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Terminal {
    id: String,
    name: String,
    granted: Vec<String>,
    pending: Vec<String>,
    #[serde(default)]
    agent_id: String,
}
#[derive(Clone, Serialize, Deserialize)]
struct Record {
    terminal: Terminal,
    controller: String,
}
#[derive(Default)]
struct Output {
    bytes: VecDeque<u8>,
    end: u64,
}
struct Live {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    output: Arc<Mutex<Output>>,
    _child: Box<dyn portable_pty::Child + Send + Sync>,
    scrolling: bool,
}
struct Terminals {
    hub: Arc<Hub>,
    socket: String,
    records: Mutex<Vec<Record>>,
    live: Mutex<HashMap<String, Live>>,
    changed: Arc<tokio::sync::Notify>,
}
type TermState = State<Arc<Terminals>>;

pub fn routes(hub: Arc<Hub>) -> Result<Router> {
    let records = hub
        .store
        .get(KEY)?
        .map(|data| serde_json::from_str(&data))
        .transpose()?
        .unwrap_or_default();
    let terminals = Arc::new(Terminals {
        socket: format!("oxroute-terminals-{}", hub.config.listen.replace(':', "_")),
        hub,
        records: Mutex::new(records),
        live: Mutex::new(HashMap::new()),
        changed: Arc::new(tokio::sync::Notify::new()),
    });
    Ok(Router::new()
        .route("/api/terminals", get(list).post(create))
        .route("/api/terminals/{id}", get(output).delete(end))
        .route("/api/terminals/{id}/input", post(input))
        .route("/api/terminals/{id}/resize", post(resize))
        .route("/api/terminals/{id}/scroll", post(scroll))
        .route("/api/terminals/{id}/access", post(request_access))
        .route("/api/terminals/{id}/claim", post(claim))
        .route("/api/terminals/{id}/consent", post(consent))
        .with_state(terminals))
}
impl Terminals {
    fn save(&self, records: &[Record]) -> Result<()> {
        self.hub.store.set(KEY, &serde_json::to_string(records)?)?;
        self.changed.notify_waiters();
        self.hub.emit(Event::Sync);
        Ok(())
    }
    fn record(&self, id: &str) -> Result<Record> {
        self.records
            .lock()
            .unwrap()
            .iter()
            .find(|r| r.terminal.id == id)
            .cloned()
            .context("No such terminal")
    }
    fn attach(&self, id: &str) -> Result<()> {
        self.record(id)?;
        let mut live = self.live.lock().unwrap();
        if live.contains_key(id) {
            return Ok(());
        }
        let exists = std::process::Command::new("tmux")
            .args(["-L", &self.socket, "has-session", "-t", id])
            .output()?
            .status
            .success();
        if !exists {
            let started = std::process::Command::new("tmux")
                .args([
                    "-L",
                    &self.socket,
                    "new-session",
                    "-d",
                    "-s",
                    id,
                    "-c",
                    &self.hub.config.workspace,
                ])
                .output()?;
            anyhow::ensure!(
                started.status.success(),
                "Starting terminal: {}",
                String::from_utf8_lossy(&started.stderr)
            );
        }
        for options in [
            ["set-option", "status", "off"],
            ["set-window-option", "window-size", "manual"],
        ] {
            let configured = std::process::Command::new("tmux")
                .args([
                    "-L",
                    &self.socket,
                    options[0],
                    "-t",
                    id,
                    options[1],
                    options[2],
                ])
                .output()?;
            anyhow::ensure!(
                configured.status.success(),
                "Configuring terminal: {}",
                String::from_utf8_lossy(&configured.stderr)
            );
        }
        let pair = native_pty_system().openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        let mut command = CommandBuilder::new("tmux");
        command.args(["-L", &self.socket, "attach-session", "-t", id]);
        command.env("TERM", "xterm-256color");
        let child = pair.slave.spawn_command(command)?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let output = Arc::new(Mutex::new(Output::default()));
        let captured = output.clone();
        let changed = self.changed.clone();
        std::thread::spawn(move || {
            let mut bytes = [0; 8192];
            while let Ok(count) = reader.read(&mut bytes) {
                if count == 0 {
                    break;
                }
                let mut output = captured.lock().unwrap();
                output.bytes.extend(&bytes[..count]);
                output.end += count as u64;
                while output.bytes.len() > LIMIT {
                    output.bytes.pop_front();
                }
                drop(output);
                changed.notify_waiters();
            }
        });
        live.insert(
            id.to_owned(),
            Live {
                master: pair.master,
                writer,
                output,
                _child: child,
                scrolling: self
                    .tmux(id, &["display-message", "-p", "#{@oxroute-scrolling}"])?
                    .trim()
                    == "1",
            },
        );
        Ok(())
    }
    fn tmux(&self, id: &str, args: &[&str]) -> Result<String> {
        let output = std::process::Command::new("tmux")
            .args(["-L", &self.socket, args[0], "-t", id])
            .args(&args[1..])
            .output()?;
        anyhow::ensure!(
            output.status.success(),
            "tmux: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }
    fn control(&self, id: &str, token: &str) -> Result<Record> {
        let record = self.record(id)?;
        anyhow::ensure!(
            !token.is_empty() && record.controller == token,
            "Terminal owner authorization required"
        );
        Ok(record)
    }
    fn write(&self, id: &str, data: &[u8], controller: &str, agent: &str) -> Result<()> {
        let record = self.record(id)?;
        if controller.is_empty() {
            anyhow::ensure!(
                !agent.is_empty()
                    && record
                        .terminal
                        .granted
                        .iter()
                        .any(|allowed| allowed == agent),
                "Request terminal access and wait for the user's approval"
            );
        } else {
            self.control(id, controller)?;
        }
        self.attach(id)?;
        let mut live = self.live.lock().unwrap();
        let terminal = live.get_mut(id).context("Terminal disconnected")?;
        if terminal.scrolling {
            if self
                .tmux(id, &["display-message", "-p", "#{pane_in_mode}"])?
                .trim()
                == "1"
            {
                self.tmux(id, &["send-keys", "-X", "cancel"])?;
            }
            self.tmux(id, &["set-option", "@oxroute-scrolling", "0"])?;
            terminal.scrolling = false;
        }
        terminal.writer.write_all(data)?;
        terminal.writer.flush()?;
        Ok(())
    }
}
async fn list(State(state): TermState) -> Json<Vec<Terminal>> {
    Json(
        state
            .records
            .lock()
            .unwrap()
            .iter()
            .map(|r| r.terminal.clone())
            .collect(),
    )
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Create {
    #[serde(default)]
    agent_id: String,
}
async fn create(State(state): TermState, Json(body): Json<Create>) -> Result<Json<Value>, Failed> {
    if !body.agent_id.is_empty() {
        if state.hub.store.agent(&body.agent_id)?.is_none() {
            return Err(anyhow::anyhow!("No such agent").into());
        }
    }
    let id = new_id("terminal");
    let terminal = Terminal {
        name: format!("Terminal {}", &id[id.len() - 6..]),
        id,
        granted: if body.agent_id.is_empty() {
            vec![]
        } else {
            vec![body.agent_id.clone()]
        },
        pending: vec![],
        agent_id: body.agent_id,
    };
    let controller = new_id("control");
    {
        let mut records = state.records.lock().unwrap();
        if !terminal.agent_id.is_empty()
            && records
                .iter()
                .filter(|r| r.terminal.agent_id == terminal.agent_id)
                .count()
                >= 2
        {
            return Err(anyhow::anyhow!(
                "This conversation already has two agent-created terminals"
            )
            .into());
        }
        records.push(Record {
            terminal: terminal.clone(),
            controller: controller.clone(),
        });
        state.save(&records)?;
    }
    if let Err(error) = state.attach(&terminal.id) {
        let mut records = state.records.lock().unwrap();
        records.retain(|r| r.terminal.id != terminal.id);
        state.save(&records)?;
        return Err(error.into());
    }
    Ok(Json(if terminal.agent_id.is_empty() {
        json!({"terminal": terminal, "controller": controller})
    } else {
        json!({"terminal": terminal})
    }))
}
// The human UI adopts an agent-created pane to retain typing, resize, end and revoke controls.
// Agent operations use agentId and never receive the browser controller credential.
async fn claim(State(state): TermState, Path(id): Path<String>) -> Result<Json<Value>, Failed> {
    let record = state.record(&id)?;
    if record.terminal.agent_id.is_empty() {
        return Err(anyhow::anyhow!("This is a user-created terminal").into());
    }
    Ok(Json(json!({"controller": record.controller})))
}
#[derive(Default, Deserialize)]
struct Position {
    #[serde(default)]
    after: u64,
    #[serde(default)]
    wait: bool,
}
async fn output(
    State(state): TermState,
    Path(id): Path<String>,
    Query(position): Query<Position>,
) -> Result<Json<Value>, Failed> {
    state.attach(&id)?;
    let notified = state.changed.notified();
    tokio::pin!(notified);
    notified.as_mut().enable();
    let mut response = output_snapshot(&state, &id, position.after)?;
    if position.wait
        && response["bytes"].as_array().unwrap().is_empty()
        && response["reset"] == false
    {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(20), notified).await;
        response = output_snapshot(&state, &id, position.after)?;
    }
    Ok(Json(response))
}

fn output_snapshot(state: &Terminals, id: &str, after: u64) -> Result<Value> {
    let record = state.record(id)?;
    let live = state.live.lock().unwrap();
    let output = live
        .get(id)
        .context("Terminal ended")?
        .output
        .lock()
        .unwrap();
    let start = output.end - output.bytes.len() as u64;
    let reset = after < start || after > output.end;
    let after = if reset { start } else { after };
    let bytes = output
        .bytes
        .range((after - start) as usize..)
        .copied()
        .collect::<Vec<_>>();
    Ok(json!({ "terminal": record.terminal, "bytes": bytes, "end": output.end, "reset": reset }))
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    #[serde(default)]
    binary: bool,
    #[serde(default)]
    data: String,
    #[serde(default)]
    controller: String,
    #[serde(default)]
    agent_id: String,
}
async fn input(
    State(state): TermState,
    Path(id): Path<String>,
    Json(body): Json<Input>,
) -> Result<Json<Value>, Failed> {
    let data = if body.binary {
        body.data
            .chars()
            .map(|c| u8::try_from(u32::from(c)))
            .collect::<std::result::Result<Vec<_>, _>>()?
    } else {
        body.data.into_bytes()
    };
    state.write(&id, &data, &body.controller, &body.agent_id)?;
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
struct Scroll {
    controller: String,
    lines: i32,
}
async fn scroll(
    State(state): TermState,
    Path(id): Path<String>,
    Json(body): Json<Scroll>,
) -> Result<Json<Value>, Failed> {
    state.control(&id, &body.controller)?;
    if body.lines == 0 {
        return Ok(Json(json!({"ok":true})));
    }
    state.attach(&id)?;
    let mut live = state.live.lock().unwrap();
    let terminal = live.get_mut(&id).context("Terminal disconnected")?;
    // Preserve wheel-key input in full-screen applications that own the inner screen.
    if !terminal.scrolling
        && state
            .tmux(&id, &["display-message", "-p", "#{alternate_on}"])?
            .trim()
            == "1"
    {
        state.tmux(
            &id,
            &["send-keys", if body.lines < 0 { "Up" } else { "Down" }],
        )?;
        return Ok(Json(json!({"ok":true})));
    }
    let in_mode = state
        .tmux(&id, &["display-message", "-p", "#{pane_in_mode}"])?
        .trim()
        == "1";
    if body.lines < 0 && !in_mode {
        state.tmux(&id, &["copy-mode", "-e"])?;
        state.tmux(&id, &["set-option", "@oxroute-scrolling", "1"])?;
        terminal.scrolling = true;
    } else if !in_mode {
        return Ok(Json(json!({"ok":true})));
    }
    let count = body.lines.unsigned_abs().min(1000).to_string();
    state.tmux(
        &id,
        &[
            "send-keys",
            "-X",
            "-N",
            &count,
            if body.lines < 0 {
                "scroll-up"
            } else {
                "scroll-down"
            },
        ],
    )?;
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
struct Size {
    controller: String,
    rows: u16,
    cols: u16,
}
async fn resize(
    State(state): TermState,
    Path(id): Path<String>,
    Json(body): Json<Size>,
) -> Result<Json<Value>, Failed> {
    state.control(&id, &body.controller)?;
    if body.rows == 0 || body.cols == 0 {
        return Err(anyhow::anyhow!("Terminal dimensions must be positive").into());
    }
    state.attach(&id)?;
    state
        .live
        .lock()
        .unwrap()
        .get(&id)
        .unwrap()
        .master
        .resize(PtySize {
            rows: body.rows,
            cols: body.cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
    let resized = std::process::Command::new("tmux")
        .args([
            "-L",
            &state.socket,
            "resize-window",
            "-t",
            &id,
            "-x",
            &body.cols.to_string(),
            "-y",
            &body.rows.to_string(),
        ])
        .output()?;
    if !resized.status.success() {
        return Err(anyhow::anyhow!(
            "Resizing terminal: {}",
            String::from_utf8_lossy(&resized.stderr)
        )
        .into());
    }
    Ok(Json(json!({"ok":true})))
}
async fn request_access(
    State(state): TermState,
    Path(id): Path<String>,
    Json(body): Json<Input>,
) -> Result<Json<Terminal>, Failed> {
    if state.hub.store.agent(&body.agent_id)?.is_none() {
        return Err(anyhow::anyhow!("No such agent").into());
    }
    let mut records = state.records.lock().unwrap();
    let record = records
        .iter_mut()
        .find(|r| r.terminal.id == id)
        .context("No such terminal")?;
    if !record.terminal.granted.contains(&body.agent_id)
        && !record.terminal.pending.contains(&body.agent_id)
    {
        record.terminal.pending.push(body.agent_id);
    }
    let result = record.terminal.clone();
    state.save(&records)?;
    Ok(Json(result))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Consent {
    controller: String,
    agent_id: String,
    allow: bool,
}
async fn consent(
    State(state): TermState,
    Path(id): Path<String>,
    Json(body): Json<Consent>,
) -> Result<Json<Terminal>, Failed> {
    state.control(&id, &body.controller)?;
    let (result, newly_allowed) = {
        let mut records = state.records.lock().unwrap();
        let record = records
            .iter_mut()
            .find(|r| r.terminal.id == id)
            .context("No such terminal")?;
        if !record.terminal.pending.contains(&body.agent_id)
            && !record.terminal.granted.contains(&body.agent_id)
        {
            return Err(anyhow::anyhow!("No access request for this agent").into());
        }
        let newly_allowed = body.allow && !record.terminal.granted.contains(&body.agent_id);
        record
            .terminal
            .pending
            .retain(|agent| agent != &body.agent_id);
        record
            .terminal
            .granted
            .retain(|agent| agent != &body.agent_id);
        if body.allow {
            record.terminal.granted.push(body.agent_id.clone());
        }
        let result = record.terminal.clone();
        state.save(&records)?;
        (result, newly_allowed)
    };
    if newly_allowed {
        state.hub.ask_quietly(
            &body.agent_id,
            &format!("The user granted you access to terminal {} ({}). Resume the terminal work you were waiting to do. This grant applies only to this terminal and does not authorize unrelated actions.", result.id, result.name),
            &format!("Terminal access granted: {}", result.name),
        ).await?;
    }
    Ok(Json(result))
}
async fn end(
    State(state): TermState,
    Path(id): Path<String>,
    Json(body): Json<Input>,
) -> Result<Json<Value>, Failed> {
    state.control(&id, &body.controller)?;
    let status = std::process::Command::new("tmux")
        .args(["-L", &state.socket, "kill-session", "-t", &id])
        .status()?;
    if !status.success() {
        return Err(anyhow::anyhow!("Could not end terminal session").into());
    }
    state.live.lock().unwrap().remove(&id);
    let mut records = state.records.lock().unwrap();
    records.retain(|r| r.terminal.id != id);
    state.save(&records)?;
    Ok(Json(json!({"ok":true})))
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxroute_core::{
        model::{AgentStatus, Backend},
        Agent, Config, Store,
    };
    async fn wait_output(
        client: &reqwest::Client,
        target: &str,
        mut after: u64,
        expected: &str,
    ) -> u64 {
        let mut text = String::new();
        for _ in 0..100 {
            let snapshot: Value = client
                .get(format!("{target}?after={after}"))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            let bytes: Vec<u8> = snapshot["bytes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n.as_u64().unwrap() as u8)
                .collect();
            text.push_str(&String::from_utf8_lossy(&bytes));
            after = snapshot["end"].as_u64().unwrap();
            if text.contains(expected) {
                return after;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("Expected {expected:?} in terminal output: {text:?}");
    }
    struct TerminalHarness(tokio::sync::mpsc::UnboundedSender<Vec<oxroute_core::model::TurnInput>>);
    #[async_trait::async_trait]
    impl oxroute_core::agent::Harness for TerminalHarness {
        fn backend(&self) -> Backend {
            Backend::Codex
        }
        fn capabilities(&self) -> oxroute_core::agent::Capabilities {
            oxroute_core::agent::Capabilities {
                fork: false,
                inject: false,
                resume: true,
            }
        }
        fn events(&self) -> tokio::sync::broadcast::Receiver<oxroute_core::agent::HarnessEvent> {
            tokio::sync::broadcast::channel(16).1
        }
        async fn open(&self, _: &oxroute_core::agent::SessionSpec) -> Result<String> {
            Ok("terminal-fixture-session".into())
        }
        async fn start(
            &self,
            _: &str,
            inputs: Vec<oxroute_core::model::TurnInput>,
        ) -> Result<String> {
            self.0.send(inputs).unwrap();
            Ok("terminal-fixture-turn".into())
        }
        async fn interrupt(&self, _: &str, _: &str) -> Result<()> {
            Ok(())
        }
    }
    #[tokio::test]
    async fn terminal_input_requires_owner_or_explicit_revocable_consent() {
        let root = std::env::temp_dir().join(new_id("terminal-test"));
        std::fs::create_dir(&root).unwrap();
        let config_file = root.join("config.toml");
        std::fs::write(&config_file, "owner = 'fixture'\n").unwrap();
        let mut config = Config::load_from(&config_file).unwrap();
        config.workspace = root.to_string_lossy().into();
        config.listen = "127.0.0.1:0".into();
        config.database = root.join("state.sqlite");
        let store = Store::open(&config.database).unwrap();
        for id in ["requester", "other-agent"] {
            store
                .save_agent(&Agent {
                    id: id.into(),
                    name: id.into(),
                    backend: Backend::Codex,
                    model: config.default_model.clone(),
                    session_id: String::new(),
                    cwd: config.workspace.clone(),
                    status: AgentStatus::Complete,
                    activity: String::new(),
                    permalink: String::new(),
                    last_activity: 0.0,
                    updated_at: 0.0,
                    stall_reason: None,
                    stall_alerted: false,
                    pinned: false,
                })
                .unwrap();
        }
        let (sent, mut notifications) = tokio::sync::mpsc::unbounded_channel();
        let mut hub = Hub::new(config, store);
        hub.with_harness(Arc::new(TerminalHarness(sent)));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/api/terminals", listener.local_addr().unwrap());
        let router = routes(hub.clone()).unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let client = reqwest::Client::new();
        let created: Value = client
            .post(&url)
            .json(&json!({}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let id = created["terminal"]["id"].as_str().unwrap();
        let controller = created["controller"].as_str().unwrap();
        let target = format!("{url}/{id}");
        assert!(!client
            .post(format!("{target}/input"))
            .json(&json!({"agentId":"requester","data":"printf unsafe\r"}))
            .send()
            .await
            .unwrap()
            .status()
            .is_success());
        assert!(!client
            .post(format!("{target}/input"))
            .json(&json!({"data":"printf unsafe\r"}))
            .send()
            .await
            .unwrap()
            .status()
            .is_success());
        let pending: Value = client
            .post(format!("{target}/access"))
            .json(&json!({"agentId":"requester"}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(pending["pending"], json!(["requester"]));
        assert!(!client
            .post(format!("{target}/consent"))
            .json(&json!({"controller":"wrong","agentId":"requester","allow":true}))
            .send()
            .await
            .unwrap()
            .status()
            .is_success());
        client
            .post(format!("{target}/consent"))
            .json(&json!({"controller":controller,"agentId":"requester","allow":true}))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        assert!(!client
            .post(format!("{target}/input"))
            .json(&json!({"agentId":"other-agent","data":"printf unsafe\r"}))
            .send()
            .await
            .unwrap()
            .status()
            .is_success());
        client
            .post(format!("{target}/resize"))
            .json(&json!({"controller":controller,"rows":31,"cols":93}))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        client
            .post(format!("{target}/input"))
            .json(&json!({"agentId":"requester","data":"printf '%s' 'term-' 'pty'; stty size\r"}))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        let mut seen = false;
        let notification =
            tokio::time::timeout(std::time::Duration::from_secs(2), notifications.recv())
                .await
                .unwrap()
                .unwrap();
        assert!(notification
            .iter()
            .filter_map(|input| input.as_text())
            .any(|text| text.contains(id) && text.contains("Resume")));
        let notices = hub.store.timeline("requester", 100).unwrap().len();
        client
            .post(format!("{target}/consent"))
            .json(&json!({"controller":controller,"agentId":"requester","allow":true}))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        assert_eq!(
            hub.store.timeline("requester", 100).unwrap().len(),
            notices,
            "Repeating an existing grant must not schedule another turn"
        );
        let mut captured = String::new();
        for _ in 0..50 {
            let result: Value = client
                .get(&target)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            let bytes = result["bytes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_u64().unwrap() as u8)
                .collect::<Vec<_>>();
            let text = String::from_utf8_lossy(&bytes);
            captured = text.to_string();
            if text.contains("term-pty") && text.contains("31 93") {
                seen = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(
            seen,
            "Real PTY output or resized terminal dimensions missing: {captured:?}"
        );
        client
            .post(format!("{target}/input"))
            .json(&json!({"controller": controller, "data": "seq -f 'history-%03g' 1 120\r"}))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        let tail = wait_output(&client, &target, 0, "history-120").await;
        client
            .post(format!("{target}/scroll"))
            .json(&json!({"controller": controller, "lines": -1000}))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        let tail = wait_output(&client, &target, tail, "history-001").await;
        // Typing from history reaches the running shell, rather than copy-mode keys.
        client
            .post(format!("{target}/input"))
            .json(&json!({"controller": controller, "data": "printf 'back-to-shell\\n'\r"}))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        wait_output(&client, &target, tail, "back-to-shell\r\n").await;
        let listing = client.get(&url).send().await.unwrap().text().await.unwrap();
        assert!(
            !listing.contains(controller),
            "Owner credential leaked in terminal metadata"
        );
        client
            .post(format!("{target}/consent"))
            .json(&json!({"controller":controller,"agentId":"requester","allow":false}))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        assert!(!client
            .post(format!("{target}/input"))
            .json(&json!({"agentId":"requester","data":"printf unsafe\r"}))
            .send()
            .await
            .unwrap()
            .status()
            .is_success());
        assert!(!hub.store.get(KEY).unwrap().unwrap().contains("requester"));
        // Drain the shell prompt before checking that idle reads wait for changes.
        let mut end = 0;
        loop {
            let snapshot: Value = client
                .get(&target)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            let next = snapshot["end"].as_u64().unwrap();
            if next == end {
                break;
            }
            end = next;
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let waiting_client = client.clone();
        let waiting_url = format!("{target}?after={end}&wait=true");
        let waiting = tokio::spawn(async move {
            waiting_client
                .get(waiting_url)
                .send()
                .await
                .unwrap()
                .json::<Value>()
                .await
                .unwrap()
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(!waiting.is_finished(), "Idle output reads should wait");
        client
            .post(format!("{target}/access"))
            .json(&json!({"agentId":"requester"}))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        let update = tokio::time::timeout(std::time::Duration::from_secs(1), waiting)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(update["terminal"]["pending"], json!(["requester"]));
        assert_eq!(update["bytes"], json!([]));
        client
            .delete(&target)
            .json(&json!({"controller":controller}))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        let missing = client
            .post(&url)
            .json(&json!({"agentId":"missing"}))
            .send()
            .await
            .unwrap();
        assert!(!missing.status().is_success());
        let mut opened = Vec::new();
        for _ in 0..2 {
            let created: Value = client
                .post(&url)
                .json(&json!({"agentId":"requester"}))
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap()
                .json()
                .await
                .unwrap();
            assert!(
                created.get("controller").is_none(),
                "Agent must not receive browser credentials"
            );
            assert_eq!(created["terminal"]["agentId"], "requester");
            assert_eq!(created["terminal"]["granted"], json!(["requester"]));
            opened.push(created["terminal"]["id"].as_str().unwrap().to_owned());
        }
        assert!(!client
            .post(&url)
            .json(&json!({"agentId":"requester"}))
            .send()
            .await
            .unwrap()
            .status()
            .is_success());
        let owned = format!("{url}/{}", opened[0]);
        client
            .post(format!("{owned}/input"))
            .json(&json!({"agentId":"requester","data":"printf agent-owned\r"}))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        assert!(!client
            .post(format!("{owned}/input"))
            .json(&json!({"agentId":"other-agent","data":"printf unauthorized\r"}))
            .send()
            .await
            .unwrap()
            .status()
            .is_success());
        // The limit belongs to the creator, and human-created terminals are unaffected.
        for body in [json!({"agentId":"other-agent"}), json!({})] {
            let created: Value = client
                .post(&url)
                .json(&body)
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap()
                .json()
                .await
                .unwrap();
            let terminal_id = created["terminal"]["id"].as_str().unwrap();
            let controller = if body.get("agentId").is_some() {
                client
                    .post(format!("{url}/{terminal_id}/claim"))
                    .json(&json!({}))
                    .send()
                    .await
                    .unwrap()
                    .error_for_status()
                    .unwrap()
                    .json::<Value>()
                    .await
                    .unwrap()["controller"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            } else {
                created["controller"].as_str().unwrap().to_owned()
            };
            client
                .delete(format!("{url}/{terminal_id}"))
                .json(&json!({"controller":controller}))
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap();
        }
        for terminal_id in &opened {
            let owner: Value = client
                .post(format!("{url}/{terminal_id}/claim"))
                .json(&json!({}))
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap()
                .json()
                .await
                .unwrap();
            let target = format!("{url}/{terminal_id}");
            // Human revocation protects a pane taken over by the user.
            client
                .post(format!("{target}/consent"))
                .json(
                    &json!({"controller":owner["controller"],"agentId":"requester","allow":false}),
                )
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap();
            assert!(!client
                .post(format!("{target}/input"))
                .json(&json!({"agentId":"requester","data":"printf revoked\r"}))
                .send()
                .await
                .unwrap()
                .status()
                .is_success());
            client
                .delete(&target)
                .json(&json!({"controller":owner["controller"]}))
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap();
        }
        // Ending a pane frees a slot.
        let replacement: Value = client
            .post(&url)
            .json(&json!({"agentId":"requester"}))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        let target = format!("{url}/{}", replacement["terminal"]["id"].as_str().unwrap());
        let owner: Value = client
            .post(format!("{target}/claim"))
            .json(&json!({}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        client
            .delete(&target)
            .json(&json!({"controller":owner["controller"]}))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        server.abort();
        std::fs::remove_dir_all(root).unwrap();
    }
}
