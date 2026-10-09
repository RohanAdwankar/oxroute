use anyhow::{Context, Result};
use futures_util::{stream, StreamExt, TryStreamExt};
use serde::{Deserialize, Serialize};
use std::path::Path;
use tokio::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff { pub path: String, pub patch: String }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub repository: String,
    pub remote: String,
    pub remote_url: String,
    pub branch: String,
    pub base_ref: String,
    pub base_commit: String,
    pub head_commit: String,
}

async fn git(directory: &Path, args: &[&str]) -> Result<String> {
    let output = tokio::time::timeout(std::time::Duration::from_secs(15),
        Command::new("git").arg("--no-pager").arg("--literal-pathspecs")
            .arg("-C").arg(directory).args(args).env("GIT_OPTIONAL_LOCKS", "0")
            .kill_on_drop(true).output()).await.context("Git review timed out")??;
    anyhow::ensure!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr).trim());
    anyhow::ensure!(output.stdout.len() <= 2 * 1024 * 1024, "Diff is too large to preview");
    Ok(String::from_utf8(output.stdout)?.trim_end_matches('\n').to_string())
}

async fn commit(root: &Path, reference: &str) -> Result<String> {
    git(root, &["rev-parse", "--verify", "--end-of-options", &format!("{reference}^{{commit}}")]).await
}

pub async fn capture(workspace: &Path, repository: &str, base: &str, remote: &str) -> Result<Snapshot> {
    let root = tokio::fs::canonicalize(repository).await?;
    let workspace = tokio::fs::canonicalize(workspace).await?;
    anyhow::ensure!(root.starts_with(workspace), "Repository must be inside the workspace");
    let top = git(&root, &["rev-parse", "--show-toplevel"]).await?;
    anyhow::ensure!(Path::new(&top) == root, "Specify the repository root");
    let branch = git(&root, &["symbolic-ref", "--short", "HEAD"]).await.context("Review requires a local branch")?;
    let bases = git(&root, &["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]).await?;
    let matches: Vec<&str> = bases.lines().filter(|reference| *reference == base || *reference == format!("refs/heads/{base}") || *reference == format!("refs/remotes/{base}")).collect();
    anyhow::ensure!(matches.len() == 1, "Specify one unambiguous base branch");
    let base = matches[0];
    anyhow::ensure!(base != format!("refs/heads/{branch}"), "Proposed changes must be on a separate branch");
    let remotes = git(&root, &["remote"]).await?;
    anyhow::ensure!(remotes.lines().any(|name| name == remote), "Specify an existing remote");
    let remote_url = git(&root, &["remote", "get-url", "--push", "--all", remote]).await?;
    anyhow::ensure!(remote_url.lines().count() == 1, "Review requires a single publication destination");
    if let Some((scheme, address)) = remote_url.split_once("://") {
        let credentials = address.split('/').next().unwrap_or("").rsplit_once('@')
            .is_some_and(|(user, _)| scheme != "ssh" || user.contains(':'));
        anyhow::ensure!(!credentials && !address.contains(['?', '#']), "Use a remote URL without embedded credentials or query parameters");
    }
    anyhow::ensure!(git(&root, &["status", "--porcelain", "--untracked-files=no"]).await?.is_empty(),
        "Commit tracked changes before presenting a review");
    let base_commit = commit(&root, base).await?;
    let head_commit = commit(&root, "HEAD").await?;
    let snapshot = Snapshot { repository: root.to_string_lossy().into(), remote: remote.into(), remote_url,
        branch, base_ref: base.into(), base_commit, head_commit };
    files(&snapshot).await?;
    anyhow::ensure!(current(&snapshot).await?, "Repository changed while capturing the review; present it again");
    Ok(snapshot)
}

pub async fn files(snapshot: &Snapshot) -> Result<Vec<FileDiff>> {
    let root = Path::new(&snapshot.repository);
    anyhow::ensure!(root.is_dir(), "Review worktree was removed; its diff is no longer available");
    anyhow::ensure!(Path::new(&git(root, &["rev-parse", "--show-toplevel"]).await?) == root,
        "Review worktree is no longer a repository root");
    let range = format!("{}...{}", snapshot.base_commit, snapshot.head_commit);
    let names = git(&root, &["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", &range, "--"]).await?;
    let mut files = Vec::new();
    let mut size = 0;
    let range = range.as_str();
    let jobs: Vec<_> = names.split('\0').filter(|path| !path.is_empty()).map(|path| async move {
        let patch = git(&root, &["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", "--unified=5", &range, "--", path]).await?;
        Ok::<_, anyhow::Error>(FileDiff { path: path.into(), patch })
    }).collect();
    let mut patches = stream::iter(jobs).buffered(8);
    while let Some(file) = patches.try_next().await? {
        size += file.patch.len();
        anyhow::ensure!(size <= 2 * 1024 * 1024, "Review is too large; split the proposed change");
        files.push(file);
    }
    anyhow::ensure!(!files.is_empty(), "No committed changes to review");
    Ok(files)
}

pub async fn current(snapshot: &Snapshot) -> Result<bool> {
    let root = Path::new(&snapshot.repository);
    let remote_args = ["remote", "get-url", "--push", "--all", &snapshot.remote];
    let (head, base, branch, remote, status) = tokio::try_join!(
        commit(root, "HEAD"), commit(root, &snapshot.base_ref),
        git(root, &["symbolic-ref", "--short", "HEAD"]),
        git(root, &remote_args),
        git(root, &["status", "--porcelain", "--untracked-files=no"]),
    )?;
    Ok(head == snapshot.head_commit && base == snapshot.base_commit && branch == snapshot.branch
        && remote == snapshot.remote_url && status.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn review_is_immutable_and_approval_expires_when_publication_changes() {
        let root = std::env::temp_dir().join(oxroute_core::model::new_id("review-test"));
        tokio::fs::create_dir_all(&root).await.unwrap();
        git(&root, &["init", "-b", "main"]).await.unwrap();
        git(&root, &["config", "user.name", "Test"]).await.unwrap();
        git(&root, &["config", "user.email", "test@example.invalid"]).await.unwrap();
        git(&root, &["remote", "add", "origin", "https://example.invalid/repo.git"]).await.unwrap();
        tokio::fs::write(root.join("settings.txt"), "before\n").await.unwrap();
        let paths: Vec<_> = (0..12).map(|index| format!("file {index:02} λ\n.txt")).collect();
        for (index, path) in paths.iter().enumerate() {
            tokio::fs::write(root.join(path), format!("old-{index}\n")).await.unwrap();
        }
        git(&root, &["add", "."]).await.unwrap();
        git(&root, &["commit", "-m", "Initial"]).await.unwrap();
        git(&root, &["checkout", "-b", "proposal"]).await.unwrap();
        tokio::fs::write(root.join("settings.txt"), "after\n").await.unwrap();
        for (index, path) in paths.iter().enumerate() {
            tokio::fs::write(root.join(path), format!("new-{index}\n")).await.unwrap();
        }
        assert!(capture(&root, root.to_str().unwrap(), "main", "origin").await.is_err());
        git(&root, &["commit", "-am", "Change"]).await.unwrap();
        let before = git(&root, &["status", "--porcelain"]).await.unwrap();
        let snapshot = capture(&root, root.to_str().unwrap(), "main", "origin").await.unwrap();
        let diffs = files(&snapshot).await.unwrap();
        assert_eq!(diffs.len(), paths.len() + 1);
        assert!(diffs.windows(2).all(|pair| pair[0].path < pair[1].path));
        for (index, path) in paths.iter().enumerate() {
            let patch = &diffs.iter().find(|file| &file.path == path).unwrap().patch;
            assert!(patch.contains(&format!("-old-{index}\n")));
            assert!(patch.contains(&format!("+new-{index}")));
        }
        assert!(diffs.iter().find(|file| file.path == "settings.txt").unwrap().patch.contains("+after"));
        assert!(serde_json::to_value(&snapshot).unwrap().get("files").is_none());
        assert_eq!(git(&root, &["status", "--porcelain"]).await.unwrap(), before);
        assert!(current(&snapshot).await.unwrap());
        git(&root, &["remote", "set-url", "origin", "https://example.invalid/other.git"]).await.unwrap();
        assert!(!current(&snapshot).await.unwrap());
        git(&root, &["remote", "set-url", "origin", &snapshot.remote_url]).await.unwrap();
        tokio::fs::write(root.join("settings.txt"), "new revision\n").await.unwrap();
        assert!(!current(&snapshot).await.unwrap());
        git(&root, &["commit", "-am", "Revise"]).await.unwrap();
        assert!(!current(&snapshot).await.unwrap());
        let original = files(&snapshot).await.unwrap();
        let settings = &original.iter().find(|file| file.path == "settings.txt").unwrap().patch;
        assert!(settings.contains("+after"));
        assert!(!settings.contains("new revision"));
        let newer = capture(&root, root.to_str().unwrap(), "main", "origin").await.unwrap();
        git(&root, &["branch", "-f", "main", "HEAD"]).await.unwrap();
        assert!(!current(&newer).await.unwrap());
        let allowed = root.join("allowed");
        tokio::fs::create_dir_all(&allowed).await.unwrap();
        assert!(capture(&allowed, root.to_str().unwrap(), "main", "origin").await.is_err());
        tokio::fs::remove_dir_all(root).await.unwrap();
        assert!(files(&snapshot).await.unwrap_err().to_string().contains("worktree was removed"));
    }
}
