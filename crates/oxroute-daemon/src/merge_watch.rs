//! Durable, read-only forge polling. A push registers the exact published head;
//! discovery also works when a human opens the PR later from a compare link.
use std::{sync::Arc, time::Duration};
use anyhow::{Context, Result, bail, ensure};
use axum::{Json, extract::{Path, State}};
use oxroute_core::Hub;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::process::Command;
use super::Failed;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Registration { repository: String, remote: String, branch: String, #[serde(default)] pull_request: Option<String> }

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Watch {
    id: String, agent_id: String, host: String, project: String,
    branch: String, commit: String, pr: Option<String>, merged: Option<String>,
    #[serde(default)] error: Option<String>,
}

async fn git(repository: &std::path::Path, args: &[&str]) -> Result<String> {
    let out = tokio::time::timeout(Duration::from_secs(30), Command::new("git")
        .arg("-C").arg(repository).args(args).env("GIT_TERMINAL_PROMPT", "0").kill_on_drop(true).output()).await??;
    ensure!(out.status.success(), "Could not read the published Git branch");
    Ok(String::from_utf8(out.stdout)?.trim().into())
}

fn remote(url: &str) -> Result<(String, String)> {
    let parsed = if let Some((host, path)) = url.strip_prefix("git@").and_then(|v| v.split_once(':')) {
        reqwest::Url::parse(&format!("ssh://{host}/{path}"))?
    } else { reqwest::Url::parse(url)? };
    let host = parsed.host_str().context("Remote has no host")?.to_owned();
    ensure!(parsed.username().is_empty() || parsed.username() == "git", "Remote must not contain credentials");
    ensure!(parsed.password().is_none(), "Remote must not contain credentials");
    let project = parsed.path().trim_matches('/').trim_end_matches(".git").to_owned();
    ensure!(project.split('/').count() >= 2, "Remote must identify a repository");
    Ok((host, project))
}

pub async fn register(State(hub): State<Arc<Hub>>, Path(agent): Path<String>, Json(body): Json<Registration>) -> Result<Json<Value>, Failed> {
    hub.store.agent(&agent)?.context("No such agent")?;
    let root = std::fs::canonicalize(&body.repository)?;
    ensure_path(&hub, &root)?;
    if body.remote.starts_with('-') || body.branch.starts_with('-') { return Err(anyhow::anyhow!("Invalid remote or branch").into()); }
    let (host, project) = remote(&git(&root, &["remote", "get-url", "--push", &body.remote]).await?)?;
    let commit = git(&root, &["rev-parse", "--verify", &format!("refs/heads/{}^{{commit}}", body.branch)]).await?;
    let published = git(&root, &["ls-remote", "--heads", &body.remote, &format!("refs/heads/{}", body.branch)]).await?;
    if published.split_whitespace().next() != Some(commit.as_str()) { return Err(anyhow::anyhow!("Push this branch before registering its merge listener").into()); }
    // Updating a pushed branch replaces its observation, never its PR receipt.
    let id = format!("{}:{}:{}:{}", agent, host, project, body.branch);
    if let Some(pr) = &body.pull_request { pr_endpoint(pr, &host)?; }
    let key = format!("merge-watch:{id}");
    if let Some(saved) = hub.store.get(&key)? {
        let mut watch: Watch = serde_json::from_str(&saved)?;
        if watch.commit == commit {
            if let Some(pr) = body.pull_request {
                if watch.pr.as_ref() != Some(&pr) { watch.merged = None; watch.error = None; }
                watch.pr = Some(pr);
                hub.store.set(&key, &serde_json::to_string(&watch)?)?;
            }
            return Ok(Json(serde_json::to_value(watch)?));
        }
    }
    let watch = Watch { id, agent_id: agent, host, project, branch: body.branch, commit, pr: body.pull_request, merged: None, error: None };
    hub.store.set(&key, &serde_json::to_string(&watch)?)?;
    Ok(Json(serde_json::to_value(watch)?))
}

fn ensure_path(hub: &Hub, root: &std::path::Path) -> Result<()> {
    ensure!(root.starts_with(std::fs::canonicalize(&hub.config.workspace)?), "Repository is outside the workspace");
    Ok(())
}

pub async fn list(State(hub): State<Arc<Hub>>, Path(agent): Path<String>) -> Result<Json<Value>, Failed> {
    hub.store.agent(&agent)?.context("No such agent")?;
    let mut watches = vec![];
    for value in hub.store.values_with_prefix("merge-watch:")? {
        let watch: Watch = serde_json::from_str(&value)?;
        if watch.agent_id == agent {
            let delivered = match &watch.pr { Some(pr) => hub.store.get(&format!("merge-receipt:{}:{pr}", watch.agent_id))?.is_some(), None => false };
            let mut value = serde_json::to_value(watch)?;
            value["delivered"] = json!(delivered);
            watches.push(value);
        }
    }
    Ok(Json(json!(watches)))
}

/// CLI authentication stays in the user's existing protected forge stores.
/// No shell interpolation and no writes to either forge.
async fn api(host: &str, path: &str) -> Result<Value> {
    let program = if host == "github.com" { "gh" } else { "glab" };
    let result = tokio::time::timeout(Duration::from_secs(30), Command::new(program)
        .args(["api", "--hostname", host, path]).kill_on_drop(true).output()).await?;
    match result {
        Ok(output) => {
            ensure!(output.status.success(), "{program} could not read merge status on {host}; check its authentication and access");
            Ok(serde_json::from_slice(&output.stdout)?)
        }
        Err(error) if host == "github.com" && error.kind() == std::io::ErrorKind::NotFound => {
            let client = reqwest::Client::builder().timeout(Duration::from_secs(30)).redirect(reqwest::redirect::Policy::none()).build()?;
            let mut request = client.get(format!("https://api.github.com/{path}")).header("User-Agent", "oxroute-merge-listener");
            if let Ok(token) = std::env::var("GH_TOKEN").or_else(|_| std::env::var("GITHUB_TOKEN")) { request = request.bearer_auth(token); }
            let response = request.send().await?;
            ensure!(response.status().is_success(), "GitHub merge status returned HTTP {}; configure existing GitHub authentication or retry after the rate limit resets", response.status());
            Ok(response.json().await?)
        }
        Err(_) => bail!("Install/authenticate {program} to read merge status on {host}"),
    }
}

fn query(watch: &Watch) -> String {
    let github = watch.host == "github.com";
    let path = if github { format!("repos/{}/pulls", watch.project) } else {
        let mut url = reqwest::Url::parse("https://forge.invalid/").unwrap();
        url.path_segments_mut().unwrap().push(&watch.project);
        let project = url.path().trim_start_matches('/');
        format!("projects/{project}/merge_requests")
    };
    let mut url = reqwest::Url::parse(&format!("https://forge.invalid/{path}")).unwrap();
    if github {
        url.query_pairs_mut().append_pair("state", "all").append_pair("head", &format!("{}:{}", watch.project.split('/').next().unwrap(), watch.branch)).append_pair("sort", "updated").append_pair("direction", "desc").append_pair("per_page", "100");
    } else {
        url.query_pairs_mut().append_pair("scope", "all").append_pair("source_branch", &watch.branch).append_pair("per_page", "100").append_pair("order_by", "updated_at").append_pair("sort", "desc");
    }
    format!("{}?{}", url.path().trim_start_matches('/'), url.query().unwrap())
}

fn observe(watch: &mut Watch, response: Value) -> Result<()> {
    let rows = response.as_array().context("Forge returned an invalid PR list")?;
    for row in rows {
        let github = watch.host == "github.com";
        let head = if github { &row["head"]["sha"] } else { &row["sha"] };
        if head.as_str() != Some(&watch.commit) { continue; }
        let branch = if github { &row["head"]["ref"] } else { &row["source_branch"] };
        if branch.as_str() != Some(&watch.branch) { continue; }
        watch.pr = row[if github { "html_url" } else { "web_url" }].as_str().map(str::to_owned);
        // Confirm GitHub merge status with the single-PR endpoint.
        if !github { watch.merged = row["merged_at"].as_str().map(str::to_owned); }
        return Ok(());
    }
    Ok(())
}

fn pr_endpoint(url: &str, host: &str) -> Result<String> {
    let url = reqwest::Url::parse(url)?;
    ensure!(url.host_str() == Some(host) && url.scheme() == "https", "PR URL must use the remote forge host over HTTPS");
    let path = url.path().trim_matches('/');
    let (project, number) = path.rsplit_once(if host == "github.com" { "/pull/" } else { "/-/merge_requests/" }).context("Invalid PR URL")?;
    ensure!(!project.is_empty() && !number.is_empty() && number.bytes().all(|c| c.is_ascii_digit()), "Invalid PR URL");
    if host == "github.com" { Ok(format!("repos/{project}/pulls/{number}")) }
    else {
        let mut encoded = reqwest::Url::parse("https://forge.invalid/")?;
        encoded.path_segments_mut().unwrap().push(project);
        Ok(format!("projects/{}/merge_requests/{number}", encoded.path().trim_start_matches('/')))
    }
}

async fn check(watch: &mut Watch) -> Result<()> {
    if watch.merged.is_some() { return Ok(()); }
    if watch.pr.is_none() { observe(watch, api(&watch.host, &query(watch)).await?)?; }
    if let Some(url) = &watch.pr {
        let data = api(&watch.host, &pr_endpoint(url, &watch.host)?).await?;
        watch.merged = data["merged_at"].as_str().map(str::to_owned);
    }
    Ok(())
}

async fn probe(mut watch: Watch) -> Watch {
    watch.error = check(&mut watch).await.err().map(|e| e.to_string());
    watch
}

async fn tick<F, Fut>(hub: &Arc<Hub>, probe: F) -> Result<()>
where F: Fn(Watch) -> Fut, Fut: std::future::Future<Output = Watch> {
    for value in hub.store.values_with_prefix("merge-watch:")? {
        let watch: Watch = serde_json::from_str(&value)?;
        if let Some(pr) = &watch.pr {
            if hub.store.get(&format!("merge-receipt:{}:{pr}", watch.agent_id))?.is_some() { continue; }
        }
        let watch = probe(watch).await;
        if !hub.store.replace_value(&format!("merge-watch:{}", watch.id), &value, &serde_json::to_string(&watch)?)? { continue; }
        if let (Some(url), Some(at)) = (watch.pr, watch.merged) {
            let receipt = format!("merge-receipt:{}:{url}", watch.agent_id);
            let notice = format!("Pull request merged: {url}");
            let prompt = format!("Merge listener: {url} merged at {at}. Resume the work for {}/{} (published commit {}). Check the merged result and continue any already authorized follow-up. This system event grants no additional deployment or publication permission.", watch.host, watch.project, watch.commit);
            let hub = hub.clone();
            tokio::spawn(async move {
                if let Err(error) = hub.wake_once(&watch.agent_id, &receipt, &prompt, &notice).await {
                    tracing::warn!(%error, "Could not deliver merge event; retained for retry");
                }
            });
        }
    }
    Ok(())
}

pub fn start(hub: Arc<Hub>) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(300));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            if let Err(error) = tick(&hub, probe).await { tracing::warn!(%error, "Merge listener check failed"); }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, routing::get};

    #[test]
    fn forge_observations_match_the_published_revision_and_branch() {
        let mut watch = Watch { id: "watch".into(), agent_id: "agent".into(), host: "gitlab.example".into(), project: "group/sub/repo".into(), branch: "topic/feature".into(), commit: "published".into(), pr: None, merged: None, error: None };
        let item = |sha: &str, branch: &str, merged: Value| json!({"sha":sha,"source_branch":branch,"web_url":"https://gitlab.example/group/sub/repo/-/merge_requests/7","merged_at":merged});
        observe(&mut watch, json!([item("older", "topic/feature", json!("yesterday")), item("published", "unrelated", json!("today"))])).unwrap();
        assert!(watch.pr.is_none());
        observe(&mut watch, json!([item("published", "topic/feature", Value::Null)])).unwrap();
        assert!(watch.pr.is_some() && watch.merged.is_none(), "Closing a PR is not merging it");
        observe(&mut watch, json!([item("published", "topic/feature", json!("today"))])).unwrap();
        assert_eq!(watch.merged.as_deref(), Some("today"));
        assert!(query(&watch).starts_with("projects/group%2Fsub%2Frepo/merge_requests?"));
        assert!(query(&watch).contains("source_branch=topic%2Ffeature"));
        assert_eq!(remote("git@github.com:owner/repo.git").unwrap(), ("github.com".into(), "owner/repo".into()));
        assert!(remote("https://user:secret@github.com/owner/repo").is_err());
        assert_eq!(pr_endpoint("https://github.com/target/upstream/pull/51", "github.com").unwrap(), "repos/target/upstream/pulls/51");
        assert_eq!(pr_endpoint("https://gitlab.example/target/sub/repo/-/merge_requests/9", "gitlab.example").unwrap(), "projects/target%2Fsub%2Frepo/merge_requests/9");
        assert!(pr_endpoint("https://other.example/owner/repo/pull/51", "github.com").is_err());
    }


    #[tokio::test]
    #[ignore = "Uses read-only GitHub API access for an explicitly selected repository"]
    async fn github_live_read_only_contract() {
        let project = std::env::var("OXROUTE_TEST_GITHUB_REPOSITORY").expect("Select a repository for read-only validation");
        for state in ["open", "closed"] {
            let rows = api("github.com", &format!("repos/{project}/pulls?state={state}&per_page=1")).await.unwrap();
            let Some(row) = rows.as_array().unwrap().first() else { continue; };
            let mut watch = Watch { id:"contract".into(), agent_id:"fixture".into(), host:"github.com".into(), project:project.clone(), branch:row["head"]["ref"].as_str().unwrap().into(), commit:row["head"]["sha"].as_str().unwrap().into(), pr:None, merged:None, error:None };
            check(&mut watch).await.unwrap();
            assert_eq!(watch.pr.as_deref(), row["html_url"].as_str());
            let data = api("github.com", &pr_endpoint(watch.pr.as_ref().unwrap(), "github.com").unwrap()).await.unwrap();
            assert_eq!(watch.merged.as_deref(),data["merged_at"].as_str());
        }
    }

    #[tokio::test]
    async fn pushed_branch_is_persisted_and_merge_wakes_only_its_owner_once() {
        let root = std::env::temp_dir().join(oxroute_core::model::new_id("merge-listener"));
        std::fs::create_dir_all(&root).unwrap();
        let repo = root.join("work");
        let bare = root.join("remote.git");
        let run = |args: &[&str]| {
            let output = std::process::Command::new("git").args(args).output().unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        };
        run(&["init", "--bare", bare.to_str().unwrap()]);
        run(&["init", "-b", "proposal", repo.to_str().unwrap()]);
        run(&["-C",repo.to_str().unwrap(),"config","user.name","Fixture"]);
        run(&["-C",repo.to_str().unwrap(),"config","user.email","fixture@example.invalid"]);
        std::fs::write(repo.join("change.txt"), "Proposed content\n").unwrap();
        run(&["-C",repo.to_str().unwrap(),"add","change.txt"]);
        run(&["-C",repo.to_str().unwrap(),"commit","-m","Propose change"]);
        run(&["-C",repo.to_str().unwrap(),"push",bare.to_str().unwrap(),"proposal"]);
        run(&["--git-dir",bare.to_str().unwrap(),"update-server-info"]);
        let config_path = root.join("config.toml");
        std::fs::write(&config_path,"owner = 'fixture'\n").unwrap();
        let mut config = oxroute_core::Config::load_from(&config_path).unwrap();
        config.workspace = root.to_string_lossy().into();
        config.artifacts = root.join("artifacts");
        config.attachments = root.join("attachments");
        config.database = root.join("state.sqlite");
        config.min_free_bytes = 0;
        let store = oxroute_core::Store::open(&config.database).unwrap();
        store.save_agent(&oxroute_core::Agent {
            id:"owner".into(), name:"Owner".into(), backend:oxroute_core::Backend::Codex,
            model:config.default_model.clone(),session_id:String::new(),cwd:config.workspace.clone(),
            status:oxroute_core::model::AgentStatus::Complete,activity:String::new(),permalink:String::new(),
            last_activity:0.0,updated_at:0.0,stall_reason:None,stall_alerted:false,pinned:false,
        }).unwrap();
        let mut hub = Hub::new(config,store);
        let harness = Arc::new(super::super::tests::ReviewHarness::default());
        hub.with_harness(harness.clone());
        let files = bare.clone();
        let status = Arc::new(std::sync::Mutex::new(Value::Null));
        let response = status.clone();
        let router = Router::new()
            .route("/org/repo.git/{*file}",get(move |Path(path):Path<String>| { let files=files.clone(); async move {
                std::fs::read(files.join(path)).map_err(|_| axum::http::StatusCode::NOT_FOUND)
            }}))
            .route("/forge",get(move || { let response=response.clone(); async move { Json(response.lock().unwrap().clone()) }}))
            .route("/api/agents/{id}/merge-watches",get(list).post(register)).with_state(hub.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {axum::serve(listener,router).await.unwrap()});
        run(&["-C",repo.to_str().unwrap(),"remote","add","origin",&format!("http://{address}/org/repo.git")]);
        let client = reqwest::Client::new();
        let endpoint = format!("http://{address}/api/agents/owner/merge-watches");
        let body = json!({"repository":repo,"remote":"origin","branch":"proposal"});
        let registered:Value = client.post(&endpoint).json(&body).send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
        let again:Value = client.post(&endpoint).json(&body).send().await.unwrap().json().await.unwrap();
        assert_eq!(registered,again);
        let probe = |mut watch:Watch| { let client=client.clone(); async move {
            let data = client.get(format!("http://{address}/forge")).send().await.unwrap().json().await.unwrap();
            watch.error = observe(&mut watch,data).err().map(|e|e.to_string()); watch
        }};
        tick(&hub,probe).await.unwrap(); // Invalid forge response stays diagnosable and retryable.
        assert!(hub.store.values_with_prefix("merge-watch:").unwrap()[0].contains("invalid PR list"));
        assert!(harness.inputs.lock().unwrap().is_empty());
        *status.lock().unwrap()=json!([{"sha":registered["commit"],"source_branch":"proposal","web_url":"https://forge.example/org/repo/-/merge_requests/17","merged_at":null}]);
        tick(&hub,probe).await.unwrap();
        assert!(harness.inputs.lock().unwrap().is_empty());
        status.lock().unwrap()[0]["merged_at"]=json!("2026-01-01T00:00:00Z");
        // Persist the merge before waking, as happens across a daemon restart.
        let mut saved:Watch=serde_json::from_str(&hub.store.values_with_prefix("merge-watch:").unwrap()[0]).unwrap();
        observe(&mut saved,status.lock().unwrap().clone()).unwrap();
        hub.store.set(&format!("merge-watch:{}",saved.id),&serde_json::to_string(&saved).unwrap()).unwrap();
        let reopened=oxroute_core::Store::open(&hub.config.database).unwrap();
        assert!(reopened.values_with_prefix("merge-watch:").unwrap()[0].contains("2026-01-01"));
        tick(&hub,probe).await.unwrap();
        tokio::time::timeout(Duration::from_secs(5),async {
            while harness.inputs.lock().unwrap().is_empty() {tokio::time::sleep(Duration::from_millis(10)).await;}
        }).await.unwrap();
        tick(&hub,probe).await.unwrap();
        assert_eq!(harness.inputs.lock().unwrap().len(),1);
        let receipt=format!("merge-receipt:owner:{}",saved.pr.unwrap());
        assert_eq!(reopened.get(&receipt).unwrap().as_deref(),Some("delivered"));
        let rows:Value=client.get(&endpoint).send().await.unwrap().json().await.unwrap();
        assert_eq!(rows[0]["delivered"],true);
        assert!(rows[0]["error"].is_null());
        // Registration never manufactures a PR or sends any source messages.
        assert_eq!(hub.store.agents(100).unwrap().len(),1);
        server.abort();
        std::fs::remove_dir_all(root).unwrap();
    }
}
