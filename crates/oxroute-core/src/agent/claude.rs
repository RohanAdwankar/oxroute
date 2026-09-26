//! Claude Code, driven through its CLI.
//!
//! ```text
//! claude -p --input-format stream-json --output-format stream-json --verbose
//!        --session-id <uuid> --permission-mode bypassPermissions
//! ```
//!
//! A persistent session on stdin and stdout: write user messages in, read
//! assistant messages, tool calls and results out. One process per agent,
//! unlike Codex's single server holding every thread.
//!
//! Two things about the CLI shape the code here, both learned by running it:
//!
//! * **It says nothing until it is spoken to.** The `system/init` frame that
//!   carries the session id only arrives after the first user message, so
//!   waiting for it before sending deadlocks. `--session-id` is the way out:
//!   oxroute names the session itself and knows the id before the process
//!   has drawn breath, which also makes `--resume` work across a restart.
//! * **It asks permission by default.** There is nobody here to answer, so
//!   an unattended turn would simply stop. `--permission-mode` is set to the
//!   equivalent of the Codex harness's `approvalPolicy: never`, and is the
//!   one thing here worth overriding deliberately.
//!
//! No steering. The CLI queues input rather than folding it into the turn
//! that is already running, so `delivery()` reports `queue` for a busy agent
//! and every surface says so before you send. That is the honest difference
//! from Codex, and the reason capabilities are declared rather than assumed.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::sync::{broadcast, Mutex};

use super::{Capabilities, Harness, HarnessEvent, SessionSpec};
use crate::model::{Backend, ConversationLine, NativeSession, TurnInput};
use crate::rpc::JsonChild;

pub struct ClaudeHarness {
    binary: String,
    default_cwd: String,
    permission_mode: String,
    history_root: PathBuf,
    sessions: Mutex<HashMap<String, Arc<Mutex<JsonChild>>>>,
    events: broadcast::Sender<HarnessEvent>,
}

impl ClaudeHarness {
    pub fn new(config: &crate::config::Config) -> Self {
        ClaudeHarness {
            binary: config.claude_binary.clone(),
            default_cwd: config.workspace_path().to_string_lossy().to_string(),
            permission_mode: config.claude_permission_mode.clone(),
            history_root: std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_default()
                .join(".claude/projects"),
            sessions: Mutex::new(HashMap::new()),
            events: broadcast::channel(2048).0,
        }
    }

    /// For tests, which want a harness without a whole configuration.
    #[cfg(test)]
    fn bare(binary: &str, cwd: &str, permission_mode: &str) -> Self {
        ClaudeHarness {
            binary: binary.into(),
            default_cwd: cwd.into(),
            permission_mode: permission_mode.into(),
            history_root: PathBuf::new(),
            sessions: Mutex::new(HashMap::new()),
            events: broadcast::channel(2048).0,
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<HarnessEvent> {
        self.events.subscribe()
    }

    /// How a session is opened: as itself, carried on, or branched off
    /// another one. `--fork-session` copies the history and hands the copy
    /// whatever id we ask for, which is what lets a fork be opened the same
    /// way every other session is.
    fn argv(&self, session: &str, spec: &SessionSpec, from: Opening<'_>) -> Vec<String> {
        let mut argv = vec![
            self.binary.clone(),
            "-p".into(),
            "--input-format".into(),
            "stream-json".into(),
            "--output-format".into(),
            "stream-json".into(),
            "--verbose".into(),
            "--permission-mode".into(),
            self.permission_mode.clone(),
        ];
        match from {
            // `--resume` already names the session; passing both is
            // contradictory.
            Opening::Resume => {
                argv.push("--resume".into());
                argv.push(session.to_string());
            }
            Opening::Fresh => {
                argv.push("--session-id".into());
                argv.push(session.to_string());
            }
            Opening::ForkOf(parent) => {
                argv.push("--resume".into());
                argv.push(parent.to_string());
                argv.push("--fork-session".into());
                argv.push("--session-id".into());
                argv.push(session.to_string());
            }
        }
        if !spec.model.is_empty() {
            argv.push("--model".into());
            argv.push(spec.model.clone());
        }
        argv
    }

    /// Start the process behind one session and listen to it.
    ///
    /// Every session arrives this way -- new, resumed, or branched off
    /// another -- so there is one place where a session becomes a process.
    async fn begin(&self, session: String, spec: &SessionSpec, from: Opening<'_>) -> Result<String> {
        if self.sessions.lock().await.contains_key(&session) {
            return Ok(session);
        }

        let cwd = if spec.cwd.is_empty() { &self.default_cwd } else { &spec.cwd };
        let (child, mut lines) = JsonChild::spawn(&self.argv(&session, spec, from), Some(cwd))
            .context("starting Claude Code")?;
        self.sessions
            .lock()
            .await
            .insert(session.clone(), Arc::new(Mutex::new(child)));

        let events = self.events.clone();
        let name = session.clone();
        tokio::spawn(async move {
            while let Some(message) = lines.recv().await {
                translate(&events, &name, &message);
            }
            // The process ending is not itself a failure -- an interrupt
            // closes it deliberately -- but the hub needs to know the session
            // is no longer live.
            let _ = events.send(HarnessEvent::TurnFinished {
                session: name.clone(),
                status: "exited".into(),
            });
        });

        Ok(session)
    }
}

/// Where a session comes from.
#[derive(Clone, Copy)]
enum Opening<'a> {
    Fresh,
    Resume,
    ForkOf(&'a str),
}

#[async_trait]
impl Harness for ClaudeHarness {
    fn events(&self) -> broadcast::Receiver<HarnessEvent> {
        self.events.subscribe()
    }

    fn backend(&self) -> Backend {
        Backend::ClaudeCode
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            // The CLI queues; it does not fold into a running turn.
            steer: false,
            fork: true,
            inject: false,
            resume: true,
        }
    }

    async fn open(&self, spec: &SessionSpec) -> Result<String> {
        match spec.resume.as_deref().filter(|s| !s.is_empty()) {
            Some(existing) => self.begin(existing.to_string(), spec, Opening::Resume).await,
            // The CLI wants a UUID, and naming the session ourselves is what
            // lets this return before the process has said anything.
            None => {
                self.begin(uuid::Uuid::new_v4().to_string(), spec, Opening::Fresh)
                    .await
            }
        }
    }

    /// Branch a session.
    ///
    /// Without its turns there is nothing of the original left to copy but
    /// the model and the directory, which is a new session -- so that is
    /// what a side question gets.
    async fn fork(&self, session: &str, spec: &SessionSpec, exclude_turns: bool) -> Result<String> {
        let child = uuid::Uuid::new_v4().to_string();
        let from = if exclude_turns { Opening::Fresh } else { Opening::ForkOf(session) };
        self.begin(child, spec, from).await
    }
    async fn search_sessions(&self, query: &str, limit: usize) -> Result<Vec<NativeSession>> {
        let root = self.history_root.clone();
        let query = query.to_string();
        Ok(tokio::task::spawn_blocking(move || scan_sessions(&root, Some(&query), limit)).await??)
    }

    async fn find_session(&self, session: &str) -> Result<Option<NativeSession>> {
        let root = self.history_root.clone();
        let session = session.to_string();
        Ok(tokio::task::spawn_blocking(move || {
            Ok::<_, anyhow::Error>(scan_sessions(&root, None, usize::MAX)?
                .into_iter()
                .find(|candidate| candidate.session_id == session))
        })
        .await??)
    }

    async fn session_preview(&self, session: &str, limit: usize) -> Result<Vec<ConversationLine>> {
        let root = self.history_root.clone();
        let session = session.to_string();
        Ok(tokio::task::spawn_blocking(move || preview_session(&root, &session, limit)).await??)
    }

    async fn start(&self, session: &str, inputs: Vec<TurnInput>) -> Result<String> {
        let child = self
            .sessions
            .lock()
            .await
            .get(session)
            .cloned()
            .with_context(|| format!("no live Claude Code session {session}"))?;

        // The CLI takes one text body. Naming an image's path is the best we
        // can do without the SDK, and saying where the file is beats
        // dropping it on the floor.
        let body = inputs
            .iter()
            .map(|input| match input {
                TurnInput::Text { text } => text.clone(),
                TurnInput::LocalImage { path } => format!("(image attached at {path})"),
            })
            .collect::<Vec<_>>()
            .join("\n\n");

        child.lock().await.send(&json!({
            "type": "user",
            "message": { "role": "user", "content": body },
        }))?;

        // There is no turn id on the wire. One is minted so the hub has
        // something to hold, and `interrupt` ends the process rather than
        // naming a turn.
        let turn = crate::model::new_id("turn");
        let _ = self.events.send(HarnessEvent::TurnStarted {
            session: session.to_string(),
            turn_id: turn.clone(),
        });
        Ok(turn)
    }

    async fn steer(
        &self,
        _session: &str,
        _turn_id: &str,
        _message_id: &str,
        _inputs: Vec<TurnInput>,
    ) -> Result<()> {
        anyhow::bail!("Claude Code queues input rather than steering a running turn")
    }

    async fn interrupt(&self, session: &str, _turn_id: &str) -> Result<()> {
        // There is no interrupt on the wire. Ending the process stops the
        // turn; the session id is ours, so the next send resumes it.
        let child = self.sessions.lock().await.remove(session);
        let Some(child) = child else {
            anyhow::bail!("no live Claude Code session {session}")
        };
        child.lock().await.shutdown().await;
        let _ = self.events.send(HarnessEvent::TurnFinished {
            session: session.to_string(),
            status: "interrupted".into(),
        });
        Ok(())
    }

    async fn release(&self, _session: &str) -> Result<()> {
        // Unlike Codex, where releasing only unsubscribes, ending a Claude
        // process ends the conversation's host. The session is resumable, so
        // the process is kept until something actually stops it.
        Ok(())
    }
}

fn scan_sessions(root: &Path, query: Option<&str>, limit: usize) -> Result<Vec<NativeSession>> {
    if !root.is_dir() {
        return Ok(vec![]);
    }
    let mut files = Vec::new();
    collect_histories(root, &mut files)?;
    files.sort_by_key(|path| {
        std::cmp::Reverse(path.metadata().and_then(|m| m.modified()).ok())
    });
    let query = query.map(str::to_lowercase);
    let mut sessions = Vec::new();
    for path in files {
        if let Some(session) = read_session(&path, query.as_deref())? {
            sessions.push(session);
            if sessions.len() == limit {
                break;
            }
        }
    }
    Ok(sessions)
}

fn collect_histories(dir: &Path, files: &mut Vec<PathBuf>) -> Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            if entry.file_name() != "subagents" {
                collect_histories(&path, files)?;
            }
        } else if path.extension().and_then(|value| value.to_str()) == Some("jsonl") {
            files.push(path);
        }
    }
    Ok(())
}

fn read_session(path: &Path, query: Option<&str>) -> Result<Option<NativeSession>> {
    // Most of a history directory has nothing to do with what was typed, and
    // parsing every line of every transcript to find that out is the whole
    // cost of a search. The bytes answer it first.
    if let Some(query) = query {
        let raw = fs::read(path)?;
        if !raw
            .to_ascii_lowercase()
            .windows(query.len())
            .any(|window| window == query.as_bytes())
        {
            return Ok(None);
        }
    }
    let file = File::open(path)?;
    let mut session_id = String::new();
    let mut cwd = String::new();
    let mut model = String::new();
    let mut preview = String::new();
    let mut name = String::new();
    let mut matches = query.is_none();
    for line in BufReader::new(file).lines() {
        let Ok(value) = serde_json::from_str::<Value>(&line?) else { continue };
        if session_id.is_empty() {
            session_id = value.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string();
        }
        if cwd.is_empty() {
            cwd = value.get("cwd").and_then(Value::as_str).unwrap_or("").to_string();
        }
        if value.get("type").and_then(Value::as_str) == Some("summary") {
            name = value.get("summary").and_then(Value::as_str).unwrap_or("").to_string();
        }
        let message = value.get("message");
        if let Some(candidate) = message
            .and_then(|message| message.get("model"))
            .and_then(Value::as_str)
        {
            model = candidate.to_string();
        }
        let text = message
            .and_then(|message| message.get("content"))
            .map(message_text)
            .unwrap_or_default();
        if preview.is_empty()
            && value.get("type").and_then(Value::as_str) == Some("user")
            && !text.trim().is_empty()
        {
            preview = text.trim().to_string();
        }
        if query.is_some_and(|query| text.to_lowercase().contains(query)) {
            matches = true;
        }
    }
    if session_id.is_empty() {
        session_id = path.file_stem().and_then(|value| value.to_str()).unwrap_or("").to_string();
    }
    if session_id.is_empty() || !matches {
        return Ok(None);
    }
    if name.is_empty() {
        name = preview.clone();
    }
    let updated_at = path
        .metadata()?
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64();
    Ok(Some(NativeSession {
        backend: Backend::ClaudeCode,
        session_id,
        name,
        preview,
        cwd,
        model,
        updated_at,
    }))
}

fn message_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn preview_session(root: &Path, session: &str, limit: usize) -> Result<Vec<ConversationLine>> {
    let mut files = Vec::new();
    if root.is_dir() {
        collect_histories(root, &mut files)?;
    }
    let Some(path) = files.into_iter().find(|path| {
        path.file_stem().and_then(|value| value.to_str()) == Some(session)
    }) else {
        return Ok(vec![]);
    };
    let mut lines = Vec::new();
    for line in BufReader::new(File::open(path)?).lines() {
        let Ok(value) = serde_json::from_str::<Value>(&line?) else { continue };
        let role = match value.get("type").and_then(Value::as_str) {
            Some("user") => "you",
            Some("assistant") => "agent",
            _ => continue,
        };
        let text = value
            .pointer("/message/content")
            .map(message_text)
            .unwrap_or_default();
        if !text.trim().is_empty() {
            lines.push(ConversationLine { role: role.into(), text });
        }
    }
    Ok(lines.into_iter().rev().take(limit).collect::<Vec<_>>().into_iter().rev().collect())
}

/// One frame from the CLI, in oxroute's vocabulary.
fn translate(events: &broadcast::Sender<HarnessEvent>, session: &str, message: &Value) {
    match message.get("type").and_then(Value::as_str) {
        Some("assistant") => {
            let blocks = message.pointer("/message/content").and_then(Value::as_array);
            for block in blocks.into_iter().flatten() {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        let text = block.get("text").and_then(Value::as_str).unwrap_or("").trim();
                        if !text.is_empty() {
                            let _ = events.send(HarnessEvent::Message {
                                session: session.to_string(),
                                text: text.to_string(),
                                // The CLI does not mark a final answer. The
                                // `result` frame carries it instead, so this
                                // is commentary until proven otherwise.
                                final_answer: false,
                            });
                        }
                    }
                    Some("tool_use") => {
                        let input = block.get("input").cloned().unwrap_or(Value::Null);
                        let _ = events.send(HarnessEvent::Item {
                            session: session.to_string(),
                            item: json!({
                                "type": "toolCall",
                                "id": block.get("id").cloned().unwrap_or(Value::Null),
                                "tool": block.get("name").cloned().unwrap_or(Value::Null),
                                "status": "completed",
                                "arguments": input,
                            }),
                        });
                    }
                    _ => {}
                }
            }
        }
        // A tool's output comes back as a user frame. Without this the
        // interface can say what an agent ran but never what it saw, which
        // is the half a person actually wants.
        Some("user") => {
            let blocks = message.pointer("/message/content").and_then(Value::as_array);
            for block in blocks.into_iter().flatten() {
                if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                    continue;
                }
                let output = tool_result_text(block);
                if output.trim().is_empty() {
                    continue;
                }
                let _ = events.send(HarnessEvent::Item {
                    session: session.to_string(),
                    item: json!({
                        "type": "toolResult",
                        "id": block.get("tool_use_id").cloned().unwrap_or(Value::Null),
                        "status": "completed",
                        "aggregatedOutput": output,
                    }),
                });
            }
        }
        Some("result") => {
            // `result` carries the answer verbatim, which is the only frame
            // the CLI marks as final.
            if let Some(text) = message.get("result").and_then(Value::as_str) {
                if !text.trim().is_empty() {
                    let _ = events.send(HarnessEvent::Message {
                        session: session.to_string(),
                        text: text.trim().to_string(),
                        final_answer: true,
                    });
                }
            }
            let status = match message.get("subtype").and_then(Value::as_str) {
                Some("success") | None => "completed".to_string(),
                Some(other) => other.to_string(),
            };
            let _ = events.send(HarnessEvent::TurnFinished {
                session: session.to_string(),
                status,
            });
        }
        _ => {}
    }
}

/// A tool result is either a string or a list of content blocks, depending
/// on the tool. Both shapes turn into the text a person would read.
fn tool_result_text(block: &Value) -> String {
    match block.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
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

    fn spec(model: &str, resume: Option<&str>) -> SessionSpec {
        SessionSpec {
            model: model.into(),
            cwd: String::new(),
            resume: resume.map(str::to_string),
            ephemeral: false,
        }
    }

    #[test]
    fn a_new_session_is_named_by_us_and_a_resumed_one_is_not_renamed() {
        let harness = ClaudeHarness::bare("claude", "/work", "bypassPermissions");
        let fresh = harness.argv(
            "11111111-2222-3333-4444-555555555555",
            &spec("opus", None),
            Opening::Fresh,
        );
        assert!(fresh.windows(2).any(|w| w[0] == "--session-id"));
        assert!(!fresh.iter().any(|a| a == "--resume"));

        let again = harness.argv(
            "11111111-2222-3333-4444-555555555555",
            &spec("opus", Some("11111111-2222-3333-4444-555555555555")),
            Opening::Resume,
        );
        // Passing both would be contradictory; resume already names it.
        assert!(again.iter().any(|a| a == "--resume"));
        assert!(!again.iter().any(|a| a == "--session-id"));
    }

    #[test]
    fn a_fork_resumes_the_parent_under_a_name_of_our_own() {
        let harness = ClaudeHarness::bare("claude", "/work", "bypassPermissions");
        let argv = harness.argv("child", &spec("opus", None), Opening::ForkOf("parent"));
        // The parent is what is resumed, the copy is what is named, and the
        // flag between them is what makes it a copy rather than the same
        // conversation continued.
        let resumed = argv.windows(2).find(|w| w[0] == "--resume").map(|w| w[1].clone());
        let named = argv.windows(2).find(|w| w[0] == "--session-id").map(|w| w[1].clone());
        assert_eq!(resumed.as_deref(), Some("parent"));
        assert_eq!(named.as_deref(), Some("child"));
        assert!(argv.iter().any(|a| a == "--fork-session"));
    }

    #[test]
    fn an_unattended_turn_never_stops_to_ask() {
        let harness = ClaudeHarness::bare("claude", "/work", "bypassPermissions");
        let argv = harness.argv("s", &spec("", None), Opening::Fresh);
        let mode = argv
            .windows(2)
            .find(|w| w[0] == "--permission-mode")
            .map(|w| w[1].clone());
        assert_eq!(mode.as_deref(), Some("bypassPermissions"));
    }

    #[test]
    fn the_result_frame_is_the_final_answer() {
        let events = broadcast::channel(16).0;
        let mut received = events.subscribe();
        translate(
            &events,
            "s1",
            &json!({ "type": "result", "subtype": "success", "result": " all done " }),
        );
        match received.try_recv().unwrap() {
            HarnessEvent::Message { text, final_answer, .. } => {
                assert_eq!(text, "all done");
                assert!(final_answer);
            }
            other => panic!("expected a final message, got {other:?}"),
        }
        assert!(matches!(
            received.try_recv().unwrap(),
            HarnessEvent::TurnFinished { status, .. } if status == "completed"
        ));
    }

    #[test]
    fn a_tool_result_becomes_output_worth_showing() {
        let events = broadcast::channel(16).0;
        let mut received = events.subscribe();
        translate(
            &events,
            "s1",
            &json!({
                "type": "user",
                "message": {
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": "t1",
                        "content": [{ "type": "text", "text": "e2e.txt\nnotes.md" }],
                    }],
                },
            }),
        );
        match received.try_recv().unwrap() {
            HarnessEvent::Item { item, .. } => {
                assert_eq!(item["type"], "toolResult");
                assert!(item["aggregatedOutput"].as_str().unwrap().contains("notes.md"));
            }
            other => panic!("expected an item, got {other:?}"),
        }
    }

    #[test]
    fn a_plain_string_result_works_too() {
        let events = broadcast::channel(16).0;
        let mut received = events.subscribe();
        translate(
            &events,
            "s1",
            &json!({
                "type": "user",
                "message": {
                    "content": [{ "type": "tool_result", "content": "42 files" }],
                },
            }),
        );
        assert!(matches!(received.try_recv().unwrap(), HarnessEvent::Item { .. }));
    }

    #[test]
    fn mid_turn_text_is_commentary_not_the_answer() {
        let events = broadcast::channel(16).0;
        let mut received = events.subscribe();
        translate(
            &events,
            "s1",
            &json!({
                "type": "assistant",
                "message": { "content": [{ "type": "text", "text": "looking now" }] },
            }),
        );
        match received.try_recv().unwrap() {
            HarnessEvent::Message { final_answer, .. } => assert!(!final_answer),
            other => panic!("expected a message, got {other:?}"),
        }
    }
}
