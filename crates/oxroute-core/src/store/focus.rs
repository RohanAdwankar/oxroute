use super::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusTurnEvent {
    pub id: String,
    pub agent_id: String,
    pub outcome: String,
    pub at: f64,
}

pub struct FocusEventBatch {
    pub receipt: String,
    pub events: Vec<FocusTurnEvent>,
}

impl Store {
    /// Turn identity is the persisted artifact directory, including across recovery.
    /// Settlement and outbox insertion commit together; old timeline entries are never scanned.
    pub fn finish_focus_turn(&self, agent: &str, turn: &str, outcome: &str, at: f64, settled: bool) -> Result<bool> {
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            if settled {
                tx.execute("DELETE FROM active_turns WHERE agent_id=?1 AND artifact_dir=?2", params![agent, turn])?;
            }
            let focus: Option<String> = tx.query_row("SELECT value FROM kv WHERE key='focus.agent'", [], |row| row.get(0)).optional()?;
            let inserted = if let Some(focus) = focus.filter(|focus| focus != agent) {
                tx.execute("INSERT OR IGNORE INTO focus_turn_events(id,focus_id,agent_id,outcome,at) VALUES(?1,?2,?3,?4,?5)", params![turn, focus, agent, outcome, at])? > 0
            } else { false };
            tx.commit()?;
            Ok(inserted)
        })
    }

    pub fn pending_focus_events(&self, focus: &str) -> Result<bool> {
        self.read(|c| Ok(c.query_row("SELECT EXISTS(SELECT 1 FROM focus_turn_events e WHERE focus_id=?1 AND NOT EXISTS(SELECT 1 FROM kv WHERE key=e.receipt))", [focus], |row| row.get(0))?))
    }

    /// A retry retains its receipt and coalesces any events not yet accepted by the harness.
    pub fn claim_focus_events(&self, focus: &str) -> Result<Option<FocusEventBatch>> {
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            let receipt: Option<String> = tx.query_row("SELECT receipt FROM focus_turn_events e WHERE focus_id=?1 AND receipt IS NOT NULL AND NOT EXISTS(SELECT 1 FROM kv WHERE key=e.receipt) ORDER BY at,id LIMIT 1", [focus], |row| row.get(0)).optional()?;
            let receipt = receipt.unwrap_or_else(|| crate::model::new_id("focus-event-batch"));
            tx.execute("UPDATE focus_turn_events SET receipt=?2 WHERE focus_id=?1 AND receipt IS NULL", params![focus, receipt])?;
            let events = {
                let mut statement = tx.prepare("SELECT id,agent_id,outcome,at FROM focus_turn_events WHERE receipt=?1 ORDER BY at,id")?;
                let rows = statement.query_map([&receipt], |row| Ok(FocusTurnEvent {id: row.get(0)?, agent_id: row.get(1)?, outcome: row.get(2)?, at: row.get(3)?}))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            tx.commit()?;
            Ok((!events.is_empty()).then_some(FocusEventBatch {receipt, events}))
        })
    }

    /// Harness acceptance and event acknowledgement are one transaction.
    pub fn accept_turn_receipt(&self, receipt: &str, at: f64) -> Result<()> {
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            tx.execute("INSERT OR REPLACE INTO kv(key,value) VALUES(?1,'delivered')", [receipt])?;
            let event_batch: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM focus_turn_events WHERE receipt=?1)", [receipt], |row| row.get(0))?;
            if event_batch {
                tx.execute("INSERT INTO kv(key,value) VALUES('focus.last-event-delivery',?1) ON CONFLICT(key) DO UPDATE SET value=CAST(MAX(CAST(value AS REAL),?1) AS TEXT)", [at])?;
            }
            tx.commit()?;
            Ok(())
        })
    }

    pub fn last_focus_activity(&self, focus: &str) -> Result<Option<f64>> {
        self.read(|c| Ok(c.query_row("SELECT MAX(at) FROM (
            SELECT at FROM focus_turn_events WHERE focus_id=?1
            UNION ALL SELECT CAST(value AS REAL) FROM kv WHERE key='focus.last-event-delivery'
            UNION ALL SELECT CAST(substr(key,12) AS REAL) FROM kv WHERE key GLOB 'focus-wake:*'
        )", [focus], |row| row.get(0))?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_outbox_keeps_identity_and_acceptance_across_restart() {
        let root = std::env::temp_dir().join(crate::model::new_id("focus-events"));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("state.sqlite3");
        let receipt;
        {
            let store = Store::open(&path).unwrap();
            assert!(!store.finish_focus_turn("worker", "earlier-turn", "completed", 10.0, true).unwrap());
            store.set("focus.agent", "coordinator").unwrap();
            assert!(!store.pending_focus_events("coordinator").unwrap());
            store.save_active_turn(&super::super::ActiveTurn {
                agent_id: "worker".into(), session_id: "session".into(), turn_id: "native-turn".into(),
                artifact_dir: "current-turn".into(), target: None,
            }).unwrap();
            assert!(store.finish_focus_turn("worker", "current-turn", "stopped", 100.0, false).unwrap());
            assert_eq!(store.active_turns().unwrap().len(), 1, "A stop request retains recoverable active state");
            assert!(!store.finish_focus_turn("worker", "current-turn", "stopped", 900.0, true).unwrap());
            assert!(store.active_turns().unwrap().is_empty());
            assert_eq!(store.last_focus_activity("coordinator").unwrap(), Some(100.0), "Duplicate completion does not postpone inactivity");
            assert!(!store.finish_focus_turn("coordinator", "self-turn", "completed", 950.0, true).unwrap());
            receipt = store.claim_focus_events("coordinator").unwrap().unwrap().receipt;
        }
        {
            let store = Store::open(&path).unwrap();
            let batch = store.claim_focus_events("coordinator").unwrap().unwrap();
            assert_eq!(batch.receipt, receipt);
            assert_eq!(batch.events.len(), 1);
            assert_eq!(batch.events[0].outcome, "stopped");
            store.accept_turn_receipt(&receipt, 1000.0).unwrap();
            assert!(!store.pending_focus_events("coordinator").unwrap());
            assert_eq!(store.last_focus_activity("coordinator").unwrap(), Some(1000.0));
        }
        let store = Store::open(&path).unwrap();
        assert!(!store.pending_focus_events("coordinator").unwrap());
        assert!(!store.finish_focus_turn("worker", "current-turn", "stopped", 2000.0, true).unwrap());
        assert!(store.finish_focus_turn("worker", "next-turn", "failed", 2100.0, true).unwrap());
        let batch = store.claim_focus_events("coordinator").unwrap().unwrap();
        assert_ne!(batch.receipt, receipt);
        assert_eq!(batch.events.len(), 1);
        assert_eq!(batch.events[0].id, "next-turn");
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
}
