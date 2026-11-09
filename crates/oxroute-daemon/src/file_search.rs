//! Project file discovery and literal content search, independent of conversation search.
use super::*;
use std::path::PathBuf;
use tokio::{io::{AsyncBufReadExt, BufReader}, process::Command};

#[derive(Deserialize)]
pub struct Search { q: String, mode: String }
#[derive(serde::Serialize)]
pub struct Match { path: String, line: usize, text: String }
#[derive(Deserialize)]
pub struct ContextQuery { path: String, #[serde(default)] line: usize }

async fn root(hub: &Hub, agent: &str) -> Result<PathBuf> {
    let agent = hub.store.agent(agent)?.context("No such conversation")?;
    tokio::fs::canonicalize(if agent.cwd.is_empty() { &hub.config.workspace } else { &agent.cwd }).await.map_err(Into::into)
}

pub async fn search(State(hub): Hubs, Path(agent): Path<String>, Query(query): Query<Search>) -> Result<Json<Vec<Match>>, Failed> {
    let folder = root(&hub, &agent).await?;
    if query.q.trim().is_empty() { return Ok(Json(vec![])); }
    if query.q.len() > 1000 || !["names", "contents"].contains(&query.mode.as_str()) { return Err(anyhow::anyhow!("Choose filename or content search").into()); }
    let names = query.mode == "names";
    let mut command = Command::new("rg");
    command.current_dir(&folder).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).kill_on_drop(true);
    if names { command.args(["--files", "-0"]); }
    else { command.args(["--json", "--fixed-strings", "--ignore-case", "--max-count", "3", "--", &query.q, "."]); }
    let mut child = command.spawn().context("Could not start project file search")?;
    let mut reader = BufReader::new(child.stdout.take().unwrap());
    let search = async {
        let mut matches = vec![];
        let wanted = query.q.to_lowercase();
        let mut buffer = vec![];
        while matches.len() < 200 {
            buffer.clear();
            if reader.read_until(if names { 0 } else { b'\n' }, &mut buffer).await? == 0 { break; }
            if names {
                let path = String::from_utf8_lossy(&buffer[..buffer.len()-1]);
                if path.to_lowercase().contains(&wanted) { matches.push(Match { path: path.into_owned(), line: 1, text: String::new() }); }
            } else {
                let event: serde_json::Value = serde_json::from_slice(&buffer)?;
                if event["type"] != "match" { continue; }
                if let (Some(path), Some(text), Some(line)) = (event["data"]["path"]["text"].as_str(), event["data"]["lines"]["text"].as_str(), event["data"]["line_number"].as_u64()) {
                    matches.push(Match { path: path.trim_start_matches("./").into(), line: line as usize, text: text.chars().take(1000).collect() });
                }
            }
        }
        Ok::<_, anyhow::Error>(matches)
    };
    let result = tokio::time::timeout(Duration::from_secs(15), search).await;
    let _ = child.kill().await;
    Ok(Json(result.context("Project search timed out; narrow the query")??))
}

pub async fn context(State(hub): Hubs, Path(agent): Path<String>, Query(query): Query<ContextQuery>) -> Result<Json<serde_json::Value>, Failed> {
    let folder = root(&hub, &agent).await?;
    let path = tokio::fs::canonicalize(folder.join(&query.path)).await?;
    if !path.starts_with(&folder) || !path.is_file() { return Err(anyhow::anyhow!("File is outside this conversation's folder").into()); }
    let mut lines = BufReader::new(tokio::fs::File::open(&path).await?).lines();
    let start = query.line.saturating_sub(20).max(1);
    let mut result = vec![];
    let mut at = 0;
    while let Some(line) = lines.next_line().await? {
        at += 1;
        if at >= start { result.push(json!({"line": at, "text": line})); }
        if result.len() == 100 { break; }
    }
    Ok(Json(json!({"path": path.strip_prefix(&folder)?, "root": folder, "lines": result})))
}
