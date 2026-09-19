//! Talking to the daemon.
//!
//! The TUI has no state of its own beyond what is on screen: it asks for a
//! snapshot, then follows the event stream and asks again. That is the whole
//! reason the daemon exists as a separate process -- a surface that cached
//! its own version of the truth would drift from the other two.

use anyhow::{Context, Result};
use futures_util::StreamExt;
use oxroute_core::model::{Agent, Entry, Event};
use oxroute_core::Snapshot;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;

#[derive(Debug, Clone, Deserialize)]
pub struct AgentView {
    pub agent: Agent,
    pub timeline: Vec<Entry>,
    pub delivery: String,
}

#[derive(Clone)]
pub struct Client {
    base: String,
    http: reqwest::Client,
}

impl Client {
    pub fn new(base: impl Into<String>) -> Self {
        let base = base.into().trim_end_matches('/').to_string();
        Client {
            base,
            http: reqwest::Client::builder()
                // The event stream is meant to stay open forever, so the
                // timeout has to belong to the individual calls instead.
                .build()
                .expect("a plain HTTP client"),
        }
    }

    async fn get<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T> {
        let response = self
            .http
            .get(format!("{}{path}", self.base))
            .timeout(std::time::Duration::from_secs(30))
            .send()
            .await
            .with_context(|| format!("GET {path}"))?;
        decode(response).await
    }

    async fn post<T: serde::de::DeserializeOwned>(&self, path: &str, body: Value) -> Result<T> {
        let response = self
            .http
            .post(format!("{}{path}", self.base))
            .timeout(std::time::Duration::from_secs(120))
            .json(&body)
            .send()
            .await
            .with_context(|| format!("POST {path}"))?;
        decode(response).await
    }

    pub async fn snapshot(&self) -> Result<Snapshot> {
        self.get("/api/state").await
    }

    pub async fn agent(&self, id: &str) -> Result<AgentView> {
        self.get(&format!("/api/agents/{id}")).await
    }

    /// Put a thought of your own into the inbox, beside everything else.
    pub async fn note(&self, text: &str) -> Result<()> {
        let _: Value = self
            .post("/api/signal", json!({ "text": text, "source": "you" }))
            .await?;
        Ok(())
    }

    pub async fn route_existing(&self, signal: &str, agents: &[String]) -> Result<()> {
        let _: Value = self
            .post(
                "/api/route",
                json!({ "signal": signal, "action": "existing", "agentIds": agents }),
            )
            .await?;
        Ok(())
    }

    pub async fn route_spawn(&self, signal: &str, model: Option<&str>) -> Result<()> {
        let _: Value = self
            .post(
                "/api/route",
                json!({ "signal": signal, "action": "spawn", "model": model }),
            )
            .await?;
        Ok(())
    }

    pub async fn discard(&self, signal: &str) -> Result<()> {
        let _: Value = self
            .post("/api/route", json!({ "signal": signal, "action": "discard" }))
            .await?;
        Ok(())
    }

    pub async fn say(&self, agent: &str, text: &str) -> Result<()> {
        let _: Value = self.post("/api/say", json!({ "agent": agent, "text": text })).await?;
        Ok(())
    }

    pub async fn interrupt(&self, agent: &str) -> Result<()> {
        let _: Value = self.post("/api/interrupt", json!({ "agent": agent })).await?;
        Ok(())
    }

    pub async fn fork(&self, agent: &str) -> Result<()> {
        let _: Value = self.post("/api/fork", json!({ "agent": agent })).await?;
        Ok(())
    }

    pub async fn rename(&self, agent: &str, name: &str) -> Result<()> {
        let _: Value = self
            .post("/api/rename", json!({ "agent": agent, "name": name }))
            .await?;
        Ok(())
    }

    pub async fn set_mode(&self, mode: &str) -> Result<()> {
        let _: Snapshot = self.post("/api/mode", json!({ "mode": mode })).await?;
        Ok(())
    }

    /// Follow the daemon's event stream, reconnecting for as long as the TUI
    /// is up. A dropped connection is normal -- the daemon restarts, the
    /// laptop sleeps -- and must not end the session.
    pub fn follow(&self) -> mpsc::UnboundedReceiver<Event> {
        let (tx, rx) = mpsc::unbounded_channel();
        let client = self.clone();
        tokio::spawn(async move {
            loop {
                if let Err(error) = client.stream(&tx).await {
                    let _ = tx.send(Event::Notice {
                        text: format!("disconnected: {error}"),
                    });
                }
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                // Whatever happened while we were away is unknown, so the
                // first thing after a reconnect is a full resync.
                if tx.send(Event::Sync).is_err() {
                    return;
                }
            }
        });
        rx
    }

    async fn stream(&self, tx: &mpsc::UnboundedSender<Event>) -> Result<()> {
        let response = self
            .http
            .get(format!("{}/api/events", self.base))
            .header("accept", "text/event-stream")
            .send()
            .await?
            .error_for_status()?;

        let mut body = response.bytes_stream();
        let mut buffer = String::new();
        while let Some(chunk) = body.next().await {
            buffer.push_str(&String::from_utf8_lossy(&chunk?));
            // Server-sent events are separated by a blank line; a chunk can
            // split one anywhere, so frames are only taken once complete.
            while let Some(split) = buffer.find("\n\n") {
                let frame: String = buffer.drain(..split + 2).collect();
                for line in frame.lines() {
                    let Some(payload) = line.strip_prefix("data:") else { continue };
                    if let Ok(event) = serde_json::from_str::<Event>(payload.trim()) {
                        if tx.send(event).is_err() {
                            return Ok(());
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

async fn decode<T: serde::de::DeserializeOwned>(response: reqwest::Response) -> Result<T> {
    let status = response.status();
    let body = response.text().await?;
    if !status.is_success() {
        // The daemon puts a readable reason in the body; show that rather
        // than a status code nobody can act on.
        let reason = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_string))
            .unwrap_or(body);
        anyhow::bail!("{reason}");
    }
    serde_json::from_str(&body).context("the daemon sent something unexpected")
}
