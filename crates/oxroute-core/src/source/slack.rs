//! Slack, over Socket Mode.
//!
//! Two halves. A WebSocket carries events in: `apps.connections.open` hands
//! out a short-lived `wss://` URL, envelopes arrive on it, and each one must
//! be acknowledged by id or Slack redelivers it. Ordinary HTTPS calls carry
//! everything out.
//!
//! Hand-written rather than pulled from a client library, because the surface
//! oxroute needs is eight methods wide and the socket loop is the interesting
//! part: it must reconnect on its own, since Slack cycles the connection
//! every few minutes by design.

use std::time::Duration;

use anyhow::{Context, Result};
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::Message;

use super::{Inbox, Posted, Source, SourceEvent};
use crate::model::{now, new_id, Attachment, Signal, Target, TurnInput};

pub const SOURCE: &str = "slack";
const API: &str = "https://slack.com/api";
/// Slack rejects anything longer, so a long answer arrives as several posts.
const MAX_MESSAGE: usize = 3_500;

pub struct SlackSource {
    app_token: String,
    bot_token: String,
    /// The one person allowed to start work. Everything else is ignored in
    /// silence: this is a private interface to a machine that runs commands.
    allowed_user: String,
    http: reqwest::Client,
}

impl SlackSource {
    pub fn new(
        app_token: impl Into<String>,
        bot_token: impl Into<String>,
        allowed_user: impl Into<String>,
    ) -> Self {
        SlackSource {
            app_token: app_token.into(),
            bot_token: bot_token.into(),
            allowed_user: allowed_user.into(),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(60))
                .build()
                .expect("a plain HTTPS client"),
        }
    }

    pub fn allowed_user(&self) -> &str {
        &self.allowed_user
    }

    async fn call(&self, method: &str, body: Value) -> Result<Value> {
        self.call_with(&self.bot_token, method, body).await
    }

    async fn call_with(&self, token: &str, method: &str, body: Value) -> Result<Value> {
        let response = self
            .http
            .post(format!("{API}/{method}"))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .with_context(|| format!("calling {method}"))?
            .json::<Value>()
            .await
            .with_context(|| format!("reading the reply to {method}"))?;
        if response.get("ok").and_then(Value::as_bool) != Some(true) {
            let error = response
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            anyhow::bail!("slack {method}: {error}");
        }
        Ok(response)
    }

    /// True when this is a message oxroute should act on.
    ///
    /// Direct messages only, from the one allowed account, and never from a
    /// bot -- including ourselves, or every reply would be a new request.
    fn accepted(&self, event: &Value) -> bool {
        let text = event.get("text").and_then(Value::as_str).unwrap_or("").trim();
        let files = event.get("files").and_then(Value::as_array);
        let subtype = event.get("subtype").and_then(Value::as_str);
        event.get("user").and_then(Value::as_str) == Some(self.allowed_user.as_str())
            && event.get("channel_type").and_then(Value::as_str) == Some("im")
            && event.get("bot_id").is_none()
            && matches!(subtype, None | Some("file_share"))
            && (!text.is_empty() || files.is_some_and(|f| !f.is_empty()))
            && event.get("ts").is_some()
            && event.get("channel").is_some()
    }

    fn to_signal(&self, event: &Value) -> Option<Signal> {
        let ts = event.get("ts")?.as_str()?.to_string();
        let channel = event.get("channel")?.as_str()?.to_string();
        let thread_ts = event
            .get("thread_ts")
            .and_then(Value::as_str)
            .map(str::to_string);
        let attachments = event
            .get("files")
            .and_then(Value::as_array)
            .map(|files| {
                files
                    .iter()
                    .map(|file| Attachment {
                        id: file.get("id").and_then(Value::as_str).unwrap_or("file").into(),
                        name: file
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("attachment")
                            .into(),
                        mimetype: file
                            .get("mimetype")
                            .and_then(Value::as_str)
                            .unwrap_or("application/octet-stream")
                            .into(),
                        url: file
                            .get("url_private_download")
                            .or_else(|| file.get("url_private"))
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .into(),
                    })
                    .collect()
            })
            .unwrap_or_default();

        Some(Signal {
            id: new_id("sig"),
            source: SOURCE.into(),
            conversation: channel,
            thread_key: thread_ts.clone().unwrap_or_else(|| ts.clone()),
            external_id: ts,
            author: event
                .get("user")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .into(),
            label: "dm".into(),
            text: event
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string(),
            attachments,
            at: now(),
            root: thread_ts.is_none(),
        })
    }

    async fn socket_url(&self) -> Result<String> {
        let response = self
            .call_with(&self.app_token, "apps.connections.open", json!({}))
            .await?;
        response
            .get("url")
            .and_then(Value::as_str)
            .map(str::to_string)
            .context("slack did not hand out a socket url")
    }

    /// One connection's lifetime. Returns when Slack closes it, which it does
    /// routinely; the caller reconnects.
    async fn pump(&self, inbox: &Inbox) -> Result<()> {
        let url = self.socket_url().await?;
        let (stream, _) = tokio_tungstenite::connect_async(&url)
            .await
            .context("opening the slack socket")?;
        let (mut sink, mut source) = stream.split();
        tracing::info!(target: "oxroute::slack", "socket connected");

        while let Some(frame) = source.next().await {
            let Message::Text(raw) = frame.context("reading from the slack socket")? else {
                continue;
            };
            let Ok(envelope) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };

            // Acknowledge first. An envelope we have not acked is one Slack
            // will send again, and a slow turn must not cause a redelivery.
            if let Some(id) = envelope.get("envelope_id").and_then(Value::as_str) {
                sink.send(Message::Text(
                    json!({ "envelope_id": id }).to_string(),
                ))
                .await
                .context("acknowledging a slack envelope")?;
            }

            match envelope.get("type").and_then(Value::as_str) {
                Some("hello") => tracing::debug!(target: "oxroute::slack", "hello"),
                Some("disconnect") => return Ok(()),
                Some("events_api") => {
                    let Some(event) = envelope.pointer("/payload/event") else {
                        continue;
                    };
                    if event.get("type").and_then(Value::as_str) != Some("message") {
                        continue;
                    }
                    if !self.accepted(event) {
                        continue;
                    }
                    if let Some(signal) = self.to_signal(event) {
                        let _ = inbox.send(SourceEvent::Arrived(Box::new(signal)));
                    }
                }
                Some("slash_commands") => {
                    let payload = envelope.get("payload").cloned().unwrap_or(Value::Null);
                    let name = payload
                        .get("command")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .trim_start_matches('/')
                        .to_string();
                    let user = payload
                        .get("user_id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let response_url = payload
                        .get("response_url")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let (reply, answer) = oneshot::channel();
                    let _ = inbox.send(SourceEvent::Command { name, user, reply });
                    let http = self.http.clone();
                    tokio::spawn(async move {
                        if let Ok(text) = answer.await {
                            if !response_url.is_empty() {
                                let _ = http
                                    .post(&response_url)
                                    .json(&json!({ "text": text }))
                                    .send()
                                    .await;
                            }
                        }
                    });
                }
                _ => {}
            }
        }
        Ok(())
    }
}

#[async_trait]
impl Source for SlackSource {
    fn name(&self) -> &str {
        SOURCE
    }

    async fn run(&self, inbox: Inbox) -> Result<()> {
        let mut backoff = Duration::from_secs(1);
        loop {
            match self.pump(&inbox).await {
                Ok(()) => backoff = Duration::from_secs(1),
                Err(error) => {
                    tracing::warn!(target: "oxroute::slack", %error, "socket dropped");
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(Duration::from_secs(60));
                }
            }
        }
    }

    async fn reply(&self, target: &Target, text: &str) -> Result<String> {
        let mut last = target.thread_key.clone();
        for chunk in split_message(text) {
            let response = self
                .call(
                    "chat.postMessage",
                    json!({
                        "channel": target.conversation,
                        "thread_ts": target.thread_key,
                        "markdown_text": chunk,
                    }),
                )
                .await?;
            if let Some(ts) = response.get("ts").and_then(Value::as_str) {
                last = ts.to_string();
            }
        }
        Ok(self
            .permalink(&target.conversation, &last)
            .await
            .unwrap_or_default())
    }

    async fn post_status(&self, target: &Target, text: &str) -> Result<Posted> {
        let response = self
            .call(
                "chat.postMessage",
                json!({
                    "channel": target.conversation,
                    "thread_ts": target.thread_key,
                    "text": truncate(text, MAX_MESSAGE),
                }),
            )
            .await?;
        Ok(Posted {
            conversation: target.conversation.clone(),
            id: response
                .get("ts")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        })
    }

    async fn update_status(&self, posted: &Posted, text: &str) -> Result<()> {
        self.call(
            "chat.update",
            json!({
                "channel": posted.conversation,
                "ts": posted.id,
                "text": truncate(text, MAX_MESSAGE),
            }),
        )
        .await?;
        Ok(())
    }

    async fn clear_status(&self, posted: &Posted) -> Result<()> {
        self.call(
            "chat.delete",
            json!({ "channel": posted.conversation, "ts": posted.id }),
        )
        .await?;
        Ok(())
    }

    async fn fetch(&self, attachments: &[Attachment], directory: &str) -> Result<Vec<TurnInput>> {
        let mut inputs = Vec::new();
        for attachment in attachments {
            let host = reqwest::Url::parse(&attachment.url)
                .ok()
                .and_then(|url| url.host_str().map(str::to_string))
                .unwrap_or_default();
            // The token goes in an Authorization header, so it must only ever
            // be sent to Slack itself.
            if attachment.url.is_empty() || !host.ends_with(".slack.com") {
                anyhow::bail!("that attachment has no trusted Slack download url");
            }
            tokio::fs::create_dir_all(directory).await?;
            let response = self
                .http
                .get(&attachment.url)
                .bearer_auth(&self.bot_token)
                .send()
                .await?;
            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_string();
            // Slack serves its sign-in page, with a 200, when the app is
            // missing files:read. Saving that as a PNG helps nobody.
            if content_type.starts_with("text/html") {
                anyhow::bail!(
                    "I couldn't read that attachment because the Slack app is missing the \
                     `files:read` permission. Reinstall it from OAuth & Permissions, then \
                     resend the file."
                );
            }
            let name = std::path::Path::new(&attachment.name)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("attachment");
            let path = std::path::Path::new(directory).join(format!("{}-{name}", attachment.id));
            tokio::fs::write(&path, response.bytes().await?).await?;
            let path = path.to_string_lossy().to_string();
            if attachment.mimetype.starts_with("image/") {
                inputs.push(TurnInput::LocalImage { path });
            } else {
                inputs.push(TurnInput::text(format!(
                    "Slack attachment ({}) saved at {path}",
                    attachment.mimetype
                )));
            }
        }
        Ok(inputs)
    }

    async fn upload(&self, target: &Target, paths: &[String]) -> Result<()> {
        for path in paths {
            let bytes = tokio::fs::read(path).await?;
            let name = std::path::Path::new(path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("artifact")
                .to_string();
            // Uploads are a three-step dance: ask for a URL, PUT the bytes
            // somewhere that is not the API, then tell Slack where to put it.
            let ticket = self
                .http
                .post(format!("{API}/files.getUploadURLExternal"))
                .bearer_auth(&self.bot_token)
                .form(&[("filename", name.as_str()), ("length", &bytes.len().to_string())])
                .send()
                .await?
                .json::<Value>()
                .await?;
            if ticket.get("ok").and_then(Value::as_bool) != Some(true) {
                anyhow::bail!(
                    "slack files.getUploadURLExternal: {}",
                    ticket.get("error").and_then(Value::as_str).unwrap_or("unknown")
                );
            }
            let upload_url = ticket
                .get("upload_url")
                .and_then(Value::as_str)
                .context("slack gave no upload url")?;
            let file_id = ticket
                .get("file_id")
                .and_then(Value::as_str)
                .context("slack gave no file id")?;
            self.http.post(upload_url).body(bytes).send().await?;
            self.call(
                "files.completeUploadExternal",
                json!({
                    "files": [{ "id": file_id, "title": name }],
                    "channel_id": target.conversation,
                    "thread_ts": target.thread_key,
                }),
            )
            .await?;
        }
        Ok(())
    }

    async fn open_thread(&self, conversation: &str, title: &str) -> Result<(String, String)> {
        let response = self
            .call(
                "chat.postMessage",
                json!({ "channel": conversation, "markdown_text": title }),
            )
            .await?;
        let ts = response
            .get("ts")
            .and_then(Value::as_str)
            .context("slack posted without a timestamp")?
            .to_string();
        let permalink = self.permalink(conversation, &ts).await.unwrap_or_default();
        Ok((ts, permalink))
    }

    async fn retitle(&self, target: &Target, title: &str) -> Result<()> {
        let replies = self
            .call(
                "conversations.replies",
                json!({ "channel": target.conversation, "ts": target.thread_key, "limit": 1 }),
            )
            .await?;
        let root = replies
            .pointer("/messages/0")
            .cloned()
            .unwrap_or(Value::Null);
        // Only a message we posted can be edited, so a thread the human
        // started keeps its own opening line.
        if root.get("bot_id").is_none() {
            anyhow::bail!("only threads oxroute opened can be retitled");
        }
        self.call(
            "chat.update",
            json!({ "channel": target.conversation, "ts": target.thread_key, "text": title }),
        )
        .await?;
        Ok(())
    }

    async fn history(&self, target: &Target, limit: usize) -> Result<Vec<(String, String)>> {
        let mut cursor: Option<String> = None;
        let mut out: Vec<(String, String)> = Vec::new();
        loop {
            let mut body = json!({
                "channel": target.conversation,
                "ts": target.thread_key,
                "limit": 100,
            });
            if let Some(next) = &cursor {
                body["cursor"] = json!(next);
            }
            let response = self.call("conversations.replies", body).await?;
            for message in response
                .get("messages")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let text = message.get("text").and_then(Value::as_str).unwrap_or("").trim();
                if text.is_empty() {
                    continue;
                }
                let role = if message.get("bot_id").is_some() {
                    "assistant"
                } else if message.get("user").and_then(Value::as_str)
                    == Some(self.allowed_user.as_str())
                {
                    "user"
                } else {
                    continue;
                };
                out.push((role.into(), text.to_string()));
            }
            cursor = response
                .pointer("/response_metadata/next_cursor")
                .and_then(Value::as_str)
                .filter(|c| !c.is_empty())
                .map(str::to_string);
            if cursor.is_none() {
                break;
            }
        }
        if out.len() > limit {
            out.drain(..out.len() - limit);
        }
        Ok(out)
    }

    async fn permalink(&self, conversation: &str, external_id: &str) -> Result<String> {
        let response = self
            .call(
                "chat.getPermalink",
                json!({ "channel": conversation, "message_ts": external_id }),
            )
            .await?;
        Ok(response
            .get("permalink")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string())
    }
}

/// Split on character boundaries, so a long answer never lands mid-codepoint.
fn split_message(text: &str) -> Vec<String> {
    if text.is_empty() {
        return vec![String::new()];
    }
    let mut chunks = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        if current.len() + ch.len_utf8() > MAX_MESSAGE {
            chunks.push(std::mem::take(&mut current));
        }
        current.push(ch);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

fn truncate(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    let mut end = limit;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source() -> SlackSource {
        SlackSource::new("xapp-test", "xoxb-test", "U_ME")
    }

    #[test]
    fn only_the_allowed_user_in_a_dm_is_accepted() {
        let s = source();
        let base = json!({
            "user": "U_ME", "channel_type": "im", "channel": "D1",
            "ts": "1.0", "text": "hello",
        });
        assert!(s.accepted(&base));

        let mut other = base.clone();
        other["user"] = json!("U_THEM");
        assert!(!s.accepted(&other));

        let mut public = base.clone();
        public["channel_type"] = json!("channel");
        assert!(!s.accepted(&public));

        let mut bot = base.clone();
        bot["bot_id"] = json!("B1");
        assert!(!s.accepted(&bot));

        let mut edited = base.clone();
        edited["subtype"] = json!("message_changed");
        assert!(!s.accepted(&edited));
    }

    #[test]
    fn a_file_with_no_caption_still_counts() {
        let s = source();
        assert!(s.accepted(&json!({
            "user": "U_ME", "channel_type": "im", "channel": "D1", "ts": "1.0",
            "text": "", "subtype": "file_share",
            "files": [{ "id": "F1", "name": "a.png", "mimetype": "image/png" }],
        })));
    }

    #[test]
    fn a_reply_keeps_the_root_as_its_thread_key() {
        let s = source();
        let signal = s
            .to_signal(&json!({
                "user": "U_ME", "channel": "D1", "ts": "2.0",
                "thread_ts": "1.0", "text": "more",
            }))
            .unwrap();
        assert_eq!(signal.thread_key, "1.0");
        assert_eq!(signal.external_id, "2.0");
        assert!(!signal.root);

        let opener = s
            .to_signal(&json!({ "user": "U_ME", "channel": "D1", "ts": "1.0", "text": "go" }))
            .unwrap();
        assert_eq!(opener.thread_key, "1.0");
        assert!(opener.root);
    }

    #[test]
    fn splitting_never_breaks_a_character() {
        let text = "é".repeat(4000);
        let chunks = split_message(&text);
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|c| c.len() <= MAX_MESSAGE));
        assert_eq!(chunks.concat(), text);
    }
}
