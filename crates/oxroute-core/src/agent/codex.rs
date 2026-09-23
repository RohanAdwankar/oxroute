//! Codex, driven through its app-server.
//!
//! The app-server is a separate durable service. oxroute reaches it over a
//! loopback WebSocket, so replacing this daemon leaves Codex turns alone.
//!
//! JSON-RPC on stdin and stdout, one long-lived process for the whole fleet.
//! Threads are the sessions; every agent oxroute runs on Codex is one Codex
//! thread, and the process holds all of them at once.
//!
//! This is the harness that can steer: `turn/steer` folds input into a turn
//! that is already running, which is why a Codex agent reads differently from
//! a Claude Code one in the UI.
//!
//! The process is supervised lazily. If it exits, every in-flight request
//! fails at once with the reason, a `Down` event goes out so the hub can
//! stall what it thought was running, and the next call starts a fresh one.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::sync::{broadcast, oneshot, Mutex as AsyncMutex};

use super::{Capabilities, Harness, HarnessEvent, RecoveredTurn, SessionSpec};
use crate::model::{Backend, ConversationLine, NativeSession, TurnInput};
use crate::rpc::JsonSocket;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const SHORT_TIMEOUT: Duration = Duration::from_secs(30);

/// Codex will not run without an approval policy and a sandbox. oxroute is an
/// unattended router: there is nobody at the keyboard to approve anything, so
/// asking would just wedge the turn. The isolation that matters is the VM.
const APPROVAL_POLICY: &str = "never";
const SANDBOX: &str = "danger-full-access";

/// Features a naming call has no use for. Turning them off is not an
/// optimisation -- a title model with web search and sub-agents enabled will
/// happily go and do the task instead of naming it.
const TITLE_FEATURES: &[&str] = &[
    "apps",
    "code_mode",
    "code_mode_only",
    "current_time_reminder",
    "deferred_executor",
    "enable_fanout",
    "goals",
    "hooks",
    "image_generation",
    "memories",
    "multi_agent",
    "multi_agent_v2",
    "plugins",
    "request_permissions_tool",
    "shell_snapshot",
    "shell_tool",
    "standalone_web_search",
    "token_budget",
    "tool_suggest",
    "unified_exec",
    "view_image",
];

pub struct CodexHarness {
    url: String,
    default_cwd: String,
    reasoning_effort: String,
    title_model: String,
    search_binary: PathBuf,
    session_index: PathBuf,
    inner: AsyncMutex<Option<Arc<Connection>>>,
    events: broadcast::Sender<HarnessEvent>,
}

/// One live app-server process and everything waiting on it.
struct Connection {
    socket: AsyncMutex<JsonSocket>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    /// Set once, when the process is gone. Every later call fails with it
    /// rather than hanging on a pipe nobody is reading.
    failure: Mutex<Option<String>>,
    /// Sessions opened purely to name something. Their traffic is noise to
    /// the hub, so it never leaves this module.
    private: Mutex<HashMap<String, oneshot::Sender<String>>>,
    private_text: Mutex<HashMap<String, String>>,
}

impl Connection {
    fn fail(&self, reason: &str) -> bool {
        let mut failure = self.failure.lock().unwrap();
        if failure.is_some() {
            return false;
        }
        *failure = Some(reason.to_string());
        drop(failure);
        let waiting: Vec<_> = self.pending.lock().unwrap().drain().map(|(_, tx)| tx).collect();
        for tx in waiting {
            let _ = tx.send(json!({ "error": { "message": reason } }));
        }
        let private: Vec<_> = self.private.lock().unwrap().drain().map(|(_, tx)| tx).collect();
        for tx in private {
            let _ = tx.send(String::new());
        }
        true
    }

    fn failed(&self) -> Option<String> {
        self.failure.lock().unwrap().clone()
    }
}

impl CodexHarness {
    pub fn new(config: &crate::config::Config) -> Self {
        let search_binary = std::fs::canonicalize(&config.codex_binary)
            .ok()
            .and_then(|binary| binary.parent()?.parent().map(|root| root.join("codex-path/rg")))
            .filter(|binary| binary.is_file())
            .unwrap_or_else(|| PathBuf::from("rg"));
        CodexHarness {
            url: config.codex_url.clone(),
            default_cwd: config.workspace_path().to_string_lossy().to_string(),
            reasoning_effort: config.codex_effort.clone(),
            title_model: config.title_model.clone(),
            search_binary,
            session_index: std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_default()
                .join(".codex/session_index.jsonl"),
            inner: AsyncMutex::new(None),
            events: broadcast::channel(2048).0,
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<HarnessEvent> {
        self.events.subscribe()
    }

    /// The live connection, started if there is not one.
    async fn connection(&self) -> Result<Arc<Connection>> {
        let mut slot = self.inner.lock().await;
        if let Some(existing) = slot.as_ref() {
            if existing.failed().is_none() {
                return Ok(existing.clone());
            }
        }

        let (socket, mut lines) = JsonSocket::connect(&self.url).await?;

        let connection = Arc::new(Connection {
            socket: AsyncMutex::new(socket),
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            failure: Mutex::new(None),
            private: Mutex::new(HashMap::new()),
            private_text: Mutex::new(HashMap::new()),
        });

        let reader = connection.clone();
        let events = self.events.clone();
        tokio::spawn(async move {
            while let Some(message) = lines.recv().await {
                dispatch(&reader, &events, message);
            }
            if reader.fail("the Codex app-server exited") {
                let _ = events.send(HarnessEvent::Down {
                    message: "the Codex app-server exited".into(),
                });
            }
        });

        *slot = Some(connection.clone());
        drop(slot);

        connection
            .request(
                "initialize",
                json!({
                    "clientInfo": { "name": "oxroute", "title": "oxroute", "version": "0.1.0" },
                    "capabilities": { "experimentalApi": true },
                }),
                SHORT_TIMEOUT,
            )
            .await
            .context("initializing the Codex app-server")?;
        connection.notify("initialized", json!({}))?;
        Ok(connection)
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        self.request_within(method, params, REQUEST_TIMEOUT).await
    }

    async fn request_within(&self, method: &str, params: Value, within: Duration) -> Result<Value> {
        let connection = self.connection().await?;
        connection.request(method, params, within).await
    }

    /// The shared half of `thread/start` and `thread/resume`.
    fn thread_options(&self, spec: &SessionSpec) -> Value {
        json!({
            "cwd": if spec.cwd.is_empty() { &self.default_cwd } else { &spec.cwd },
            "approvalPolicy": APPROVAL_POLICY,
            "sandbox": SANDBOX,
            "model": spec.model,
            "config": { "model_reasoning_effort": self.reasoning_effort },
        })
    }

    /// Ask Codex what its effective config is, so a naming session can switch
    /// off exactly the MCP servers this install actually has.
    async fn title_config(&self, cwd: &str) -> Value {
        let mut config = serde_json::Map::new();
        for feature in TITLE_FEATURES {
            config.insert(format!("features.{feature}"), json!(false));
        }
        for (key, value) in [
            ("orchestrator.skills.enabled", json!(false)),
            ("skills.include_instructions", json!(false)),
            ("token_budget.use_history_notes_extension", json!(false)),
            ("tools.experimental_request_user_input.enabled", json!(false)),
            ("tools.update_plan.enabled", json!(false)),
            ("web_search", json!("disabled")),
        ] {
            config.insert(key.into(), value);
        }
        let effective = self
            .request_within(
                "config/read",
                json!({ "includeLayers": false, "cwd": cwd }),
                SHORT_TIMEOUT,
            )
            .await
            .ok();
        let servers = effective
            .as_ref()
            .and_then(|v| v.pointer("/config/mcp_servers"))
            .and_then(Value::as_object)
            .map(|servers| {
                servers
                    .keys()
                    .map(|name| (name.clone(), json!({ "enabled": false })))
                    .collect::<serde_json::Map<_, _>>()
            })
            .unwrap_or_default();
        config.insert("mcp_servers".into(), Value::Object(servers));
        Value::Object(config)
    }
}

impl Connection {
    async fn request(&self, method: &str, params: Value, within: Duration) -> Result<Value> {
        if let Some(reason) = self.failed() {
            anyhow::bail!("{reason}");
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);

        let sent = {
            let socket = self.socket.lock().await;
            socket.send(&json!({ "id": id, "method": method, "params": params }))
        };
        if let Err(error) = sent {
            self.pending.lock().unwrap().remove(&id);
            self.fail(&error.to_string());
            return Err(error);
        }

        let reply = match tokio::time::timeout(within, rx).await {
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                anyhow::bail!("Codex did not answer {method} within {}s", within.as_secs());
            }
            Ok(Err(_)) => anyhow::bail!("Codex dropped the reply to {method}"),
            Ok(Ok(value)) => value,
        };
        if let Some(error) = reply.get("error") {
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("unknown error");
            anyhow::bail!("{message}");
        }
        Ok(reply.get("result").cloned().unwrap_or(Value::Null))
    }

    fn notify(&self, method: &str, params: Value) -> Result<()> {
        let socket = self.socket.try_lock();
        match socket {
            Ok(socket) => socket.send(&json!({ "method": method, "params": params })),
            Err(_) => Err(anyhow!("the Codex app-server is busy")),
        }
    }

    fn respond_error(&self, id: &Value, message: &str) {
        if let Ok(socket) = self.socket.try_lock() {
            let _ = socket.send(&json!({
                "id": id,
                "error": { "code": -32601, "message": message },
            }));
        }
    }
}

/// Turn one line from the app-server into either a resolved request, a
/// private naming result, or a `HarnessEvent`.
fn dispatch(connection: &Arc<Connection>, events: &broadcast::Sender<HarnessEvent>, message: Value) {
    let id = message.get("id");
    let method = message.get("method").and_then(Value::as_str);

    // A server->client request. oxroute runs unattended, so the honest answer
    // to "may I?" is that there is nobody here to ask.
    if let (Some(id), Some(method)) = (id, method) {
        connection.respond_error(
            id,
            &format!("oxroute runs unattended and cannot answer {method}"),
        );
        return;
    }

    if let Some(id) = id.and_then(Value::as_u64) {
        let waiting = connection.pending.lock().unwrap().remove(&id);
        if let Some(tx) = waiting {
            let _ = tx.send(message);
        }
        return;
    }

    let Some(method) = method else { return };
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let Some(session) = params.get("threadId").and_then(Value::as_str) else {
        return;
    };
    let session = session.to_string();

    // Naming sessions are ours. Collect their answer and tell nobody.
    let is_private = connection.private.lock().unwrap().contains_key(&session);
    if is_private {
        match method {
            "item/completed" => {
                let item = params.get("item").cloned().unwrap_or(Value::Null);
                if item.get("type").and_then(Value::as_str) == Some("agentMessage") {
                    if let Some(text) = item.get("text").and_then(Value::as_str) {
                        connection
                            .private_text
                            .lock()
                            .unwrap()
                            .insert(session.clone(), text.to_string());
                    }
                }
            }
            "turn/completed" => {
                let text = connection
                    .private_text
                    .lock()
                    .unwrap()
                    .remove(&session)
                    .unwrap_or_default();
                if let Some(tx) = connection.private.lock().unwrap().remove(&session) {
                    let _ = tx.send(text);
                }
            }
            _ => {}
        }
        return;
    }

    let event = match method {
        "thread/name/updated" => params
            .get("threadName")
            .and_then(Value::as_str)
            .map(|name| HarnessEvent::Named {
                session,
                name: name.to_string(),
            }),
        "thread/status/changed" => {
            let status = params
                .get("status")
                .and_then(|s| s.get("type").and_then(Value::as_str).or_else(|| s.as_str()))
                .unwrap_or_default();
            (status == "systemError").then(|| HarnessEvent::SessionError {
                session,
                message: "system error".into(),
            })
        }
        "turn/started" => Some(HarnessEvent::TurnStarted {
            turn_id: params
                .pointer("/turn/id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            session,
        }),
        "turn/completed" => Some(HarnessEvent::TurnFinished {
            status: params
                .pointer("/turn/status")
                .and_then(Value::as_str)
                .unwrap_or("completed")
                .to_string(),
            session,
        }),
        "item/started" | "item/completed" => {
            let item = params.get("item").cloned().unwrap_or(Value::Null);
            let kind = item.get("type").and_then(Value::as_str).unwrap_or_default();
            if method == "item/completed" {
                if kind == "imageGeneration" {
                    if let Some(path) = item.get("savedPath").and_then(Value::as_str) {
                        let _ = events.send(HarnessEvent::Artifact {
                            session: session.clone(),
                            path: path.to_string(),
                        });
                    }
                }
                if kind == "agentMessage" {
                    if let Some(text) = item.get("text").and_then(Value::as_str) {
                        let _ = events.send(HarnessEvent::Message {
                            session: session.clone(),
                            text: text.to_string(),
                            final_answer: item.get("phase").and_then(Value::as_str)
                                == Some("final_answer"),
                        });
                    }
                }
            }
            Some(HarnessEvent::Item { session, item })
        }
        _ if method.starts_with("item/") && method.ends_with("/outputDelta") => {
            Some(HarnessEvent::Item {
                session,
                item: json!({
                    "type": method
                        .trim_start_matches("item/")
                        .trim_end_matches("/outputDelta"),
                    "id": params.get("itemId").cloned().unwrap_or(Value::Null),
                    "streamedOutput": params.get("delta").cloned().unwrap_or(Value::Null),
                    "_delta": true,
                }),
            })
        }
        _ => None,
    };

    if let Some(event) = event {
        let _ = events.send(event);
    }
}

#[async_trait]
impl Harness for CodexHarness {
    fn events(&self) -> broadcast::Receiver<HarnessEvent> {
        self.events.subscribe()
    }

    fn backend(&self) -> Backend {
        Backend::Codex
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            steer: true,
            fork: true,
            inject: true,
            resume: true,
        }
    }

    async fn open(&self, spec: &SessionSpec) -> Result<String> {
        let mut params = self.thread_options(spec);
        if let Some(existing) = spec.resume.as_deref().filter(|s| !s.is_empty()) {
            params["threadId"] = json!(existing);
            // A resume that fails is not fatal: the thread may have been
            // pruned out from under us, and a new one still answers the user.
            match self.request("thread/resume", params.clone()).await {
                Ok(_) => return Ok(existing.to_string()),
                Err(error) => {
                    tracing::warn!(session = existing, %error, "resume failed; starting fresh");
                }
            }
            params = self.thread_options(spec);
        }
        params["serviceName"] = json!("oxroute");
        if spec.ephemeral {
            params["ephemeral"] = json!(true);
        }
        let result = self.request("thread/start", params).await?;
        result
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .context("Codex opened a thread without an id")
    }

    async fn start(&self, session: &str, inputs: Vec<TurnInput>) -> Result<String> {
        let result = self
            .request(
                "turn/start",
                json!({ "threadId": session, "input": inputs }),
            )
            .await?;
        Ok(result
            .pointer("/turn/id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string())
    }

    async fn steer(
        &self,
        session: &str,
        turn_id: &str,
        message_id: &str,
        inputs: Vec<TurnInput>,
    ) -> Result<()> {
        self.request(
            "turn/steer",
            json!({
                "threadId": session,
                "clientUserMessageId": message_id,
                "input": inputs,
                "expectedTurnId": turn_id,
            }),
        )
        .await?;
        Ok(())
    }

    async fn interrupt(&self, session: &str, turn_id: &str) -> Result<()> {
        self.request(
            "turn/interrupt",
            json!({ "threadId": session, "turnId": turn_id }),
        )
        .await?;
        Ok(())
    }

    async fn fork(&self, session: &str, spec: &SessionSpec, exclude_turns: bool) -> Result<String> {
        let mut params = self.thread_options(spec);
        params["threadId"] = json!(session);
        if spec.ephemeral {
            params["ephemeral"] = json!(true);
        }
        if exclude_turns {
            params["excludeTurns"] = json!(true);
        }
        let result = self.request("thread/fork", params).await?;
        result
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .context("Codex forked a thread without an id")
    }

    async fn inject(&self, session: &str, exchanges: &[(String, String)]) -> Result<()> {
        // A persisted thread need not still be resident in the app-server.
        // Reattach before mutating it so merges also work after unsubscribe or
        // an app-server restart.
        self.request("thread/resume", json!({ "threadId": session }))
            .await?;
        let mut items = Vec::new();
        for (question, answer) in exchanges {
            items.push(json!({
                "type": "message", "role": "user",
                "content": [{ "type": "input_text", "text": question }],
            }));
            items.push(json!({
                "type": "message", "role": "assistant",
                "content": [{ "type": "output_text", "text": answer }],
            }));
        }
        self.request(
            "thread/inject_items",
            json!({ "threadId": session, "items": items }),
        )
        .await?;
        Ok(())
    }

    async fn set_name(&self, session: &str, name: &str) -> Result<()> {
        self.request_within(
            "thread/name/set",
            json!({ "threadId": session, "name": name }),
            SHORT_TIMEOUT,
        )
        .await?;
        Ok(())
    }

    async fn release(&self, session: &str) -> Result<()> {
        self.request_within(
            "thread/unsubscribe",
            json!({ "threadId": session }),
            SHORT_TIMEOUT,
        )
        .await?;
        Ok(())
    }

    async fn recover(&self, session: &str, spec: &SessionSpec) -> Result<Option<RecoveredTurn>> {
        let mut params = self.thread_options(spec);
        params["threadId"] = json!(session);
        let result = self.request("thread/resume", params).await?;
        let Some(turn) = result
            .pointer("/thread/turns")
            .and_then(Value::as_array)
            .and_then(|turns| turns.last())
        else {
            return Ok(None);
        };
        Ok(Some(RecoveredTurn {
            id: turn.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
            status: turn
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("failed")
                .to_string(),
            items: turn
                .get("items")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        }))
    }

    async fn search_sessions(&self, query: &str, limit: usize) -> Result<Vec<NativeSession>> {
        let mut sessions = Vec::new();
        for archived in [false, true] {
            let response = self
                .request(
                    "thread/list",
                    json!({
                        "searchTerm": query,
                        "archived": archived,
                        "limit": limit,
                        "sortKey": "updated_at",
                        "sortDirection": "desc",
                        "useStateDbOnly": true
                    }),
                )
                .await?;
            sessions.extend(
                response
                    .get("data")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(native_session),
            );
        }
        let index = self.session_index.clone();
        let search_binary = self.search_binary.clone();
        let query = query.to_string();
        let indexed = tokio::task::spawn_blocking(move || {
            search_index(&index, &search_binary, &query, limit)
        })
        .await??;
        let mut by_id: HashMap<String, NativeSession> = indexed
            .into_iter()
            .map(|session| (session.session_id.clone(), session))
            .collect();
        for session in sessions {
            by_id.insert(session.session_id.clone(), session);
        }
        let mut sessions: Vec<_> = by_id.into_values().collect();
        sessions.sort_by(|a, b| b.updated_at.total_cmp(&a.updated_at));
        sessions.truncate(limit);
        Ok(sessions)
    }

    async fn find_session(&self, session: &str) -> Result<Option<NativeSession>> {
        let response = self
            .request(
                "thread/read",
                json!({ "threadId": session, "includeTurns": false }),
            )
            .await?;
        Ok(response.get("thread").and_then(native_session))
    }

    async fn session_preview(&self, session: &str, limit: usize) -> Result<Vec<ConversationLine>> {
        let response = self
            .request(
                "thread/read",
                json!({ "threadId": session, "includeTurns": true }),
            )
            .await?;
        let mut lines = Vec::new();
        for item in response
            .pointer("/thread/turns")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .flat_map(|turn| turn.get("items").and_then(Value::as_array).into_iter().flatten())
        {
            let kind = item.get("type").and_then(Value::as_str).unwrap_or("");
            let role = match kind {
                "userMessage" => "you",
                "agentMessage" => "agent",
                _ => continue,
            };
            let text = item
                .get("text")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| item.get("content").map(content_text))
                .unwrap_or_default();
            if !text.trim().is_empty() {
                lines.push(ConversationLine { role: role.into(), text });
            }
        }
        Ok(lines.into_iter().rev().take(limit).collect::<Vec<_>>().into_iter().rev().collect())
    }

    async fn oneshot(&self, prompt: &str, schema: Value, cwd: &str) -> Result<String> {
        let cwd = if cwd.is_empty() { &self.default_cwd } else { cwd };
        let config = self.title_config(cwd).await;
        let connection = self.connection().await?;
        let result = connection
            .request(
                "thread/start",
                json!({
                    "model": self.title_model,
                    "cwd": cwd,
                    "approvalPolicy": APPROVAL_POLICY,
                    "sandbox": "read-only",
                    "runtimeWorkspaceRoots": [],
                    "ephemeral": true,
                    "threadSource": "system",
                    "environments": [],
                    "dynamicTools": [],
                    "selectedCapabilityRoots": [],
                    "config": config,
                }),
                SHORT_TIMEOUT,
            )
            .await?;
        let session = result
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .context("Codex opened a naming thread without an id")?
            .to_string();

        let (tx, rx) = oneshot::channel();
        connection.private.lock().unwrap().insert(session.clone(), tx);

        let outcome = async {
            connection
                .request(
                    "turn/start",
                    json!({
                        "threadId": session,
                        "input": [{ "type": "text", "text": prompt }],
                        "outputSchema": schema,
                        "effort": "low",
                    }),
                    SHORT_TIMEOUT,
                )
                .await?;
            tokio::time::timeout(SHORT_TIMEOUT, rx)
                .await
                .map_err(|_| anyhow!("the naming turn did not finish"))?
                .map_err(|_| anyhow!("the naming turn was dropped"))
        }
        .await;

        connection.private.lock().unwrap().remove(&session);
        connection.private_text.lock().unwrap().remove(&session);
        let _ = connection
            .request(
                "thread/unsubscribe",
                json!({ "threadId": session }),
                SHORT_TIMEOUT,
            )
            .await;
        outcome
    }
}

fn search_index(
    path: &Path,
    search_binary: &Path,
    query: &str,
    limit: usize,
) -> Result<Vec<NativeSession>> {
    if !path.is_file() {
        return Ok(vec![]);
    }
    let mut latest = HashMap::new();
    for line in BufReader::new(File::open(path)?).lines() {
        let Ok(value) = serde_json::from_str::<Value>(&line?) else { continue };
        let Some(session_id) = value.get("id").and_then(Value::as_str) else { continue };
        let name = value
            .get("thread_name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let updated_at = value
            .get("updated_at")
            .and_then(Value::as_str)
            .and_then(|value| {
                time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)
                    .ok()
            })
            .map(|value| value.unix_timestamp_nanos() as f64 / 1_000_000_000.0)
            .unwrap_or(0.0);
        latest.insert(
            session_id.to_string(),
            NativeSession {
                backend: Backend::Codex,
                session_id: session_id.to_string(),
                name: name.clone(),
                preview: name,
                cwd: String::new(),
                model: String::new(),
                updated_at,
            },
        );
    }
    let content = search_rollouts(path, search_binary, query)?;
    for (session_id, cwd, updated_at) in &content {
        latest
            .entry(session_id.clone())
            .and_modify(|session| {
                session.cwd = cwd.clone();
                session.updated_at = session.updated_at.max(*updated_at);
            })
            .or_insert_with(|| NativeSession {
                backend: Backend::Codex,
                session_id: session_id.clone(),
                name: String::new(),
                preview: String::new(),
                cwd: cwd.clone(),
                model: String::new(),
                updated_at: *updated_at,
            });
    }
    let content: HashSet<_> = content.into_iter().map(|(id, _, _)| id).collect();
    let query = query.to_lowercase();
    let mut sessions: Vec<_> = latest
        .into_values()
        .filter(|session| {
            session.name.to_lowercase().contains(&query) || content.contains(&session.session_id)
        })
        .collect();
    sessions.sort_by(|a, b| b.updated_at.total_cmp(&a.updated_at));
    sessions.truncate(limit);
    Ok(sessions)
}

/// Codex's list API searches thread metadata, not the conversation. Ripgrep
/// cheaply narrows the native rollouts, then JSON parsing keeps only human
/// and agent messages so a command containing the query is not a false hit.
fn search_rollouts(
    index: &Path,
    search_binary: &Path,
    query: &str,
) -> Result<Vec<(String, String, f64)>> {
    if query.chars().count() < 3 {
        return Ok(vec![]);
    }
    let root = index.parent().unwrap_or(Path::new("")).join("sessions");
    if !root.is_dir() {
        return Ok(vec![]);
    }
    let output = Command::new(search_binary)
        .args([
            "--files-with-matches",
            "--ignore-case",
            "--fixed-strings",
            "--glob",
            "*.jsonl",
            "--",
        ])
        .arg(query)
        .arg(root)
        .output()
        .context("searching Codex conversation history with rg")?;
    anyhow::ensure!(
        output.status.success() || output.status.code() == Some(1),
        "rg could not search Codex conversation history"
    );
    let query = query.to_lowercase();
    let mut matches = Vec::new();
    for path in String::from_utf8_lossy(&output.stdout).lines() {
        if let Some(found) = matching_rollout(Path::new(path), &query)? {
            matches.push(found);
        }
    }
    Ok(matches)
}

fn matching_rollout(path: &Path, query: &str) -> Result<Option<(String, String, f64)>> {
    let file = File::open(path)?;
    let updated_at = file
        .metadata()?
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64();
    let mut session_id = String::new();
    let mut cwd = String::new();
    let mut matched = false;
    for line in BufReader::new(file).lines() {
        let line = line?;
        if session_id.is_empty() || line.to_lowercase().contains(query) {
            let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
            if value.get("type").and_then(Value::as_str) == Some("session_meta") {
                session_id = value
                    .pointer("/payload/id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                cwd = value
                    .pointer("/payload/cwd")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
            }
            let payload = value.get("payload");
            if value.get("type").and_then(Value::as_str) == Some("response_item")
                && payload
                    .and_then(|item| item.get("type"))
                    .and_then(Value::as_str)
                    == Some("message")
                && matches!(
                    payload.and_then(|item| item.get("role")).and_then(Value::as_str),
                    Some("user" | "assistant")
                )
                && payload
                    .and_then(|item| item.get("content"))
                    .map(content_text)
                    .unwrap_or_default()
                    .to_lowercase()
                    .contains(query)
            {
                matched = true;
            }
        }
    }
    Ok((matched && !session_id.is_empty()).then_some((session_id, cwd, updated_at)))
}

fn native_session(thread: &Value) -> Option<NativeSession> {
    let session_id = thread.get("id")?.as_str()?.to_string();
    let preview = thread.get("preview").and_then(Value::as_str).unwrap_or("").to_string();
    Some(NativeSession {
        backend: Backend::Codex,
        session_id,
        name: thread
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.trim().is_empty())
            .unwrap_or(&preview)
            .to_string(),
        preview,
        cwd: thread.get("cwd").and_then(Value::as_str).unwrap_or("").to_string(),
        model: thread.get("model").and_then(Value::as_str).unwrap_or("").to_string(),
        updated_at: thread.get("updatedAt").and_then(Value::as_i64).unwrap_or(0) as f64,
    })
}

fn content_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        std::env::temp_dir().join(format!(
            "oxroute-codex-search-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn search_index_finds_conversation_text_outside_the_title_index() {
        let root = scratch();
        let sessions = root.join("sessions/2026/09/23");
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::write(
            root.join("session_index.jsonl"),
            r#"{"id":"old-session","thread_name":"release work","updated_at":"2026-09-23T12:00:00Z"}"#,
        )
        .unwrap();
        std::fs::write(
            sessions.join("rollout.jsonl"),
            concat!(
                r#"{"type":"session_meta","payload":{"id":"old-session","cwd":"/work/project"}}"#,
                "\n",
                r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"GitHub currently has a tag named 0.0.1"}]}}"#,
                "\n"
            ),
        )
        .unwrap();

        let found = search_index(
            &root.join("session_index.jsonl"),
            Path::new("rg"),
            "github currently has a tag named",
            20,
        )
        .unwrap();

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].session_id, "old-session");
        assert_eq!(found[0].cwd, "/work/project");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rollout_search_ignores_query_text_inside_tool_calls() {
        let root = scratch();
        let sessions = root.join("sessions/2026/09/23");
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::write(root.join("session_index.jsonl"), "").unwrap();
        std::fs::write(
            sessions.join("rollout.jsonl"),
            concat!(
                r#"{"type":"session_meta","payload":{"id":"diagnostic-session","cwd":"/work/project"}}"#,
                "\n",
                r#"{"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"search for unique diagnostic phrase"}}"#,
                "\n"
            ),
        )
        .unwrap();

        let found = search_index(
            &root.join("session_index.jsonl"),
            Path::new("rg"),
            "unique diagnostic phrase",
            20,
        )
        .unwrap();

        assert!(found.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
}
