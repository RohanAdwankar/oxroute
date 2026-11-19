//! Source-grounded response obligations; local drafts never count as replies.
use super::*;
use serde_json::Value;

impl Store {
    pub fn imported_conversations(&self, source: &str, prefix: &str) -> Result<Vec<String>> {
        self.read(|c| {let mut query=c.prepare("SELECT DISTINCT conversation FROM inbox_messages WHERE source=?1 AND substr(conversation,1,length(?2))=?2 ORDER BY conversation")?;let rows=query.query_map(params![source,prefix],|r|r.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?;Ok(rows)})
    }

    pub fn observe_slack_dm(
        &self,
        conversation: &str,
        message: &Value,
        checked: f64,
    ) -> Result<bool> {
        let parts = conversation.split(':').collect::<Vec<_>>();
        anyhow::ensure!(parts.len() == 3, "invalid Slack conversation identity");
        let (owner, channel) = (parts[1], parts[2]);
        let ts = message["ts"]
            .as_str()
            .context("Slack message has no timestamp")?;
        let revision = message["edited"]["ts"].as_str().unwrap_or(ts);
        let activity = revision
            .parse::<f64>()
            .context("invalid Slack revision timestamp")?;
        let at = ts
            .parse::<f64>()
            .context("invalid Slack message timestamp")?;
        anyhow::ensure!(
            at.is_finite() && activity.is_finite(),
            "invalid Slack message time"
        );
        let baseline = self
            .get(&format!(
                "inbox-baseline:{}:{conversation}",
                crate::inbox::SLACK
            ))?
            .map(|s| s.parse::<f64>())
            .transpose()?
            .unwrap_or(checked - 7.0 * 86400.0);
        let thread = message["thread_ts"]
            .as_str()
            .filter(|thread| *thread != ts)
            .unwrap_or("");
        let sender = message["user"].as_str().unwrap_or_default();
        let human = !sender.is_empty()
            && message["bot_id"].is_null()
            && message["bot_profile"].is_null()
            && matches!(
                message["subtype"].as_str(),
                None | Some("file_share" | "thread_broadcast")
            );
        self.with(|c| {
            let tx=c.unchecked_transaction()?;
            let previous_text:Option<String>=tx.query_row("SELECT text FROM slack_inbox_messages WHERE conversation=?1 AND ts=?2",params![conversation,ts],|r|r.get(0)).optional()?;
            let content_same=previous_text.as_deref()==Some(message["text"].as_str().unwrap_or(""));
            let changed=tx.execute("INSERT INTO slack_inbox_messages(conversation,ts,at,revision,activity,thread,sender,human,text,channel,owner) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11) ON CONFLICT(conversation,ts) DO UPDATE SET revision=excluded.revision,activity=excluded.activity,thread=excluded.thread,sender=excluded.sender,human=excluded.human,text=excluded.text WHERE excluded.activity>=slack_inbox_messages.activity AND (excluded.revision!=slack_inbox_messages.revision OR excluded.thread!=slack_inbox_messages.thread OR excluded.sender!=slack_inbox_messages.sender OR excluded.human!=slack_inbox_messages.human OR excluded.text!=slack_inbox_messages.text)",params![conversation,ts,at,revision,activity,thread,sender,human,message["text"].as_str().unwrap_or(""),channel,owner])?;
            if changed==0 {
                let current:f64=tx.query_row("SELECT activity FROM slack_inbox_messages WHERE conversation=?1 AND ts=?2",params![conversation,ts],|r|r.get(0))?;
                return Ok(activity>=current);
            }
            let target=if sender==owner {None}else{Some(ts)};
            let mut query=tx.prepare("SELECT m.ts,m.revision,m.activity,m.text,EXISTS(SELECT 1 FROM slack_inbox_messages r WHERE r.conversation=m.conversation AND r.human=1 AND r.sender=?2 AND r.at>m.activity AND (r.thread=m.thread OR (m.thread='' AND r.thread=m.ts))) FROM slack_inbox_messages m WHERE m.conversation=?1 AND m.human=1 AND m.sender!=?2 AND (?3 IS NULL OR m.ts=?3) AND m.activity>=?4")?;
            let incoming=query.query_map(params![conversation,owner,target,baseline],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,f64>(2)?,r.get::<_,String>(3)?,r.get::<_,bool>(4)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
            drop(query);
            for (ts,revision,activity,text,replied) in incoming {
                let id=format!("{channel}:{ts}");
                let previous:Option<String>=tx.query_row("SELECT data FROM focus_inbox WHERE source='slack' AND item_id=?1",[&id],|r|r.get(0)).optional()?;
                let previous=previous.map(|s|serde_json::from_str::<FocusInboxItem>(&s)).transpose()?;
                let disposition_at=if content_same {previous.as_ref().and_then(|item|item.revision.parse::<f64>().ok()).unwrap_or(activity)}else{activity};
                let dismissed=previous.as_ref().and_then(|i|i.dismissed_by).is_some_and(|entry|tx.query_row("SELECT kind='you' AND at>=?2 FROM entries WHERE id=?1",params![entry,disposition_at],|r|r.get::<_,bool>(0)).unwrap_or(false));
                let mut item=previous.clone().unwrap_or_else(||FocusInboxItem {source:"slack".into(),item_id:id.clone(),revision:revision.clone(),state:"response_needed".into(),summary:String::new(),conversation_id:None,draft:None,dismissed_by:None,resolution_entries:vec![]});
                let same=item.revision==revision||content_same;
                let reviewed_reply=same&&matches!(item.state.as_str(),"resolved"|"no_response_needed")&&(Self::inbox_resolution(&tx,&item)?||Self::dm_obligation(&tx,&id)?.is_some_and(|(_,_,needed)|!needed));
                item.revision=revision;
                if !same {item.resolution_entries.clear();}
                if dismissed&&content_same {if let Some(entry)=item.dismissed_by {if !item.resolution_entries.contains(&entry) {item.resolution_entries.push(entry);}item.dismissed_by=None;}}
                if !dismissed {item.dismissed_by=None;}
                item.state=if dismissed {"no_response_needed".into()}else if reviewed_reply {item.state}else if replied {"resolved".into()}else if same&&matches!(item.state.as_str(),"drafted"|"investigating") {item.state}else{"response_needed".into()};
                if item.summary.is_empty()||!same {item.summary=format!("Incoming direct message: {}",text.chars().take(500).collect::<String>());}
                let data=serde_json::to_string(&item)?;
                if previous.as_ref()!=Some(&item) {tx.execute("INSERT INTO focus_inbox(source,item_id,data,updated_at) VALUES('slack',?1,?2,?3) ON CONFLICT(source,item_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at",params![id,data,checked])?;}
            }
            tx.commit()?;Ok(true)
        })
    }

    pub(super) fn dm_obligation(c: &Connection, id: &str) -> Result<Option<(String, f64, bool)>> {
        let Some((channel, ts)) = id.split_once(':') else {
            return Ok(None);
        };
        Ok(c.query_row("SELECT m.revision,m.activity,NOT EXISTS(SELECT 1 FROM slack_inbox_messages r WHERE r.conversation=m.conversation AND r.human=1 AND r.sender=m.owner AND r.at>m.activity) FROM slack_inbox_messages m WHERE m.channel=?1 AND m.ts=?2 AND m.human=1 AND m.sender!=m.owner",params![channel,ts],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn obligations_require_source_replies_and_reopen_on_edits() -> Result<()> {
        let root = std::env::temp_dir().join(crate::model::new_id("dm-ledger"));
        std::fs::create_dir_all(&root)?;
        let path = root.join("state.sqlite3");
        let store = Store::open(&path)?;
        let conv = "workspace:owner:direct";
        let message = |ts: &str, user: &str, text: &str| json!({"ts":ts,"thread_ts":ts,"user":user,"text":text});
        store.observe_slack_dm(conv, &message("100.1", "sender", "Review requested"), 200.0)?;
        let mut item = store.focus_inbox(None, None)?.items.remove(0);
        assert_eq!(item.state, "response_needed");
        item.state = "drafted".into();
        item.draft = Some("Local response".into());
        let mut update = FocusInboxUpdate {
            items: vec![item.clone()],
            ..Default::default()
        };
        store.update_focus_inbox(&update, 210.0)?;
        update.items[0].state = "resolved".into();
        assert!(store.update_focus_inbox(&update, 211.0).is_err());
        store.observe_slack_dm(conv, &message("100.1", "sender", "Review requested"), 212.0)?;
        assert_eq!(store.focus_inbox(None, None)?.items[0].state, "drafted");
        store.observe_slack_dm(conv, &message("101.0", "another", "Acknowledged"), 213.0)?;
        store.observe_slack_dm(
            conv,
            &json!({"ts":"102.0","user":"owner","bot_id":"mirror","text":"Draft mirror"}),
            214.0,
        )?;
        assert_eq!(
            store
                .focus_inbox(Some("slack"), Some("direct:100.1"))?
                .items[0]
                .state,
            "drafted"
        );
        assert!(store.update_focus_inbox(&update,214.5).is_err(),"Another participant's acknowledgment cannot authorize closure");
        store.observe_slack_dm(
            conv,
            &message("103.0", "owner", "Response delivered"),
            215.0,
        )?;
        assert_eq!(
            store
                .focus_inbox(Some("slack"), Some("direct:100.1"))?
                .items[0]
                .state,
            "resolved"
        );
        let mut edited = message("100.1", "sender", "Revised request");
        edited["edited"] = json!({"ts":"104.0"});
        store.observe_slack_dm(conv, &edited, 216.0)?;
        assert!(!store.observe_slack_dm(
            conv,
            &message("100.1", "sender", "Older indexed content"),
            216.5
        )?);
        let revised = store
            .focus_inbox(Some("slack"), Some("direct:100.1"))?
            .items
            .remove(0);
        assert_eq!(revised.state, "response_needed");
        assert_eq!(revised.draft, item.draft);
        assert_eq!(revised.revision, "104.0");
        drop(store);
        let store = Store::open(&path)?;
        assert_eq!(
            store
                .focus_inbox(Some("slack"), Some("direct:100.1"))?
                .items,
            vec![revised]
        );
        // An unrelated thread reply cannot silently close the main conversation.
        store.observe_slack_dm(
            conv,
            &json!({"ts":"105.0","thread_ts":"other","user":"owner","text":"Thread reply"}),
            217.0,
        )?;
        assert_eq!(
            store
                .focus_inbox(Some("slack"), Some("direct:100.1"))?
                .items[0]
                .state,
            "response_needed"
        );
        let mut reviewed = store
            .focus_inbox(Some("slack"), Some("direct:100.1"))?
            .items
            .remove(0);
        reviewed.state = "resolved".into();
        store.update_focus_inbox(
            &FocusInboxUpdate {
                items: vec![reviewed],
                ..Default::default()
            },
            217.5,
        )?;
        store.observe_slack_dm(conv, &edited, 217.6)?;
        assert_eq!(
            store
                .focus_inbox(Some("slack"), Some("direct:100.1"))?
                .items[0]
                .state,
            "resolved",
            "A reviewed source reply in another thread remains valid"
        );
        let insert_entry = |kind: &str| {
            store.with(|c| {c.execute("INSERT INTO entries(agent_id,at,kind,text) VALUES('coordinator',106,?1,'Dismiss this item')",[kind])?;Ok(c.last_insert_rowid())})
        };
        let mut item = store
            .focus_inbox(Some("slack"), Some("direct:100.1"))?
            .items
            .remove(0);
        item.state = "no_response_needed".into();
        item.dismissed_by = Some(insert_entry("coordination")?);
        assert!(store
            .update_focus_inbox(
                &FocusInboxUpdate {
                    items: vec![item.clone()],
                    ..Default::default()
                },
                218.0
            )
            .is_err());
        item.dismissed_by = Some(insert_entry("you")?);
        store.update_focus_inbox(
            &FocusInboxUpdate {
                items: vec![item],
                ..Default::default()
            },
            219.0,
        )?;
        store.observe_slack_dm(conv, &edited, 220.0)?;
        assert_eq!(
            store
                .focus_inbox(Some("slack"), Some("direct:100.1"))?
                .items[0]
                .state,
            "no_response_needed"
        );
        let mut unchanged=edited.clone();unchanged["edited"]=json!({"ts":"221"});
        store.observe_slack_dm(conv,&unchanged,222.0)?;
        assert_eq!(store.focus_inbox(Some("slack"),Some("direct:100.1"))?.items[0].state,"no_response_needed","Timestamp-only edits preserve human dismissal");
        drop(store);
        std::fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn retained_resolution_survives_collection_until_request_changes() -> Result<()> {
        let root=std::env::temp_dir().join(crate::model::new_id("inbox-resolution"));
        std::fs::create_dir_all(&root)?;
        let store=Store::open(&root.join("state.sqlite3"))?;
        for (index,state) in ["resolved","no_response_needed"].into_iter().enumerate() {
            let conversation=format!("workspace:owner:direct-{index}");
            let original=serde_json::json!({"ts":"100","user":"sender","text":"Conditional request"});
            store.observe_slack_dm(&conversation,&original,200.0)?;
            let id=format!("direct-{index}:100");
            let mut item=store.focus_inbox(Some("slack"),Some(&id))?.items.remove(0);
            let entry=store.with(|c| {c.execute("INSERT INTO entries(agent_id,at,kind,text) VALUES('other-conversation',150,'you','The condition no longer applies')",[])?;Ok(c.last_insert_rowid())})?;
            item.state=state.into();item.resolution_entries=vec![entry];
            store.update_focus_inbox(&FocusInboxUpdate {items:vec![item],..Default::default()},201.0)?;
            store.observe_slack_dm(&conversation,&original,202.0)?;
            let mut revised=original.clone();revised["edited"]=serde_json::json!({"ts":"203"});
            store.observe_slack_dm(&conversation,&revised,204.0)?;
            let retained=store.focus_inbox(Some("slack"),Some(&id))?.items.remove(0);
            assert_eq!(retained.state,state);assert_eq!(retained.resolution_entries,vec![entry]);
            store.update_focus_inbox(&FocusInboxUpdate {items:vec![retained],..Default::default()},204.5)?;
            revised["text"]=serde_json::json!("New requested outcome");revised["edited"]=serde_json::json!({"ts":"205"});
            store.observe_slack_dm(&conversation,&revised,206.0)?;
            let reopened=store.focus_inbox(Some("slack"),Some(&id))?.items.remove(0);
            assert_eq!(reopened.state,"response_needed");assert!(reopened.resolution_entries.is_empty());
            let mut stale=reopened.clone();stale.state=state.into();stale.resolution_entries=vec![entry];
            assert!(store.update_focus_inbox(&FocusInboxUpdate {items:vec![stale],..Default::default()},207.0).is_err(),"An earlier decision cannot close a changed request");
            let coordination=store.with(|c| {c.execute("INSERT INTO entries(agent_id,at,kind,text) VALUES('coordinator',207,'coordination','Delivery accepted')",[])?;Ok(c.last_insert_rowid())})?;
            let mut invalid=reopened;invalid.state=state.into();invalid.resolution_entries=vec![coordination];
            assert!(store.update_focus_inbox(&FocusInboxUpdate {items:vec![invalid],..Default::default()},208.0).is_err());
            let fresh=store.with(|c| {c.execute("INSERT INTO entries(agent_id,at,kind,text) VALUES('source-context',209,?1,'Current source context establishes resolution')",[if index==0 {"you"}else{"said"}])?;Ok(c.last_insert_rowid())})?;
            let mut current=store.focus_inbox(Some("slack"),Some(&id))?.items.remove(0);current.state=state.into();current.resolution_entries=vec![entry,fresh];
            store.update_focus_inbox(&FocusInboxUpdate {items:vec![current],..Default::default()},210.0)?;
            assert_eq!(store.focus_inbox(Some("slack"),Some(&id))?.items[0].state,state,"Fresh evidence can reconcile retained historical context");
        }
        drop(store);std::fs::remove_dir_all(root)?;Ok(())
    }

    #[test]
    fn historical_context_is_not_replayed_but_late_edits_and_replies_are_obligations() -> Result<()>
    {
        let root = std::env::temp_dir().join(crate::model::new_id("dm-baseline"));
        std::fs::create_dir_all(&root)?;
        let store = Store::open(&root.join("state.sqlite3"))?;
        let conv = "workspace:owner:direct";
        store.set("inbox-baseline:slack-inbox:workspace:owner:direct", "90")?;
        store.observe_slack_dm(
            conv,
            &json!({"ts":"80","user":"sender","text":"Historical context"}),
            200.0,
        )?;
        assert_eq!(store.focus_inbox(None, None)?.total, 0);
        store.observe_slack_dm(
            conv,
            &json!({"ts":"80","user":"sender","edited":{"ts":"100"},"text":"Updated request"}),
            201.0,
        )?;
        assert_eq!(
            store.focus_inbox(None, None)?.items[0].state,
            "response_needed"
        );
        store.observe_slack_dm(
            conv,
            &json!({"ts":"110","user":"owner","thread_ts":"80","text":"Source reply"}),
            202.0,
        )?;
        assert_eq!(store.focus_inbox(None, None)?.items[0].state, "resolved");
        store.observe_slack_dm(
            conv,
            &json!({"ts":"120","user":"sender","thread_ts":"80","text":"New follow-up"}),
            203.0,
        )?;
        assert_eq!(store.focus_inbox(None, None)?.pending_count, 1);
        drop(store);
        std::fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn cached_history_stays_available_without_creating_new_work() -> Result<()> {
        let root = std::env::temp_dir().join(crate::model::new_id("inbox-context"));
        std::fs::create_dir_all(&root)?;
        let store = Store::open(&root.join("state.sqlite3"))?;
        let mut signal = Signal {
            id: crate::model::new_id("sig"),
            source: crate::inbox::SLACK.into(),
            conversation: "workspace:owner:direct".into(),
            thread_key: "conversation".into(),
            external_id: "80".into(),
            author: "sender".into(),
            label: "Direct conversation".into(),
            text: "Earlier source context".into(),
            attachments: vec![],
            at: 80.0,
            root: true,
        };
        store.cache_inbox_context(&signal)?;
        assert!(store.inbox(10)?.is_empty());
        signal.external_id = "100".into();
        signal.text = "New source follow-up".into();
        signal.at = 100.0;
        store.import_inbox(&signal, "https://example.invalid/source")?;
        let items = store.inbox(10)?;
        assert_eq!(items.len(), 1);
        assert!(
            items[0].signal.text.contains("Earlier source context")
                && items[0].signal.text.contains("New source follow-up")
        );
        drop(store);
        std::fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn observations_expose_pagination_and_never_certify_source_coverage() -> Result<()> {
        let root = std::env::temp_dir().join(crate::model::new_id("inbox-pages"));
        std::fs::create_dir_all(&root)?;
        let store = Store::open(&root.join("state.sqlite3"))?;
        for part in 0..3 {
            let update = FocusInboxUpdate {
                items: (0..45)
                    .map(|n| FocusInboxItem {
                        source: "slack".into(),
                        item_id: format!("item-{}", part * 45 + n),
                        revision: "version".into(),
                        state: "response_needed".into(),
                        summary: String::new(),
                        conversation_id: None,
                        draft: None,
                        dismissed_by: None,
            resolution_entries: vec![],
                    })
                    .collect(),
                ..Default::default()
            };
            store.update_focus_inbox(&update, part as f64)?;
        }
        let first = store.focus_inbox(None, None)?;
        assert_eq!(first.total, 135);
        assert_eq!(first.items.len(), 100);
        assert_eq!(first.next_offset, Some(100));
        assert!(first.coverage.is_empty());
        let rest = store.focus_inbox_page(None, None, 100)?;
        assert_eq!(rest.items.len(), 35);
        assert!(rest.next_offset.is_none());
        let ids = first
            .items
            .into_iter()
            .chain(rest.items)
            .map(|i| i.item_id)
            .collect::<HashSet<_>>();
        assert_eq!(ids.len(), 135);
        drop(store);
        std::fs::remove_dir_all(root)?;
        Ok(())
    }
}
