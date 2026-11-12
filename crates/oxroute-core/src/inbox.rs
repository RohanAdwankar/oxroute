//! Read-only personal inbox polling. Imported context never starts a turn.
use crate::{
    model::{new_id, now, Event, Signal},
    Hub,
};
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{path::PathBuf, sync::Arc, time::Duration};

pub const OUTLOOK: &str = "outlook-inbox";
pub const SLACK: &str = "slack-inbox";
pub fn imported(source: &str) -> bool {
    matches!(source, OUTLOOK | SLACK)
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub outlook_token_file: Option<PathBuf>,
    pub slack_token_file: Option<PathBuf>,
    pub slack_app_token_file: Option<PathBuf>,
    #[serde(default)]
    pub slack_channels: Vec<String>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub source: String,
    pub configured: bool,
    pub last_sync: Option<f64>,
    pub error: Option<String>,
}

pub fn statuses(hub: &Hub) -> Vec<Status> {
    [
        (OUTLOOK, &hub.config.inbox.outlook_token_file),
        (SLACK, &hub.config.inbox.slack_token_file),
    ]
    .into_iter()
    .map(|(source, path)| {
        let mut status: Status = hub
            .store
            .get(&format!("inbox-status:{source}"))
            .ok()
            .flatten()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        status.source = source.into();
        status.configured = path.is_some();
        if source == SLACK && status.configured && status.error.is_none() {
            status.error = if hub.config.inbox.slack_app_token_file.is_none() {
                Some("Live updates need the dedicated Slack app token file".into())
            } else {
                hub.store
                    .get("inbox-events-error")
                    .ok()
                    .flatten()
                    .filter(|value| !value.is_empty())
            };
        }
        status
    })
    .collect()
}

struct Reader {
    http: reqwest::Client,
    base: reqwest::Url,
    token_file: PathBuf,
}
#[derive(Debug)]
struct HttpError(reqwest::StatusCode);
impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "connector HTTP {}", self.0)
    }
}
impl std::error::Error for HttpError {}
#[derive(Debug)]
struct SlackError(String);
impl std::fmt::Display for SlackError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Slack read failed: {}", self.0)
    }
}
impl std::error::Error for SlackError {}
impl Reader {
    fn new(base: &str, token_file: PathBuf) -> Result<Self> {
        Ok(Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(60))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            base: base.parse()?,
            token_file,
        })
    }
    async fn get(&self, path: &str, query: &[(&str, &str)]) -> Result<Value> {
        let url = self.base.join(path)?;
        ensure!(
            url.origin() == self.base.origin(),
            "connector pagination changed origin"
        );
        let token = tokio::fs::read_to_string(&self.token_file)
            .await
            .context("read protected connector token file")?;
        ensure!(!token.trim().is_empty(), "connector token file is empty");
        loop {
            let response = self
                .http
                .get(url.clone())
                .bearer_auth(token.trim())
                .query(query)
                .header(
                    "Prefer",
                    "IdType=\"ImmutableId\", outlook.body-content-type=\"text\"",
                )
                .send()
                .await
                .map_err(|_| anyhow::anyhow!("connector request failed"))?;
            let status = response.status();
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                let retry = response
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(60);
                tokio::time::sleep(Duration::from_secs(retry)).await;
                continue;
            }
            if !status.is_success() {
                return Err(HttpError(status).into());
            }
            let value = response
                .json::<Value>()
                .await
                .context("read connector JSON")?;
            if value.get("ok") == Some(&Value::Bool(false)) {
                return Err(SlackError(value["error"].as_str().unwrap_or("unknown").into()).into());
            }
            return Ok(value);
        }
    }
}

pub fn start(hub: Arc<Hub>) {
    if let (Some(token), Some(app)) = (
        hub.config.inbox.slack_token_file.clone(),
        hub.config.inbox.slack_app_token_file.clone(),
    ) {
        let events = hub.clone();
        tokio::spawn(async move {
            loop {
                if let Ok(reader) = Reader::new("https://slack.com/api/", token.clone()) {
                    if let Err(error) = slack_events(events.clone(), reader, app.clone()).await {
                        tracing::warn!(%error,"personal Slack events disconnected");
                        let _ = events.store.set("inbox-events-error", &error.to_string());
                    }
                }
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        });
    }
    let advisor = hub.clone();
    tokio::spawn(async move {
        loop {
            let waiting = advisor.store.pending_imports().unwrap_or_default();
            for id in waiting {
                if let Err(error) = advisor.recommend_routing(&id).await {
                    tracing::warn!(%error,"inbox routing suggestion failed");
                    tokio::time::sleep(Duration::from_secs(60)).await;
                }
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });
    for (source, path, base) in [
        (
            OUTLOOK,
            hub.config.inbox.outlook_token_file.clone(),
            "https://graph.microsoft.com/",
        ),
        (
            SLACK,
            hub.config.inbox.slack_token_file.clone(),
            "https://slack.com/api/",
        ),
    ] {
        let Some(path) = path else { continue };
        let hub = hub.clone();
        tokio::spawn(async move {
            let reader = match Reader::new(base, path) {
                Ok(reader) => reader,
                Err(error) => {
                    tracing::error!(%source,%error,"inbox reader failed");
                    return;
                }
            };
            loop {
                let result = if source == OUTLOOK {
                    outlook(&hub, &reader).await
                } else {
                    slack(&hub, &reader).await
                };
                let mut status = statuses(&hub)
                    .into_iter()
                    .find(|s| s.source == source)
                    .unwrap_or_default();
                match result {
                    Ok(()) => {
                        status.last_sync = Some(now());
                        status.error = None
                    }
                    Err(error) => status.error = Some(error.to_string()),
                }
                if let Ok(value) = serde_json::to_string(&status) {
                    let _ = hub.store.set(&format!("inbox-status:{source}"), &value);
                }
                hub.emit(Event::Sync);
                tokio::time::sleep(Duration::from_secs(60)).await;
            }
        });
    }
}

async fn outlook(hub: &Arc<Hub>, reader: &Reader) -> Result<()> {
    let profile = reader
        .get("v1.0/me/mailFolders/inbox", &[("$select", "id")])
        .await?;
    let account = profile["id"]
        .as_str()
        .context("Outlook profile has no id")?;
    let key = format!("inbox-cursor:{OUTLOOK}:{account}");
    let since = time::OffsetDateTime::now_utc() - time::Duration::days(7);
    let initial=format!("v1.0/me/mailFolders/inbox/messages/delta?$select=id,conversationId,subject,from,body,receivedDateTime,webLink,hasAttachments&$top=100&$filter=receivedDateTime ge {}",since.format(&time::format_description::well_known::Rfc3339)?);
    let mut url = hub.store.get(&key)?.unwrap_or_else(|| initial.clone());
    loop {
        let page = match reader.get(&url, &[]).await {
            Ok(page) => page,
            Err(error) => {
                if error
                    .downcast_ref::<HttpError>()
                    .is_some_and(|e| e.0 == reqwest::StatusCode::GONE)
                {
                    hub.store.set(&key, &initial)?;
                }
                return Err(error);
            }
        };
        for item in page["value"]
            .as_array()
            .context("Outlook page has no messages")?
        {
            if item.get("@removed").is_some() {
                continue;
            }
            let id = item["id"].as_str().context("Outlook message has no id")?;
            let thread = item["conversationId"].as_str().unwrap_or(id);
            let mut text = item["body"]["content"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            if item["hasAttachments"] == true {
                text.push_str("\n[Attachments available in Outlook]");
            }
            let at = item["receivedDateTime"]
                .as_str()
                .and_then(|s| {
                    time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339)
                        .ok()
                })
                .map(|t| t.unix_timestamp() as f64)
                .unwrap_or_else(now);
            let signal = Signal {
                id: new_id("sig"),
                source: OUTLOOK.into(),
                conversation: account.into(),
                thread_key: thread.into(),
                external_id: id.into(),
                author: item["from"]["emailAddress"]["address"]
                    .as_str()
                    .unwrap_or_default()
                    .into(),
                label: item["subject"].as_str().unwrap_or("Email").into(),
                text,
                attachments: vec![],
                at,
                root: true,
            };
            hub.import_inbox(signal, item["webLink"].as_str().unwrap_or_default())
                .await?;
        }
        hub.emit(Event::Sync);
        if let Some(next) = page["@odata.nextLink"].as_str() {
            url = next.into();
            hub.store.set(&key, &url)?;
        } else {
            hub.store.set(
                &key,
                page["@odata.deltaLink"]
                    .as_str()
                    .context("Outlook page has no continuation")?,
            )?;
            return Ok(());
        }
    }
}

async fn slack(hub: &Arc<Hub>, reader: &Reader) -> Result<()> {
    let profile = reader.get("auth.test", &[]).await?;
    let account = profile["team_id"]
        .as_str()
        .context("Slack profile has no team")?;
    let user = profile["user_id"]
        .as_str()
        .context("Slack profile has no user")?;
    let mut cursor = String::new();
    loop {
        let page = reader
            .get(
                "users.conversations",
                &[("types", "im,mpim"), ("limit", "200"), ("cursor", &cursor)],
            )
            .await?;
        let mut channels = page["channels"]
            .as_array()
            .context("Slack page has no channels")?
            .clone();
        if cursor.is_empty() {
            channels.extend(
                hub.config
                    .inbox
                    .slack_channels
                    .iter()
                    .map(|id| serde_json::json!({"id":id,"name":id})),
            );
        }
        for channel in &channels {
            let id = channel["id"].as_str().context("Slack channel has no id")?;
            let conversation = format!("{account}:{user}:{id}");
            if channel["is_im"] == true || channel["is_mpim"] == true {
                hub.store.set(&format!("inbox-dm:{account}:{id}"), "true")?;
            }
            let label = channel["name"]
                .as_str()
                .unwrap_or(if channel["is_im"] == true {
                    "Direct message"
                } else {
                    "Group message"
                });
            let key = format!("inbox-cursor:{SLACK}:{conversation}");
            let oldest = hub
                .store
                .get(&key)?
                .unwrap_or_else(|| format!("{:.6}", now() - 7.0 * 86400.0));
            let upper = format!("{:.6}", now());
            let mut next = String::new();
            loop {
                let history = reader
                    .get(
                        "conversations.history",
                        &[
                            ("channel", id),
                            ("oldest", &oldest),
                            ("latest", &upper),
                            ("limit", "100"),
                            ("cursor", &next),
                        ],
                    )
                    .await?;
                for message in history["messages"]
                    .as_array()
                    .context("Slack history has no messages")?
                {
                    slack_message(hub, message, &conversation, label, id).await?;
                }
                hub.emit(Event::Sync);
                next = history["response_metadata"]["next_cursor"]
                    .as_str()
                    .unwrap_or_default()
                    .into();
                if next.is_empty() {
                    break;
                }
            }
            hub.store.set(&key, &upper)?;
        }
        cursor = page["response_metadata"]["next_cursor"]
            .as_str()
            .unwrap_or_default()
            .into();
        if cursor.is_empty() {
            break;
        }
    }
    slack_mentions(hub, reader, account, user).await?;
    recover_slack_threads(hub, reader, &format!("{account}:{user}:")).await
}

/// Rotate through a bounded set of known roots, independent of channel history.
async fn recover_slack_threads(
    hub: &Arc<Hub>,
    reader: &Reader,
    account_prefix: &str,
) -> Result<()> {
    for (conversation, mut state) in hub.store.slack_recovery(account_prefix, 16)? {
        let channel = conversation
            .strip_prefix(account_prefix)
            .context("Slack thread has no channel")?;
        let label = hub
            .store
            .inbox_label(SLACK, &conversation)?
            .unwrap_or_else(|| channel.into());
        if state.latest.is_empty() {
            state.oldest = state.checkpoint.clone();
            state.latest = format!("{:.6}", now());
        }
        // Save a continuation after each page, so an interrupted sweep resumes exactly.
        for _ in 0..2 {
            let page = match reader
                .get(
                    "conversations.replies",
                    &[
                        ("channel", channel),
                        ("ts", &state.thread),
                        ("oldest", &state.oldest),
                        ("latest", &state.latest),
                        ("inclusive", "true"),
                        ("limit", "100"),
                        ("cursor", &state.cursor),
                    ],
                )
                .await
            {
                Ok(page) => page,
                Err(error)
                    if error.downcast_ref::<SlackError>().is_some_and(|e| {
                        matches!(e.0.as_str(), "thread_not_found" | "message_not_found")
                    }) =>
                {
                    state.available = false;
                    hub.store.save_slack_thread(&conversation, &state)?;
                    break;
                }
                Err(error) => return Err(error),
            };
            for message in page["messages"]
                .as_array()
                .context("Slack replies has no messages")?
            {
                slack_message(hub, message, &conversation, &label, channel).await?;
            }
            state.cursor = page["response_metadata"]["next_cursor"]
                .as_str()
                .unwrap_or_default()
                .into();
            if state.cursor.is_empty() {
                state.checkpoint = state.latest.clone();
                state.oldest.clear();
                state.latest.clear();
            }
            hub.store.save_slack_thread(&conversation, &state)?;
            hub.emit(Event::Sync);
            if state.cursor.is_empty() {
                break;
            }
        }
    }
    Ok(())
}
async fn slack_message(
    hub: &Arc<Hub>,
    message: &Value,
    conversation: &str,
    label: &str,
    channel: &str,
) -> Result<()> {
    let Some(ts) = message["ts"].as_str() else {
        return Ok(());
    };
    hub.store
        .remember_slack_thread(conversation, message["thread_ts"].as_str().unwrap_or(ts))?;
    let mut text = message["text"].as_str().unwrap_or_default().to_string();
    if let Some(files) = message["files"].as_array() {
        for file in files {
            text.push_str(&format!(
                "\n[Attachment: {}]",
                file["name"].as_str().unwrap_or("file")
            ));
        }
    }
    if text.is_empty() {
        return Ok(());
    }
    let dm = hub
        .store
        .get(&format!(
            "inbox-dm:{}:{channel}",
            conversation.split(':').next().unwrap_or_default()
        ))?
        .is_some();
    let thread = if dm {
        "conversation"
    } else {
        message["thread_ts"].as_str().unwrap_or(ts)
    };
    let signal = Signal {
        id: new_id("sig"),
        source: SLACK.into(),
        conversation: conversation.into(),
        thread_key: thread.into(),
        external_id: ts.into(),
        author: message["user"]
            .as_str()
            .or(message["bot_id"].as_str())
            .unwrap_or_default()
            .into(),
        label: label.into(),
        text,
        attachments: vec![],
        at: ts.parse().unwrap_or_else(|_| now()),
        root: message["thread_ts"].is_null(),
    };
    hub.import_inbox(
        signal,
        &format!(
            "https://app.slack.com/archives/{channel}/p{}",
            ts.replace('.', "")
        ),
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::{Query, State},
        routing::{get, post},
        Json, Router,
    };
    use serde_json::json;
    use std::{collections::HashMap, sync::Mutex};
    #[derive(Default)]
    struct Remote {
        base: String,
        socket: String,
        round: usize,
        fail: bool,
        reads: Vec<String>,
    }
    async fn graph(State(state): State<Arc<Mutex<Remote>>>, uri: axum::http::Uri) -> Json<Value> {
        let mut remote = state.lock().unwrap();
        remote.reads.push(uri.to_string());
        let message = |id: &str, text: &str| json!({"id":id,"conversationId":"thread","subject":"Capacity report","from":{"emailAddress":{"address":"sender@example.test"}},"body":{"content":text},"receivedDateTime":"2026-11-12T10:00:00Z","webLink":"https://outlook.example.test/message"});
        Json(match uri.path() {
            "/v1.0/me/mailFolders/inbox" => json!({"id":"mailbox"}),
            "/v1.0/me/mailFolders/inbox/messages/delta" => {
                json!({"value":[message("first","Current observations")],"@odata.nextLink":format!("{}page",remote.base)})
            }
            "/page" => {
                json!({"value":[message("second","Additional measurements")],"@odata.deltaLink":format!("{}delta",remote.base)})
            }
            "/delta" => {
                json!({"value":if remote.round==0{vec![]}else{vec![message("third","New observation")]},"@odata.deltaLink":format!("{}delta",remote.base)})
            }
            _ => panic!("unexpected graph request"),
        })
    }
    async fn slack_api(
        State(state): State<Arc<Mutex<Remote>>>,
        uri: axum::http::Uri,
        Query(_query): Query<HashMap<String, String>>,
    ) -> (axum::http::StatusCode, Json<Value>) {
        let mut remote = state.lock().unwrap();
        remote.reads.push(uri.to_string());
        if remote.fail && uri.path() == "/conversations.history" {
            return (
                axum::http::StatusCode::UNAUTHORIZED,
                Json(json!({"ok":false,"error":"invalid_auth"})),
            );
        }
        let value = match uri.path() {
            "/auth.test" => json!({"ok":true,"team_id":"team","user_id":"owner"}),
            "/users.conversations" => {
                json!({"ok":true,"channels":[{"id":"channel","name":"ongoing-work"}]})
            }
            "/search.messages" => {
                json!({"ok":true,"messages":{"matches":[],"pagination":{"page_count":1,"total_count":0}}})
            }
            "/conversations.history" => {
                json!({"ok":true,"messages":if remote.round==0{vec![json!({"ts":"1700000000.000001","user":"sender","text":"Current observations","reply_count":1})]}else{vec![]}})
            }
            "/conversations.replies" => {
                json!({"ok":true,"messages":[{"ts":"1700000000.000001","user":"sender","text":"Current observations"},{"ts":"1700000001.000002","thread_ts":"1700000000.000001","user":"owner","text":"Context from the owner"}]})
            }
            _ => panic!("unexpected slack request"),
        };
        (axum::http::StatusCode::OK, Json(value))
    }
    #[tokio::test]
    async fn polling_groups_pages_survives_restart_and_never_runs_imported_context() -> Result<()> {
        let scratch = std::env::temp_dir().join(new_id("inbox-test"));
        tokio::fs::create_dir_all(&scratch).await?;
        let token = scratch.join("token");
        tokio::fs::write(&token, "fixture").await?;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let base = format!("http://{}/", listener.local_addr()?);
        let remote = Arc::new(Mutex::new(Remote {
            base: base.clone(),
            ..Default::default()
        }));
        let app = Router::new()
            .route(
                "/apps.connections.open",
                post(|State(remote): State<Arc<Mutex<Remote>>>| async move {
                    Json(json!({"ok":true,"url":remote.lock().unwrap().socket}))
                }),
            )
            .route("/v1.0/me/mailFolders/inbox", get(graph))
            .route("/v1.0/me/mailFolders/inbox/messages/delta", get(graph))
            .route("/page", get(graph))
            .route("/delta", get(graph))
            .route("/search.messages", get(slack_api))
            .route("/auth.test", get(slack_api))
            .route("/users.conversations", get(slack_api))
            .route("/conversations.history", get(slack_api))
            .route("/conversations.replies", get(slack_api))
            .with_state(remote.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let mut config = crate::Config::load()?;
        config.inbox = Config::default();
        config.min_free_bytes = 0;
        let database = scratch.join("inbox.sqlite3");
        let hub = Hub::new(config.clone(), crate::Store::open(&database)?);
        hub.set_mode(crate::Mode::Auto)?;
        let reader = Reader::new(&base, token.clone())?;
        outlook(&hub, &reader).await?;
        slack(&hub, &reader).await?;
        let items = hub.store.inbox(10)?;
        assert_eq!(items.len(), 2);
        assert!(items
            .iter()
            .all(|i| i.state == crate::model::InboxState::Waiting));
        assert!(items
            .iter()
            .find(|i| i.signal.source == SLACK)
            .unwrap()
            .signal
            .text
            .contains("Context from the owner"));
        assert!(
            hub.store.unarchived_agents()?.is_empty(),
            "Import does not start an agent even in automatic mode"
        );
        let mail = items.iter().find(|i| i.signal.source == OUTLOOK).unwrap();
        let mail_id = mail.signal.id.clone();
        hub.store.resolve_signal(&mail_id, "discarded", &[])?;
        drop(hub);
        let hub = Hub::new(config, crate::Store::open(&database)?);
        outlook(&hub, &reader).await?;
        slack(&hub, &reader).await?;
        assert_eq!(hub.store.inbox(10)?.len(), 2);
        assert_eq!(
            hub.store.inbox_item(&mail_id)?.unwrap().state,
            crate::model::InboxState::Done
        );
        remote.lock().unwrap().round = 1;
        outlook(&hub, &reader).await?;
        let mail = hub.store.inbox_item(&mail_id)?.unwrap();
        assert_eq!(mail.state, crate::model::InboxState::Waiting);
        assert!(mail.signal.text.contains("New observation"));
        assert!(mail.signal.text.contains("Additional measurements"));
        let cursor = hub
            .store
            .get("inbox-cursor:slack-inbox:team:owner:channel")?;
        remote.lock().unwrap().fail = true;
        assert!(slack(&hub, &reader).await.is_err());
        assert_eq!(
            cursor,
            hub.store
                .get("inbox-cursor:slack-inbox:team:owner:channel")?
        );
        assert!(
            reader
                .get("https://example.test/untrusted-pagination", &[])
                .await
                .is_err(),
            "Pagination must not leak credentials to another origin"
        );
        assert!(hub.store.unarchived_agents()?.is_empty());
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;
        let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        remote.lock().unwrap().socket = format!("ws://{}", socket.local_addr()?);
        let event_server = tokio::spawn(async move {
            let (stream, _) = socket.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            for (number,event) in [json!({"type":"message","channel":"direct","channel_type":"im","user":"sender","ts":"1800000000.000001","text":"A new direct conversation"}),json!({"type":"message","channel":"direct","channel_type":"im","user":"owner","ts":"1800000001.000001","text":"Additional context"}),json!({"type":"message","channel":"unselected","channel_type":"channel","ts":"1800000000.000002","text":"Unselected channel"})].into_iter().enumerate() {
                let id=format!("envelope-{number}");
                socket.send(Message::Text(json!({"envelope_id":id,"payload":{"event":event}}).to_string())).await.unwrap();
                let ack=socket.next().await.unwrap().unwrap();
                assert_eq!(serde_json::from_str::<Value>(ack.to_text().unwrap()).unwrap()["envelope_id"],id);
            }
            socket.close(None).await.unwrap();
        });
        assert!(
            slack_events(hub.clone(), Reader::new(&base, token.clone())?, token)
                .await
                .is_err()
        );
        event_server.await?;
        let direct = hub
            .store
            .inbox(10)?
            .into_iter()
            .find(|item| item.signal.conversation.ends_with(":direct"))
            .unwrap();
        assert!(direct.signal.text.contains("Additional context"));
        assert_eq!(
            hub.store.inbox(10)?.len(),
            3,
            "DM events group together; unselected channel events are excluded"
        );
        assert!(hub.store.unarchived_agents()?.is_empty());
        server.abort();
        tokio::fs::remove_dir_all(scratch).await?;
        Ok(())
    }
    struct RecoveryRemote {
        roots: Vec<String>,
        phase: usize,
        reply_at: f64,
        fail_page: bool,
        calls: Vec<(String, HashMap<String, String>)>,
    }
    async fn recovery_api(
        State(state): State<Arc<Mutex<RecoveryRemote>>>,
        uri: axum::http::Uri,
        Query(query): Query<HashMap<String, String>>,
    ) -> (axum::http::StatusCode, Json<Value>) {
        let mut remote = state.lock().unwrap();
        remote.calls.push((uri.path().into(), query.clone()));
        let value = match uri.path() {
            "/auth.test" => json!({"ok":true,"team_id":"workspace","user_id":"owner"}),
            "/users.conversations" => {
                if query.get("cursor").is_none_or(|s| s.is_empty()) {
                    json!({"ok":true,"channels":[{"id":"direct","is_im":true}],"response_metadata":{"next_cursor":"groups"}})
                } else {
                    json!({"ok":true,"channels":[{"id":"group","is_mpim":true}]})
                }
            }
            "/search.messages" => {
                json!({"ok":true,"messages":{"matches":if remote.phase==0 {vec![json!({"ts":remote.roots[0],"thread_ts":remote.roots[0],"user":"sender","text":"Opening observation 0","channel":{"id":"mentioned","name":"Context review"}})]}else{vec![]},"pagination":{"page_count":1,"total_count":1}}})
            }
            "/conversations.history" => {
                let offset = query
                    .get("cursor")
                    .and_then(|s| s.parse::<usize>().ok())
                    .unwrap_or(0);
                if remote.phase > 0 {
                    json!({"ok":true,"messages":[]})
                } else {
                    let next = if offset + 1 < remote.roots.len() {
                        (offset + 1).to_string()
                    } else {
                        String::new()
                    };
                    json!({"ok":true,"messages":[{"ts":remote.roots[offset],"user":"sender","text":format!("Opening observation {offset}"),"reply_count":0}],"response_metadata":{"next_cursor":next}})
                }
            }
            "/conversations.replies" => {
                let offset = query
                    .get("cursor")
                    .and_then(|s| s.parse::<usize>().ok())
                    .unwrap_or(0);
                if remote.phase > 0 && offset == 1 && remote.fail_page {
                    remote.fail_page = false;
                    return (
                        axum::http::StatusCode::SERVICE_UNAVAILABLE,
                        Json(json!({"error":"temporarily unavailable"})),
                    );
                }
                let root = query.get("ts").unwrap();
                let index = remote.roots.iter().position(|s| s == root).unwrap();
                let oldest = query.get("oldest").unwrap().parse::<f64>().unwrap();
                let latest = query.get("latest").unwrap().parse::<f64>().unwrap();
                let messages: Vec<_> = if remote.phase == 0 {
                    vec![
                        json!({"ts":root,"user":"sender","text":format!("Opening observation {index}")}),
                    ]
                } else {
                    (0..3).filter_map(|part|{
                    let at=remote.reply_at+index as f64*0.0001+part as f64*0.00001;
                    (at>=oldest&&at<=latest).then(||json!({"ts":format!("{at:.6}"),"thread_ts":root,"user":"sender","text":format!("Delta {index}-{part}")}))
                }).collect()
                };
                let next = if offset + 1 < messages.len() {
                    (offset + 1).to_string()
                } else {
                    String::new()
                };
                json!({"ok":true,"messages":messages.get(offset).into_iter().collect::<Vec<_>>(),"response_metadata":{"next_cursor":next}})
            }
            _ => panic!("unexpected recovery endpoint"),
        };
        (axum::http::StatusCode::OK, Json(value))
    }

    #[tokio::test]
    async fn older_threads_recover_in_bounded_pages_after_disconnect_and_restart() -> Result<()> {
        for roots in [2, 20] {
            let scratch = std::env::temp_dir().join(new_id("slack-recovery"));
            tokio::fs::create_dir_all(&scratch).await?;
            let token = scratch.join("token");
            tokio::fs::write(&token, "fixture").await?;
            let remote = Arc::new(Mutex::new(RecoveryRemote {
                roots: (0..roots)
                    .map(|i| format!("{:.6}", now() - 3600.0 - i as f64))
                    .collect(),
                phase: 0,
                reply_at: 0.0,
                fail_page: false,
                calls: vec![],
            }));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
            let base = format!("http://{}/", listener.local_addr()?);
            let app = Router::new()
                .fallback(recovery_api)
                .with_state(remote.clone());
            let server = tokio::spawn(async move {
                axum::serve(listener, app).await.unwrap();
            });
            let mut config = crate::Config::load()?;
            config.inbox = Config {
                slack_channels: vec!["work".into()],
                ..Default::default()
            };
            let database = scratch.join("inbox.sqlite3");
            let hub = Hub::new(config.clone(), crate::Store::open(&database)?);
            let reader = Reader::new(&base, token)?;
            slack(&hub, &reader).await?;
            let original: std::collections::HashSet<_> = hub
                .store
                .inbox(100)?
                .into_iter()
                .map(|item| item.signal.id)
                .collect();
            assert_eq!(original.len(), roots + 3);
            let before = hub
                .store
                .slack_recovery("workspace:owner:direct", 100)?
                .into_iter()
                .map(|(_, s)| (s.thread, s.checkpoint))
                .collect::<HashMap<_, _>>();
            tokio::time::sleep(Duration::from_millis(20)).await;
            {
                let mut state = remote.lock().unwrap();
                state.phase = 1;
                state.reply_at = now() - 0.01;
                state.fail_page = true;
            }
            assert!(slack(&hub, &reader).await.is_err());
            let pending = hub
                .store
                .slack_recovery("workspace:owner:direct", 100)?
                .into_iter()
                .map(|(_, s)| s)
                .find(|s| !s.cursor.is_empty())
                .unwrap();
            assert_eq!(pending.cursor, "1");
            assert_eq!(pending.checkpoint, before[&pending.thread]);
            drop(hub);
            let hub = Hub::new(config, crate::Store::open(&database)?);
            for _ in 0..10 {
                let start = remote.lock().unwrap().calls.len();
                slack(&hub, &reader).await?;
                let state = remote.lock().unwrap();
                assert!(
                    state.calls[start..]
                        .iter()
                        .filter(|(path, _)| path == "/conversations.replies")
                        .count()
                        <= 32
                );
                for channel in ["direct", "group", "work", "mentioned"] {
                    assert!(
                        state.calls[start..]
                            .iter()
                            .filter(|(path, q)| path == "/conversations.replies"
                                && q.get("channel").is_some_and(|v| v == channel))
                            .count()
                            <= 32
                    );
                }
            }
            let items = hub.store.inbox(100)?;
            assert_eq!(
                items
                    .iter()
                    .map(|item| item.signal.id.clone())
                    .collect::<std::collections::HashSet<_>>(),
                original
            );
            assert_eq!(
                items
                    .iter()
                    .map(|item| item.signal.text.matches("Delta ").count())
                    .sum::<usize>(),
                roots * 3 * 3 + 3
            );
            for item in &items {
                hub.store
                    .resolve_signal(&item.signal.id, "discarded", &[])?;
            }
            slack(&hub, &reader).await?;
            assert!(hub
                .store
                .inbox(100)?
                .iter()
                .all(|item| item.state == crate::model::InboxState::Done));
            assert!(hub.store.unarchived_agents()?.is_empty());
            let state = remote.lock().unwrap();
            assert!(state
                .calls
                .iter()
                .any(|(path, q)| path == "/conversations.replies"
                    && q.get("cursor").is_some_and(|v| v == "1")));
            drop(state);
            server.abort();
            tokio::fs::remove_dir_all(scratch).await?;
        }
        Ok(())
    }
}

async fn slack_mentions(hub: &Arc<Hub>, reader: &Reader, team: &str, user: &str) -> Result<()> {
    let key = format!("inbox-mentions:{team}:{user}");
    let since = hub
        .store
        .get(&key)?
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(now() - 7.0 * 86400.0)
        - 86400.0;
    let date = time::OffsetDateTime::from_unix_timestamp(since as i64)?.date();
    let query = format!("<@{user}> after:{date}");
    let at = now();
    let mut page = 1;
    loop {
        let result = reader
            .get(
                "search.messages",
                &[
                    ("query", &query),
                    ("sort", "timestamp"),
                    ("sort_dir", "asc"),
                    ("count", "100"),
                    ("page", &page.to_string()),
                ],
            )
            .await?;
        for message in result["messages"]["matches"]
            .as_array()
            .context("Slack search has no matches")?
        {
            let channel = message["channel"]["id"]
                .as_str()
                .context("Slack mention has no channel")?;
            let label = message["channel"]["name"].as_str().unwrap_or(channel);
            slack_message(
                hub,
                message,
                &format!("{team}:{user}:{channel}"),
                label,
                channel,
            )
            .await?;
        }
        hub.emit(Event::Sync);
        let pages = result["messages"]["pagination"]["page_count"]
            .as_u64()
            .context("Slack search has no pagination")?;
        ensure!(
            result["messages"]["pagination"]["total_count"]
                .as_u64()
                .unwrap_or(0)
                <= 10000,
            "Slack mention recovery exceeds search window; cursor retained"
        );
        if page >= pages {
            hub.store.set(&key, &at.to_string())?;
            return Ok(());
        }
        page += 1;
    }
}

async fn slack_events(hub: Arc<Hub>, reader: Reader, app_token_file: PathBuf) -> Result<()> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    let profile = reader.get("auth.test", &[]).await?;
    let team = profile["team_id"]
        .as_str()
        .context("Slack profile has no team")?;
    let user = profile["user_id"]
        .as_str()
        .context("Slack profile has no user")?;
    let token = tokio::fs::read_to_string(app_token_file)
        .await
        .context("read dedicated Slack app token file")?;
    let opened = reader
        .http
        .post(reader.base.join("apps.connections.open")?)
        .bearer_auth(token.trim())
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("Slack event connection failed"))?
        .json::<Value>()
        .await?;
    ensure!(opened["ok"] == true, "Slack event connection rejected");
    let url = opened["url"]
        .as_str()
        .context("Slack event connection has no URL")?;
    let (socket, _) = tokio_tungstenite::connect_async(url)
        .await
        .map_err(|_| anyhow::anyhow!("Slack event socket failed"))?;
    let (mut sink, mut stream) = socket.split();
    hub.store.set("inbox-events-error", "")?;
    hub.emit(Event::Sync);
    while let Some(frame) = stream.next().await {
        let Message::Text(raw) = frame? else { continue };
        let envelope: Value = serde_json::from_str(&raw)?;
        if let Some(id) = envelope["envelope_id"].as_str() {
            sink.send(Message::Text(
                serde_json::json!({"envelope_id":id}).to_string(),
            ))
            .await?;
        }
        handle_slack_event(&hub, team, user, &envelope["payload"]["event"]).await?;
    }
    anyhow::bail!("Slack event socket closed")
}

async fn handle_slack_event(hub: &Arc<Hub>, team: &str, user: &str, event: &Value) -> Result<()> {
    if event["type"] != "message" && event["type"] != "app_mention" {
        return Ok(());
    }
    let message = if event["subtype"] == "message_changed" {
        &event["message"]
    } else {
        event
    };
    let Some(channel) = event["channel"].as_str() else {
        return Ok(());
    };
    let dm = matches!(event["channel_type"].as_str(), Some("im" | "mpim"))
        || hub
            .store
            .get(&format!("inbox-dm:{team}:{channel}"))?
            .is_some();
    if dm {
        hub.store
            .set(&format!("inbox-dm:{team}:{channel}"), "true")?;
    }
    if dm
        || hub
            .config
            .inbox
            .slack_channels
            .iter()
            .any(|id| id == channel)
        || message["text"]
            .as_str()
            .is_some_and(|text| text.contains(&format!("<@{user}>")))
    {
        slack_message(
            hub,
            message,
            &format!("{team}:{user}:{channel}"),
            channel,
            channel,
        )
        .await?;
        hub.emit(Event::Sync);
    }
    Ok(())
}
