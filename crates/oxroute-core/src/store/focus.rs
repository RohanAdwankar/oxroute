use super::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusTurnEvent {
    pub id: String,
    pub agent_id: String,
    pub outcome: String,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub intake:Option<super::IntakeArrival>,
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
    #[serde(default, skip_serializing_if="Option::is_none")]
    pub dismissed_by: Option<i64>,
    #[serde(default, skip_serializing_if="Vec::is_empty")]
    pub resolution_entries: Vec<i64>,
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
    pub coverage: std::collections::BTreeMap<String, serde_json::Value>,
    pub checkpoint_meaning: &'static str,
    pub total: usize,
    pub pending_count:usize,
    pub next_offset: Option<usize>,
}

impl Store {
    pub(super) fn inbox_resolution(c:&Connection,item:&FocusInboxItem)->Result<bool> {
        anyhow::ensure!(item.resolution_entries.len()<=20,"too many inbox evidence entries");
        for entry in &item.resolution_entries {
            let valid=c.query_row("SELECT kind IN ('you','said') AND length(text)>0 FROM entries WHERE id=?1",[entry],|r|r.get::<_,bool>(0)).optional()?.unwrap_or(false);
            anyhow::ensure!(valid,"resolution requires retained human or result evidence; internal receipts are not authority");
        }
        Ok(!item.resolution_entries.is_empty())
    }

    pub fn focus_inbox(&self, source: Option<&str>, item: Option<&str>) -> Result<FocusInboxSnapshot> {
        self.focus_inbox_page(source,item,0)
    }

    pub fn focus_inbox_page(&self, source:Option<&str>, item:Option<&str>, offset:usize)->Result<FocusInboxSnapshot> {
        anyhow::ensure!(offset<=i64::MAX as usize,"inbox offset too large");
        self.read(|c| {
            let total:usize=c.query_row("SELECT count(*) FROM focus_inbox WHERE (?1 IS NULL OR source=?1) AND (?2 IS NULL OR item_id=?2)",params![source,item],|r|r.get(0))?;
            let pending_count:usize=c.query_row("SELECT count(*) FROM focus_inbox WHERE (?1 IS NULL OR source=?1) AND (?2 IS NULL OR item_id=?2) AND json_extract(data,'$.state') IN ('observed','response_needed','investigating','drafted')",params![source,item],|r|r.get(0))?;
            let mut statement = c.prepare("SELECT data FROM focus_inbox WHERE (?1 IS NULL OR source=?1) AND (?2 IS NULL OR item_id=?2) ORDER BY (json_extract(data,'$.state') IN ('observed','response_needed','investigating','drafted')) DESC,updated_at DESC,source,item_id LIMIT 100 OFFSET ?3")?;
            let data = statement.query_map(params![source,item,offset as i64], |row| row.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            let items = data.iter().map(|value| serde_json::from_str(value)).collect::<serde_json::Result<_>>()?;
            let mut checkpoints = std::collections::BTreeMap::new();
            for source in ["slack", "outlook"] {
                if let Some(value) = c.query_row("SELECT value FROM kv WHERE key=?1", [format!("focus-inbox-checkpoint:{source}")], |row| row.get::<_,String>(0)).optional()? { checkpoints.insert(source.into(),value); }
            }
            let mut coverage=std::collections::BTreeMap::new();
            for name in ["slack","outlook"] {
                if let Some(value)=c.query_row("SELECT value FROM kv WHERE key=?1",[format!("inbox-coverage:{name}")],|r|r.get::<_,String>(0)).optional()? {coverage.insert(name.into(),serde_json::from_str(&value)?);}
            }
            Ok(FocusInboxSnapshot {items,checkpoints,coverage,total,pending_count,next_offset:(offset.saturating_add(100)<total).then_some(offset.saturating_add(100)),checkpoint_meaning:"Manual observations only; not proof of source collection coverage"})
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
            anyhow::ensure!(matches!(item.state.as_str(),"observed"|"response_needed"|"investigating"|"drafted"|"resolved"|"no_response_needed"), "invalid inbox state");
            anyhow::ensure!(item.summary.len() <= 4000 && item.draft.as_ref().is_none_or(|draft| draft.len() <= 16000), "inbox text too large");
            if let Some(id) = &item.conversation_id { anyhow::ensure!(self.agent(id)?.is_some(),"inbox conversation must exist in Oxroute"); }
        }
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            for item in &update.items {
                let obligation=if item.source=="slack" {Self::dm_obligation(&tx,&item.item_id)?}else{None};
                let reviewed=Self::inbox_resolution(&tx,item)?;
                let mut dismissed=false;
                if let Some(entry)=item.dismissed_by {
                    dismissed=tx.query_row("SELECT kind='you' AND at>=?2 FROM entries WHERE id=?1",params![entry,obligation.as_ref().map(|v|v.1).unwrap_or(0.0)],|r|r.get::<_,bool>(0)).optional()?.unwrap_or(false);
                    anyhow::ensure!(dismissed,"dismissal requires an actual human entry after this message revision");
                }
                if let Some((revision,activity,needed))=obligation {
                    anyhow::ensure!(item.revision==revision,"DM observation is stale; reread current source state");
                    if needed&&!dismissed&&reviewed&&matches!(item.state.as_str(),"resolved"|"no_response_needed") {
                        let previous:Option<String>=tx.query_row("SELECT data FROM focus_inbox WHERE source=?1 AND item_id=?2",params![item.source,item.item_id],|r|r.get(0)).optional()?;
                        let previous=previous.map(|s|serde_json::from_str::<FocusInboxItem>(&s)).transpose()?;
                        let mut grounded=previous.as_ref().is_some_and(|old|old.revision==item.revision&&matches!(old.state.as_str(),"resolved"|"no_response_needed")&&old.resolution_entries.iter().any(|entry|item.resolution_entries.contains(entry)));
                        for entry in &item.resolution_entries {
                            grounded|=tx.query_row("SELECT at>=?2 FROM entries WHERE id=?1",params![entry,activity],|r|r.get::<_,bool>(0))?;
                        }
                        anyhow::ensure!(grounded,"a changed request requires fresh resolution evidence");
                    }
                    anyhow::ensure!(!needed||dismissed||reviewed||!matches!(item.state.as_str(),"resolved"|"no_response_needed"),"incoming human DM needs fresh source reply/resolution evidence or explicit human dismissal; drafts do not resolve it");
                }
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

    fn suppress_ineligible_intake(&self)->Result<()> {
        self.with(|c|{c.execute("INSERT OR IGNORE INTO suppressed_intake_events SELECT e.id,'Source event is context only or already dismissed' FROM focus_turn_events e WHERE e.outcome='intake' AND json_extract(e.payload,'$.source')='slack-inbox' AND NOT EXISTS(SELECT 1 FROM inbox_arrivals a JOIN signals s ON s.id=a.signal_id WHERE s.id=json_extract(e.payload,'$.signalId') AND a.dismissed_by IS NULL AND s.state='waiting')",[])?;Ok(())})
    }

    pub fn pending_focus_events(&self, focus: &str) -> Result<bool> {
        self.suppress_ineligible_intake()?;
        self.read(|c| Ok(c.query_row("SELECT EXISTS(SELECT 1 FROM focus_turn_events e WHERE focus_id=?1 AND NOT EXISTS(SELECT 1 FROM suppressed_intake_events WHERE id=e.id) AND NOT EXISTS(SELECT 1 FROM kv WHERE key=e.receipt))", [focus], |row| row.get(0))?))
    }

    /// A retry retains its receipt and coalesces any events not yet accepted by the harness.
    pub fn claim_focus_events(&self, focus: &str) -> Result<Option<FocusEventBatch>> {
        self.suppress_ineligible_intake()?;
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            let receipt: Option<String> = tx.query_row("SELECT receipt FROM focus_turn_events e WHERE focus_id=?1 AND NOT EXISTS(SELECT 1 FROM suppressed_intake_events WHERE id=e.id) AND receipt IS NOT NULL AND NOT EXISTS(SELECT 1 FROM kv WHERE key=e.receipt) ORDER BY at,id LIMIT 1", [focus], |row| row.get(0)).optional()?;
            let receipt = receipt.unwrap_or_else(|| crate::model::new_id("focus-event-batch"));
            tx.execute("UPDATE focus_turn_events SET receipt=?2 WHERE focus_id=?1 AND receipt IS NULL", params![focus, receipt])?;
            let events = {
                let mut statement = tx.prepare("SELECT id,agent_id,outcome,at,payload FROM focus_turn_events e WHERE receipt=?1 AND NOT EXISTS(SELECT 1 FROM suppressed_intake_events WHERE id=e.id) ORDER BY at,id")?;
                let rows = statement.query_map([&receipt], |row| Ok(FocusTurnEvent {id: row.get(0)?, agent_id: row.get(1)?, outcome: row.get(2)?, at: row.get(3)?,intake:row.get::<_,Option<String>>(4)?.map(|value|serde_json::from_str(&value).map_err(|error|rusqlite::Error::FromSqlConversionFailure(4,rusqlite::types::Type::Text,Box::new(error)))).transpose()?}))?;
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
            UNION ALL SELECT at FROM entries WHERE agent_id=?1 AND kind='you'
            UNION ALL SELECT CAST(value AS REAL) FROM kv WHERE key IN ('focus.last-event-delivery','focus.idle-baseline')
            UNION ALL SELECT CAST(substr(key,12) AS REAL) FROM kv WHERE key GLOB 'focus-wake:*'
        )", [focus], |row| row.get(0))?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn talking_to_focus_counts_as_activity() {
        let root=std::env::temp_dir().join(crate::model::new_id("focus-activity"));
        std::fs::create_dir_all(&root).unwrap();
        let store=Store::open(&root.join("state.sqlite3")).unwrap();
        assert_eq!(store.last_focus_activity("focus").unwrap(),None);
        store.add_entry("focus",5.0,EntryKind::You,"hello","","").unwrap();
        store.add_entry("other",9.0,EntryKind::You,"unrelated","","").unwrap();
        store.add_entry("focus",7.0,EntryKind::Said,"reply","","").unwrap();
        assert_eq!(store.last_focus_activity("focus").unwrap(),Some(5.0));
        drop(store);std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn coordination_origin_survives_retries_and_restart() {
        let root=std::env::temp_dir().join(crate::model::new_id("coordination"));
        std::fs::create_dir_all(&root).unwrap();let path=root.join("state.sqlite3");
        {
            let store=Store::open(&path).unwrap();
            let entry=store.enqueue_focus_message("request","source","recipient","Evidence ready",false,None).unwrap().unwrap();
            assert_eq!(entry.kind,EntryKind::Coordination);assert_eq!(entry.origin,"source");
            assert_eq!(store.last_human_entry("recipient").unwrap(),0);
        }
        let store=Store::open(&path).unwrap();
        assert!(store.enqueue_focus_message("request","source","recipient","Evidence ready",false,None).unwrap().is_none());
        assert!(store.enqueue_focus_message("request","another-source","recipient","Evidence ready",false,None).is_err());
        let entries=store.timeline("recipient",100).unwrap();assert_eq!(entries.len(),1);
        assert_eq!(entries[0].kind,EntryKind::Coordination);assert_eq!(entries[0].origin,"source");assert_eq!(entries[0].request_id,"request");
        assert!(!store.has_human_message("recipient").unwrap());
        drop(store);std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn queued_context_preserves_user_versions_across_delays_and_restart() {
        let root=std::env::temp_dir().join(crate::model::new_id("queue-context"));
        std::fs::create_dir_all(&root).unwrap();let path=root.join("state.sqlite3");
        let (source,target,queued,new_target,new_source);
        {
            let store=Store::open(&path).unwrap();
            source=store.add_entry("source",1.0,EntryKind::You,"Prepare the requested outcome","","").unwrap().id;
            target=store.add_entry("recipient",2.0,EntryKind::Received,"Use the accepted scope","","").unwrap().id;
            queued=store.enqueue_focus_message("receipt","source","recipient","Recorded evidence",false,None).unwrap().unwrap().id;
            new_target=store.add_entry("recipient",3.0,EntryKind::You,"Revise the requested outcome","","").unwrap().id;
            new_source=store.add_entry("source",4.0,EntryKind::You,"Apply the current authorization","","").unwrap().id;
        }
        let store=Store::open(&path).unwrap();
        let context=store.focus_message_context("receipt").unwrap().unwrap();
        assert_eq!(context["queuedEntryId"],queued);
        assert_eq!(context["source"]["humanEntryAtQueue"],source);
        assert_eq!(context["source"]["humanEntryNow"],new_source);
        assert_eq!(context["recipient"]["humanEntryAtQueue"],target);
        assert_eq!(context["recipient"]["humanEntryNow"],new_target);
        assert_eq!(context["source"]["humanContextAdvanced"],true);
        assert_eq!(context["recipient"]["humanContextAdvanced"],true);
        assert_eq!(context["authority"],"internal_context_only");
        assert!(store.enqueue_focus_message("receipt","source","recipient","Recorded evidence",false,None).unwrap().is_none());
        store.finish_focus_message("receipt").unwrap();
        assert_eq!(store.focus_message_context("receipt").unwrap().unwrap(),context);
        assert_eq!(store.last_human_entry("recipient").unwrap(),new_target);
        assert_eq!(store.timeline("recipient",100).unwrap().len(),3);
        assert!(store.focus_message_context("unrecorded").unwrap().is_none());
        drop(store);std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn inbox_observations_and_local_drafts_survive_restart_and_revisions() {
        let root = std::env::temp_dir().join(crate::model::new_id("focus-inbox"));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("state.sqlite3");
        let mut item = FocusInboxItem { source:"slack".into(), item_id:"thread-one".into(), revision:"reply-one".into(), state:"drafted".into(), summary:"Response requested after context inspection".into(), conversation_id:None, dismissed_by:None, resolution_entries:vec![], draft:Some("Proposed response, not sent".into()) };
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

#[cfg(test)]
mod steering_receipts {
    use super::*;
    #[test]
    fn old_queues_and_uncertain_attempts_survive_reopening() -> Result<()> {
        let root=std::env::temp_dir().join(crate::model::new_id("steering-store"));std::fs::create_dir_all(&root)?;
        let path=root.join("state.sqlite3");
        {let c=rusqlite::Connection::open(&path)?;c.execute_batch("CREATE TABLE focus_messages(id TEXT PRIMARY KEY,sender TEXT NOT NULL,target TEXT NOT NULL,text TEXT NOT NULL,accepted INTEGER NOT NULL DEFAULT 0); INSERT INTO focus_messages(id,sender,target,text) VALUES('existing','source','target','Routine context');")?;}
        let store=Store::open(&path)?;assert!(!store.pending_focus_messages()?[0].urgent);
        store.enqueue_focus_message("new","source","target","Current correction",true,None)?;
        assert!(store.begin_focus_steering("new","session","turn")?);
        assert!(!store.begin_focus_steering("new","session","turn")?);drop(store);
        let store=Store::open(&path)?;assert_eq!(store.focus_message_delivery("new")?["state"],"unconfirmed");
        assert!(!store.begin_focus_steering("new","session","turn")?);
        assert!(store.enqueue_focus_message("new","source","target","Current correction",false,None).is_err(),"Retry modes cannot silently change intent");
        store.confirm_focus_steering("new")?;drop(store);
        let store=Store::open(&path)?;assert_eq!(store.focus_message_delivery("new")?["state"],"steered");
        assert_eq!(store.pending_focus_messages()?.len(),1);assert_eq!(store.pending_focus_messages()?[0].id,"existing");
        drop(store);std::fs::remove_dir_all(root)?;Ok(())
    }
}
