use crate::Failed;
use anyhow::{Context, Result};
use axum::{
    extract::{Path, Query, State},
    routing::{get, post},
    Json, Router,
};
use oxroute_core::{model::new_id, Hub};
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
        .route("/api/terminals/{id}/access", post(request_access))
        .route("/api/terminals/{id}/consent", post(consent))
        .with_state(terminals))
}
impl Terminals {
    fn save(&self, records: &[Record]) -> Result<()> {
        self.hub.store.set(KEY, &serde_json::to_string(records)?)?;
        self.changed.notify_waiters();
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
            },
        );
        Ok(())
    }
    fn control(&self, id: &str, token: &str) -> Result<Record> {
        let record = self.record(id)?;
        anyhow::ensure!(
            !token.is_empty() && record.controller == token,
            "Terminal owner authorization required"
        );
        Ok(record)
    }
    fn write(&self, id: &str, data: &str, controller: &str, agent: &str) -> Result<()> {
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
        terminal.writer.write_all(data.as_bytes())?;
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
async fn create(State(state): TermState) -> Result<Json<Value>, Failed> {
    let id = new_id("terminal");
    let terminal = Terminal {
        name: format!("Terminal {}", &id[id.len() - 6..]),
        id,
        granted: vec![],
        pending: vec![],
    };
    let controller = new_id("control");
    {
        let mut records = state.records.lock().unwrap();
        records.push(Record {
            terminal: terminal.clone(),
            controller: controller.clone(),
        });
        state.save(&records)?;
    }
    state.attach(&terminal.id)?;
    Ok(Json(
        json!({"terminal": terminal, "controller": controller}),
    ))
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
    state.write(&id, &body.data, &body.controller, &body.agent_id)?;
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
    record
        .terminal
        .pending
        .retain(|agent| agent != &body.agent_id);
    record
        .terminal
        .granted
        .retain(|agent| agent != &body.agent_id);
    if body.allow {
        record.terminal.granted.push(body.agent_id);
    }
    let result = record.terminal.clone();
    state.save(&records)?;
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
        let hub = Hub::new(config, store);
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
        server.abort();
        std::fs::remove_dir_all(root).unwrap();
    }
}
