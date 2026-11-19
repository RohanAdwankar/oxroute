//! Collection coverage is distinct from manually reviewed observations.
use super::*;
use std::collections::{BTreeMap, HashSet};

const OVERLAP: f64 = 86400.0;
pub(super) const INITIAL: f64 = 7.0 * 86400.0;

pub(super) fn continuation(page: &Value) -> Result<String> {
    let cursor = page["response_metadata"]["next_cursor"]
        .as_str()
        .unwrap_or_default();
    ensure!(
        page["has_more"] != true || !cursor.is_empty(),
        "Slack truncated a page without a continuation; checkpoint retained"
    );
    Ok(cursor.into())
}

pub(super) async fn poll(hub: &Arc<Hub>, reader: &Reader) -> Result<()> {
    hub.store.set("inbox-coverage:slack",&serde_json::json!({"checkedAt":now(),"inProgress":true,"gaps":["Collection has not finished; no new source watermark"]}).to_string())?;
    let result = poll_at(hub, reader, now()).await;
    if let Err(error) = &result {
        let coverage: Value =
            serde_json::from_str(&hub.store.get("inbox-coverage:slack")?.unwrap_or_default())?;
        if coverage["inProgress"] == true {
            hub.store.set("inbox-coverage:slack",&serde_json::json!({"checkedAt":now(),"inProgress":false,"enumerated":false,"forwardHistoryThrough":null,"gaps":[error.to_string()]}).to_string())?;
        }
    }
    result
}

async fn poll_at(hub: &Arc<Hub>, reader: &Reader, at: f64) -> Result<()> {
    let profile = reader.get("auth.test", &[]).await?;
    let team = profile["team_id"]
        .as_str()
        .context("Slack profile has no team")?;
    let user = profile["user_id"]
        .as_str()
        .context("Slack profile has no user")?;
    let key = format!("inbox-conversations:{team}:{user}");
    let mut channels: BTreeMap<String, Value> = hub
        .store
        .get(&key)?
        .map(|v| serde_json::from_str(&v))
        .transpose()?
        .unwrap_or_default();
    channels.retain(|id, channel| {
        channel["is_im"] == true
            || channel["is_mpim"] == true
            || hub.config.inbox.slack_channels.contains(id)
    });
    for conversation in hub
        .store
        .imported_conversations(SLACK, &format!("{team}:{user}:"))?
    {
        let Some(id) = conversation.strip_prefix(&format!("{team}:{user}:")) else {
            continue;
        };
        let dm = hub.store.get(&format!("inbox-dm:{team}:{id}"))?.is_some();
        if !dm
            && !hub
                .config
                .inbox
                .slack_channels
                .iter()
                .any(|selected| selected == id)
        {
            continue;
        }
        let label = hub
            .store
            .inbox_label(SLACK, &conversation)?
            .unwrap_or_else(|| id.into());
        channels
            .entry(id.into())
            .or_insert_with(|| serde_json::json!({"id":id,"name":label,"is_im":dm}));
    }
    let mut gaps = Vec::new();
    let mut cursor = String::new();
    let mut seen = HashSet::new();
    loop {
        let page = match reader
            .get(
                "users.conversations",
                &[
                    ("types", "im,mpim"),
                    ("team_id", team),
                    ("limit", "200"),
                    ("cursor", &cursor),
                ],
            )
            .await
        {
            Ok(page) => page,
            Err(error) => {
                gaps.push(format!("Conversation enumeration incomplete: {error}"));
                break;
            }
        };
        for channel in page["channels"]
            .as_array()
            .context("Slack page has no channels")?
        {
            channels.insert(
                channel["id"]
                    .as_str()
                    .context("Slack channel has no id")?
                    .into(),
                channel.clone(),
            );
        }
        hub.store.set(&key, &serde_json::to_string(&channels)?)?;
        cursor = continuation(&page)?;
        if cursor.is_empty() {
            break;
        }
        ensure!(
            seen.insert(cursor.clone()),
            "Slack repeated an enumeration cursor"
        );
    }
    let enumerated = gaps.is_empty();
    // Search can discover indexed conversations under history/search-only access.
    // It never establishes enumeration coverage or a global ingestion checkpoint.
    if let Err(error) = discover(hub, reader, team, user, at, &mut channels).await {
        gaps.push(format!("Indexed discovery incomplete: {error}"));
    }
    hub.store.set(&key, &serde_json::to_string(&channels)?)?;
    for id in &hub.config.inbox.slack_channels {
        channels
            .entry(id.clone())
            .or_insert_with(|| serde_json::json!({"id":id,"name":id}));
    }
    for (id, channel) in &channels {
        let conversation = format!("{team}:{user}:{id}");
        if channel["is_im"] == true || channel["is_mpim"] == true {
            hub.store.set(&format!("inbox-dm:{team}:{id}"), "true")?;
        }
        let label = channel["name"].as_str().unwrap_or("Direct message");
        if let Err(error) = collect(hub, reader, &conversation, label, id, at).await {
            gaps.push(format!("History {id}: {error}"));
        }
    }
    if let Err(error) = slack_mentions(hub, reader, team, user).await {
        gaps.push(format!("Mentions: {error}"));
    }
    if let Err(error) = recover_slack_threads(hub, reader, &format!("{team}:{user}:")).await {
        gaps.push(format!("Thread reconciliation: {error}"));
    }
    let coverage = serde_json::json!({"checkedAt":at,"teamId":team,"userId":user,"inProgress":false,"enumerated":enumerated,"knownConversations":channels.len(),"gaps":gaps,"overlapSeconds":OVERLAP,"historyReconciliation":"Rotating full history and full known-thread sweeps; older edits are eventually reconciled, not instant event coverage.","forwardHistoryThrough":if gaps.is_empty(){Some(at)}else{None},"checkpointScope":"Enumerated top-level history; edits and known-thread replies use independent reconciliation sweeps"});
    hub.store
        .set("inbox-coverage:slack", &coverage.to_string())?;
    if !gaps.is_empty() {
        anyhow::bail!(
            "Slack collection has {} coverage gap(s); see inbox coverage",
            gaps.len()
        );
    }
    Ok(())
}

fn date_envelope(start: f64, end: f64) -> Result<(time::Date, time::Date)> {
    Ok((
        time::OffsetDateTime::from_unix_timestamp((start - 86400.0) as i64)?.date(),
        time::OffsetDateTime::from_unix_timestamp((end + 2.0 * 86400.0) as i64)?.date(),
    ))
}

async fn discover(
    hub: &Arc<Hub>,
    reader: &Reader,
    team: &str,
    user: &str,
    at: f64,
    channels: &mut BTreeMap<String, Value>,
) -> Result<()> {
    let key = format!("inbox-discovery:{team}:{user}");
    let oldest = hub
        .store
        .get(&key)?
        .map(|s| s.parse::<f64>())
        .transpose()?
        .unwrap_or(at - INITIAL)
        .min(at - INITIAL)
        - OVERLAP;
    // Date filters use a deliberately wider UTC calendar envelope. Exact bounds
    // are applied to numeric timestamps locally, independent of Slack timezone.
    let (lower, upper) = date_envelope(oldest, at)?;
    for kind in ["dm", "mpim"] {
        let query = format!("is:{kind} after:{lower} before:{upper}");
        let mut page = 1;
        loop {
            let result = reader
                .get(
                    "search.messages",
                    &[
                        ("query", &query),
                        ("team_id", team),
                        ("count", "100"),
                        ("sort", "timestamp"),
                        ("sort_dir", "asc"),
                        ("page", &page.to_string()),
                    ],
                )
                .await?;
            let messages = &result["messages"];
            let pages = messages["pagination"]["page_count"]
                .as_u64()
                .context("Slack discovery has no pagination")?;
            ensure!(
                messages["pagination"]["total_count"]
                    .as_u64()
                    .context("Slack discovery has no count")?
                    <= 10000,
                "Slack discovery exceeded searchable window; checkpoint retained"
            );
            for message in messages["matches"]
                .as_array()
                .context("Slack search has no matches")?
            {
                let channel = &message["channel"];
                let id = channel["id"]
                    .as_str()
                    .context("Slack search has no channel id")?;
                if channel["is_im"] != true && channel["is_mpim"] != true {
                    continue;
                }
                channels.insert(id.into(), channel.clone());
                hub.store.remember_slack_thread(
                    &format!("{team}:{user}:{id}"),
                    message["thread_ts"]
                        .as_str()
                        .or(message["ts"].as_str())
                        .context("Slack discovery has no timestamp")?,
                )?;
            }
            if page >= pages {
                break;
            }
            page += 1;
        }
    }
    hub.store.set(&key, &at.to_string())?;
    Ok(())
}

async fn collect(
    hub: &Arc<Hub>,
    reader: &Reader,
    conversation: &str,
    label: &str,
    id: &str,
    at: f64,
) -> Result<()> {
    let key = format!("inbox-cursor:{SLACK}:{conversation}");
    let previous = hub.store.get(&key)?.map(|s| s.parse::<f64>()).transpose()?;
    let baseline_key = format!("inbox-baseline:{SLACK}:{conversation}");
    let baseline = hub
        .store
        .get(&baseline_key)?
        .map(|s| s.parse::<f64>())
        .transpose()?
        .unwrap_or(previous.unwrap_or(at - INITIAL).min(at - INITIAL));
    hub.store.set(&baseline_key, &baseline.to_string())?;
    let oldest = previous
        .map(|n| (n - OVERLAP).max(baseline))
        .unwrap_or(baseline);
    history(
        hub,
        reader,
        conversation,
        label,
        id,
        &format!("{:.6}", oldest.max(0.0)),
        &format!("{at:.6}"),
        "",
        false,
    )
    .await?;
    // Independently rotate through old history, so edits and old thread roots
    // outside the incremental overlap are not permanently abandoned.
    let sweep = format!("inbox-history-sweep:{conversation}");
    let previous: Value = hub
        .store
        .get(&sweep)?
        .map(|s| serde_json::from_str(&s))
        .transpose()?
        .unwrap_or_default();
    let upper = previous["latest"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| format!("{at:.6}"));
    let cursor = previous["cursor"].as_str().unwrap_or_default();
    let next = history(
        hub,
        reader,
        conversation,
        label,
        id,
        "0",
        &upper,
        cursor,
        true,
    )
    .await?;
    hub.store.set(
        &sweep,
        &if next.is_empty() {
            "null".into()
        } else {
            serde_json::json!({"latest":upper,"cursor":next}).to_string()
        },
    )?;
    hub.store.set(&key, &format!("{at:.6}"))?;
    Ok(())
}

async fn history(
    hub: &Arc<Hub>,
    reader: &Reader,
    conversation: &str,
    label: &str,
    id: &str,
    oldest: &str,
    latest: &str,
    start: &str,
    one_page: bool,
) -> Result<String> {
    let mut cursor = start.to_string();
    let mut seen = HashSet::new();
    loop {
        let page = reader
            .get(
                "conversations.history",
                &[
                    ("channel", id),
                    ("oldest", oldest),
                    ("latest", latest),
                    ("inclusive", "true"),
                    ("limit", "100"),
                    ("cursor", &cursor),
                ],
            )
            .await?;
        for message in page["messages"]
            .as_array()
            .context("Slack history has no messages")?
        {
            slack_message(hub, message, conversation, label, id).await?;
        }
        hub.emit(Event::Sync);
        let next = continuation(&page)?;
        ensure!(
            next.is_empty() || next != cursor,
            "Slack repeated a history cursor; checkpoint retained"
        );
        cursor = next;
        if cursor.is_empty() || one_page {
            return Ok(cursor);
        }
        ensure!(
            seen.insert(cursor.clone()),
            "Slack repeated a history cursor; checkpoint retained"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::{Query, State},
        Json, Router,
    };
    use serde_json::json;
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
    };

    struct Remote {
        at: f64,
        fail: bool,
        requests: Vec<(String, HashMap<String, String>)>,
    }
    async fn source(
        State(state): State<Arc<Mutex<Remote>>>,
        uri: axum::http::Uri,
        Query(query): Query<HashMap<String, String>>,
    ) -> Json<Value> {
        let mut r = state.lock().unwrap();
        r.requests.push((uri.path().into(), query.clone()));
        let ts = |n: f64| format!("{:.6}", r.at - n);
        Json(match uri.path() {
            "/auth.test" => json!({"ok":true,"team_id":"workspace","user_id":"owner"}),
            "/users.conversations" => {
                json!({"ok":false,"error":"missing_scope","needed":"im:read"})
            }
            "/search.messages" => {
                let q = query.get("query").unwrap();
                let (messages, pages) = if q.starts_with("is:dm") {
                    if query.get("page").unwrap() == "1" {
                        (
                            vec![json!({"ts":ts(50.0),"channel":{"id":"direct","is_im":true}})],
                            2,
                        )
                    } else {
                        (
                            vec![json!({"ts":ts(60.0),"channel":{"id":"group","is_mpim":true}})],
                            2,
                        )
                    }
                } else {
                    (vec![], 1)
                };
                json!({"ok":true,"messages":{"matches":messages,"pagination":{"page_count":pages,"total_count":2}}})
            }
            "/conversations.history" => {
                if r.fail && query.get("cursor").is_some_and(|c| c == "tail") {
                    json!({"ok":false,"error":"temporarily_unavailable"})
                } else if query.get("channel").unwrap() == "direct" {
                    if query.get("cursor").is_some_and(|c| c == "tail") {
                        json!({"ok":true,"messages":[{"ts":ts(50.0),"user":"sender","text":"Request"}]})
                    } else {
                        json!({"ok":true,"messages":[{"ts":ts(10.0),"user":"owner","text":"Source reply"}],"has_more":true,"response_metadata":{"next_cursor":"tail"}})
                    }
                } else {
                    json!({"ok":true,"messages":[{"ts":ts(60.0),"user":"participant","text":"Group request"}]})
                }
            }
            "/conversations.replies" => json!({"ok":true,"messages":[]}),
            _ => panic!("unexpected read endpoint"),
        })
    }

    #[tokio::test]
    async fn partial_discovery_never_certifies_enumeration_or_skips_failed_pages() -> Result<()> {
        let root = std::env::temp_dir().join(new_id("inbox-collection"));
        std::fs::create_dir_all(&root)?;
        let token = root.join("token");
        std::fs::write(&token, "fixture")?;
        let state = Arc::new(Mutex::new(Remote {
            at: now(),
            fail: false,
            requests: vec![],
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let base = format!("http://{}/", listener.local_addr()?);
        let app = Router::new().fallback(source).with_state(state.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let mut config = crate::Config::load()?;
        config.inbox = Config::default();
        config.min_free_bytes = 0;
        let path = root.join("state.sqlite3");
        let hub = Hub::new(config.clone(), crate::Store::open(&path)?);
        let reader = Reader::new(&base, token)?;
        assert!(poll(&hub, &reader).await.is_err());
        let snapshot = hub.store.focus_inbox(None, None)?;
        let coverage = &snapshot.coverage["slack"];
        assert_eq!(coverage["enumerated"], false);
        assert!(coverage["forwardHistoryThrough"].is_null());
        assert!(coverage["gaps"].as_array().unwrap()[0]
            .as_str()
            .unwrap()
            .contains("im:read"));
        assert!(snapshot
            .items
            .iter()
            .any(|i| i.item_id.starts_with("direct:") && i.state == "resolved"));
        assert!(snapshot
            .items
            .iter()
            .any(|i| i.item_id.starts_with("group:") && i.state == "response_needed"));
        let public = Signal {
            id: new_id("sig"),
            source: SLACK.into(),
            conversation: "workspace:owner:mentioned".into(),
            thread_key: "root".into(),
            external_id: "root".into(),
            author: "sender".into(),
            label: "Mention context".into(),
            text: "Source context".into(),
            attachments: vec![],
            at: now(),
            root: true,
        };
        hub.store.cache_inbox_context(&public)?;
        let checkpoint = hub
            .store
            .get("inbox-cursor:slack-inbox:workspace:owner:direct")?;
        state.lock().unwrap().fail = true;
        assert!(poll(&hub, &reader).await.is_err());
        assert_eq!(
            hub.store
                .get("inbox-cursor:slack-inbox:workspace:owner:direct")?,
            checkpoint
        );
        drop(hub);
        state.lock().unwrap().fail = false;
        let hub = Hub::new(config, crate::Store::open(&path)?);
        assert!(poll(&hub, &reader).await.is_err());
        assert_eq!(
            hub.store.focus_inbox(None, None)?.items.len(),
            2,
            "Restart and overlap deduplicate obligations"
        );
        let requests = &state.lock().unwrap().requests;
        assert!(requests
            .iter()
            .any(|(p, q)| p == "/search.messages" && q.get("page").is_some_and(|s| s == "2")));
        assert!(requests
            .iter()
            .any(|(p, q)| p == "/conversations.history"
                && q.get("cursor").is_some_and(|s| s == "tail")));
        assert!(
            requests
                .iter()
                .filter(|(p, _)| p == "/conversations.history")
                .all(|(_, q)| matches!(
                    q.get("channel").map(String::as_str),
                    Some("direct" | "group")
                )),
            "Mention context must not opt a public channel into full history collection"
        );
        server.abort();
        drop(hub);
        std::fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn overnight_windows_cover_calendar_boundaries_in_every_timezone() -> Result<()> {
        for local_offset in [-12, 0, 14] {
            let midnight = 1704067200.0 - local_offset as f64 * 3600.0;
            let (start, end) = (midnight - 7200.0, midnight + 7.0 * 3600.0);
            let (lower, upper) = date_envelope(start, end)?;
            for source_offset in -12..=14 {
                let offset = time::UtcOffset::from_hms(source_offset, 0, 0)?;
                assert!(lower.midnight().assume_offset(offset).unix_timestamp() as f64 <= start);
                assert!(upper.midnight().assume_offset(offset).unix_timestamp() as f64 >= end);
            }
        }
        Ok(())
    }

    #[test]
    fn missing_continuations_cannot_look_like_complete_history() {
        assert!(continuation(&json!({"has_more":true})).is_err());
        assert_eq!(continuation(&json!({"has_more":false})).unwrap(), "");
    }

    #[tokio::test]
    #[ignore = "requires explicitly provided read-only Slack token and private validation directory"]
    async fn read_only_live_collection() -> Result<()> {
        let token = PathBuf::from(std::env::var("OXROUTE_VALIDATION_SLACK_TOKEN")?);
        let root = PathBuf::from(std::env::var("OXROUTE_VALIDATION_INBOX_ROOT")?);
        std::fs::create_dir_all(&root)?;
        let mut config = crate::Config::load()?;
        config.inbox = Config::default();
        config.min_free_bytes = 0;
        let hub = Hub::new(config, crate::Store::open(&root.join("state.sqlite3"))?);
        let reader = Reader::new("https://slack.com/api/", token)?;
        let result = poll(&hub, &reader).await;
        println!(
            "collection result: {}",
            result
                .err()
                .map(|e| e.to_string())
                .unwrap_or_else(|| "complete".into())
        );
        let snapshot = hub.store.focus_inbox(None, None)?;
        println!("coverage: {}", serde_json::to_string(&snapshot.coverage)?);
        println!("observed obligations: {}", snapshot.total);
        assert!(snapshot.coverage.contains_key("slack"));
        Ok(())
    }
}
