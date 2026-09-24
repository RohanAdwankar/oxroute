//! Everything oxroute needs to know before it starts.
//!
//! There are two places to say it, and they layer:
//!
//! 1. `~/.config/oxroute/config.toml`, which is where a person configures
//!    this — commented, checked into nothing, edited by hand.
//! 2. Environment variables, which override the file. That is what a systemd
//!    unit and a container want, and it is how secrets stay out of a file on
//!    disk if you would rather they did.
//!
//! Every variable the Codex Slack bot used is still read, so an existing
//! `~/.config/codex-slack/env` keeps working without a config file at all.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::Deserialize;

use crate::model::Backend;

/// What a new agent gets when nothing says otherwise.
pub const DEFAULT_MODEL: &str = "gpt-5.6-sol";

/// A model a person can pick by name.
#[derive(Debug, Clone)]
pub struct Choice {
    /// What the harness calls it.
    pub id: String,
    /// What a person calls it.
    pub label: String,
    /// Which harness runs it. A model belongs to exactly one.
    pub backend: Backend,
}

/// What happens to a signal that opens a new thread.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Spin up an agent and get going for non-Slack signals.
    Auto,
    /// Hold non-Slack signals in the inbox until someone chooses a route.
    Ask,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Auto => "auto",
            Mode::Ask => "ask",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "auto" => Mode::Auto,
            _ => Mode::Ask,
        }
    }
}

// -- the file ------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileConfig {
    owner: Option<String>,
    workspace: Option<String>,
    default_model: Option<String>,
    listen: Option<String>,
    #[serde(default)]
    models: BTreeMap<String, FileModel>,
    #[serde(default)]
    binaries: FileBinaries,
    #[serde(default)]
    slack: FileSlack,
    #[serde(default)]
    paths: FilePaths,
    #[serde(default)]
    limits: FileLimits,
    #[serde(default)]
    codex: FileCodex,
    #[serde(default)]
    claude: FileClaude,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileModel {
    id: String,
    label: Option<String>,
    backend: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileBinaries {
    codex: Option<String>,
    claude: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileSlack {
    app_token: Option<String>,
    bot_token: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct FilePaths {
    database: Option<String>,
    attachments: Option<String>,
    artifacts: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileLimits {
    stall_timeout: Option<f64>,
    min_free_bytes: Option<u64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileCodex {
    url: Option<String>,
    reasoning_effort: Option<String>,
    title_model: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileClaude {
    permission_mode: Option<String>,
}

// -- the resolved thing --------------------------------------------------

#[derive(Debug, Clone)]
pub struct Config {
    /// Which file this came from, for `doctor` to point at.
    pub source: Option<PathBuf>,
    /// Where agents run.
    pub workspace: String,
    pub codex_binary: String,
    pub claude_binary: String,
    /// The durable app-server owned outside oxrouted.
    pub codex_url: String,
    pub codex_effort: String,
    /// The small, cheap model that writes agent titles.
    pub title_model: String,
    /// Claude Code's equivalent of `approvalPolicy: never`. There is nobody
    /// here to answer a prompt, so asking would simply stop the turn.
    pub claude_permission_mode: String,
    pub database: PathBuf,
    pub attachments: PathBuf,
    pub artifacts: PathBuf,
    pub default_backend: Backend,
    pub default_model: String,
    /// Alias -> model, for picking one by typing its name.
    pub models: BTreeMap<String, Choice>,
    /// Silence for this long means something is wrong.
    pub stall_timeout: f64,
    /// Below this much free disk, refuse new work rather than running out of
    /// space halfway through a write.
    pub min_free_bytes: u64,
    pub slack_app_token: Option<String>,
    pub slack_bot_token: Option<String>,
    /// The single account allowed to drive this. There is no multi-tenancy
    /// here on purpose: it runs commands on a machine you own.
    pub owner: String,
    pub listen: String,
}

fn home() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/tmp"))
}

/// `~/code` is what a person types; it is not a path until this runs.
fn expand(value: &str) -> PathBuf {
    match value.strip_prefix("~/") {
        Some(rest) => home().join(rest),
        None if value == "~" => home(),
        _ => PathBuf::from(value),
    }
}

/// The first environment variable that is set and non-empty.
fn from_env(names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| std::env::var(name).ok())
        .filter(|value| !value.is_empty())
}

/// Environment beats file beats built-in default.
fn pick(names: &[&str], file: Option<String>, fallback: impl FnOnce() -> String) -> String {
    from_env(names).or(file).unwrap_or_else(fallback)
}

impl Config {
    /// Where the config file lives, honouring `$OXROUTE_CONFIG`.
    pub fn default_path() -> PathBuf {
        std::env::var("OXROUTE_CONFIG")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home().join(".config/oxroute/config.toml"))
    }

    pub fn load() -> Result<Self> {
        Self::load_from(&Self::default_path())
    }

    /// A missing file is not an error: the environment alone is enough, and
    /// that is how the Slack bot's existing env file keeps working.
    pub fn load_from(path: &Path) -> Result<Self> {
        let (file, source) = match std::fs::read_to_string(path) {
            Ok(raw) => (
                toml::from_str::<FileConfig>(&raw)
                    .with_context(|| format!("reading {}", path.display()))?,
                Some(path.to_path_buf()),
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                (FileConfig::default(), None)
            }
            Err(error) => {
                return Err(error).with_context(|| format!("opening {}", path.display()))
            }
        };
        Self::resolve(file, source)
    }

    fn resolve(file: FileConfig, source: Option<PathBuf>) -> Result<Self> {
        let home = home();

        let owner = from_env(&["OXROUTE_OWNER", "SLACK_ALLOWED_USER_ID"])
            .or(file.owner)
            .context(
                "set `owner` in your config file (or OXROUTE_OWNER) to the Slack user id \
                 allowed to drive this; any string will do when running without Slack",
            )?;

        // Models come from the file when it names any, and otherwise from a
        // set that covers both harnesses out of the box.
        let mut models = BTreeMap::new();
        if file.models.is_empty() {
            let spec = from_env(&["OXROUTE_MODELS"]).unwrap_or_else(|| {
                "opus=claude-opus-5:Opus,sonnet=claude-sonnet-5:Sonnet,\
                 sol=gpt-5.6-sol:Sol,astra=gpt-6-astra:Astra"
                    .into()
            });
            for entry in spec.split(',').map(str::trim).filter(|e| !e.is_empty()) {
                let (alias, rest) = entry.split_once('=').unwrap_or((entry, entry));
                let (id, label) = rest.split_once(':').unwrap_or((rest, rest));
                models.insert(
                    alias.trim().to_lowercase(),
                    Choice {
                        backend: infer_backend(id.trim()),
                        id: id.trim().into(),
                        label: label.trim().into(),
                    },
                );
            }
        } else {
            for (alias, model) in file.models {
                let backend = match model.backend.as_deref() {
                    Some(name) => Backend::parse(name)
                        .with_context(|| format!("model `{alias}`: unknown backend `{name}`"))?,
                    None => infer_backend(&model.id),
                };
                models.insert(
                    alias.to_lowercase(),
                    Choice {
                        label: model.label.unwrap_or_else(|| model.id.clone()),
                        id: model.id,
                        backend,
                    },
                );
            }
        }
        anyhow::ensure!(!models.is_empty(), "configure at least one model");

        let default_model = pick(
            &["OXROUTE_DEFAULT_MODEL"],
            file.default_model,
            || DEFAULT_MODEL.to_string(),
        );
        // A default nobody can select is a trap, so it resolves through the
        // same alias table everything else uses.
        let default_model = models
            .get(&default_model.to_lowercase())
            .map(|c| c.id.clone())
            .unwrap_or(default_model);
        let default_backend = models
            .values()
            .find(|c| c.id == default_model)
            .map(|c| c.backend)
            .with_context(|| {
                format!("default model `{default_model}` is not one of the configured models")
            })?;

        let codex_binary = pick(
            &["OXROUTE_CODEX_CLI", "CODEX_CLI"],
            file.binaries.codex,
            || {
                // The VM installs it here; a laptop usually has it on PATH.
                // Falling back to the bare name lets the OS resolve it
                // rather than guessing a directory wrong.
                let installed = home.join(".local/bin/codex");
                if installed.exists() {
                    installed.to_string_lossy().to_string()
                } else {
                    "codex".into()
                }
            },
        );

        Ok(Config {
            source,
            workspace: pick(
                &["OXROUTE_WORKSPACE", "CODEX_SLACK_WORKSPACE"],
                file.workspace,
                || home.to_string_lossy().to_string(),
            ),
            codex_binary,
            claude_binary: pick(&["OXROUTE_CLAUDE_CLI"], file.binaries.claude, || {
                "claude".into()
            }),
            codex_url: pick(&["OXROUTE_CODEX_URL"], file.codex.url, || {
                "ws://127.0.0.1:8788".into()
            }),
            codex_effort: pick(
                &["OXROUTE_CODEX_EFFORT"],
                file.codex.reasoning_effort,
                || "medium".into(),
            ),
            title_model: pick(&["OXROUTE_TITLE_MODEL"], file.codex.title_model, || {
                "gpt-5.6-luna".into()
            }),
            claude_permission_mode: pick(
                &["OXROUTE_CLAUDE_PERMISSION_MODE"],
                file.claude.permission_mode,
                || "bypassPermissions".into(),
            ),
            database: expand(&pick(&["OXROUTE_DATABASE"], file.paths.database, || {
                home.join(".local/state/oxroute/oxroute.sqlite3")
                    .to_string_lossy()
                    .to_string()
            })),
            attachments: expand(&pick(
                &["OXROUTE_ATTACHMENTS"],
                file.paths.attachments,
                || {
                    home.join(".local/share/oxroute/attachments")
                        .to_string_lossy()
                        .to_string()
                },
            )),
            artifacts: expand(&pick(&["OXROUTE_ARTIFACTS"], file.paths.artifacts, || {
                home.join(".local/share/oxroute/artifacts")
                    .to_string_lossy()
                    .to_string()
            })),
            default_backend,
            default_model,
            models,
            stall_timeout: from_env(&["OXROUTE_STALL_TIMEOUT"])
                .and_then(|v| v.parse().ok())
                .or(file.limits.stall_timeout)
                .unwrap_or(600.0),
            min_free_bytes: from_env(&["OXROUTE_MIN_FREE_BYTES"])
                .and_then(|v| v.parse().ok())
                .or(file.limits.min_free_bytes)
                .unwrap_or(512 * 1024 * 1024),
            slack_app_token: from_env(&["OXROUTE_SLACK_APP_TOKEN", "SLACK_APP_TOKEN"])
                .or(file.slack.app_token)
                .filter(|t| !t.is_empty()),
            slack_bot_token: from_env(&["OXROUTE_SLACK_BOT_TOKEN", "SLACK_BOT_TOKEN"])
                .or(file.slack.bot_token)
                .filter(|t| !t.is_empty()),
            owner,
            listen: pick(&["OXROUTE_LISTEN"], file.listen, || {
                "127.0.0.1:8787".into()
            }),
        })
    }

    /// Kept so existing callers and the Slack bot's env file still work.
    pub fn from_env() -> Result<Self> {
        Self::load()
    }

    /// The workspace, as a path rather than as the string a person typed.
    pub fn workspace_path(&self) -> PathBuf {
        expand(&self.workspace)
    }

    pub fn model_aliases(&self) -> Vec<&str> {
        self.models.keys().map(String::as_str).collect()
    }

    /// Resolve whatever the user typed to a concrete model.
    pub fn resolve_model(&self, alias_or_id: &str) -> Option<&Choice> {
        self.models
            .get(&alias_or_id.to_lowercase())
            .or_else(|| self.models.values().find(|c| c.id == alias_or_id))
    }

    pub fn backend_for(&self, model: &str) -> Backend {
        self.resolve_model(model)
            .map(|c| c.backend)
            .unwrap_or(self.default_backend)
    }
}

/// A model id says which harness runs it, so a config file does not have to.
fn infer_backend(id: &str) -> Backend {
    if id.starts_with("claude") {
        Backend::ClaudeCode
    } else {
        Backend::Codex
    }
}

/// Free bytes on the filesystem holding `path`.
///
/// A turn that runs out of disk halfway through leaves a repository in a
/// state nobody asked for, so this is checked before work starts rather than
/// discovered during it.
#[cfg(unix)]
pub fn free_bytes(path: &std::path::Path) -> u64 {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let Ok(raw) = CString::new(path.as_os_str().as_bytes()) else {
        return u64::MAX;
    };
    // SAFETY: `raw` is a valid NUL-terminated path and `stats` is fully
    // initialised by the call before any field is read.
    unsafe {
        let mut stats: libc::statvfs = std::mem::zeroed();
        if libc::statvfs(raw.as_ptr(), &mut stats) != 0 {
            return u64::MAX;
        }
        (stats.f_bavail as u64).saturating_mul(stats.f_frsize as u64)
    }
}

#[cfg(not(unix))]
pub fn free_bytes(_path: &std::path::Path) -> u64 {
    u64::MAX
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routing_defaults_to_human_choice() {
        assert_eq!(Mode::parse(""), Mode::Ask);
        assert_eq!(Mode::parse("unexpected"), Mode::Ask);
    }

    /// Environment variables are process-wide, and the test harness runs
    /// these in parallel, so anything that touches them takes this first.
    static ENV: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn exclusive() -> std::sync::MutexGuard<'static, ()> {
        // A test that panicked while holding it poisoned nothing worth
        // protecting; the next test clears the environment anyway.
        let guard = ENV.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        clear();
        guard
    }

    fn clear() {
        for name in [
            "OXROUTE_OWNER",
            "SLACK_ALLOWED_USER_ID",
            "OXROUTE_MODELS",
            "OXROUTE_DEFAULT_MODEL",
            "OXROUTE_WORKSPACE",
            "CODEX_SLACK_WORKSPACE",
            "OXROUTE_LISTEN",
            "OXROUTE_CODEX_URL",
            "OXROUTE_CLAUDE_PERMISSION_MODE",
            "OXROUTE_SLACK_APP_TOKEN",
            "SLACK_APP_TOKEN",
        ] {
            std::env::remove_var(name);
        }
    }

    fn write(name: &str, body: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "oxroute-config-{name}-{}.toml",
            std::process::id()
        ));
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn the_default_is_sol() {
        let _guard = exclusive();
        std::env::set_var("OXROUTE_OWNER", "me");
        let config = Config::load_from(Path::new("/nonexistent/oxroute.toml")).unwrap();
        assert_eq!(config.default_model, DEFAULT_MODEL);
        assert_eq!(config.default_backend, Backend::Codex);
        assert_eq!(config.codex_url, "ws://127.0.0.1:8788");
        // Both harnesses are reachable without configuring anything.
        assert_eq!(config.backend_for("sol"), Backend::Codex);
        assert_eq!(config.backend_for("opus"), Backend::ClaudeCode);
    }

    #[test]
    fn a_config_file_is_enough_on_its_own() {
        let _guard = exclusive();
        let path = write(
            "full",
            r#"
owner = "U123"
workspace = "~/code"
default_model = "sonnet"
listen = "0.0.0.0:9000"

[models.sonnet]
id = "claude-sonnet-5"
label = "Sonnet"

[models.sol]
id = "gpt-5.6-sol"

[binaries]
claude = "/opt/claude"

[claude]
permission_mode = "acceptEdits"

[limits]
stall_timeout = 120.0
"#,
        );
        let config = Config::load_from(&path).unwrap();
        assert_eq!(config.owner, "U123");
        assert_eq!(config.default_model, "claude-sonnet-5");
        assert_eq!(config.default_backend, Backend::ClaudeCode);
        assert_eq!(config.listen, "0.0.0.0:9000");
        assert_eq!(config.claude_binary, "/opt/claude");
        assert_eq!(config.claude_permission_mode, "acceptEdits");
        assert_eq!(config.stall_timeout, 120.0);
        // `~` is what a person types, and is not a path until it is expanded.
        assert!(config.workspace_path().is_absolute());
        assert!(!config.workspace_path().to_string_lossy().contains('~'));
        // The backend is inferred from the id when the file does not say.
        assert_eq!(config.models["sol"].backend, Backend::Codex);
        assert_eq!(config.source.as_deref(), Some(path.as_path()));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn the_environment_wins_over_the_file() {
        let _guard = exclusive();
        let path = write("override", "owner = \"from-file\"\nlisten = \"1.2.3.4:1\"\n");
        std::env::set_var("OXROUTE_OWNER", "from-env");
        let config = Config::load_from(&path).unwrap();
        assert_eq!(config.owner, "from-env");
        // Untouched keys still come from the file.
        assert_eq!(config.listen, "1.2.3.4:1");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_typo_in_the_file_is_an_error_rather_than_a_silent_default() {
        let _guard = exclusive();
        std::env::set_var("OXROUTE_OWNER", "me");
        let path = write("typo", "workspce = \"~/code\"\n");
        let error = Config::load_from(&path).unwrap_err().to_string();
        assert!(error.contains("reading"), "unhelpful error: {error}");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_default_model_nobody_configured_is_refused() {
        let _guard = exclusive();
        std::env::set_var("OXROUTE_OWNER", "me");
        let path = write(
            "bad-default",
            "default_model = \"gpt-9\"\n\n[models.opus]\nid = \"claude-opus-5\"\n",
        );
        let error = Config::load_from(&path).unwrap_err().to_string();
        assert!(error.contains("not one of the configured models"), "{error}");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn missing_ownership_says_what_to_do_about_it() {
        let _guard = exclusive();
        let error = Config::load_from(Path::new("/nonexistent/x.toml"))
            .unwrap_err()
            .to_string();
        assert!(error.contains("owner"), "{error}");
    }

    #[test]
    fn free_space_on_a_real_path_is_plausible() {
        assert!(free_bytes(Path::new("/")) > 0);
    }
}
