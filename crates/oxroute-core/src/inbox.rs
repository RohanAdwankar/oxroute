//! Read-only personal inbox collection with identity-scoped Focus intake.
use crate::{
    model::{new_id, now, Event, Signal},
    Hub,
};
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{path::PathBuf, sync::Arc, time::Duration};

mod collection;
mod identities;

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
    pub slack_arrivals_since: Option<f64>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub source: String,
    pub configured: bool,
    pub last_sync: Option<f64>,
    pub error: Option<String>,
}

pub fn configured(hub: &Hub) -> bool {
    hub.config.inbox.outlook_token_file.is_some() || hub.config.inbox.slack_token_file.is_some()
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
        if source == SLACK && status.configured && status.error.is_none() && hub.config.inbox.slack_app_token_file.is_some() {
            status.error = hub.store
                    .get("inbox-events-error")
                    .ok()
                    .flatten()
                    .filter(|value| !value.is_empty());
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
struct SlackError(String, Option<String>);
impl std::fmt::Display for SlackError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Slack read failed: {}{}", self.0, self.1.as_ref().map(|s|format!(" (required scope: {s})")).unwrap_or_default())
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
                return Err(SlackError(value["error"].as_str().unwrap_or("unknown").into(),value["needed"].as_str().map(str::to_owned)).into());
            }
            return Ok(value);
        }
    }
}

pub fn start(hub: Arc<Hub>) {
    if let Err(error)=hub.store.slack_arrival_cutoff(hub.config.inbox.slack_arrivals_since) {tracing::error!(%error,"Slack admission initialization failed");}
    if let Some(path)=hub.config.inbox.slack_token_file.clone() {identities::start(hub.clone(),path);}
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
    // Profile discovery is optional metadata; its scopes do not gate existing mail reads.
    let identity=reader.get("v1.0/me",&[("$select","id,mail,userPrincipalName")]).await;
    let owner=identity.ok().map(|profile|["mail","userPrincipalName"].into_iter().filter_map(|key|profile[key].as_str().filter(|value|!value.is_empty()).map(str::to_owned)).collect::<Vec<_>>()).unwrap_or_default();
    let key = format!("inbox-cursor:{OUTLOOK}:{account}");
    let since = time::OffsetDateTime::now_utc() - time::Duration::days(7);
    let initial=format!("v1.0/me/mailFolders/inbox/messages/delta?$select=id,conversationId,subject,from,body,receivedDateTime,lastModifiedDateTime,webLink,hasAttachments&$top=100&$filter=receivedDateTime ge {}",since.format(&time::format_description::well_known::Rfc3339)?);
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
            if owner.iter().any(|address|address.eq_ignore_ascii_case(&signal.author)) {hub.store.cache_inbox_context(&signal)?;continue;}
            let sender=signal.author.clone();
            let revision=item["lastModifiedDateTime"].as_str().unwrap_or(item["receivedDateTime"].as_str().unwrap_or(id));
            let activity=time::OffsetDateTime::parse(revision,&time::format_description::well_known::Rfc3339).map(|at|at.unix_timestamp() as f64).unwrap_or(at);
            hub.import_collected(signal,item["webLink"].as_str().unwrap_or_default(),&sender,revision,activity).await?;
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
    collection::poll(hub, reader).await
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
            state.oldest = state.thread.clone();
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
            let next=collection::continuation(&page)?;
            ensure!(next.is_empty()||next!=state.cursor,"Slack repeated a thread cursor; checkpoint retained");
            state.cursor=next;
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
    let ts=message["ts"].as_str().context("Slack message has no timestamp")?;
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
    let dm = hub
        .store
        .get(&format!(
            "inbox-dm:{}:{channel}",
            conversation.split(':').next().unwrap_or_default()
        ))?
        .is_some();
    if dm && !hub.store.observe_slack_dm(conversation,message,now())? {return Ok(());}
    let cutoff=hub.store.slack_arrival_cutoff(hub.config.inbox.slack_arrivals_since)?;
    let at=ts.parse::<f64>().context("invalid Slack source timestamp")?;
    let activity=message["edited"]["ts"].as_str().unwrap_or(ts).parse::<f64>().context("invalid Slack message timestamp")?;
    ensure!(at.is_finite()&&activity.is_finite(),"invalid Slack source time");
    if text.is_empty() {return Ok(());}
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
        at,
        root: message["thread_ts"].is_null(),
    };
    let owner=conversation.split(':').nth(1).unwrap_or_default();
    let targeted=message["text"].as_str().is_some_and(|text|text.contains(&format!("<@{owner}>")));
    if signal.at<=cutoff || signal.author==owner || (!dm&&!targeted) {
        hub.store.cache_inbox_context(&signal)?;return Ok(());
    }
    let sender=message["bot_id"].as_str().or(message["user"].as_str()).unwrap_or_default();
    let revision=message["edited"]["ts"].as_str().unwrap_or(ts);
    hub.import_collected(signal,&format!("https://app.slack.com/archives/{channel}/p{}",ts.replace('.',"")),sender,revision,activity).await?;
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
        slack_at:f64,
        fail: bool,
        enumeration_gap: bool,
        reads: Vec<String>,
    }
    async fn graph(State(state): State<Arc<Mutex<Remote>>>, uri: axum::http::Uri) -> Json<Value> {
        let mut remote = state.lock().unwrap();
        remote.reads.push(uri.to_string());
        let message = |id: &str, text: &str| json!({"id":id,"conversationId":"thread","subject":"Capacity report","from":{"emailAddress":{"address":"sender@example.test"}},"body":{"content":text},"receivedDateTime":"2026-11-12T10:00:00Z","webLink":"https://outlook.example.test/message"});
        Json(match uri.path() {
            "/v1.0/me" => json!({"id":"mail-account","mail":"owner@example.test"}),
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
        Query(query): Query<HashMap<String, String>>,
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
            "/users.info" => if remote.fail {json!({"ok":false,"error":"missing_scope","needed":"users:read"})}else{json!({"ok":true,"user":{"id":query["user"],"profile":{"display_name":format!("Source {} {}",query["user"],remote.round)}}})},
            "/auth.test" => json!({"ok":true,"team_id":"team","user_id":"owner"}),
            "/users.conversations" => {
                if remote.enumeration_gap {json!({"ok":false,"error":"missing_scope","needed":"im:read"})}else{json!({"ok":true,"channels":[{"id":"channel","name":"ongoing-work"}]})}
            }
            "/search.messages" => {
                json!({"ok":true,"messages":{"matches":[],"pagination":{"page_count":1,"total_count":0}}})
            }
            "/conversations.history" => {
                json!({"ok":true,"messages":if remote.round==0{vec![json!({"ts":format!("{:.6}",remote.slack_at),"user":"sender","text":"<@owner> Current observations","reply_count":1})]}else{vec![]}})
            }
            "/conversations.replies" => {
                json!({"ok":true,"messages":[{"ts":format!("{:.6}",remote.slack_at),"user":"sender","text":"<@owner> Current observations"},{"ts":format!("{:.6}",remote.slack_at+1.0),"thread_ts":format!("{:.6}",remote.slack_at),"user":"owner","text":"Context from the owner"}]})
            }
            _ => panic!("unexpected slack request"),
        };
        (axum::http::StatusCode::OK, Json(value))
    }
    #[tokio::test]
    async fn identity_metadata_changes_only_display() -> Result<()> {
        let scratch=std::env::temp_dir().join(new_id("identity-display"));tokio::fs::create_dir_all(&scratch).await?;
        let token=scratch.join("token");tokio::fs::write(&token,"fixture").await?;
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await?;let base=format!("http://{}/",listener.local_addr()?);
        let remote=Arc::new(Mutex::new(Remote::default()));let app=Router::new().route("/auth.test",get(slack_api)).route("/users.info",get(slack_api)).with_state(remote.clone());
        let server=tokio::spawn(async move {axum::serve(listener,app).await.unwrap()});
        let mut config=crate::Config::load()?;config.inbox=Config{slack_arrivals_since:Some(1.0),..Default::default()};config.min_free_bytes=0;
        let hub=Hub::new(config,crate::Store::open(&scratch.join("state.sqlite3"))?);
        hub.store.set("inbox-conversations:team:owner",&json!({"direct":{"id":"direct","is_im":true,"user":"sender","name":"sender"},"group":{"id":"group","is_mpim":true,"name":"mpdm-generated"}}).to_string())?;
        hub.store.set("inbox-dm:team:direct","1")?;hub.store.set("inbox-dm:team:group","1")?;
        let mut signal=Signal{id:"identity-row".into(),source:SLACK.into(),conversation:"team:owner:direct".into(),thread_key:"conversation".into(),external_id:"100.1".into(),author:"sender".into(),label:"sender".into(),text:"Source request for <@observer>".into(),attachments:vec![],at:100.1,root:true};
        hub.store.import_inbox(&signal,"")?;signal.external_id="101.1".into();signal.author="owner".into();signal.text="Source response".into();signal.at=101.1;hub.store.import_inbox(&signal,"")?;
        let before=hub.store.inbox_version("identity-row")?.unwrap();let raw=serde_json::to_value(&before.0.signal)?;
        assert_eq!(before.0.display.as_ref().unwrap().label,"Direct message");assert!(before.0.display.as_ref().unwrap().preview.starts_with("Participant:"));assert!(!before.0.display.as_ref().unwrap().preview.contains("observer"));
        let reader=Reader::new(&base,token)?;identities::refresh(&hub,&reader).await?;
        let after=hub.store.inbox_version("identity-row")?.unwrap();assert_eq!(serde_json::to_value(&after.0.signal)?,raw);assert_eq!(before.1,after.1);assert_eq!(before.0.state,after.0.state);
        let display=after.0.display.unwrap();assert_eq!(display.label,"Source sender 0");assert!(display.preview.contains("@Source observer 0"));assert!(display.text.contains("Source sender 0: Source request")&&display.text.contains("Source owner 0: Source response"));
        signal.id="group-row".into();signal.conversation="team:owner:group".into();signal.author="sender".into();signal.label="mpdm-generated".into();hub.store.import_inbox(&signal,"")?;
        assert_eq!(hub.store.inbox_item("group-row")?.unwrap().display.unwrap().label,"Group · Source sender 0");
        let reads=remote.lock().unwrap().reads.len();identities::refresh(&hub,&reader).await?;assert_eq!(remote.lock().unwrap().reads.len(),reads+1,"Verified profiles are cached independently of collection");
        hub.store.save_slack_name(&crate::store::SlackName{team:"other-team".into(),user:"sender".into(),name:"Other source".into(),checked_at:now(),retry_at:now()+86400.0})?;
        assert_eq!(hub.store.inbox_item("identity-row")?.unwrap().display.unwrap().label,"Source sender 0","Display identity stays account-scoped");
        let mut saved=hub.store.slack_names("team")?.remove("sender").unwrap();saved.retry_at=0.0;hub.store.save_slack_name(&saved)?;remote.lock().unwrap().fail=true;identities::refresh(&hub,&reader).await?;
        assert_eq!(hub.store.slack_names("team")?["sender"].name,"Source sender 0","Temporary profile failures retain the last verified name");
        assert!(!hub.store.pending_focus_events("coordinator")?,"Name enrichment never starts work or rewrites source provenance");
        server.abort();drop(hub);tokio::fs::remove_dir_all(scratch).await?;Ok(())
    }
    #[tokio::test]
    async fn known_direct_history_collects_without_discovery_or_push_access() -> Result<()> {
        let scratch=std::env::temp_dir().join(new_id("history-access"));tokio::fs::create_dir_all(&scratch).await?;
        let token=scratch.join("token");tokio::fs::write(&token,"fixture").await?;
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await?;let base=format!("http://{}/",listener.local_addr()?);
        let remote=Arc::new(Mutex::new(Remote{base:base.clone(),slack_at:now()-3600.0,enumeration_gap:true,..Default::default()}));
        let app=Router::new().route("/auth.test",get(slack_api)).route("/users.conversations",get(slack_api)).route("/search.messages",get(slack_api)).route("/conversations.history",get(slack_api)).route("/conversations.replies",get(slack_api)).with_state(remote.clone());
        let server=tokio::spawn(async move {axum::serve(listener,app).await.unwrap()});
        let mut config=crate::Config::load()?;config.inbox=Config{slack_token_file:Some(token.clone()),slack_arrivals_since:Some(1.0),slack_channels:vec!["D-fixture-source".into()],..Default::default()};config.min_free_bytes=0;
        let hub=Hub::new(config,crate::Store::open(&scratch.join("state.sqlite3"))?);
        hub.store.set("inbox-events-error","Previous push transport disconnected")?;
        let status=statuses(&hub).into_iter().find(|status|status.source==SLACK).unwrap();assert!(status.configured);assert!(status.error.is_none(),"Optional push transport cannot turn configured polling into missing read access");
        assert!(slack(&hub,&Reader::new(&base,token)?).await.is_err(),"The discovery coverage gap remains visible");
        let items=hub.store.inbox(10)?;assert_eq!(items.len(),1);assert_eq!(items[0].signal.thread_key,"conversation");assert!(!items[0].signal.text.contains("Context from the owner"));assert!(items[0].display.as_ref().unwrap().text.contains("Context from the owner"));
        assert!(hub.store.get("inbox-cursor:slack-inbox:team:owner:D-fixture-source")?.is_some(),"Known history checkpoints advance independently of missing listing access");
        let coverage:Value=serde_json::from_str(&hub.store.get("inbox-coverage:slack")?.unwrap())?;assert_eq!(coverage["enumerated"],false);assert_eq!(coverage["knownConversations"],1);assert!(coverage["forwardHistoryThrough"].is_null());assert!(!coverage["gaps"].as_array().unwrap().is_empty());
        assert_eq!(hub.store.focus_inbox(Some("slack"),None)?.items.len(),1,"Configured DM history retains response reconciliation");
        let reads=&remote.lock().unwrap().reads;
        assert!(reads.iter().position(|path|path.starts_with("/conversations.history")).unwrap()<reads.iter().position(|path|path.starts_with("/search.messages")).unwrap(),"Known source collection cannot wait for indexed discovery");
        server.abort();drop(hub);tokio::fs::remove_dir_all(scratch).await?;Ok(())
    }
    #[tokio::test]
    async fn collected_identity_wakes_only_delegated_revisions() -> Result<()> {
        use crate::store::{IntakeMode,IntakePolicy};
        use crate::model::{EntryKind,InboxState};
        let scratch=std::env::temp_dir().join(new_id("intake-runtime"));
        tokio::fs::create_dir_all(&scratch).await?;
        let token=scratch.join("token");tokio::fs::write(&token,"fixture").await?;
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let base=format!("http://{}/",listener.local_addr()?);
        let at=now();
        let remote=Arc::new(Mutex::new(Remote{base:base.clone(),slack_at:at,..Default::default()}));
        let app=Router::new().route("/auth.test",get(slack_api)).route("/users.conversations",get(slack_api)).route("/search.messages",get(slack_api)).route("/conversations.history",get(slack_api)).route("/conversations.replies",get(slack_api)).route("/v1.0/me",get(graph)).route("/v1.0/me/mailFolders/inbox",get(graph)).route("/v1.0/me/mailFolders/inbox/messages/delta",get(graph)).route("/page",get(graph)).route("/delta",get(graph)).with_state(remote);
        let server=tokio::spawn(async move {axum::serve(listener,app).await.unwrap()});
        let mut config=crate::Config::load()?;config.inbox=Config{slack_arrivals_since:Some(1.0),..Default::default()};config.min_free_bytes=0;
        let path=scratch.join("state.sqlite3");let hub=Hub::new(config.clone(),crate::Store::open(&path)?);
        hub.store.set("focus.agent","coordinator")?;
        let delegation=hub.store.add_entry("coordinator",at,EntryKind::You,"Delegate scoped requests","","")?;
        let mut policy=IntakePolicy{source:SLACK.into(),account:"team".into(),sender:"sender".into(),label:"Selected source".into(),mode:IntakeMode::Immediate,delegation_entry_id:delegation.id,effective_at:at-1.0};
        hub.store.save_intake_policy(&policy)?;
        let reader=Reader::new(&base,token)?;slack(&hub,&reader).await?;outlook(&hub,&reader).await?;
        let batch=hub.store.claim_focus_events("coordinator")?.unwrap();assert_eq!(batch.events.len(),1,"HTTP collection wakes only the selected sender; email and owner replies retain standard triage");
        let intake=batch.events[0].intake.as_ref().unwrap();assert_eq!(intake.sender,"sender");assert_eq!(intake.delegation_entry_id,delegation.id);
        hub.store.accept_turn_receipt(&batch.receipt,now())?;
        hub.store.set("inbox-dm:team:direct","1")?;
        let original=json!({"ts":format!("{:.6}",at+2.0),"user":"sender","text":"Review the changed requirement"});
        for _ in 0..2 {slack_message(&hub,&original,"team:owner:direct","Direct source","direct").await?;}
        // A connector bot cannot borrow a selected human identity, even with the same user field.
        let bot=json!({"ts":format!("{:.6}",at+3.0),"user":"sender","bot_id":"bot-source","text":"Forwarded context"});
        slack_message(&hub,&bot,"team:owner:direct","Direct source","direct").await?;
        let mut edited=original.clone();edited["text"]=json!("Use the corrected requirement");edited["edited"]=json!({"ts":format!("{:.6}",at+4.0)});
        slack_message(&hub,&edited,"team:owner:direct","Direct source","direct").await?;
        slack_message(&hub,&original,"team:owner:direct","Direct source","direct").await?;
        drop(hub);let hub=Hub::new(config,crate::Store::open(&path)?);
        let batch=hub.store.claim_focus_events("coordinator")?.unwrap();assert_eq!(batch.events.len(),2,"New DM and edited revision survive restart; duplicates, stale history and bot content do not create work");
        for event in &batch.events {let item=hub.store.inbox_item(&event.intake.as_ref().unwrap().signal_id)?.unwrap();assert!(item.signal.text.contains("corrected requirement"));assert!(!item.signal.text.contains("sender: Review the changed requirement"));}
        hub.store.accept_turn_receipt(&batch.receipt,now())?;
        policy.mode=IntakeMode::Standard;hub.store.save_intake_policy(&policy)?;
        let next=json!({"ts":format!("{:.6}",at+5.0),"user":"sender","text":"Standard source request"});
        slack_message(&hub,&next,"team:owner:direct","Direct source","direct").await?;
        assert!(!hub.store.pending_focus_events("coordinator")?);
        assert!(hub.store.inbox(20)?.iter().all(|item|item.state==InboxState::Waiting),"Collection and wake acceptance preserve manual controls");
        server.abort();drop(hub);tokio::fs::remove_dir_all(scratch).await?;Ok(())
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
            slack_at:now()-3600.0,
            ..Default::default()
        }));
        let app = Router::new()
            .route(
                "/apps.connections.open",
                post(|State(remote): State<Arc<Mutex<Remote>>>| async move {
                    Json(json!({"ok":true,"url":remote.lock().unwrap().socket}))
                }),
            )
            .route("/v1.0/me",get(graph)).route("/v1.0/me/mailFolders/inbox", get(graph))
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
        config.inbox = Config{slack_arrivals_since:Some(1.0),..Default::default()};
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
            .display.as_ref().unwrap()
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
        let persisted=hub.clone();
        let event_server = tokio::spawn(async move {
            let (stream, _) = socket.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            for (number,event) in [json!({"type":"message","channel":"direct","channel_type":"im","user":"sender","ts":"1800000000.000001","text":"A new direct conversation"}),json!({"type":"message","channel":"direct","channel_type":"im","user":"owner","ts":"1800000001.000001","text":"Additional context"}),json!({"type":"message","channel":"unselected","channel_type":"channel","ts":"1800000000.000002","text":"Unselected channel"})].into_iter().enumerate() {
                let id=format!("envelope-{number}");
                socket.send(Message::Text(json!({"envelope_id":id,"payload":{"event":event}}).to_string())).await.unwrap();
                let ack=socket.next().await.unwrap().unwrap();
                assert_eq!(serde_json::from_str::<Value>(ack.to_text().unwrap()).unwrap()["envelope_id"],id);
                if number<2 {assert!(persisted.store.inbox(10).unwrap().iter().any(|item|item.display.as_ref().unwrap().text.contains(if number==0 {"A new direct conversation"}else{"Additional context"})),"Acknowledged source data must already be durable as arrival or reply context");}
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
        assert!(!direct.signal.text.contains("Additional context"));assert!(direct.display.as_ref().unwrap().text.contains("Additional context"));
        assert_eq!(
            hub.store.inbox(10)?.len(),
            3,
            "Own replies and unselected chatter never create another arrival"
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
                json!({"ok":true,"messages":{"matches":if remote.phase==0 {vec![json!({"ts":remote.roots[0],"thread_ts":remote.roots[0],"user":"sender","text":"<@owner> Opening observation 0","channel":{"id":"mentioned","name":"Context review"}})]}else{vec![]},"pagination":{"page_count":1,"total_count":1}}})
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
                slack_arrivals_since:Some(1.0),slack_channels: vec!["work".into()],
                ..Default::default()
            };
            let database = scratch.join("inbox.sqlite3");
            let hub = Hub::new(config.clone(), crate::Store::open(&database)?);
            let reader = Reader::new(&base, token)?;
            slack(&hub, &reader).await?;
            let original: std::collections::HashSet<_> = hub
                .store
                .inbox(10000)?
                .into_iter()
                .map(|item| item.signal.id)
                .collect();
            assert_eq!(original.len(), roots * 2 + 1,"Only direct and group-direct source messages and the actual targeted mention arrive");
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
            let items = hub.store.inbox(10000)?;
            assert!(original.iter().all(|id|items.iter().any(|item|&item.signal.id==id)),"Recovered arrivals retain their stable identities");
            assert_eq!(items.len(),original.len()+roots*6,"New direct/group replies arrive individually; unmentioned channel replies stay context only");
            for channel in ["direct","group","work","mentioned"] {
                let conversation=format!("workspace:owner:{channel}");
                let imported=hub.store.imported_conversations(SLACK,"workspace:owner:")?;assert!(imported.contains(&conversation));
                let roots=remote.lock().unwrap().roots.clone();
                for root in &roots {
                    let mut context=Signal{id:String::new(),source:SLACK.into(),conversation:conversation.clone(),thread_key:if matches!(channel,"direct"|"group") {"conversation".into()}else{root.clone()},external_id:String::new(),author:String::new(),label:String::new(),text:String::new(),attachments:vec![],at:0.0,root:false};
                    context.text=hub.store.routing_text(&context,100000)?;
                    if channel!="mentioned"||root==&roots[0] {assert!(context.text.contains("Delta "),"Recovered source context is durable even when it is not an arrival");}
                }
            }
            for item in &items {
                hub.store
                    .resolve_signal(&item.signal.id, "discarded", &[])?;
            }
            slack(&hub, &reader).await?;
            assert!(hub
                .store
                .inbox(10000)?
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
        // A failed local write must remain eligible for source redelivery.
        handle_slack_event(&hub, team, user, &envelope["payload"]["event"]).await?;
        if let Some(id) = envelope["envelope_id"].as_str() {
            sink.send(Message::Text(
                serde_json::json!({"envelope_id":id}).to_string(),
            ))
            .await?;
        }
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
