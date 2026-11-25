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

use super::{Inbox, Posted, Reply, Source, SourceEvent};
use crate::model::{now, new_id, Attachment, Signal, Target, TurnInput};

pub const SOURCE: &str = "slack";
const API: &str = "https://slack.com/api";
/// Slack rejects anything longer, so a long answer arrives as several posts.
const MAX_MESSAGE: usize = 3_500;

pub struct SlackSource {
    api: String,
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
            api: API.into(),
            app_token: app_token.into(),
            bot_token: bot_token.into(),
            allowed_user: allowed_user.into(),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(60))
                .build()
                .expect("a plain HTTPS client"),
        }
    }

    /// Read the configured source namespace without changing transport or permissions.
    pub async fn account_metadata(&self)->Result<Value> {
        let value:Value=self.http.get(format!("{}/auth.test",self.api)).bearer_auth(&self.bot_token).send().await?.json().await?;
        anyhow::ensure!(value["ok"]==true,"Slack source identity could not be verified");
        let team=value["team_id"].as_str().context("Slack source has no workspace")?;
        let actor=value["user_id"].as_str().context("Slack source has no actor")?;
        Ok(json!({"account":team,"owner":self.allowed_user,"actor":actor}))
    }

    pub fn allowed_user(&self) -> &str {
        &self.allowed_user
    }

    async fn call(&self, method: &str, mut body: Value) -> Result<Value> {
        if body.get("thread_ts").and_then(Value::as_str) == Some("") {
            body.as_object_mut().unwrap().remove("thread_ts");
        }
        self.call_with(&self.bot_token, method, body).await
    }

    async fn call_with(&self, token: &str, method: &str, body: Value) -> Result<Value> {
        let response = self
            .http
            .post(format!("{}/{method}", self.api))
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

        let text=event.get("text").and_then(Value::as_str).unwrap_or_default().to_owned();

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
            text,
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
                        let _ = inbox.send(SourceEvent::Arrived{signal:Box::new(signal),metadata:Some(event.clone())});
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

impl SlackSource {
    async fn read_history(&self, target: &Target, limit: usize, requests:bool) -> Result<Vec<(String, String)>> {
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
                let raw=message.get("text").and_then(Value::as_str).unwrap_or_default();
                let text=if requests&&role=="user"&&message["ts"]==target.thread_key {invocation_prefix(message,true).and_then(|prefix|raw.get(prefix..)).unwrap_or(raw).trim()}else{text};
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

    async fn reply(&self, target: &Target, text: &str) -> Result<Reply> {
        let mut last = target.thread_key.clone();
        let mut messages = Vec::new();
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
            last = response.get("ts").and_then(Value::as_str).context("Slack posted without a timestamp")?.into();
            messages.push(Posted { conversation: target.conversation.clone(), id: last.clone() });
        }
        Ok(Reply {
            permalink: self.permalink(&target.conversation, &last).await.unwrap_or_default(),
            messages,
        })
    }

    async fn link_button(&self, target: &Target, title: &str, url: &str) -> Result<String> {
        let response = self.call("chat.postMessage", json!({
            "channel": target.conversation, "thread_ts": target.thread_key,
            "text": format!("Review changes: {title}"),
            "blocks": [{"type": "section", "text": {"type": "plain_text", "text": title},
                "accessory": {"type": "button", "text": {"type": "plain_text", "text": "Review changes"},
                    "url": url, "action_id": "review_changes"}}]
        })).await?;
        self.permalink(&target.conversation, response["ts"].as_str().context("Slack returned no message timestamp")?).await
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

    async fn upload(&self, target: &Target, paths: &[String]) -> Result<Vec<Posted>> {
        let mut uploaded = Vec::new();
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
                .post(format!("{}/files.getUploadURLExternal", self.api))
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
            uploaded.push(json!({ "id": file_id, "title": name }));
        }
        if uploaded.is_empty() {
            return Ok(Vec::new());
        }
        // One completion call posts every file as a single message.
        let response = self.call(
            "files.completeUploadExternal",
            json!({
                "files": uploaded,
                "channel_id": target.conversation,
                "thread_ts": target.thread_key,
            }),
        )
        .await?;
        let mut messages: Vec<Posted> = Vec::new();
        for file in response["files"].as_array().into_iter().flatten() {
            for visibility in ["private", "public"] {
                for share in file["shares"][visibility][&target.conversation].as_array().into_iter().flatten() {
                    let Some(ts) = share["ts"].as_str() else { continue };
                    if !messages.iter().any(|m| m.id == ts) {
                        messages.push(Posted { conversation: target.conversation.clone(), id: ts.into() });
                    }
                }
            }
        }
        Ok(messages)
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

    async fn history(&self,target:&Target,limit:usize)->Result<Vec<(String,String)>> {self.read_history(target,limit,false).await}
    async fn request_history(&self,target:&Target,limit:usize)->Result<Vec<(String,String)>> {self.read_history(target,limit,true).await}

    async fn permalink(&self, conversation: &str, external_id: &str) -> Result<String> {
        let response = permalink_request(&self.http, &self.api, &self.bot_token, conversation, external_id)
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        if response.get("ok").and_then(Value::as_bool) != Some(true) {
            anyhow::bail!("slack chat.getPermalink: {}", response["error"]);
        }
        response
            .get("permalink")
            .and_then(Value::as_str)
            .filter(|url| !url.is_empty())
            .map(str::to_string)
            .context("Slack returned no message permalink")
    }
}

pub(crate) fn invocation_key(conversation:&str,message:&str)->String {format!("source-invocation:{}",json!([SOURCE,conversation,message]))}

/// Consume only the existing root invocation, using Slack's list metadata when rendered.
pub(crate) fn invocation_prefix(event:&Value,root:bool)->Option<usize> {
    if !root {return None;}
    let raw=event["text"].as_str().unwrap_or_default();let text=raw.trim_start();let leading=raw.len()-text.len();
    if text.starts_with("- ") {return Some(leading+2);}
    let first=event.pointer("/blocks/0/elements/0");
    let list=event.pointer("/blocks/0/type").and_then(Value::as_str)==Some("rich_text")&&first.is_some_and(|element|element["type"]=="rich_text_list"&&element["style"]=="bullet");
    list.then(||leading+if text.starts_with("• "){"• ".len()}else{0})
}

fn permalink_request(http: &reqwest::Client, api: &str, token: &str, channel: &str, ts: &str) -> reqwest::RequestBuilder {
    http.get(format!("{api}/chat.getPermalink"))
        .bearer_auth(token)
        .query(&[("channel", channel), ("message_ts", ts)])
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
    fn permalink_parameters_are_sent_in_the_url() {
        let request = permalink_request(&reqwest::Client::new(), API, "test", "D123", "123.456")
            .build().unwrap();
        assert_eq!(request.method(), reqwest::Method::GET);
        let params: std::collections::HashMap<_, _> = request.url().query_pairs().collect();
        assert_eq!(params.get("channel").unwrap(), "D123");
        assert_eq!(params.get("message_ts").unwrap(), "123.456");
        assert!(request.body().is_none());
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

    #[tokio::test]
    async fn main_chat_transport_preserves_chunks_files_and_thread_targets() {
        use axum::{routing::{get, post}, Json, Router};
        use std::sync::{Arc, Mutex};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::<(String,Value)>::new()));
        let seen = requests.clone();
        let api = endpoint.clone();
        let router = Router::new().route("/chat.postMessage", post(move |Json(body): Json<Value>| {
            let seen = seen.clone();
            async move {
                let mut seen = seen.lock().unwrap();
                let ts = format!("{}.0", seen.len()+10);
                seen.push(("message".into(),body));
                Json(json!({"ok":true,"ts":ts}))
            }
        })).route("/chat.getPermalink", get(|| async {Json(json!({"ok":true,"permalink":"https://example.invalid/message"}))}))
        .route("/files.getUploadURLExternal", post(move || {let api=api.clone(); async move {Json(json!({"ok":true,"file_id":"F1","upload_url":format!("{api}/bytes")}))}}))
        .route("/bytes", post(|| async {"ok"}))
        .route("/files.completeUploadExternal", post({let seen=requests.clone(); move |Json(body):Json<Value>| {let seen=seen.clone(); async move {seen.lock().unwrap().push(("file".into(),body)); Json(json!({"ok":true,"files":[{"shares":{"private":{"D1":[{"ts":"file-message"}]}}}]}))}}}));
        let server = tokio::spawn(async move {axum::serve(listener,router).await.unwrap()});
        let mut slack = source();
        slack.api = endpoint;
        let target = Target::new(SOURCE,"D1","");
        let reply = slack.reply(&target,&"x".repeat(MAX_MESSAGE+10)).await.unwrap();
        assert_eq!(reply.messages.len(),2);
        assert_ne!(reply.messages[0].id,reply.messages[1].id);
        assert_eq!(reply.permalink,"https://example.invalid/message");
        slack.post_status(&target,"Working").await.unwrap();
        slack.reply(&Target::new(SOURCE,"D1","existing"),"Thread reply").await.unwrap();
        let path=std::env::temp_dir().join(format!("{}.txt",new_id("slack-file")));
        tokio::fs::write(&path,"retained attachment").await.unwrap();
        let files = slack.upload(&target,&[path.to_string_lossy().into_owned()]).await.unwrap();
        assert_eq!(files[0].id,"file-message");
        tokio::fs::remove_file(path).await.unwrap();
        let requests=requests.lock().unwrap();
        assert_eq!(requests.len(),5);
        for (_,body) in requests.iter().filter(|(_,body)| body["text"] != "Thread reply" && body["markdown_text"] != "Thread reply") {
            assert!(body.get("thread_ts").is_none(),"main-chat posts must omit thread_ts");
        }
        assert_eq!(requests[3].1["thread_ts"],"existing");
        assert_eq!(requests[4].1["channel_id"],"D1");
        server.abort();
    }

    #[test]
    fn routing_marker_survives_file_only_input() {
        let slack = source();
        let event=json!({"user":"U_ME","channel_type":"im","channel":"D1","ts":"1.0","text":"- ","files":[{"id":"F1","name":"source.txt"}]});
        assert!(slack.accepted(&event));
        let signal=slack.to_signal(&event).unwrap();
        assert_eq!(signal.text,"- ");
        assert_eq!(signal.attachments.len(),1);
        for text in ["• A formatted list", "− A different character", "-without space"] {
            let mut event=event.clone();event["text"]=json!(text);
            assert_eq!(slack.to_signal(&event).unwrap().text,text);
        }
    }

    #[test]
    fn leading_unordered_list_retains_separate_thread_intent_and_contents() {
        let slack=source();
        for text in ["• Inspect storage evidence", "Inspect unordered evidence", "• Compare <https://example.invalid/a|source>\n• Retain the second item\n    ◦ Nested evidence"] {
            let event=json!({"user":"U_ME","channel_type":"im","channel":"D1","ts":"1.0","text":text,
                "blocks":[{"type":"rich_text","elements":[{"type":"rich_text_list","style":"bullet","indent":0,"elements":[{"type":"rich_text_section","elements":[{"type":"text","text":"Interchangeable list content"}]}]}]}]});
            assert!(slack.accepted(&event));
            let signal=slack.to_signal(&event).unwrap();
            assert_eq!(signal.text,text,"Raw provider text is retained independently of invocation projection");
            let prefix=invocation_prefix(&event,true).unwrap();assert_eq!(&signal.text[prefix..],text.strip_prefix("• ").unwrap_or(text));
            for altered in [json!({"thread_ts":"0.9"}),json!({"blocks":[]}),json!({"blocks":[{"type":"rich_text","elements":[{"type":"rich_text_list","style":"ordered"}]}]}),json!({"blocks":[{"type":"rich_text","elements":[{"type":"rich_text_section","elements":[{"type":"text","text":"Introduction"}]},{"type":"rich_text_list","style":"bullet"}]}]})] {
                let mut other=event.clone();for (key,value) in altered.as_object().unwrap(){other[key]=value.clone();}
                assert_eq!(slack.to_signal(&other).unwrap().text,text,"Replies and nonleading or unstructured lists keep their source text");
            }
        }
    }

    struct CaptureHarness {events:tokio::sync::broadcast::Sender<crate::agent::HarnessEvent>,inputs:std::sync::Arc<std::sync::Mutex<Vec<Vec<TurnInput>>>>}
    #[async_trait]
    impl crate::agent::Harness for CaptureHarness {
        fn backend(&self)->crate::model::Backend {crate::model::Backend::Codex}
        fn capabilities(&self)->crate::agent::Capabilities {crate::agent::Capabilities{fork:false,inject:false,resume:false,steer:false}}
        fn events(&self)->tokio::sync::broadcast::Receiver<crate::agent::HarnessEvent> {self.events.subscribe()}
        async fn open(&self,_:&crate::agent::SessionSpec)->Result<String> {Ok(new_id("captured-session"))}
        async fn start(&self,session:&str,inputs:Vec<TurnInput>)->Result<String> {
            self.inputs.lock().unwrap().push(inputs);let id=new_id("captured-turn");let events=self.events.clone();let session=session.to_owned();
            let _=events.send(crate::agent::HarnessEvent::TurnStarted{session:session.clone(),turn_id:id.clone()});
            tokio::spawn(async move{tokio::time::sleep(Duration::from_millis(10)).await;let _=events.send(crate::agent::HarnessEvent::Message{session:session.clone(),text:"Source processing completed.".into(),final_answer:true});let _=events.send(crate::agent::HarnessEvent::TurnFinished{session,status:"completed".into()});});Ok(id)
        }
        async fn interrupt(&self,_:&str,_:&str)->Result<()> {Ok(())}
    }

    #[tokio::test]
    async fn socket_list_intake_preserves_routing_and_payload() {
        let event=if let Some(path)=std::env::var_os("OXROUTE_SLACK_EVENT_FIXTURE") {
            serde_json::from_slice::<Value>(&std::fs::read(path).unwrap()).unwrap()
        }else{json!({"type":"message","user":"U_ME","channel_type":"im","channel":"D1","ts":"1.0","text":"• Inspect <https://example.invalid/evidence|source>\n• Keep the second item",
            "blocks":[{"type":"rich_text","elements":[{"type":"rich_text_list","style":"bullet","indent":0}]}]})};
        let socket_listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let socket_url=format!("ws://{}",socket_listener.local_addr().unwrap());
        let api_listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api=format!("http://{}",api_listener.local_addr().unwrap());
        let router=axum::Router::new().route("/apps.connections.open",axum::routing::post(move||{let url=socket_url.clone();async move{axum::Json(json!({"ok":true,"url":url}))}}));
        let server=tokio::spawn(async move{axum::serve(api_listener,router).await.unwrap()});
        let mut slack=SlackSource::new("fixture-app","fixture-bot",event["user"].as_str().unwrap());slack.api=api;
        let (inbox,mut received)=tokio::sync::mpsc::unbounded_channel();
        let intake=tokio::spawn(async move{slack.pump(&inbox).await});
        let (stream,_)=socket_listener.accept().await.unwrap();let mut socket=tokio_tungstenite::accept_async(stream).await.unwrap();
        socket.send(Message::Text(json!({"type":"events_api","envelope_id":"local-delivery","payload":{"event":event}}).to_string())).await.unwrap();
        let ack=socket.next().await.unwrap().unwrap();let ack:Value=serde_json::from_str(ack.to_text().unwrap()).unwrap();assert_eq!(ack["envelope_id"],"local-delivery");
        let SourceEvent::Arrived{signal,metadata}=tokio::time::timeout(Duration::from_secs(2),received.recv()).await.unwrap().unwrap() else{panic!("expected a message")};
        assert_eq!(signal.text,event["text"].as_str().unwrap());assert_eq!(metadata.as_ref(),Some(&event));assert!(signal.root);
        assert_eq!(signal.external_id,event["ts"].as_str().unwrap());assert_eq!(signal.conversation,event["channel"].as_str().unwrap());
        let capture=std::env::var_os("OXROUTE_SLACK_CAPTURE_DIR").map(std::path::PathBuf::from);
        let scratch=capture.clone().unwrap_or_else(||std::env::temp_dir().join(new_id("slack-invocation")));std::fs::create_dir_all(&scratch).unwrap();
        let mut config=crate::config::Config::load().unwrap();config.database=scratch.join("state.sqlite3");config.workspace=scratch.to_string_lossy().into();config.attachments=scratch.join("attachments");config.artifacts=scratch.join("artifacts");config.owner=signal.author.clone();config.inbox=Default::default();config.min_free_bytes=0;config.slack_app_token=None;config.slack_bot_token=None;config.default_backend=crate::model::Backend::Codex;config.default_model="fixture".into();config.models.clear();config.models.insert("fixture".into(),crate::config::Choice{id:"fixture".into(),label:"Fixture".into(),backend:crate::model::Backend::Codex});
        let store=crate::Store::open(&config.database).unwrap();store.set("mode","auto").unwrap();for key in ["automatic-titles","automatic-tags","recommendation-learning","next-action-suggestions"] {store.set(key,"false").unwrap();}
        let inputs=std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));let harness=std::sync::Arc::new(CaptureHarness{events:tokio::sync::broadcast::channel(64).0,inputs:inputs.clone()});
        let mut hub=crate::Hub::new(config,store);hub.with_harness(harness);hub.start().await.unwrap();
        let expected=event["text"].as_str().unwrap().strip_prefix("• ").unwrap_or(event["text"].as_str().unwrap()).to_owned();
        hub.accept_source((*signal).clone(),metadata.clone()).await.unwrap();
        for _ in 0..200 {if !inputs.lock().unwrap().is_empty(){break;}tokio::time::sleep(Duration::from_millis(10)).await;}
        assert!(inputs.lock().unwrap().iter().flatten().any(|input|input.as_text()==Some(expected.as_str())),"Actual socket ingestion supplies a clean derived request to the harness");
        let agent=hub.store.bound_agent(SOURCE,&signal.conversation,&signal.thread_key).unwrap().unwrap();
        assert_eq!(hub.store.agent(&agent).unwrap().unwrap().name,crate::naming::provisional(&expected));
        assert!(hub.store.timeline(&agent,100).unwrap().iter().any(|entry|entry.kind==crate::model::EntryKind::Received&&entry.text==expected));
        assert_eq!(hub.store.inbox_item(&signal.id).unwrap().unwrap().signal.text,signal.text,"The provider source record remains byte-exact");
        let original=inputs.lock().unwrap().len();hub.accept_source((*signal).clone(),metadata).await.unwrap();assert_eq!(inputs.lock().unwrap().len(),original,"Provider redelivery cannot invoke work twice");
        for _ in 0..200 {if hub.store.agent(&agent).unwrap().unwrap().status==crate::model::AgentStatus::Complete {break;}tokio::time::sleep(Duration::from_millis(10)).await;}
        let mut reply=event.clone();reply["ts"]=json!("2.0");reply["thread_ts"]=event["ts"].clone();reply["text"]=json!("• Preserve literal reply .config");
        socket.send(Message::Text(json!({"type":"events_api","envelope_id":"local-reply","payload":{"event":reply}}).to_string())).await.unwrap();socket.next().await.unwrap().unwrap();
        let SourceEvent::Arrived{signal:reply_signal,metadata}=tokio::time::timeout(Duration::from_secs(2),received.recv()).await.unwrap().unwrap() else{panic!("expected a reply")};
        hub.accept_source((*reply_signal).clone(),metadata).await.unwrap();
        for _ in 0..200 {if inputs.lock().unwrap().len()>=2 {break;}tokio::time::sleep(Duration::from_millis(10)).await;}
        assert!(inputs.lock().unwrap()[1].iter().any(|input|input.as_text()==reply["text"].as_str()),"Existing-thread punctuation is not a consumed invocation");
        assert_eq!(hub.store.bound_agent(SOURCE,&reply_signal.conversation,&reply_signal.thread_key).unwrap().as_deref(),Some(agent.as_str()));
        assert_eq!(hub.store.agent(&agent).unwrap().unwrap().name,crate::naming::provisional(&expected));
        let mut literal=(*signal).clone();literal.id=new_id("literal-source");literal.source="fixture-mail".into();hub.accept_source(literal,Some(event.clone())).await.unwrap();
        for _ in 0..200 {if inputs.lock().unwrap().len()>=3 {break;}tokio::time::sleep(Duration::from_millis(10)).await;}
        assert!(inputs.lock().unwrap()[2].iter().any(|input|input.as_text()==event["text"].as_str()),"Non-Slack input is unchanged even when its content resembles an invocation");
        for _ in 0..200 {if hub.store.unarchived_agents().unwrap().iter().all(|agent|agent.status==crate::model::AgentStatus::Complete) {break;}tokio::time::sleep(Duration::from_millis(10)).await;}
        assert!(hub.store.unarchived_agents().unwrap().iter().all(|agent|agent.status==crate::model::AgentStatus::Complete),"Captured conversations must be settled before runtime reuse");
        intake.abort();server.abort();
        if let Some(directory)=capture {std::fs::write(directory.join("capture.json"),serde_json::to_vec_pretty(&json!({"agentId":agent,"rawSignal":signal,"request":expected,"inputs":inputs.lock().unwrap().clone()})).unwrap()).unwrap();}
    }

    #[tokio::test]
    async fn request_history_keeps_raw_history_and_reply_punctuation() {
        let raw="• Inspect .config evidence\n• Keep the later item";
        let messages=json!({"ok":true,"messages":[{"ts":"1.0","user":"U_ME","thread_ts":"1.0","text":raw,"blocks":[{"type":"rich_text","elements":[{"type":"rich_text_list","style":"bullet"}]}]},{"ts":"1.1","user":"U_ME","thread_ts":"1.0","text":"• Preserve reply content"}]});
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let mut source=source();source.api=format!("http://{}",listener.local_addr().unwrap());
        let app=axum::Router::new().route("/conversations.replies",axum::routing::post(move||{let body=messages.clone();async{axum::Json(body)}}));let server=tokio::spawn(async move{axum::serve(listener,app).await.unwrap()});
        let target=Target::new(SOURCE,"D1","1.0");let original=source.history(&target,8).await.unwrap();assert_eq!(original[0].1,raw);
        let requests=source.request_history(&target,8).await.unwrap();assert_eq!(requests[0].1,"Inspect .config evidence\n• Keep the later item");assert_eq!(requests[1].1,"• Preserve reply content");assert_eq!(source.history(&target,8).await.unwrap(),original);server.abort();
    }

    #[test]
    fn invocation_projection_preserves_literal_content_and_reply_scope() {
        let source=source();
        for body in ["Inspect .config evidence","Compare 0.8 capacity","• Preserve a literal bullet","Review storage. Keep details."] {
            let event=json!({"user":"U_ME","channel_type":"im","channel":"D1","ts":"1.0","text":format!("• {body}\n• Keep the later list item"),"blocks":[{"type":"rich_text","elements":[{"type":"rich_text_list","style":"bullet"}]}]});
            let raw=source.to_signal(&event).unwrap();let prefix=invocation_prefix(&event,true).unwrap();assert_eq!(&raw.text[prefix..],format!("{body}\n• Keep the later list item"));
            assert_eq!(invocation_prefix(&event,false),None,"A reply's ordinary list is not a consumed root invocation");
            let mut plain=event.clone();plain["blocks"]=json!([]);assert_eq!(invocation_prefix(&plain,true),None,"Literal punctuation alone never establishes the rich-list trigger");
            for kind in ["mpim","channel"] {let mut other=event.clone();other["channel_type"]=json!(kind);assert!(!source.accepted(&other),"Do not broaden existing primary-adapter admission");}
            let mut explicit=event.clone();explicit["text"]=json!(format!("- {body}"));let raw=explicit["text"].as_str().unwrap();assert_eq!(&raw[invocation_prefix(&explicit,true).unwrap()..],body,"Consume exactly the explicit marker, including when content begins with a literal bullet");
        }
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

#[cfg(test)]
mod thread_tests;
