//! A child process that speaks newline-delimited JSON on stdin and stdout.
//!
//! Both harnesses are this shape -- `codex app-server` and `claude -p
//! --output-format stream-json` -- so the plumbing lives here once. Reading
//! happens on its own task, because the alternative is blocking the whole
//! router on an agent that has gone quiet.

use std::process::Stdio;

use anyhow::{Context, Result};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

/// Variables that tell a coding agent it is already inside one.
///
/// oxroute is very often started from a session of the very thing it is about
/// to spawn, and the agents refuse to nest: Claude Code exits outright rather
/// than launching inside another Claude Code session.
const NESTING: &[&str] = &["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CODEX_SANDBOX"];

/// Secrets that belong to oxroute and have no business in a child's
/// environment, where a model could read them back out.
const WITHHELD: &[&str] = &[
    "SLACK_APP_TOKEN",
    "SLACK_BOT_TOKEN",
    "OXROUTE_SLACK_APP_TOKEN",
    "OXROUTE_SLACK_BOT_TOKEN",
];

pub struct JsonChild {
    child: Child,
    writes: mpsc::UnboundedSender<String>,
}

impl JsonChild {
    /// Spawn `argv` and start pumping. Every parsed line arrives on the
    /// returned receiver; a `None` means the process has gone.
    pub fn spawn(
        argv: &[String],
        cwd: Option<&str>,
    ) -> Result<(Self, mpsc::UnboundedReceiver<Value>)> {
        let (program, args) = argv
            .split_first()
            .context("a command needs at least a program name")?;

        let mut command = Command::new(program);
        command
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
            command.current_dir(dir);
        }
        for name in NESTING.iter().chain(WITHHELD) {
            command.env_remove(name);
        }

        let mut child = command
            .spawn()
            .with_context(|| format!("spawning {program}"))?;

        let mut stdin = child.stdin.take().context("child stdin was not piped")?;
        let stdout = child.stdout.take().context("child stdout was not piped")?;
        let stderr = child.stderr.take().context("child stderr was not piped")?;

        let (writes, mut pending) = mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            while let Some(line) = pending.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
                if stdin.flush().await.is_err() {
                    break;
                }
            }
        });

        let (lines, rx) = mpsc::unbounded_channel::<Value>();
        let program_name = program.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(line) {
                    // Not every line is ours: banners, warnings, progress bars.
                    Err(_) => tracing::debug!(target: "oxroute::rpc", %program_name, line, "unparsed"),
                    Ok(value) => {
                        if lines.send(value).is_err() {
                            break;
                        }
                    }
                }
            }
        });

        let program_name = program.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if !line.trim().is_empty() {
                    tracing::debug!(target: "oxroute::rpc", %program_name, line, "stderr");
                }
            }
        });

        Ok((JsonChild { child, writes }, rx))
    }

    pub fn send(&self, value: &Value) -> Result<()> {
        let mut line = serde_json::to_string(value)?;
        line.push('\n');
        self.writes
            .send(line)
            .map_err(|_| anyhow::anyhow!("the child process has gone away"))?;
        Ok(())
    }

    pub async fn shutdown(&mut self) {
        // Closing stdin is the polite ask; both harnesses exit on EOF.
        drop(std::mem::replace(&mut self.writes, mpsc::unbounded_channel().0));
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), self.child.wait()).await;
        let _ = self.child.start_kill();
    }
}

/// Environment for a child, with oxroute's own secrets and nesting markers
/// taken out. Exposed for callers that build a command themselves.
pub fn child_env() -> Vec<(String, String)> {
    std::env::vars()
        .filter(|(k, _)| !NESTING.contains(&k.as_str()) && !WITHHELD.contains(&k.as_str()))
        .collect()
}
