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

/// Local research/draft state only. This never changes the external inbox.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FocusInboxItem {
    pub source: String,
    pub item_id: String,
    pub revision: String,
    pub state: String,
    pub summary: String,
    pub conversation_id: Option<String>,
    pub draft: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FocusInboxUpdate {
    #[serde(default)]
    pub items: Vec<FocusInboxItem>,
    #[serde(default)]
    pub checkpoints: std::collections::BTreeMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusInboxSnapshot {
    pub items: Vec<FocusInboxItem>,
    pub checkpoints: std::collections::BTreeMap<String, String>,
}

impl Store {
    pub fn focus_inbox(&self, source: Option<&str>, item: Option<&str>) -> Result<FocusInboxSnapshot> {
        self.read(|c| {
            let mut statement = c.prepare("SELECT data FROM focus_inbox WHERE (?1 IS NULL OR source=?1) AND (?2 IS NULL OR item_id=?2) ORDER BY updated_at DESC,source,item_id LIMIT 100")?;
            let data = statement.query_map(params![source,item], |row| row.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            let items = data.iter().map(|value| serde_json::from_str(value)).collect::<serde_json::Result<_>>()?;
            let mut checkpoints = std::collections::BTreeMap::new();
            for source in ["slack", "outlook"] {
                if let Some(value) = c.query_row("SELECT value FROM kv WHERE key=?1", [format!("focus-inbox-checkpoint:{source}")], |row| row.get::<_,String>(0)).optional()? { checkpoints.insert(source.into(),value); }
            }
            Ok(FocusInboxSnapshot {items,checkpoints})
        })
    }

    pub fn update_focus_inbox(&self, update: &FocusInboxUpdate, at: f64) -> Result<()> {
        let valid_source = |source: &str| matches!(source,"slack"|"outlook");
        anyhow::ensure!(update.items.len() <= 100 && update.checkpoints.len() <= 2, "inbox update too large");
        for (source, checkpoint) in &update.checkpoints {
            anyhow::ensure!(valid_source(source) && !checkpoint.is_empty() && checkpoint.len() <= 2000, "invalid inbox checkpoint");
        }
        for item in &update.items {
            anyhow::ensure!(valid_source(&item.source) && !item.item_id.is_empty() && item.item_id.len() <= 2000 && !item.revision.is_empty() && item.revision.len() <= 2000, "inbox source, stable itemId and revision are required");
            anyhow::ensure!(matches!(item.state.as_str(),"observed"|"investigating"|"drafted"|"resolved"|"no_response_needed"), "invalid inbox state");
            anyhow::ensure!(item.summary.len() <= 4000 && item.draft.as_ref().is_none_or(|draft| draft.len() <= 16000), "inbox text too large");
            if let Some(id) = &item.conversation_id { anyhow::ensure!(self.agent(id)?.is_some(),"inbox conversation must exist in Oxroute"); }
        }
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            for item in &update.items {
                tx.execute("INSERT INTO focus_inbox(source,item_id,data,updated_at) VALUES(?1,?2,?3,?4) ON CONFLICT(source,item_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at WHERE data!=excluded.data", params![item.source,item.item_id,serde_json::to_string(item)?,at])?;
            }
            for (source, checkpoint) in &update.checkpoints {
                tx.execute("INSERT OR REPLACE INTO kv(key,value) VALUES(?1,?2)", params![format!("focus-inbox-checkpoint:{source}"),checkpoint])?;
            }
            tx.commit()?;
            Ok(())
        })
    }

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
            UNION ALL SELECT CAST(value AS REAL) FROM kv WHERE key IN ('focus.last-event-delivery','focus.idle-baseline')
            UNION ALL SELECT CAST(substr(key,12) AS REAL) FROM kv WHERE key GLOB 'focus-wake:*'
        )", [focus], |row| row.get(0))?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inbox_observations_and_local_drafts_survive_restart_and_revisions() {
        let root = std::env::temp_dir().join(crate::model::new_id("focus-inbox"));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("state.sqlite3");
        let mut item = FocusInboxItem { source:"slack".into(), item_id:"thread-one".into(), revision:"reply-one".into(), state:"drafted".into(), summary:"Response requested after context inspection".into(), conversation_id:None, draft:Some("Proposed response, not sent".into()) };
        let mut update = FocusInboxUpdate {items:vec![item.clone()],checkpoints: [("slack".into(),"position-one".into())].into()};
        {
            let store = Store::open(&path).unwrap();
            store.update_focus_inbox(&update,10.0).unwrap();
            store.update_focus_inbox(&update,20.0).unwrap();
            assert_eq!(store.focus_inbox(None,None).unwrap().items,vec![item.clone()]);
            update.items[0].source="external".into();
            assert!(store.update_focus_inbox(&update,30.0).is_err());
        }
        let store = Store::open(&path).unwrap();
        let snapshot = store.focus_inbox(Some("slack"),Some("thread-one")).unwrap();
        assert_eq!(snapshot.items,vec![item.clone()]);
        assert_eq!(snapshot.checkpoints["slack"],"position-one");
        item.revision="reply-two".into();item.state="resolved".into();item.draft=None;
        update.items=vec![item.clone()];update.checkpoints.clear();
        store.update_focus_inbox(&update,40.0).unwrap();
        assert_eq!(store.focus_inbox(None,None).unwrap().items,vec![item]);
        assert!(store.focus_inbox(Some("outlook"),Some("thread-one")).unwrap().items.is_empty());
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }

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
