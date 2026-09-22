//! Durable state. SQLite, because it survives a restart and a VM reboot and
//! needs no server next to it.
//!
//! The calls here are synchronous. SQLite on a local file answers in
//! microseconds and the whole point of a WAL database is that a short
//! critical section is cheaper than the machinery to avoid one, so the hub
//! holds the connection behind a plain mutex rather than a worker pool.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::model::{
    Agent, AgentStatus, Attachment, Backend, Binding, Entry, EntryKind, InboxItem, InboxState,
    Signal, Target,
};

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS agents (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    backend       TEXT NOT NULL,
    model         TEXT NOT NULL,
    session_id    TEXT NOT NULL DEFAULT '',
    cwd           TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'complete',
    activity      TEXT NOT NULL DEFAULT '',
    permalink     TEXT NOT NULL DEFAULT '',
    last_activity REAL NOT NULL DEFAULT 0,
    updated_at    REAL NOT NULL DEFAULT 0,
    stall_reason  TEXT,
    stall_alerted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bindings (
    source       TEXT NOT NULL,
    conversation TEXT NOT NULL,
    thread_key   TEXT NOT NULL,
    agent_id     TEXT NOT NULL,
    PRIMARY KEY (source, conversation, thread_key)
);
CREATE INDEX IF NOT EXISTS bindings_agent ON bindings (agent_id);

CREATE TABLE IF NOT EXISTS signals (
    id           TEXT PRIMARY KEY,
    source       TEXT NOT NULL,
    conversation TEXT NOT NULL,
    thread_key   TEXT NOT NULL,
    external_id  TEXT NOT NULL,
    author       TEXT NOT NULL DEFAULT '',
    label        TEXT NOT NULL DEFAULT '',
    text         TEXT NOT NULL DEFAULT '',
    attachments  TEXT NOT NULL DEFAULT '[]',
    at           REAL NOT NULL,
    root         INTEGER NOT NULL DEFAULT 0,
    state        TEXT NOT NULL DEFAULT 'waiting',
    outcome      TEXT NOT NULL DEFAULT '',
    agent_ids    TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS signals_at ON signals (at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS signals_external
    ON signals (source, conversation, external_id);

CREATE TABLE IF NOT EXISTS entries (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    at       REAL NOT NULL,
    kind     TEXT NOT NULL,
    text     TEXT NOT NULL DEFAULT '',
    detail   TEXT NOT NULL DEFAULT '',
    origin   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS entries_agent ON entries (agent_id, id);

CREATE TABLE IF NOT EXISTS active_turns (
    agent_id     TEXT PRIMARY KEY,
    session_id   TEXT NOT NULL,
    turn_id      TEXT NOT NULL DEFAULT '',
    artifact_dir TEXT NOT NULL,
    target       TEXT NOT NULL DEFAULT 'null'
);

-- Answers produced by a side question, waiting to be folded into the main
-- session before its next turn.
CREATE TABLE IF NOT EXISTS pending_context (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    ordinal  TEXT NOT NULL,
    question TEXT NOT NULL,
    answer   TEXT NOT NULL,
    UNIQUE (agent_id, ordinal)
);

CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"#;

pub struct Store {
    conn: Mutex<Connection>,
    path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct ActiveTurn {
    pub agent_id: String,
    pub session_id: String,
    pub turn_id: String,
    pub artifact_dir: PathBuf,
    pub target: Option<Target>,
}

impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
        }
        let conn = Connection::open(&path)
            .with_context(|| format!("opening {}", path.display()))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "busy_timeout", 30_000)?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.execute_batch(SCHEMA)?;
        Ok(Store {
            conn: Mutex::new(conn),
            path,
        })
    }

    pub fn in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        Ok(Store {
            conn: Mutex::new(conn),
            path: PathBuf::from(":memory:"),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn with<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let guard = self.conn.lock().map_err(|_| anyhow::anyhow!("store poisoned"))?;
        f(&guard)
    }

    // -- agents ----------------------------------------------------------

    pub fn save_agent(&self, agent: &Agent) -> Result<()> {
        self.with(|c| {
            c.execute(
                "INSERT INTO agents (id, name, backend, model, session_id, cwd, status,
                                     activity, permalink, last_activity, updated_at,
                                     stall_reason, stall_alerted)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
                 ON CONFLICT (id) DO UPDATE SET
                    name = excluded.name, backend = excluded.backend,
                    model = excluded.model, session_id = excluded.session_id,
                    cwd = excluded.cwd, status = excluded.status,
                    activity = excluded.activity, permalink = excluded.permalink,
                    last_activity = excluded.last_activity,
                    updated_at = excluded.updated_at,
                    stall_reason = excluded.stall_reason,
                    stall_alerted = excluded.stall_alerted",
                params![
                    agent.id,
                    agent.name,
                    agent.backend.as_str(),
                    agent.model,
                    agent.session_id,
                    agent.cwd,
                    agent.status.as_str(),
                    agent.activity,
                    agent.permalink,
                    agent.last_activity,
                    agent.updated_at,
                    agent.stall_reason,
                    agent.stall_alerted as i64,
                ],
            )?;
            Ok(())
        })
    }

    pub fn agent(&self, id: &str) -> Result<Option<Agent>> {
        self.with(|c| {
            Ok(c.query_row("SELECT * FROM agents WHERE id = ?1", params![id], read_agent)
                .optional()?)
        })
    }

    /// Everything unfinished, plus the most recent finished ones.
    ///
    /// The cap exists because the dashboard is a single message and a list
    /// that grows forever stops being a dashboard.
    pub fn agents(&self, completed_limit: usize) -> Result<Vec<Agent>> {
        self.with(|c| {
            let mut out = Vec::new();
            let mut live = c.prepare("SELECT * FROM agents WHERE status != 'complete'")?;
            for row in live.query_map([], read_agent)? {
                out.push(row?);
            }
            let mut done = c.prepare(
                "SELECT * FROM agents WHERE status = 'complete'
                 ORDER BY updated_at DESC LIMIT ?1",
            )?;
            for row in done.query_map(params![completed_limit as i64], read_agent)? {
                out.push(row?);
            }
            out.sort_by(|a, b| {
                a.status
                    .rank()
                    .cmp(&b.status.rank())
                    .then(b.updated_at.total_cmp(&a.updated_at))
            });
            Ok(out)
        })
    }

    pub fn set_agent_status(&self, id: &str, status: AgentStatus, at: f64) -> Result<()> {
        self.with(|c| {
            c.execute(
                "UPDATE agents SET status = ?2, updated_at = ?3, last_activity = ?3,
                    stall_reason = NULL, stall_alerted = 0
                 WHERE id = ?1",
                params![id, status.as_str(), at],
            )?;
            Ok(())
        })
    }

    pub fn touch_agent(&self, id: &str, activity: Option<&str>, at: f64) -> Result<()> {
        self.with(|c| {
            c.execute(
                "UPDATE agents SET status = 'working', stall_reason = NULL, stall_alerted = 0,
                    last_activity = ?2, updated_at = ?2,
                    activity = COALESCE(?3, activity)
                 WHERE id = ?1 AND status != 'complete'",
                params![id, at, activity],
            )?;
            Ok(())
        })
    }

    pub fn rename_agent(&self, id: &str, name: &str) -> Result<()> {
        self.with(|c| {
            c.execute("UPDATE agents SET name = ?2 WHERE id = ?1", params![id, name])?;
            Ok(())
        })
    }

    pub fn set_agent_session(&self, id: &str, session_id: &str) -> Result<()> {
        self.with(|c| {
            c.execute(
                "UPDATE agents SET session_id = ?2 WHERE id = ?1",
                params![id, session_id],
            )?;
            Ok(())
        })
    }

    pub fn set_agent_model(&self, id: &str, model: &str) -> Result<()> {
        self.with(|c| {
            c.execute("UPDATE agents SET model = ?2 WHERE id = ?1", params![id, model])?;
            Ok(())
        })
    }

    pub fn set_agent_permalink(&self, id: &str, permalink: &str) -> Result<()> {
        self.with(|c| {
            c.execute(
                "UPDATE agents SET permalink = ?2 WHERE id = ?1",
                params![id, permalink],
            )?;
            Ok(())
        })
    }

    /// Mark an agent stalled. Returns whether this is worth telling someone
    /// about, so a stall that is already on screen does not ping twice.
    pub fn stall_agent(&self, id: &str, reason: &str, at: f64) -> Result<bool> {
        self.with(|c| {
            let existing: Option<(String, Option<String>, i64)> = c
                .query_row(
                    "SELECT status, stall_reason, stall_alerted FROM agents WHERE id = ?1",
                    params![id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            let Some((status, previous, alerted)) = existing else {
                return Ok(false);
            };
            if status == "complete" {
                return Ok(false);
            }
            let fresh = status != "stalled" || alerted == 0;
            // A system error is the more useful explanation, so it overwrites
            // a vaguer one; anything else leaves the first reason standing.
            let stored = if status != "stalled" || reason == "system error" {
                reason.to_string()
            } else {
                previous.unwrap_or_else(|| reason.to_string())
            };
            c.execute(
                "UPDATE agents SET status = 'stalled', stall_reason = ?2, updated_at = ?3,
                    stall_alerted = 1 WHERE id = ?1",
                params![id, stored, at],
            )?;
            Ok(fresh)
        })
    }

    /// Stall everything that has gone quiet past the cutoff, and say which.
    pub fn stall_inactive(&self, cutoff: f64, at: f64, reason: &str) -> Result<Vec<Agent>> {
        self.with(|c| {
            let mut stmt = c.prepare(
                "SELECT * FROM agents WHERE status = 'working' AND last_activity <= ?1",
            )?;
            let mut out = Vec::new();
            for row in stmt.query_map(params![cutoff], read_agent)? {
                out.push(row?);
            }
            c.execute(
                "UPDATE agents SET status = 'stalled', stall_reason = ?1, updated_at = ?2,
                    stall_alerted = 1
                 WHERE status = 'working' AND last_activity <= ?3",
                params![reason, at, cutoff],
            )?;
            Ok(out)
        })
    }

    /// On startup nothing is really running, whatever the database says.
    pub fn recover(&self, at: f64) -> Result<Vec<Agent>> {
        self.with(|c| {
            let mut stmt = c.prepare(
                "SELECT * FROM agents WHERE status = 'working'
                 AND id NOT IN (SELECT agent_id FROM active_turns)",
            )?;
            let mut out = Vec::new();
            for row in stmt.query_map([], read_agent)? {
                out.push(row?);
            }
            c.execute(
                "UPDATE agents SET status = 'stalled', stall_reason = 'oxroute restarted',
                    updated_at = ?1, stall_alerted = 1 WHERE status = 'working'
                    AND id NOT IN (SELECT agent_id FROM active_turns)",
                params![at],
            )?;
            Ok(out)
        })
    }

    pub fn save_active_turn(&self, turn: &ActiveTurn) -> Result<()> {
        self.with(|c| {
            c.execute(
                "INSERT OR REPLACE INTO active_turns
                 (agent_id, session_id, turn_id, artifact_dir, target)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    turn.agent_id,
                    turn.session_id,
                    turn.turn_id,
                    turn.artifact_dir.to_string_lossy(),
                    serde_json::to_string(&turn.target)?,
                ],
            )?;
            Ok(())
        })
    }

    pub fn set_active_turn_id(&self, agent_id: &str, turn_id: &str) -> Result<()> {
        self.with(|c| {
            c.execute(
                "UPDATE active_turns SET turn_id = ?2 WHERE agent_id = ?1",
                params![agent_id, turn_id],
            )?;
            Ok(())
        })
    }

    pub fn active_turns(&self) -> Result<Vec<ActiveTurn>> {
        self.with(|c| {
            let mut stmt = c.prepare(
                "SELECT agent_id, session_id, turn_id, artifact_dir, target FROM active_turns",
            )?;
            let mut turns = Vec::new();
            for row in stmt.query_map([], |row| {
                let target: String = row.get(4)?;
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    PathBuf::from(row.get::<_, String>(3)?),
                    target,
                ))
            })? {
                let (agent_id, session_id, turn_id, artifact_dir, target) = row?;
                turns.push(ActiveTurn {
                    agent_id,
                    session_id,
                    turn_id,
                    artifact_dir,
                    target: serde_json::from_str(&target)?,
                });
            }
            Ok(turns)
        })
    }

    pub fn clear_active_turn(&self, agent_id: &str) -> Result<()> {
        self.with(|c| {
            c.execute("DELETE FROM active_turns WHERE agent_id = ?1", params![agent_id])?;
            Ok(())
        })
    }

    // -- bindings --------------------------------------------------------

    pub fn bind(&self, source: &str, conversation: &str, thread_key: &str, agent_id: &str)
        -> Result<()>
    {
        self.with(|c| {
            c.execute(
                "INSERT INTO bindings VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (source, conversation, thread_key)
                 DO UPDATE SET agent_id = excluded.agent_id",
                params![source, conversation, thread_key, agent_id],
            )?;
            Ok(())
        })
    }

    pub fn bound_agent(&self, source: &str, conversation: &str, thread_key: &str)
        -> Result<Option<String>>
    {
        self.with(|c| {
            Ok(c.query_row(
                "SELECT agent_id FROM bindings
                 WHERE source = ?1 AND conversation = ?2 AND thread_key = ?3",
                params![source, conversation, thread_key],
                |r| r.get(0),
            )
            .optional()?)
        })
    }

    /// Cut a conversation loose from its agent, returning what it was on.
    /// This is `clean`: the thread stays, the session does not.
    pub fn unbind(&self, source: &str, conversation: &str, thread_key: &str)
        -> Result<Option<String>>
    {
        self.with(|c| {
            let existing: Option<String> = c
                .query_row(
                    "SELECT agent_id FROM bindings
                     WHERE source = ?1 AND conversation = ?2 AND thread_key = ?3",
                    params![source, conversation, thread_key],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(agent_id) = existing else { return Ok(None) };
            c.execute(
                "DELETE FROM bindings WHERE source = ?1 AND conversation = ?2 AND thread_key = ?3",
                params![source, conversation, thread_key],
            )?;
            c.execute("DELETE FROM pending_context WHERE agent_id = ?1", params![agent_id])?;
            Ok(Some(agent_id))
        })
    }

    pub fn bindings_for(&self, agent_id: &str) -> Result<Vec<Binding>> {
        self.with(|c| {
            let mut stmt = c.prepare("SELECT * FROM bindings WHERE agent_id = ?1")?;
            let mut out = Vec::new();
            for row in stmt.query_map(params![agent_id], |r| {
                Ok(Binding {
                    source: r.get(0)?,
                    conversation: r.get(1)?,
                    thread_key: r.get(2)?,
                    agent_id: r.get(3)?,
                })
            })? {
                out.push(row?);
            }
            Ok(out)
        })
    }

    // -- signals / inbox -------------------------------------------------

    /// Record an arriving signal. `false` means we have seen it before, which
    /// happens whenever a source redelivers rather than because of a bug.
    pub fn put_signal(&self, signal: &Signal) -> Result<bool> {
        self.with(|c| {
            let changed = c.execute(
                "INSERT INTO signals (id, source, conversation, thread_key, external_id,
                                      author, label, text, attachments, at, root, state,
                                      outcome, agent_ids)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'waiting', '', '[]')
                 ON CONFLICT (source, conversation, external_id) DO NOTHING",
                params![
                    signal.id,
                    signal.source,
                    signal.conversation,
                    signal.thread_key,
                    signal.external_id,
                    signal.author,
                    signal.label,
                    signal.text,
                    serde_json::to_string(&signal.attachments)?,
                    signal.at,
                    signal.root as i64,
                ],
            )?;
            Ok(changed > 0)
        })
    }

    pub fn resolve_signal(
        &self,
        id: &str,
        outcome: &str,
        agent_ids: &[String],
    ) -> Result<()> {
        self.with(|c| {
            c.execute(
                "UPDATE signals SET state = 'done', outcome = ?2, agent_ids = ?3 WHERE id = ?1",
                params![id, outcome, serde_json::to_string(agent_ids)?],
            )?;
            Ok(())
        })
    }

    pub fn inbox_item(&self, id: &str) -> Result<Option<InboxItem>> {
        self.with(|c| {
            Ok(c.query_row("SELECT * FROM signals WHERE id = ?1", params![id], read_item)
                .optional()?)
        })
    }

    pub fn inbox(&self, limit: usize) -> Result<Vec<InboxItem>> {
        self.with(|c| {
            let mut stmt =
                c.prepare("SELECT * FROM signals ORDER BY at DESC, rowid DESC LIMIT ?1")?;
            let mut out = Vec::new();
            for row in stmt.query_map(params![limit as i64], read_item)? {
                out.push(row?);
            }
            Ok(out)
        })
    }

    // -- timeline --------------------------------------------------------

    pub fn add_entry(
        &self,
        agent_id: &str,
        at: f64,
        kind: EntryKind,
        text: &str,
        detail: &str,
        origin: &str,
    ) -> Result<Entry> {
        self.with(|c| {
            c.execute(
                "INSERT INTO entries (agent_id, at, kind, text, detail, origin)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![agent_id, at, kind.as_str(), text, detail, origin],
            )?;
            Ok(Entry {
                id: c.last_insert_rowid(),
                agent_id: agent_id.to_string(),
                at,
                kind,
                text: text.to_string(),
                detail: detail.to_string(),
                origin: origin.to_string(),
            })
        })
    }

    pub fn copy_timeline(&self, from: &str, to: &str) -> Result<()> {
        self.with(|c| {
            c.execute(
                "INSERT INTO entries (agent_id, at, kind, text, detail, origin)
                 SELECT ?2, at, kind, text, detail, origin FROM entries
                 WHERE agent_id = ?1 ORDER BY id",
                params![from, to],
            )?;
            Ok(())
        })
    }

    /// The most recent line on an agent's timeline.
    pub fn last_entry(&self, agent_id: &str) -> Result<Option<Entry>> {
        Ok(self.timeline(agent_id, 1)?.pop())
    }

    pub fn timeline(&self, agent_id: &str, limit: usize) -> Result<Vec<Entry>> {
        self.with(|c| {
            let mut stmt = c.prepare(
                "SELECT id, agent_id, at, kind, text, detail, origin FROM entries
                 WHERE agent_id = ?1 ORDER BY id DESC LIMIT ?2",
            )?;
            let mut out = Vec::new();
            for row in stmt.query_map(params![agent_id, limit as i64], |r| {
                Ok(Entry {
                    id: r.get(0)?,
                    agent_id: r.get(1)?,
                    at: r.get(2)?,
                    kind: EntryKind::parse(&r.get::<_, String>(3)?),
                    text: r.get(4)?,
                    detail: r.get(5)?,
                    origin: r.get(6)?,
                })
            })? {
                out.push(row?);
            }
            out.reverse();
            Ok(out)
        })
    }

    // -- side answers waiting to be folded in ----------------------------

    pub fn queue_context(
        &self,
        agent_id: &str,
        ordinal: &str,
        question: &str,
        answer: &str,
    ) -> Result<()> {
        self.with(|c| {
            c.execute(
                "INSERT INTO pending_context (agent_id, ordinal, question, answer)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (agent_id, ordinal) DO UPDATE SET answer = excluded.answer",
                params![agent_id, ordinal, question, answer],
            )?;
            Ok(())
        })
    }

    pub fn pending_context(&self, agent_id: &str) -> Result<Vec<(i64, String, String)>> {
        self.with(|c| {
            let mut stmt = c.prepare(
                "SELECT id, question, answer FROM pending_context
                 WHERE agent_id = ?1 ORDER BY CAST(ordinal AS REAL), id",
            )?;
            let mut out = Vec::new();
            for row in stmt.query_map(params![agent_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })? {
                out.push(row?);
            }
            Ok(out)
        })
    }

    pub fn clear_context(&self, ids: &[i64]) -> Result<()> {
        self.with(|c| {
            for id in ids {
                c.execute("DELETE FROM pending_context WHERE id = ?1", params![id])?;
            }
            Ok(())
        })
    }

    // -- scratch ---------------------------------------------------------

    pub fn get(&self, key: &str) -> Result<Option<String>> {
        self.with(|c| {
            Ok(c.query_row("SELECT value FROM kv WHERE key = ?1", params![key], |r| r.get(0))
                .optional()?)
        })
    }

    pub fn set(&self, key: &str, value: &str) -> Result<()> {
        self.with(|c| {
            c.execute(
                "INSERT INTO kv VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = ?2",
                params![key, value],
            )?;
            Ok(())
        })
    }
}

fn read_agent(row: &Row<'_>) -> rusqlite::Result<Agent> {
    Ok(Agent {
        id: row.get("id")?,
        name: row.get("name")?,
        backend: Backend::parse(&row.get::<_, String>("backend")?).unwrap_or(Backend::Codex),
        model: row.get("model")?,
        session_id: row.get("session_id")?,
        cwd: row.get("cwd")?,
        status: AgentStatus::parse(&row.get::<_, String>("status")?),
        activity: row.get("activity")?,
        permalink: row.get("permalink")?,
        last_activity: row.get("last_activity")?,
        updated_at: row.get("updated_at")?,
        stall_reason: row.get("stall_reason")?,
        stall_alerted: row.get::<_, i64>("stall_alerted")? != 0,
    })
}

fn read_item(row: &Row<'_>) -> rusqlite::Result<InboxItem> {
    let attachments: Vec<Attachment> =
        serde_json::from_str(&row.get::<_, String>("attachments")?).unwrap_or_default();
    let agent_ids: Vec<String> =
        serde_json::from_str(&row.get::<_, String>("agent_ids")?).unwrap_or_default();
    Ok(InboxItem {
        signal: Signal {
            id: row.get("id")?,
            source: row.get("source")?,
            conversation: row.get("conversation")?,
            thread_key: row.get("thread_key")?,
            external_id: row.get("external_id")?,
            author: row.get("author")?,
            label: row.get("label")?,
            text: row.get("text")?,
            attachments,
            at: row.get("at")?,
            root: row.get::<_, i64>("root")? != 0,
        },
        state: InboxState::parse(&row.get::<_, String>("state")?),
        outcome: row.get("outcome")?,
        agent_ids,
        suggested: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::now;

    fn agent(id: &str) -> Agent {
        Agent {
            id: id.into(),
            name: id.into(),
            backend: Backend::Codex,
            model: "sol".into(),
            session_id: String::new(),
            cwd: "/tmp".into(),
            status: AgentStatus::Working,
            activity: String::new(),
            permalink: String::new(),
            last_activity: now(),
            updated_at: now(),
            stall_reason: None,
            stall_alerted: false,
        }
    }

    #[test]
    fn an_agent_survives_a_round_trip() {
        let store = Store::in_memory().unwrap();
        store.save_agent(&agent("a1")).unwrap();
        let back = store.agent("a1").unwrap().unwrap();
        assert_eq!(back.backend, Backend::Codex);
        assert_eq!(back.status, AgentStatus::Working);
    }

    #[test]
    fn a_binding_routes_a_thread_back_to_its_agent() {
        let store = Store::in_memory().unwrap();
        store.save_agent(&agent("a1")).unwrap();
        store.bind("slack", "D1", "111.0", "a1").unwrap();
        assert_eq!(
            store.bound_agent("slack", "D1", "111.0").unwrap().as_deref(),
            Some("a1")
        );
        assert_eq!(store.unbind("slack", "D1", "111.0").unwrap().as_deref(), Some("a1"));
        assert_eq!(store.bound_agent("slack", "D1", "111.0").unwrap(), None);
    }

    #[test]
    fn a_redelivered_signal_is_not_a_second_signal() {
        let store = Store::in_memory().unwrap();
        let signal = Signal {
            id: "s1".into(),
            source: "slack".into(),
            conversation: "D1".into(),
            thread_key: "111.0".into(),
            external_id: "111.0".into(),
            author: "U1".into(),
            label: String::new(),
            text: "hello".into(),
            attachments: vec![],
            at: now(),
            root: true,
        };
        assert!(store.put_signal(&signal).unwrap());
        let again = Signal { id: "s2".into(), ..signal };
        assert!(!store.put_signal(&again).unwrap());
        assert_eq!(store.inbox(10).unwrap().len(), 1);
    }

    #[test]
    fn a_stall_alerts_once_and_a_system_error_overrides_the_reason() {
        let store = Store::in_memory().unwrap();
        store.save_agent(&agent("a1")).unwrap();
        assert!(store.stall_agent("a1", "no activity", now()).unwrap());
        assert!(!store.stall_agent("a1", "no activity", now()).unwrap());
        store.stall_agent("a1", "system error", now()).unwrap();
        assert_eq!(
            store.agent("a1").unwrap().unwrap().stall_reason.as_deref(),
            Some("system error")
        );
    }

    #[test]
    fn a_restart_stalls_whatever_claimed_to_be_running() {
        let store = Store::in_memory().unwrap();
        store.save_agent(&agent("a1")).unwrap();
        assert_eq!(store.recover(now()).unwrap().len(), 1);
        assert_eq!(store.agent("a1").unwrap().unwrap().status, AgentStatus::Stalled);
        assert!(store.recover(now()).unwrap().is_empty());
    }

    #[test]
    fn the_agent_list_keeps_everything_live_and_caps_what_is_finished() {
        let store = Store::in_memory().unwrap();
        for i in 0..4 {
            let mut a = agent(&format!("live{i}"));
            a.status = AgentStatus::Working;
            store.save_agent(&a).unwrap();
            let mut d = agent(&format!("done{i}"));
            d.status = AgentStatus::Complete;
            d.updated_at = now() + i as f64;
            store.save_agent(&d).unwrap();
        }
        let listed = store.agents(2).unwrap();
        assert_eq!(listed.len(), 6);
        assert!(listed[..4].iter().all(|a| a.status == AgentStatus::Working));
    }
}
