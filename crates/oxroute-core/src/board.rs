//! A board: issues as cards, one column per status.
//!
//! The issues stay where they are. GitHub is the record; this reads it,
//! draws it, and writes one thing back — the `status:` label, when a card
//! moves. Everything else on a card that is not on the issue (which agents
//! are on it, how far their tasks have got) is oxroute's own state, joined in
//! by the hub.
//!
//! Two machines pointed at the same repository therefore see the same board,
//! and a card moved on one is in its new column on the other at the next
//! refresh. The agents on a card are per machine, because the agents are.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::config::BoardConfig;
use crate::model::AgentStatus;

pub const STATUS: &str = "status:";

/// How long a board is trusted before it is fetched again. A move updates
/// the cache in place, so this only governs changes made elsewhere.
pub const FRESH_FOR: f64 = 300.0;

/// One issue, reduced to what a card shows.
///
/// Labels are kept whole, as `status:idea` and `priority:p1`, whichever
/// source they came from. That keeps one reading of them for both.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub open: bool,
    pub labels: Vec<String>,
    pub body: String,
    pub updated_at: String,
}

impl Issue {
    /// The value of the first label with this prefix: `priority:` -> `p1`.
    pub fn value(&self, prefix: &str) -> Option<&str> {
        self.values(prefix).into_iter().next()
    }

    pub fn values(&self, prefix: &str) -> Vec<&str> {
        self.labels
            .iter()
            .filter_map(|label| label.strip_prefix(prefix))
            .filter(|value| !value.is_empty())
            .collect()
    }

    /// Labels that are not one of the structured prefixes a card already
    /// draws on its own.
    pub fn tags(&self) -> Vec<&str> {
        self.labels
            .iter()
            .map(String::as_str)
            .filter(|label| {
                !["status:", "priority:", "kind:", "track:", "section:", "space:"]
                    .iter()
                    .any(|prefix| label.starts_with(prefix))
            })
            .map(|label| label.strip_prefix("tag:").unwrap_or(label))
            .collect()
    }
}

/// Which column an issue sits in, or `None` when this board does not show it.
///
/// A status label wins. An issue with none is new work if it is open and
/// finished if it is closed — the same reading a person would make.
pub fn lane_of(issue: &Issue, lanes: &[String]) -> Option<String> {
    match issue.value(STATUS) {
        Some(status) => lanes.iter().find(|lane| lane.as_str() == status).cloned(),
        None if !issue.open => lanes.iter().find(|lane| lane.as_str() == "completed").cloned(),
        None => lanes.first().cloned(),
    }
}

/// What a column is called on screen. Label suffixes are identifiers.
pub fn lane_name(lane: &str) -> String {
    match lane {
        "idea" => "Ideas".into(),
        "research" => "Research".into(),
        "in-progress" => "Building".into(),
        "needs-eval" => "Eval".into(),
        "needs-marketing" => "Write-up".into(),
        "maintenance" => "Maintained".into(),
        "completed" => "Done".into(),
        "failed" => "Failed".into(),
        "inactive" => "Inactive".into(),
        other => {
            let words = other.replace(['-', '_'], " ");
            let mut chars = words.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        }
    }
}

/// Lower is sooner. Unprioritised work sorts after all of it.
fn rank(priority: Option<&str>) -> u32 {
    priority
        .and_then(|p| p.strip_prefix('p'))
        .and_then(|n| n.parse().ok())
        .unwrap_or(9)
}

// -- what the API returns --------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lane {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardAgent {
    pub id: String,
    pub name: String,
    pub status: AgentStatus,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub open: bool,
    pub lane: String,
    pub priority: Option<String>,
    pub kind: Option<String>,
    pub tracks: Vec<String>,
    pub tags: Vec<String>,
    pub body: String,
    pub updated_at: String,
    /// The agents working on it, on this machine.
    pub agents: Vec<CardAgent>,
    /// Their tasks: how many are finished, out of how many.
    pub tasks_done: usize,
    pub tasks_total: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    pub view: String,
    pub name: String,
    pub repo: Option<String>,
    pub lanes: Vec<Lane>,
    pub cards: Vec<Card>,
    /// `github` when read live, `snapshot` when read from a file.
    pub source: String,
    /// Whether moving a card writes back. Only a live board with a token can.
    pub writable: bool,
    pub fetched_at: f64,
    /// Issues whose status has no column here, such as `failed`.
    pub hidden: usize,
    /// Something went wrong but the board still drew, from a fallback.
    pub warning: Option<String>,
}

/// Put the cards in their columns: most urgent first, then most recent.
pub fn cards(issues: &[Issue], lanes: &[String]) -> (Vec<Card>, usize) {
    let mut hidden = 0;
    let mut out = Vec::new();
    for issue in issues {
        let Some(lane) = lane_of(issue, lanes) else {
            hidden += 1;
            continue;
        };
        out.push(Card {
            number: issue.number,
            title: issue.title.clone(),
            url: issue.url.clone(),
            open: issue.open,
            lane,
            priority: issue.value("priority:").map(str::to_string),
            kind: issue.value("kind:").map(str::to_string),
            tracks: issue.values("track:").into_iter().map(str::to_string).collect(),
            tags: issue.tags().into_iter().map(str::to_string).collect(),
            body: issue.body.clone(),
            updated_at: issue.updated_at.clone(),
            agents: vec![],
            tasks_done: 0,
            tasks_total: 0,
        });
    }
    out.sort_by(|a, b| {
        rank(a.priority.as_deref())
            .cmp(&rank(b.priority.as_deref()))
            .then_with(|| b.updated_at.cmp(&a.updated_at))
            .then_with(|| b.number.cmp(&a.number))
    });
    (out, hidden)
}

/// What an agent started from a card is told.
pub fn prompt(repo: Option<&str>, issue: &Issue) -> String {
    let reference = match repo {
        Some(repo) => format!("{repo}#{}", issue.number),
        None => format!("#{}", issue.number),
    };
    let mut text = format!("Work on {reference}: {}\n{}\n", issue.title, issue.url);
    let body = issue.body.trim();
    if !body.is_empty() {
        // An issue thread can be long. The agent can read the rest itself;
        // the prompt only has to say what the work is.
        let body: String = body.chars().take(6000).collect();
        text.push('\n');
        text.push_str(&body);
        text.push('\n');
    }
    text
}

// -- reading the sources ---------------------------------------------------

/// An issue as the GitHub REST API returns it. Pull requests come back from
/// the same endpoint and are not cards.
pub fn parse_github_issue(value: &Value) -> Option<Issue> {
    if value.get("pull_request").is_some() {
        return None;
    }
    Some(Issue {
        number: value.get("number")?.as_u64()?,
        title: value.get("title")?.as_str()?.to_string(),
        url: value
            .get("html_url")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        open: value.get("state").and_then(Value::as_str) != Some("closed"),
        labels: value
            .get("labels")
            .and_then(Value::as_array)
            .map(|labels| {
                labels
                    .iter()
                    .filter_map(|label| {
                        label
                            .as_str()
                            .or_else(|| label.get("name").and_then(Value::as_str))
                            .map(str::to_string)
                    })
                    .collect()
            })
            .unwrap_or_default(),
        body: value
            .get("body")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        updated_at: value
            .get("updated_at")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    })
}

/// A JSON export of the issues, as `data/ideas.json` keeps them: one object
/// per issue with its labels already split into fields. Turned back into
/// labels here so the rest of the board reads both sources one way.
pub fn parse_snapshot(raw: &str) -> Result<Vec<Issue>> {
    let value: Value = serde_json::from_str(raw).context("the snapshot is not JSON")?;
    let items = value
        .get("ideas")
        .or_else(|| value.get("issues"))
        .and_then(Value::as_array)
        .or_else(|| value.as_array())
        .context("the snapshot has no `ideas` or `issues` list")?;

    let mut issues = Vec::new();
    for item in items {
        // Already the shape GitHub returns: read it the same way.
        if item.get("labels").is_some() && item.get("number").is_some() {
            issues.extend(parse_github_issue(item));
            continue;
        }
        let Some(number) = item.get("issue").and_then(Value::as_u64) else {
            continue;
        };
        let text = |key: &str| item.get(key).and_then(Value::as_str).map(str::to_string);
        let mut labels = Vec::new();
        if let Some(status) = text("status") {
            // The export writes `in_progress`; the labels say `in-progress`.
            labels.push(format!("{STATUS}{}", status.replace('_', "-")));
        }
        match item.get("priority") {
            Some(Value::Number(n)) => labels.push(format!("priority:p{n}")),
            Some(Value::String(p)) if !p.is_empty() => {
                labels.push(format!("priority:{}", p.trim_start_matches("priority:")));
            }
            _ => {}
        }
        if let Some(kind) = text("kind") {
            labels.push(format!("kind:{kind}"));
        }
        for (key, prefix) in [("tracks", "track:"), ("tags", "tag:")] {
            for value in item.get(key).and_then(Value::as_array).into_iter().flatten() {
                if let Some(value) = value.as_str() {
                    labels.push(format!("{prefix}{value}"));
                }
            }
        }
        issues.push(Issue {
            number,
            title: text("title").unwrap_or_default(),
            url: text("url").unwrap_or_default(),
            open: text("state").as_deref() != Some("closed"),
            labels,
            body: text("body").unwrap_or_default(),
            updated_at: text("updated_at").unwrap_or_default(),
        });
    }
    Ok(issues)
}

pub fn read_snapshot(path: &Path) -> Result<Vec<Issue>> {
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("reading {}", path.display()))?;
    parse_snapshot(&raw).with_context(|| format!("reading {}", path.display()))
}

/// The labels an issue should carry once it is in `lane`: the same set with
/// its one status label swapped.
pub fn relabel(labels: &[String], lane: &str) -> Vec<String> {
    let mut out: Vec<String> = labels
        .iter()
        .filter(|label| !label.starts_with(STATUS))
        .cloned()
        .collect();
    out.push(format!("{STATUS}{lane}"));
    out
}

// -- GitHub ----------------------------------------------------------------

/// Just enough of the REST API for a board: list issues, and move one.
pub struct GitHub {
    client: reqwest::Client,
    api: String,
    token: Option<String>,
}

impl GitHub {
    pub fn new(api: &str, token: Option<String>) -> Self {
        GitHub {
            client: reqwest::Client::new(),
            api: api.trim_end_matches('/').to_string(),
            token,
        }
    }

    pub fn can_write(&self) -> bool {
        self.token.is_some()
    }

    fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.api))
            .header("accept", "application/vnd.github+json")
            .header("user-agent", "oxroute")
            .header("x-github-api-version", "2022-11-28");
        if let Some(token) = &self.token {
            request = request.bearer_auth(token);
        }
        request
    }

    async fn send(&self, request: reqwest::RequestBuilder) -> Result<Value> {
        let response = request.send().await.context("GitHub did not answer")?;
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            let reason = serde_json::from_str::<Value>(&body)
                .ok()
                .and_then(|v| v.get("message").and_then(Value::as_str).map(str::to_string))
                .unwrap_or(body);
            // A private repository without a token reads as missing, which is
            // the one GitHub error worth translating.
            if status == reqwest::StatusCode::NOT_FOUND && self.token.is_none() {
                anyhow::bail!("GitHub says not found; a private repository needs a token");
            }
            anyhow::bail!("GitHub said {status}: {reason}");
        }
        serde_json::from_str(&body).context("GitHub answered with something that is not JSON")
    }

    pub async fn issues(&self, repo: &str) -> Result<Vec<Issue>> {
        let mut out = Vec::new();
        for page in 1.. {
            let batch = self
                .send(self.request(
                    reqwest::Method::GET,
                    &format!("/repos/{repo}/issues?state=all&per_page=100&page={page}"),
                ))
                .await?;
            let batch = batch.as_array().context("GitHub did not return a list")?;
            out.extend(batch.iter().filter_map(parse_github_issue));
            if batch.len() < 100 {
                break;
            }
        }
        Ok(out)
    }

    /// Move an issue into a lane: swap its status label, and close it for
    /// `completed` or reopen it for anything else. One request, so a move
    /// never lands half-applied.
    pub async fn set_lane(&self, repo: &str, issue: &Issue, lane: &str) -> Result<Issue> {
        let current = self
            .send(self.request(
                reqwest::Method::GET,
                &format!("/repos/{repo}/issues/{}", issue.number),
            ))
            .await?;
        // Read the labels fresh: the cached card may be minutes old, and a
        // label added on GitHub since then must not be dropped by this write.
        let labels = parse_github_issue(&current).map(|i| i.labels).unwrap_or_default();
        let mut patch = json!({ "labels": relabel(&labels, lane) });
        let open = current.get("state").and_then(Value::as_str) != Some("closed");
        if lane == "completed" && open {
            patch["state"] = json!("closed");
            patch["state_reason"] = json!("completed");
        } else if lane != "completed" && !open {
            patch["state"] = json!("open");
        }
        let updated = self
            .send(
                self.request(
                    reqwest::Method::PATCH,
                    &format!("/repos/{repo}/issues/{}", issue.number),
                )
                .json(&patch),
            )
            .await?;
        parse_github_issue(&updated).context("GitHub returned something that is not an issue")
    }
}

// -- the cache -------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Loaded {
    pub issues: Vec<Issue>,
    pub source: &'static str,
    pub writable: bool,
    pub fetched_at: f64,
    pub warning: Option<String>,
}

/// Fetch a board's issues from wherever it is configured to read them.
///
/// Live GitHub first. A snapshot is the fallback when there is no repository,
/// or when GitHub cannot be reached — with a warning, so a stale board never
/// passes for a live one.
pub async fn load(config: &BoardConfig, github: &GitHub) -> Result<Loaded> {
    let snapshot = |warning: Option<String>| -> Result<Loaded> {
        let path = config.snapshot.as_ref().context("no snapshot configured")?;
        Ok(Loaded {
            issues: read_snapshot(path)?,
            source: "snapshot",
            writable: false,
            fetched_at: crate::model::now(),
            warning,
        })
    };
    let Some(repo) = &config.repo else {
        return snapshot(None);
    };
    // Without a token a private repository reads as missing, so a snapshot,
    // when there is one, is the better first read.
    if !github.can_write() && config.snapshot.is_some() {
        return snapshot(Some(
            "read from the snapshot; set a GitHub token to read live and move cards".into(),
        ));
    }
    match github.issues(repo).await {
        Ok(issues) => Ok(Loaded {
            issues,
            source: "github",
            writable: github.can_write(),
            fetched_at: crate::model::now(),
            warning: None,
        }),
        Err(error) if config.snapshot.is_some() => {
            snapshot(Some(format!("GitHub failed, showing the snapshot: {error:#}")))
        }
        Err(error) => Err(error),
    }
}

/// Boards by view id. A plain mutex, never held across an await: a read or a
/// write of the map and nothing else.
#[derive(Default)]
pub struct Cache {
    boards: Mutex<HashMap<String, Loaded>>,
}

impl Cache {
    pub fn fresh(&self, view: &str) -> Option<Loaded> {
        let boards = self.boards.lock().unwrap_or_else(|p| p.into_inner());
        boards
            .get(view)
            .filter(|loaded| crate::model::now() - loaded.fetched_at < FRESH_FOR)
            .cloned()
    }

    pub fn put(&self, view: &str, loaded: Loaded) {
        let mut boards = self.boards.lock().unwrap_or_else(|p| p.into_inner());
        boards.insert(view.to_string(), loaded);
    }

    /// Swap one issue in place, after a move, so the board redraws from the
    /// write rather than waiting for the next fetch.
    pub fn replace(&self, view: &str, issue: Issue) {
        let mut boards = self.boards.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(loaded) = boards.get_mut(view) {
            match loaded.issues.iter_mut().find(|i| i.number == issue.number) {
                Some(slot) => *slot = issue,
                None => loaded.issues.push(issue),
            }
        }
    }

    pub fn issue(&self, view: &str, number: u64) -> Option<Issue> {
        let boards = self.boards.lock().unwrap_or_else(|p| p.into_inner());
        boards
            .get(view)
            .and_then(|loaded| loaded.issues.iter().find(|i| i.number == number).cloned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn issue(number: u64, open: bool, labels: &[&str]) -> Issue {
        Issue {
            number,
            title: format!("issue {number}"),
            url: format!("https://github.com/o/r/issues/{number}"),
            open,
            labels: labels.iter().map(|l| l.to_string()).collect(),
            body: String::new(),
            updated_at: format!("2026-09-{:02}T00:00:00Z", number % 28 + 1),
        }
    }

    fn lanes() -> Vec<String> {
        crate::config::DEFAULT_LANES.iter().map(|l| l.to_string()).collect()
    }

    #[test]
    fn a_status_label_picks_the_column_and_no_label_reads_like_a_person_would() {
        let lanes = lanes();
        assert_eq!(lane_of(&issue(1, true, &["status:needs-eval"]), &lanes).as_deref(), Some("needs-eval"));
        assert_eq!(lane_of(&issue(2, true, &[]), &lanes).as_deref(), Some("idea"));
        assert_eq!(lane_of(&issue(3, false, &[]), &lanes).as_deref(), Some("completed"));
        // A status with no column is left off rather than misfiled.
        assert_eq!(lane_of(&issue(4, false, &["status:failed"]), &lanes), None);
    }

    #[test]
    fn cards_sort_by_priority_then_by_recency_and_count_what_is_hidden() {
        let (cards, hidden) = cards(
            &[
                issue(10, true, &["priority:p3"]),
                issue(11, true, &["priority:p1", "kind:devtool", "track:oss"]),
                issue(12, true, &[]),
                issue(13, true, &["priority:p1"]),
                issue(14, true, &["status:inactive"]),
            ],
            &lanes(),
        );
        let order: Vec<u64> = cards.iter().map(|c| c.number).collect();
        assert_eq!(order, [13, 11, 10, 12]);
        assert_eq!(hidden, 1);
        let eleven = cards.iter().find(|c| c.number == 11).unwrap();
        assert_eq!(eleven.kind.as_deref(), Some("devtool"));
        assert_eq!(eleven.tracks, ["oss"]);
    }

    #[test]
    fn the_ideas_export_reads_back_as_labels() {
        let issues = parse_snapshot(
            r#"{"meta": {}, "ideas": [
                {"issue": 1456, "title": "context router", "state": "open",
                 "status": "in_progress", "priority": null, "kind": "infra",
                 "tracks": ["oss"], "tags": ["agents"], "body": "route it",
                 "url": "https://github.com/o/r/issues/1456", "updated_at": "2026-09-04T00:46:18Z"},
                {"issue": 7, "title": "old", "state": "closed", "status": "idea",
                 "priority": 3, "kind": null, "tracks": [], "tags": [], "body": null,
                 "url": "", "updated_at": ""},
                {"issue": null, "title": "never imported"}
            ]}"#,
        )
        .unwrap();
        assert_eq!(issues.len(), 2);
        assert_eq!(issues[0].value(STATUS), Some("in-progress"));
        assert_eq!(issues[0].value("kind:"), Some("infra"));
        assert_eq!(issues[0].tags(), ["agents"]);
        assert_eq!(issues[1].value("priority:"), Some("p3"));
        assert!(!issues[1].open);
    }

    #[test]
    fn github_issues_parse_and_pull_requests_do_not() {
        let issue = parse_github_issue(&json!({
            "number": 9, "title": "modular ui", "state": "open",
            "html_url": "https://github.com/o/r/issues/9",
            "labels": [{"name": "status:idea"}, {"name": "priority:p1"}],
            "body": null, "updated_at": "2026-09-25T01:43:46Z"
        }))
        .unwrap();
        assert_eq!(issue.labels, ["status:idea", "priority:p1"]);
        assert_eq!(issue.body, "");
        assert!(parse_github_issue(&json!({
            "number": 10, "title": "a PR", "state": "open", "pull_request": {}
        }))
        .is_none());
    }

    #[test]
    fn moving_swaps_the_status_label_and_keeps_every_other_one() {
        let labels: Vec<String> = ["status:idea", "priority:p1", "track:oss"]
            .iter()
            .map(|l| l.to_string())
            .collect();
        assert_eq!(
            relabel(&labels, "in-progress"),
            ["priority:p1", "track:oss", "status:in-progress"]
        );
    }

    #[test]
    fn the_prompt_names_the_issue_and_carries_its_body() {
        let mut work = issue(9, true, &[]);
        work.body = "make the ui modular".into();
        let text = prompt(Some("RohanAdwankar/oxroute"), &work);
        assert!(text.starts_with("Work on RohanAdwankar/oxroute#9: issue 9\n"));
        assert!(text.contains("make the ui modular"));
    }

    /// `app/lib/types.ts` reads these by name. A rename here breaks the
    /// board silently, at runtime, so it breaks this test instead.
    #[test]
    fn the_wire_names_the_board_view_reads_do_not_move() {
        let (mut cards, _) = cards(&[issue(9, true, &["priority:p1"])], &lanes());
        cards[0].agents.push(CardAgent {
            id: "a".into(),
            name: "n".into(),
            status: AgentStatus::Working,
            model: "m".into(),
        });
        let card = serde_json::to_value(&cards[0]).unwrap();
        for key in ["number", "lane", "priority", "tracks", "updatedAt", "agents", "tasksDone", "tasksTotal"] {
            assert!(card.get(key).is_some(), "Card lost {key}");
        }
        assert_eq!(card["agents"][0]["status"], "working");
        let board = serde_json::to_value(Board {
            view: "v".into(),
            name: "n".into(),
            repo: None,
            lanes: vec![Lane { id: "idea".into(), name: "Ideas".into() }],
            cards,
            source: "snapshot".into(),
            writable: false,
            fetched_at: 1.0,
            hidden: 0,
            warning: None,
        })
        .unwrap();
        for key in ["lanes", "cards", "source", "writable", "fetchedAt", "hidden", "warning"] {
            assert!(board.get(key).is_some(), "Board lost {key}");
        }
        let view = serde_json::to_value(crate::hub::ViewInfo {
            id: "ideas".into(),
            name: "Ideas".into(),
            kind: "board".into(),
        })
        .unwrap();
        assert_eq!(view["kind"], "board");
    }

    #[test]
    fn columns_have_names_not_label_suffixes() {
        assert_eq!(lane_name("in-progress"), "Building");
        assert_eq!(lane_name("needs-review"), "Needs review");
    }
}
