//! Durable state. SQLite, because it survives a restart and a VM reboot and
//! needs no server next to it.
//!
//! The calls here are synchronous. SQLite on a local file answers in
//! microseconds and the whole point of a WAL database is that a short
//! critical section is cheaper than the machinery to avoid one, so the hub
//! holds the connection behind a plain mutex rather than a worker pool.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::model::{
    Agent, AgentStatus, Attachment, Backend, Binding, Entry, EntryKind, InboxItem, InboxState,
    SearchDestination, SearchGroup, Signal, Target, TaskItem, TaskNote, TaskStatus,
};
use crate::tags::Board;

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
    stall_alerted INTEGER NOT NULL DEFAULT 0,
    archived      INTEGER NOT NULL DEFAULT 0,
    pinned        INTEGER NOT NULL DEFAULT 0
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
    output   TEXT NOT NULL DEFAULT '',
    item_id  TEXT NOT NULL DEFAULT '',
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

CREATE TABLE IF NOT EXISTS tasks (
    id                 TEXT PRIMARY KEY,
    text               TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'incomplete',
    blocked_by_task_id TEXT NOT NULL DEFAULT '',
    agent_id           TEXT NOT NULL DEFAULT '',
    position           REAL NOT NULL DEFAULT 0,
    images             TEXT NOT NULL DEFAULT '[]',
    created_at         REAL NOT NULL,
    updated_at         REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS task_notes (
    id       TEXT PRIMARY KEY,
    task_id  TEXT NOT NULL,
    text     TEXT NOT NULL,
    agent_id TEXT NOT NULL DEFAULT '',
    at       REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS task_notes_by_task ON task_notes (task_id, at);
CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tags (
    agent_id TEXT NOT NULL,
    tag      TEXT NOT NULL,
    PRIMARY KEY (agent_id, tag)
);
CREATE INDEX IF NOT EXISTS tags_tag ON tags (tag);

CREATE TABLE IF NOT EXISTS boards (
    id         TEXT PRIMARY KEY,
    spec       TEXT NOT NULL,
    created_at REAL NOT NULL
);
"#;

pub struct Store {
    conn: Mutex<Connection>,
    path: PathBuf,
}

fn migrate(conn: &Connection) -> Result<()> {
    let mut statement = conn.prepare("PRAGMA table_info(agents)")?;
    let agent_columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    if !agent_columns.iter().any(|column| column == "archived") {
        conn.execute("ALTER TABLE agents ADD COLUMN archived INTEGER NOT NULL DEFAULT 0", [])?;
    }
    if !agent_columns.iter().any(|column| column == "pinned") {
        conn.execute("ALTER TABLE agents ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0", [])?;
    }

    let mut statement = conn.prepare("PRAGMA table_info(entries)")?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    if !columns.iter().any(|column| column == "output") {
        conn.execute("ALTER TABLE entries ADD COLUMN output TEXT NOT NULL DEFAULT ''", [])?;
    }
    if !columns.iter().any(|column| column == "item_id") {
        conn.execute("ALTER TABLE entries ADD COLUMN item_id TEXT NOT NULL DEFAULT ''", [])?;
    }
    conn.execute(
        "CREATE INDEX IF NOT EXISTS entries_item ON entries (agent_id, item_id)",
        [],
    )?;

    let mut statement = conn.prepare("PRAGMA table_info(tasks)")?;
    let task_columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    if !task_columns.iter().any(|column| column == "status") {
        conn.execute("ALTER TABLE tasks ADD COLUMN status TEXT NOT NULL DEFAULT 'incomplete'", [])?;
        if task_columns.iter().any(|column| column == "done") {
            conn.execute("UPDATE tasks SET status = CASE done WHEN 1 THEN 'complete' ELSE 'incomplete' END", [])?;
        }
    }
    if !task_columns.iter().any(|column| column == "blocked_by_task_id") {
        conn.execute("ALTER TABLE tasks ADD COLUMN blocked_by_task_id TEXT NOT NULL DEFAULT ''", [])?;
    }
    if !task_columns.iter().any(|column| column == "images") {
        conn.execute("ALTER TABLE tasks ADD COLUMN images TEXT NOT NULL DEFAULT '[]'", [])?;
    }
    if !task_columns.iter().any(|column| column == "position") {
        conn.execute("ALTER TABLE tasks ADD COLUMN position REAL NOT NULL DEFAULT 0", [])?;
        // Whatever order the list was read in is the order it had, so that
        // is the order it keeps rather than shuffling on first sight.
        conn.execute(
            "UPDATE tasks SET position = (
                 SELECT COUNT(*) FROM tasks AS earlier
                 WHERE earlier.updated_at > tasks.updated_at
                    OR (earlier.updated_at = tasks.updated_at AND earlier.id < tasks.id)
             )",
            [],
        )?;
    }
    conn.execute("DROP INDEX IF EXISTS tasks_agent", [])?;
    conn.execute(
        "CREATE INDEX tasks_agent ON tasks (agent_id, status, updated_at DESC)",
        [],
    )?;
    Ok(())
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
        migrate(&conn)?;
        Ok(Store {
            conn: Mutex::new(conn),
            path,
        })
    }

    pub fn in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        migrate(&conn)?;
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
                                     stall_reason, stall_alerted, pinned)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                 ON CONFLICT (id) DO UPDATE SET
                    name = excluded.name, backend = excluded.backend,
                    model = excluded.model, session_id = excluded.session_id,
                    cwd = excluded.cwd, status = excluded.status,
                    activity = excluded.activity, permalink = excluded.permalink,
                    last_activity = excluded.last_activity,
                    updated_at = excluded.updated_at,
                    stall_reason = excluded.stall_reason,
                    stall_alerted = excluded.stall_alerted,
                    pinned = excluded.pinned",
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
                    agent.pinned as i64,
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

    pub fn agent_by_session(&self, backend: Backend, session_id: &str) -> Result<Option<Agent>> {
        self.with(|c| {
            Ok(c.query_row(
                "SELECT * FROM agents WHERE backend = ?1 AND session_id = ?2 LIMIT 1",
                params![backend.as_str(), session_id],
                read_agent,
            )
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
            let mut live =
                c.prepare("SELECT * FROM agents WHERE archived = 0 AND status != 'complete'")?;
            for row in live.query_map([], read_agent)? {
                out.push(row?);
            }
            let mut done = c.prepare(
                "SELECT * FROM (
                    SELECT * FROM agents WHERE status = 'complete'
                    ORDER BY pinned DESC, updated_at DESC LIMIT ?1
                 ) WHERE archived = 0",
            )?;
            for row in done.query_map(params![completed_limit as i64], read_agent)? {
                out.push(row?);
            }
            out.sort_by(|a, b| {
                b.pinned
                    .cmp(&a.pinned)
                    .then(a.status
                    .rank()
                    .cmp(&b.status.rank()))
                    .then(b.updated_at.total_cmp(&a.updated_at))
            });
            Ok(out)
        })
    }

    pub fn archived_agents(&self) -> Result<Vec<Agent>> {
        self.with(|c| {
            let mut statement =
                c.prepare("SELECT * FROM agents WHERE archived = 1 ORDER BY updated_at DESC")?;
            let mut agents = Vec::new();
            for row in statement.query_map([], read_agent)? {
                agents.push(row?);
            }
            Ok(agents)
        })
    }

    pub fn set_agent_archived(&self, id: &str, archived: bool) -> Result<()> {
        self.with(|c| {
            let changed = c.execute(
                "UPDATE agents SET archived = ?2 WHERE id = ?1",
                params![id, archived as i64],
            )?;
            anyhow::ensure!(changed == 1, "no such agent");
            Ok(())
        })
    }

    pub fn set_agent_pinned(&self, id: &str, pinned: bool) -> Result<()> {
        self.with(|c| {
            let changed = c.execute(
                "UPDATE agents SET pinned = ?2 WHERE id = ?1",
                params![id, pinned as i64],
            )?;
            anyhow::ensure!(changed == 1, "no such agent");
            Ok(())
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

    pub fn tasks(&self) -> Result<Vec<TaskItem>> {
        self.with(|c| {
            let mut statement = c.prepare(
                "SELECT id, text, status, blocked_by_task_id, agent_id, position, images,
                        created_at, updated_at
                 FROM tasks ORDER BY position, created_at",
            )?;
            let tasks = statement
                .query_map([], |row| {
                    let status: String = row.get(2)?;
                    Ok(TaskItem {
                        id: row.get(0)?,
                        text: row.get(1)?,
                        status: TaskStatus::parse(&status).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                2,
                                rusqlite::types::Type::Text,
                                error.into(),
                            )
                        })?,
                        blocked_by_task_id: row.get(3)?,
                        agent_id: row.get(4)?,
                        position: row.get(5)?,
                        images: serde_json::from_str(&row.get::<_, String>(6)?)
                            .unwrap_or_default(),
                        created_at: row.get(7)?,
                        updated_at: row.get(8)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(tasks)
        })
    }

    pub fn task_notes(&self) -> Result<Vec<TaskNote>> {
        self.with(|c| {
            let mut statement = c.prepare(
                "SELECT id, task_id, text, agent_id, at FROM task_notes ORDER BY at",
            )?;
            let notes = statement
                .query_map([], |row| {
                    Ok(TaskNote {
                        id: row.get(0)?,
                        task_id: row.get(1)?,
                        text: row.get(2)?,
                        agent_id: row.get(3)?,
                        at: row.get(4)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(notes)
        })
    }

    pub fn save_task_note(&self, note: &TaskNote) -> Result<()> {
        self.with(|c| {
            c.execute(
                "INSERT INTO task_notes (id, task_id, text, agent_id, at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![note.id, note.task_id, note.text, note.agent_id, note.at],
            )?;
            Ok(())
        })
    }

    pub fn save_task(&self, task: &TaskItem) -> Result<()> {
        self.with(|c| {
            c.execute(
                "INSERT INTO tasks (id, text, status, blocked_by_task_id, agent_id, position,
                     images, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(id) DO UPDATE SET text = excluded.text, status = excluded.status,
                     blocked_by_task_id = excluded.blocked_by_task_id,
                     position = excluded.position, images = excluded.images,
                     agent_id = excluded.agent_id, updated_at = excluded.updated_at",
                params![
                    task.id,
                    task.text,
                    task.status.as_str(),
                    task.blocked_by_task_id,
                    task.agent_id,
                    task.position,
                    serde_json::to_string(&task.images)?,
                    task.created_at,
                    task.updated_at,
                ],
            )?;
            Ok(())
        })
    }

    pub fn delete_task(&self, id: &str) -> Result<()> {
        self.with(|c| {
            let transaction = c.unchecked_transaction()?;
            transaction.execute(
                "UPDATE tasks SET status = 'incomplete', blocked_by_task_id = '', updated_at = ?2
                 WHERE blocked_by_task_id = ?1",
                params![id, crate::model::now()],
            )?;
            transaction.execute("DELETE FROM task_notes WHERE task_id = ?1", params![id])?;
            anyhow::ensure!(
                transaction.execute("DELETE FROM tasks WHERE id = ?1", params![id])? == 1,
                "no such task"
            );
            transaction.commit()?;
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

    pub fn fork_parent(&self, agent_id: &str) -> Result<Option<String>> {
        self.with(|c| {
            Ok(c.query_row(
                "SELECT detail FROM entries
                 WHERE agent_id = ?1 AND kind = 'forked-from'
                 ORDER BY id DESC LIMIT 1",
                params![agent_id],
                |row| row.get(0),
            )
            .optional()?)
        })
    }

    pub fn fork_children(&self, agent_id: &str) -> Result<Vec<String>> {
        self.with(|c| {
            let mut statement = c.prepare(
                "SELECT e.agent_id FROM entries e JOIN agents a ON a.id = e.agent_id
                 WHERE e.kind = 'forked-from' AND e.detail = ?1 AND a.archived = 0
                   AND e.id = (SELECT MAX(last.id) FROM entries last
                               WHERE last.agent_id = e.agent_id AND last.kind = 'forked-from')",
            )?;
            let children = statement
                .query_map(params![agent_id], |row| row.get(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(children)
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
        self.add_entry_full(agent_id, at, kind, text, detail, "", "", origin)
    }

    pub fn add_work_entry(
        &self,
        agent_id: &str,
        at: f64,
        text: &str,
        detail: &str,
        output: &str,
        item_id: &str,
    ) -> Result<Entry> {
        self.add_entry_full(
            agent_id,
            at,
            EntryKind::Worked,
            text,
            detail,
            output,
            item_id,
            "",
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn add_entry_full(
        &self,
        agent_id: &str,
        at: f64,
        kind: EntryKind,
        text: &str,
        detail: &str,
        output: &str,
        item_id: &str,
        origin: &str,
    ) -> Result<Entry> {
        self.with(|c| {
            c.execute(
                "INSERT INTO entries (agent_id, at, kind, text, detail, output, item_id, origin)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![agent_id, at, kind.as_str(), text, detail, output, item_id, origin],
            )?;
            Ok(Entry {
                id: c.last_insert_rowid(),
                agent_id: agent_id.to_string(),
                at,
                kind,
                text: text.to_string(),
                detail: detail.to_string(),
                output: output.to_string(),
                origin: origin.to_string(),
            })
        })
    }

    pub fn set_work_output(
        &self,
        agent_id: &str,
        item_id: &str,
        output: &str,
    ) -> Result<Option<Entry>> {
        self.with(|c| {
            let id = c
                .query_row(
                    "SELECT id FROM entries
                     WHERE agent_id = ?1 AND item_id = ?2 AND kind = 'worked'
                     ORDER BY id DESC LIMIT 1",
                    params![agent_id, item_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?;
            let Some(id) = id else { return Ok(None) };
            c.execute("UPDATE entries SET output = ?2 WHERE id = ?1", params![id, output])?;
            Ok(c
                .query_row(
                    "SELECT id, agent_id, at, kind, text, detail, output, origin
                     FROM entries WHERE id = ?1",
                    params![id],
                    read_entry,
                )
                .optional()?)
        })
    }

    pub fn copy_timeline(&self, from: &str, to: &str) -> Result<()> {
        self.with(|c| {
            c.execute(
                "INSERT INTO entries (agent_id, at, kind, text, detail, output, item_id, origin)
                 SELECT ?2, at, kind, text, detail, output, item_id, origin FROM entries
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
                "SELECT id, agent_id, at, kind, text, detail, output, origin FROM entries
                 WHERE agent_id = ?1 ORDER BY id DESC LIMIT ?2",
            )?;
            let mut out = Vec::new();
            for row in stmt.query_map(params![agent_id, limit as i64], read_entry)? {
                out.push(row?);
            }
            out.reverse();
            Ok(out)
        })
    }

    /// The newest human-facing line for each agent. Tool work is deliberately
    /// excluded so fleet cards stay about the conversation.
    pub fn message_previews(&self) -> Result<HashMap<String, String>> {
        self.with(|c| {
            let mut stmt = c.prepare(
                "SELECT agent_id, text FROM entries
                 WHERE kind IN ('received', 'said', 'asked', 'you') AND text != ''
                 ORDER BY id DESC",
            )?;
            let mut previews = HashMap::new();
            for row in stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })? {
                let (agent, text) = row?;
                previews.entry(agent).or_insert(text);
            }
            Ok(previews)
        })
    }

    /// Search every timeline, collapsing rows copied through a fork into one
    /// result with a destination for each branch that contains it.
    /// How well a hit answers the words you typed.
    ///
    /// You are looking for the session where something was said, so a
    /// message outranks the output of a command that happened to print the
    /// same word, and a whole word outranks a fragment of a longer one. A
    /// hit counts once however often it repeats: a long log is not a better
    /// answer than a sentence.
    fn relevance(query: &str, group: &SearchGroup) -> i64 {
        let query = query.to_lowercase();
        let has = |hay: &str| i64::from(hay.to_lowercase().contains(&query));
        let whole = |hay: &str| {
            i64::from(
                hay.to_lowercase()
                    .split(|c: char| !c.is_alphanumeric())
                    .any(|word| word == query),
            )
        };
        let spoken = matches!(
            group.kind,
            EntryKind::You | EntryKind::Said | EntryKind::Asked | EntryKind::Received
        );
        4 * whole(&group.text) + 2 * has(&group.text)
            + whole(&group.detail)
            + has(&group.detail)
            + has(&group.origin)
            + if spoken { 3 } else { 0 }
    }

    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchGroup>> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(vec![]);
        }
        self.with(|c| {
            let mut graph: HashMap<String, HashSet<String>> = HashMap::new();
            let mut links = c.prepare(
                "SELECT agent_id, detail FROM entries WHERE kind = 'forked-from'",
            )?;
            for link in links.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })? {
                let (child, parent) = link?;
                graph.entry(child.clone()).or_default().insert(parent.clone());
                graph.entry(parent).or_default().insert(child);
            }

            let mut family = HashMap::new();
            for start in graph.keys() {
                if family.contains_key(start) {
                    continue;
                }
                let mut stack = vec![start.clone()];
                let mut members = HashSet::new();
                while let Some(agent) = stack.pop() {
                    if !members.insert(agent.clone()) {
                        continue;
                    }
                    stack.extend(graph.get(&agent).into_iter().flatten().cloned());
                }
                let id = members.iter().min().cloned().unwrap_or_default();
                for member in members {
                    family.insert(member, id.clone());
                }
            }

            let mut stmt = c.prepare(
                "SELECT e.id, e.agent_id, a.name, e.at, e.kind, e.text, e.detail, e.origin
                 FROM entries e JOIN agents a ON a.id = e.agent_id
                 WHERE instr(lower(e.text), lower(?1)) > 0
                    OR instr(lower(e.detail), lower(?1)) > 0
                    OR instr(lower(e.origin), lower(?1)) > 0
                 ORDER BY e.at DESC, e.id DESC
                 LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![query, (limit * 20) as i64], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, f64>(3)?,
                    EntryKind::parse(&row.get::<_, String>(4)?),
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                ))
            })?;

            let mut groups: Vec<SearchGroup> = vec![];
            let mut grouped: HashMap<_, usize> = HashMap::new();
            for row in rows {
                let (entry_id, agent_id, agent_name, at, kind, text, detail, origin) = row?;
                let key = (
                    family.get(&agent_id).unwrap_or(&agent_id).clone(),
                    at.to_bits(),
                    kind.as_str(),
                    text.clone(),
                    detail.clone(),
                    origin.clone(),
                );
                if let Some(index) = grouped.get(&key).copied() {
                    groups[index].destinations.push(SearchDestination {
                        agent_id,
                        agent_name,
                        entry_id,
                    });
                } else {
                    grouped.insert(key, groups.len());
                    groups.push(SearchGroup {
                        at,
                        kind,
                        text,
                        detail,
                        origin,
                        destinations: vec![SearchDestination {
                            agent_id,
                            agent_name,
                            entry_id,
                        }],
                    });
                }
            }
            // The best match first, not merely the newest: you are looking
            // for the session where something was said, and the words you
            // remember are the evidence for which one that is.
            groups.sort_by(|a, b| {
                Self::relevance(query, b)
                    .cmp(&Self::relevance(query, a))
                    .then(b.at.total_cmp(&a.at))
            });
            groups.truncate(limit);
            Ok(groups)
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

    // -- tags ------------------------------------------------------------

    pub fn tags(&self, agent_id: &str) -> Result<Vec<String>> {
        self.with(|c| {
            let mut statement =
                c.prepare("SELECT tag FROM tags WHERE agent_id = ?1 ORDER BY tag")?;
            let tags = statement
                .query_map(params![agent_id], |row| row.get(0))?
                .collect::<rusqlite::Result<Vec<String>>>()?;
            Ok(tags)
        })
    }

    /// Every tagged session's tags, for drawing a board in one read.
    pub fn all_tags(&self) -> Result<HashMap<String, Vec<String>>> {
        self.with(|c| {
            let mut statement = c.prepare("SELECT agent_id, tag FROM tags ORDER BY agent_id, tag")?;
            let mut out: HashMap<String, Vec<String>> = HashMap::new();
            for row in statement.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })? {
                let (agent, tag) = row?;
                out.entry(agent).or_default().push(tag);
            }
            Ok(out)
        })
    }

    /// Replace a session's tags with exactly these. The caller has already
    /// normalised them; see [`crate::tags::change`].
    pub fn set_tags(&self, agent_id: &str, tags: &[String]) -> Result<()> {
        self.with(|c| {
            let transaction = c.unchecked_transaction()?;
            transaction.execute("DELETE FROM tags WHERE agent_id = ?1", params![agent_id])?;
            for tag in tags {
                transaction.execute(
                    "INSERT OR IGNORE INTO tags (agent_id, tag) VALUES (?1, ?2)",
                    params![agent_id, tag],
                )?;
            }
            transaction.commit()?;
            Ok(())
        })
    }

    // -- boards ----------------------------------------------------------

    /// Boards in the order they were made, which is the order of the tabs.
    pub fn boards(&self) -> Result<Vec<Board>> {
        self.with(|c| {
            let mut statement = c.prepare("SELECT spec FROM boards ORDER BY created_at, id")?;
            let specs = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            // A board that no longer parses is skipped rather than taking
            // every other board down with it.
            Ok(specs
                .iter()
                .filter_map(|spec| serde_json::from_str(spec).ok())
                .collect())
        })
    }

    pub fn board(&self, id: &str) -> Result<Option<Board>> {
        Ok(self.boards()?.into_iter().find(|board| board.id == id))
    }

    pub fn save_board(&self, board: &Board) -> Result<()> {
        let spec = serde_json::to_string(board)?;
        self.with(|c| {
            c.execute(
                "INSERT INTO boards (id, spec, created_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(id) DO UPDATE SET spec = excluded.spec",
                params![board.id, spec, board.created_at],
            )?;
            Ok(())
        })
    }

    pub fn delete_board(&self, id: &str) -> Result<()> {
        self.with(|c| {
            anyhow::ensure!(
                c.execute("DELETE FROM boards WHERE id = ?1", params![id])? == 1,
                "no such board"
            );
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
        pinned: row.get::<_, i64>("pinned")? != 0,
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

fn read_entry(row: &Row<'_>) -> rusqlite::Result<Entry> {
    Ok(Entry {
        id: row.get(0)?,
        agent_id: row.get(1)?,
        at: row.get(2)?,
        kind: EntryKind::parse(&row.get::<_, String>(3)?),
        text: row.get(4)?,
        detail: row.get(5)?,
        output: row.get(6)?,
        origin: row.get(7)?,
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
            pinned: false,
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
    fn a_search_answers_with_the_best_match_rather_than_the_newest() {
        let store = Store::in_memory().unwrap();
        store.save_agent(&agent("a1")).unwrap();
        let old = now() - 100.0;
        store
            .add_entry(&agent("a1").id, old, EntryKind::You, "the ferry timetable changed", "", "")
            .unwrap();
        store
            .add_entry(
                &agent("a1").id,
                now(),
                EntryKind::You,
                "booked the ferryboat museum instead",
                "",
                "",
            )
            .unwrap();

        // Both contain the letters; only one is about the thing.
        let found = store.search("ferry", 10).unwrap();
        assert_eq!(found.len(), 2);
        assert!(
            found[0].text.contains("timetable"),
            "the whole word should win over a fragment of a longer one",
        );
    }

    #[test]
    fn a_search_answers_with_what_was_said_before_what_a_command_printed() {
        let store = Store::in_memory().unwrap();
        store.save_agent(&agent("a1")).unwrap();
        // A log that says it many times, and a person who said it once.
        store
            .add_entry(
                &agent("a1").id,
                now(),
                EntryKind::Worked,
                "Bash",
                "ferry ferry ferry ferry",
                "",
            )
            .unwrap();
        store
            .add_entry(&agent("a1").id, now() - 50.0, EntryKind::You, "book the ferry", "", "")
            .unwrap();

        let found = store.search("ferry", 10).unwrap();
        assert_eq!(found[0].text, "book the ferry", "a person outranks a transcript");
    }

    #[test]
    fn archiving_hides_a_session_without_deleting_it() {
        let store = Store::in_memory().unwrap();
        let mut archived = agent("archived");
        archived.status = AgentStatus::Complete;
        store.save_agent(&archived).unwrap();

        store.set_agent_archived(&archived.id, true).unwrap();
        assert!(store.agents(20).unwrap().is_empty());
        assert_eq!(store.archived_agents().unwrap()[0].id, archived.id);
        assert!(store.agent(&archived.id).unwrap().is_some());

        store.set_agent_archived(&archived.id, false).unwrap();
        assert_eq!(store.agents(20).unwrap()[0].id, archived.id);
        assert!(store.archived_agents().unwrap().is_empty());
    }

    #[test]
    fn archiving_a_visible_session_does_not_backfill_old_history() {
        let store = Store::in_memory().unwrap();
        for (id, updated_at) in [("old", 1.0), ("middle", 2.0), ("new", 3.0)] {
            let mut item = agent(id);
            item.status = AgentStatus::Complete;
            item.updated_at = updated_at;
            store.save_agent(&item).unwrap();
        }

        assert_eq!(
            store.agents(2).unwrap().iter().map(|agent| agent.id.as_str()).collect::<Vec<_>>(),
            vec!["new", "middle"]
        );
        store.set_agent_archived("new", true).unwrap();
        assert_eq!(
            store.agents(2).unwrap().iter().map(|agent| agent.id.as_str()).collect::<Vec<_>>(),
            vec!["middle"]
        );
    }

    #[test]
    fn shared_tasks_can_be_created_edited_assigned_and_deleted() {
        let store = Store::in_memory().unwrap();
        let mut task = TaskItem {
            id: "task-1".into(),
            text: "draft release notes".into(),
            status: TaskStatus::Incomplete,
            blocked_by_task_id: String::new(),
            agent_id: String::new(),
            position: 0.0,
            images: vec![],
            created_at: 1.0,
            updated_at: 1.0,
        };
        store.save_task(&task).unwrap();
        assert_eq!(store.tasks().unwrap()[0].text, "draft release notes");

        task.text = "publish release notes".into();
        task.status = TaskStatus::Complete;
        task.agent_id = "agent-1".into();
        task.updated_at = 2.0;
        store.save_task(&task).unwrap();
        let saved = store.tasks().unwrap().pop().unwrap();
        assert_eq!(saved.text, "publish release notes");
        assert_eq!(saved.status, TaskStatus::Complete);
        assert_eq!(saved.agent_id, "agent-1");

        store.delete_task(&task.id).unwrap();
        assert!(store.tasks().unwrap().is_empty());
    }

    #[test]
    fn tags_replace_as_a_set_and_read_back_per_session_and_all_at_once() {
        let store = Store::in_memory().unwrap();
        let tags = |t: &[&str]| t.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        store.set_tags("a", &tags(&["stage:idea", "priority:p2"])).unwrap();
        store.set_tags("b", &tags(&["stage:building"])).unwrap();
        store.set_tags("a", &tags(&["stage:eval"])).unwrap();
        assert_eq!(store.tags("a").unwrap(), ["stage:eval"]);
        let all = store.all_tags().unwrap();
        assert_eq!(all["b"], ["stage:building"]);
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn boards_keep_their_order_and_their_settings() {
        let store = Store::in_memory().unwrap();
        let board = |id: &str, at: f64| Board {
            id: id.into(),
            name: id.into(),
            columns: "stage".into(),
            column_order: vec!["idea".into()],
            rows: "project".into(),
            row_order: vec![],
            filters: vec!["priority".into()],
            selected: vec![],
            sort: String::new(),
            created_at: at,
            updated_at: at,
        };
        store.save_board(&board("second", 2.0)).unwrap();
        store.save_board(&board("first", 1.0)).unwrap();
        let mut renamed = board("first", 1.0);
        renamed.name = "Ideas".into();
        store.save_board(&renamed).unwrap();
        let ids: Vec<_> = store.boards().unwrap().into_iter().map(|b| b.id).collect();
        assert_eq!(ids, ["first", "second"]);
        assert_eq!(store.board("first").unwrap().unwrap().name, "Ideas");
        store.delete_board("second").unwrap();
        assert!(store.delete_board("second").is_err());
        assert_eq!(store.boards().unwrap().len(), 1);
    }

    #[test]
    fn deleting_a_blocker_releases_its_dependents() {
        let store = Store::in_memory().unwrap();
        let task = |id: &str, status, blocker: &str| TaskItem {
            id: id.into(),
            text: id.into(),
            status,
            blocked_by_task_id: blocker.into(),
            agent_id: String::new(),
            position: 0.0,
            images: vec![],
            created_at: 1.0,
            updated_at: 1.0,
        };
        store.save_task(&task("first", TaskStatus::Incomplete, "")).unwrap();
        store.save_task(&task("second", TaskStatus::Blocked, "first")).unwrap();

        store.delete_task("first").unwrap();
        let second = store.tasks().unwrap().pop().unwrap();
        assert_eq!(second.status, TaskStatus::Incomplete);
        assert!(second.blocked_by_task_id.is_empty());
    }

    #[test]
    fn existing_boolean_tasks_migrate_to_statuses() {
        let path = std::env::temp_dir().join(format!("oxroute-{}.sqlite3", uuid::Uuid::new_v4()));
        let legacy = Connection::open(&path).unwrap();
        legacy.execute_batch(
            "CREATE TABLE tasks (
                id TEXT PRIMARY KEY, text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0,
                agent_id TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL, updated_at REAL NOT NULL
            );
            INSERT INTO tasks VALUES ('open', 'open', 0, '', 1, 1);
            INSERT INTO tasks VALUES ('done', 'done', 1, '', 1, 1);",
        ).unwrap();
        drop(legacy);

        let store = Store::open(&path).unwrap();
        let statuses: HashMap<_, _> = store.tasks().unwrap().into_iter()
            .map(|task| (task.id, task.status))
            .collect();
        assert_eq!(statuses["open"], TaskStatus::Incomplete);
        assert_eq!(statuses["done"], TaskStatus::Complete);
        drop(store);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn pinned_sessions_sort_before_every_other_card() {
        let store = Store::in_memory().unwrap();
        let mut working = agent("working");
        working.updated_at = 20.0;
        let mut pinned = agent("pinned");
        pinned.status = AgentStatus::Complete;
        pinned.updated_at = 10.0;
        store.save_agent(&working).unwrap();
        store.save_agent(&pinned).unwrap();

        store.set_agent_pinned(&pinned.id, true).unwrap();
        let agents = store.agents(20).unwrap();
        assert_eq!(agents[0].id, pinned.id);
        assert!(agents[0].pinned);

        store.set_agent_pinned(&pinned.id, false).unwrap();
        assert_eq!(store.agents(20).unwrap()[0].id, working.id);
    }

    #[test]
    fn an_existing_timeline_gains_tool_output_columns() {
        let path = std::env::temp_dir().join(format!("oxroute-{}.sqlite3", uuid::Uuid::new_v4()));
        let legacy = Connection::open(&path).unwrap();
        legacy
            .execute_batch(
                "CREATE TABLE entries (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    agent_id TEXT NOT NULL,
                    at REAL NOT NULL,
                    kind TEXT NOT NULL,
                    text TEXT NOT NULL DEFAULT '',
                    detail TEXT NOT NULL DEFAULT '',
                    origin TEXT NOT NULL DEFAULT ''
                );",
            )
            .unwrap();
        drop(legacy);

        let store = Store::open(&path).unwrap();
        let entry = store
            .add_work_entry("a1", now(), "Command", "printf ok", "ok", "item-1")
            .unwrap();
        assert_eq!(entry.output, "ok");
        drop(store);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn an_existing_agent_database_gains_archive_and_pin_state() {
        let path = std::env::temp_dir().join(format!("oxroute-{}.sqlite3", uuid::Uuid::new_v4()));
        let legacy = Connection::open(&path).unwrap();
        legacy
            .execute_batch(
                "CREATE TABLE agents (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, backend TEXT NOT NULL,
                    model TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '',
                    cwd TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'complete',
                    activity TEXT NOT NULL DEFAULT '', permalink TEXT NOT NULL DEFAULT '',
                    last_activity REAL NOT NULL DEFAULT 0, updated_at REAL NOT NULL DEFAULT 0,
                    stall_reason TEXT, stall_alerted INTEGER NOT NULL DEFAULT 0
                );
                INSERT INTO agents (id, name, backend, model) VALUES ('a1', 'old', 'codex', 'sol');",
            )
            .unwrap();
        drop(legacy);

        let store = Store::open(&path).unwrap();
        assert_eq!(store.agents(20).unwrap()[0].id, "a1");
        store.set_agent_pinned("a1", true).unwrap();
        assert!(store.agent("a1").unwrap().unwrap().pinned);
        store.set_agent_archived("a1", true).unwrap();
        assert_eq!(store.archived_agents().unwrap()[0].id, "a1");
        drop(store);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn a_stored_model_survives_open() {
        let path = std::env::temp_dir().join(format!("oxroute-{}.sqlite3", uuid::Uuid::new_v4()));
        let legacy = Connection::open(&path).unwrap();
        legacy.execute_batch(SCHEMA).unwrap();
        legacy
            .execute(
                "INSERT INTO agents
                 (id, name, backend, model, status, stall_reason, stall_alerted)
                 VALUES ('a1', 'old', 'codex', 'chosen-model', 'complete', NULL, 0)",
                [],
            )
            .unwrap();
        drop(legacy);

        let store = Store::open(&path).unwrap();
        let stored = store.agent("a1").unwrap().unwrap();
        assert_eq!(stored.model, "chosen-model");
        assert_eq!(stored.status, AgentStatus::Complete);
        assert_eq!(stored.stall_reason, None);
        assert!(!stored.stall_alerted);
        drop(store);
        std::fs::remove_file(path).unwrap();
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

    #[test]
    fn message_previews_ignore_tool_work() {
        let store = Store::in_memory().unwrap();
        store.save_agent(&agent("a1")).unwrap();
        store
            .add_entry("a1", 1.0, EntryKind::Received, "check the deploy", "", "")
            .unwrap();
        store
            .add_entry("a1", 2.0, EntryKind::Worked, "Bash", "kubectl get pods", "")
            .unwrap();

        assert_eq!(
            store.message_previews().unwrap().get("a1").map(String::as_str),
            Some("check the deploy")
        );
    }

    #[test]
    fn search_stacks_inherited_fork_history_without_merging_other_sessions() {
        let store = Store::in_memory().unwrap();
        for id in ["parent", "child", "grandchild", "unrelated"] {
            store.save_agent(&agent(id)).unwrap();
        }

        store
            .add_entry("parent", 1.0, EntryKind::Received, "shared needle", "", "")
            .unwrap();
        store.copy_timeline("parent", "child").unwrap();
        store
            .add_entry(
                "child",
                2.0,
                EntryKind::ForkedFrom,
                "Forked from session",
                "parent",
                "",
            )
            .unwrap();
        store
            .add_entry("child", 3.0, EntryKind::Said, "branch needle", "", "")
            .unwrap();
        store.copy_timeline("child", "grandchild").unwrap();
        store
            .add_entry(
                "grandchild",
                4.0,
                EntryKind::ForkedFrom,
                "Forked from session",
                "child",
                "",
            )
            .unwrap();
        store
            .add_entry("unrelated", 1.0, EntryKind::Received, "shared needle", "", "")
            .unwrap();

        let results = store.search("NEEDLE", 20).unwrap();
        assert_eq!(results.len(), 3);
        let shared = results
            .iter()
            .find(|result| result.text == "shared needle" && result.destinations.len() == 3)
            .unwrap();
        assert_eq!(
            shared
                .destinations
                .iter()
                .map(|destination| destination.agent_id.as_str())
                .collect::<HashSet<_>>(),
            HashSet::from(["parent", "child", "grandchild"])
        );
        assert!(results
            .iter()
            .any(|result| result.text == "branch needle" && result.destinations.len() == 2));
        assert!(results.iter().any(|result| {
            result.text == "shared needle"
                && result.destinations.len() == 1
                && result.destinations[0].agent_id == "unrelated"
        }));
    }
}
