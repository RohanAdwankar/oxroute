//! Moving in from the Slack bot.
//!
//! The bot this replaces kept its state in a SQLite file: which Slack thread
//! maps to which Codex thread, what model each one picked, and a session
//! table behind the dashboard. Every one of those has a home in oxroute's
//! schema, so the migration is a read of the old file rather than a cutover
//! you have to be awake for.
//!
//! It is safe to run twice. Nothing is written to the old database, and an
//! import that has already happened is detected and skipped, so the install
//! script can call it unconditionally.

use std::path::Path;

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};

use crate::model::{now, new_id, AgentStatus, Backend};
use crate::store::Store;

const MARKER: &str = "migrated:codex-slack";

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Imported {
    pub agents: usize,
    pub bindings: usize,
    pub pending: usize,
    pub dashboard: bool,
    pub skipped: bool,
}

impl std::fmt::Display for Imported {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.skipped {
            return write!(f, "already imported; nothing to do");
        }
        write!(
            f,
            "{} agents, {} threads, {} queued answers{}",
            self.agents,
            self.bindings,
            self.pending,
            if self.dashboard { ", dashboard" } else { "" }
        )
    }
}

/// Where the Slack bot keeps its database, checking both the path its systemd
/// unit sets and the one its code defaults to.
pub fn legacy_database() -> Option<std::path::PathBuf> {
    if let Ok(explicit) = std::env::var("CODEX_SLACK_DATABASE") {
        let path = std::path::PathBuf::from(explicit);
        if path.exists() {
            return Some(path);
        }
    }
    let home = std::env::var("HOME").ok()?;
    [
        ".local/share/codex-slack/state/threads.sqlite3",
        ".local/state/codex-slack/threads.sqlite3",
    ]
    .into_iter()
    .map(|suffix| Path::new(&home).join(suffix))
    .find(|path| path.exists())
}

/// Import the Slack bot's state. Reads the old file, writes only the new one.
pub fn import(store: &Store, legacy: &Path, default_cwd: &str, force: bool) -> Result<Imported> {
    if !force && store.get(MARKER)?.is_some() {
        return Ok(Imported {
            skipped: true,
            ..Default::default()
        });
    }

    // Read-only, so a running bot is not disturbed and cannot be damaged by
    // anything we get wrong here.
    let old = Connection::open_with_flags(
        legacy,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .with_context(|| format!("opening {}", legacy.display()))?;

    let mut report = Imported::default();
    let at = now();

    // One Codex thread becomes one agent. The mapping table is keyed by the
    // Slack thread, so several rows can point at the same Codex thread; the
    // agent is created once and bound from each.
    let mut threads = old.prepare(
        "SELECT slack_user, channel, root_ts, codex_thread_id FROM threads",
    )?;
    let rows: Vec<(String, String, String, String)> = threads
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<rusqlite::Result<_>>()?;

    let mut by_session: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    for (user, channel, root_ts, session_id) in rows {
        let model: Option<String> = old
            .query_row(
                "SELECT model FROM models WHERE slack_user = ?1 AND channel = ?2 AND root_ts = ?3",
                params![user, channel, root_ts],
                |r| r.get(0),
            )
            .optional()?;

        let session: Option<(String, String, String, Option<String>, f64, f64)> = old
            .query_row(
                "SELECT task, permalink, status, reason, last_activity, updated_at
                 FROM sessions WHERE thread_id = ?1",
                params![session_id],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                },
            )
            .optional()?;

        let agent_id = match by_session.get(&session_id) {
            Some(existing) => existing.clone(),
            None => {
                let (task, permalink, status, reason, last_activity, updated_at) = session
                    .clone()
                    .unwrap_or_else(|| {
                        ("session".into(), String::new(), "complete".into(), None, at, at)
                    });
                let agent = crate::model::Agent {
                    id: new_id("agent"),
                    name: if crate::naming::placeholder(&task) {
                        "session".into()
                    } else {
                        task
                    },
                    // Everything the old bot ran, it ran on Codex.
                    backend: Backend::Codex,
                    model: model.clone().unwrap_or_else(|| "gpt-6-sol".into()),
                    session_id: session_id.clone(),
                    cwd: default_cwd.to_string(),
                    // Nothing is running on the other side of a migration,
                    // whatever the old table claimed.
                    status: match AgentStatus::parse(&status) {
                        AgentStatus::Complete => AgentStatus::Complete,
                        _ => AgentStatus::Stalled,
                    },
                    activity: String::new(),
                    permalink,
                    last_activity,
                    updated_at,
                    stall_reason: match AgentStatus::parse(&status) {
                        AgentStatus::Complete => None,
                        _ => Some(reason.unwrap_or_else(|| "migrated from codex-slack".into())),
                    },
                    stall_alerted: true,
                    pinned: false,
                };
                store.save_agent(&agent)?;
                by_session.insert(session_id.clone(), agent.id.clone());
                report.agents += 1;
                agent.id
            }
        };

        store.bind(crate::source::slack::SOURCE, &channel, &root_ts, &agent_id)?;
        report.bindings += 1;
    }

    // Side answers that were waiting to be folded in keep waiting.
    let mut pending = old.prepare(
        "SELECT thread_id, message_ts, question, answer FROM pending_context",
    )?;
    let waiting: Vec<(String, String, String, String)> = pending
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (session_id, ordinal, question, answer) in waiting {
        if let Some(agent_id) = by_session.get(&session_id) {
            store.queue_context(agent_id, &ordinal, &question, &answer)?;
            report.pending += 1;
        }
    }

    // Take over the existing dashboard message rather than posting a second
    // one next to it.
    let dashboard: Option<(String, String)> = old
        .query_row("SELECT channel, message_ts FROM dashboard WHERE singleton = 1", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()?;
    if let Some((channel, message_ts)) = dashboard {
        store.set(
            "dashboard",
            &format!("{}\u{1f}{channel}\u{1f}{message_ts}", crate::source::slack::SOURCE),
        )?;
        report.dashboard = true;
    }

    store.set(MARKER, &legacy.display().to_string())?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build the Slack bot's schema and fill it, so the importer is tested
    /// against the shape it actually has to read.
    fn legacy(path: &Path) {
        let c = Connection::open(path).unwrap();
        c.execute_batch(
            "CREATE TABLE threads (slack_user TEXT, channel TEXT, root_ts TEXT,
                                   codex_thread_id TEXT,
                                   PRIMARY KEY (slack_user, channel, root_ts));
             CREATE TABLE models (slack_user TEXT, channel TEXT, root_ts TEXT, model TEXT,
                                  PRIMARY KEY (slack_user, channel, root_ts));
             CREATE TABLE sessions (thread_id TEXT PRIMARY KEY, slack_user TEXT, channel TEXT,
                                    root_ts TEXT, task TEXT, permalink TEXT, status TEXT,
                                    reason TEXT, last_activity REAL, updated_at REAL,
                                    stall_alerted INTEGER);
             CREATE TABLE dashboard (singleton INTEGER PRIMARY KEY, channel TEXT,
                                     message_ts TEXT);
             CREATE TABLE pending_context (id INTEGER PRIMARY KEY AUTOINCREMENT,
                                           thread_id TEXT, message_ts TEXT,
                                           question TEXT, answer TEXT);",
        )
        .unwrap();
        c.execute(
            "INSERT INTO threads VALUES ('U1', 'D1', '100.0', 'thread-a')",
            [],
        )
        .unwrap();
        // A fork: a second Slack thread onto the same Codex thread.
        c.execute(
            "INSERT INTO threads VALUES ('U1', 'D1', '200.0', 'thread-a')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO threads VALUES ('U1', 'D1', '300.0', 'thread-b')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO models VALUES ('U1', 'D1', '300.0', 'gpt-6-astra')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO sessions VALUES ('thread-a', 'U1', 'D1', '100.0', 'Drain the pool',
                                          'https://slack/x', 'working', NULL, 10.0, 20.0, 0)",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO sessions VALUES ('thread-b', 'U1', 'D1', '300.0', 'Fix the test',
                                          'https://slack/y', 'complete', NULL, 30.0, 40.0, 0)",
            [],
        )
        .unwrap();
        c.execute("INSERT INTO dashboard VALUES (1, 'D1', '999.0')", []).unwrap();
        c.execute(
            "INSERT INTO pending_context (thread_id, message_ts, question, answer)
             VALUES ('thread-a', '150.0', 'what port', '8080')",
            [],
        )
        .unwrap();
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("oxroute-migrate-{name}-{}.sqlite3", std::process::id()));
        let _ = std::fs::remove_file(&path);
        path
    }

    #[test]
    fn every_thread_and_session_comes_across() {
        let old = scratch("full");
        legacy(&old);
        let store = Store::in_memory().unwrap();

        let report = import(&store, &old, "/work", false).unwrap();
        assert_eq!(report.agents, 2);
        assert_eq!(report.bindings, 3);
        assert_eq!(report.pending, 1);
        assert!(report.dashboard);

        // Both Slack threads that pointed at one Codex thread reach one agent.
        let a = store.bound_agent("slack", "D1", "100.0").unwrap().unwrap();
        let b = store.bound_agent("slack", "D1", "200.0").unwrap().unwrap();
        assert_eq!(a, b);

        let agent = store.agent(&a).unwrap().unwrap();
        assert_eq!(agent.name, "Drain the pool");
        assert_eq!(agent.session_id, "thread-a");
        assert_eq!(agent.cwd, "/work");
        // It claimed to be working; after a migration nothing is.
        assert_eq!(agent.status, AgentStatus::Stalled);

        let other = store
            .agent(&store.bound_agent("slack", "D1", "300.0").unwrap().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(other.model, "gpt-6-astra");
        assert_eq!(other.status, AgentStatus::Complete);

        assert_eq!(store.pending_context(&a).unwrap().len(), 1);
        assert!(store.get("dashboard").unwrap().unwrap().starts_with("slack\u{1f}D1"));

        let _ = std::fs::remove_file(&old);
    }

    #[test]
    fn running_it_twice_changes_nothing() {
        let old = scratch("twice");
        legacy(&old);
        let store = Store::in_memory().unwrap();

        import(&store, &old, "/work", false).unwrap();
        let again = import(&store, &old, "/work", false).unwrap();
        assert!(again.skipped);
        assert_eq!(store.agents(50).unwrap().len(), 2);

        let _ = std::fs::remove_file(&old);
    }

    #[test]
    fn the_old_database_is_never_written_to() {
        let old = scratch("readonly");
        legacy(&old);
        let before = std::fs::read(&old).unwrap();
        let store = Store::in_memory().unwrap();
        import(&store, &old, "/work", false).unwrap();
        assert_eq!(std::fs::read(&old).unwrap(), before);
        let _ = std::fs::remove_file(&old);
    }
}
