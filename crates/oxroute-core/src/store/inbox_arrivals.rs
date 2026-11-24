use super::*;

impl Store {
    /// Persist once, including when deployment follows the originating source-time decision.
    pub fn slack_arrival_cutoff(&self,configured:Option<f64>)->Result<f64> {
        self.with(|c|{
            if let Some(at)=configured {anyhow::ensure!(at.is_finite()&&at>0.0,"invalid Slack arrival cutoff");}
            let saved:Option<String>=c.query_row("SELECT value FROM kv WHERE key='inbox-slack-arrivals-since'",[],|r|r.get(0)).optional()?;
            let previous=saved.map(|value|value.parse::<f64>()).transpose()?;
            let at=configured.or(previous).unwrap_or_else(crate::model::now);
            if previous==Some(at) {return Ok(at);}
            c.execute("INSERT INTO kv(key,value) VALUES('inbox-slack-arrivals-since',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[at.to_string()])?;Ok(at)
        })
    }

    pub(crate) fn recover_cached_arrivals(&self,account:&str,cutoff:f64)->Result<()> {
        let key=format!("inbox-admission-recovered:{account}:{cutoff}");
        if self.get(&key)?.is_some() {return Ok(());}
        let signals=self.read(|c|{
            let mut query=c.prepare("SELECT source,conversation,external_id,thread_key,author,text,at FROM inbox_messages WHERE source='slack-inbox' AND substr(conversation,1,length(?1))=?1 AND at>?2 ORDER BY at,external_id")?;
            let rows=query.query_map(params![account,cutoff],|r|Ok(Signal{id:crate::model::new_id("sig"),source:r.get(0)?,conversation:r.get(1)?,external_id:r.get(2)?,thread_key:r.get(3)?,author:r.get(4)?,text:r.get(5)?,at:r.get(6)?,label:String::new(),attachments:vec![],root:false}))?.collect::<rusqlite::Result<Vec<_>>>()?;Ok(rows)
        })?;
        for mut signal in signals {
            signal.label=self.inbox_label(&signal.source,&signal.conversation)?.unwrap_or_default();
            let channel=signal.conversation.split(':').nth(2).context("invalid Slack source identity")?;
            let url=format!("https://app.slack.com/archives/{channel}/p{}",signal.external_id.replace('.',""));
            self.import_inbox(&signal,&url)?;
        }
        self.set(&key,"complete")
    }

    pub(super) fn advance_arrival(c:&Connection,id:&str,message:&str)->Result<()> {
        c.execute("DELETE FROM inbox_arrivals WHERE signal_id=?1",[id])?;
        c.execute("INSERT INTO inbox_arrivals(signal_id,message_id) VALUES(?1,?2)",params![id,message])?;Ok(())
    }

    // A Slack row represents one admitted source message, never a refreshed history aggregate.
    pub(super) fn import_slack_arrival(tx:rusqlite::Transaction<'_>,signal:&Signal,url:&str)->Result<Option<String>> {
        Self::put_inbox_context(&tx,signal)?;
        let cutoff:Option<String>=tx.query_row("SELECT value FROM kv WHERE key='inbox-slack-arrivals-since'",[],|r|r.get(0)).optional()?;
        let cutoff=cutoff.map(|cutoff|cutoff.parse::<f64>()).transpose()?;
        let parts=signal.conversation.split(':').collect::<Vec<_>>();
        let [team,owner,channel]=parts.as_slice() else {anyhow::bail!("invalid Slack account identity")};
        anyhow::ensure!(!owner.is_empty()&&signal.at.is_finite(),"invalid Slack source metadata");
        let dm=tx.query_row("SELECT EXISTS(SELECT 1 FROM kv WHERE key=?1)",[format!("inbox-dm:{team}:{channel}")],|r|r.get::<_,bool>(0))?;
        if cutoff.is_some_and(|cutoff|signal.at<=cutoff) || signal.author==*owner || (!dm&&!signal.text.contains(&format!("<@{owner}>"))) {tx.commit()?;return Ok(None);}

        let existing:Option<String>=tx.query_row("SELECT id FROM signals WHERE source=?1 AND conversation=?2 AND external_id=?3",params![signal.source,signal.conversation,signal.external_id],|r|r.get(0)).optional()?;
        let id=existing.clone().unwrap_or_else(||signal.id.clone());
        let admitted=tx.query_row("SELECT EXISTS(SELECT 1 FROM inbox_arrivals WHERE signal_id=?1)",[&id],|r|r.get::<_,bool>(0))?;
        let changed=tx.execute("INSERT INTO signals(id,source,conversation,thread_key,external_id,author,label,text,at,root) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(id) DO UPDATE SET text=excluded.text,label=excluded.label,at=excluded.at,revision=signals.revision+1 WHERE text!=excluded.text OR label!=excluded.label",params![id,signal.source,signal.conversation,signal.thread_key,signal.external_id,signal.author,signal.label,signal.text,signal.at,signal.root])?;
        if !admitted {Self::advance_arrival(&tx,&id,&signal.external_id)?;}
        if changed>0 {tx.execute("DELETE FROM kv WHERE key=?1",[format!("routing-advice:{id}")])?;}
        tx.execute("INSERT INTO kv(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![format!("inbox-url:{id}"),url])?;
        tx.execute("UPDATE focus_turn_events SET payload=json_set(payload,'$.signalId',?1) WHERE outcome='intake' AND json_extract(payload,'$.source')=?2 AND json_extract(payload,'$.itemId')=?3 AND NOT EXISTS(SELECT 1 FROM kv WHERE key=focus_turn_events.receipt) AND EXISTS(SELECT 1 FROM signals old WHERE old.id=json_extract(payload,'$.signalId') AND old.conversation=?4)",params![id,signal.source,signal.external_id,signal.conversation])?;
        tx.commit()?;Ok((!admitted).then_some(id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn admission_uses_source_time_and_preserves_context_across_restart()->Result<()> {
        for (account,owner,peer) in [("provider-one","reader-a","author-a"),("provider-two","reader-b","author-b")] {
            let root=std::env::temp_dir().join(crate::model::new_id("arrivals"));std::fs::create_dir_all(&root)?;let path=root.join("state.sqlite3");
            let store=Store::open(&path)?;assert_eq!(store.slack_arrival_cutoff(Some(100.0))?,100.0);
            for channel in ["direct","group"] {store.set(&format!("inbox-dm:{account}:{channel}"),"1")?;}
            let message=|channel:&str,id:&str,author:&str,at:f64,text:&str|Signal{id:format!("row-{channel}-{id}"),source:crate::inbox::SLACK.into(),conversation:format!("{account}:{owner}:{channel}"),thread_key:"conversation".into(),external_id:id.into(),author:author.into(),label:"Source conversation".into(),text:text.into(),attachments:vec![],at,root:true};
            let old=message("direct","old",peer,90.0,"Earlier request context");store.import_inbox(&old,"")?;
            let mut edited=old.clone();edited.text="Revised old context".into();store.import_inbox(&edited,"")?;
            let incoming=message("direct","new",peer,101.0,"Current incoming request");store.import_inbox(&incoming,"https://example.invalid/source")?;
            let before=store.inbox_version(&incoming.id)?.unwrap();
            let own=message("direct","reply",owner,102.0,"Own reply context");store.import_inbox(&own,"")?;
            let mut own_edit=own.clone();own_edit.text="Own unrelated follow-up".into();store.import_inbox(&own_edit,"")?;
            let after=store.inbox_version(&incoming.id)?.unwrap();assert_eq!(serde_json::to_value(&before.0.signal)?,serde_json::to_value(&after.0.signal)?);assert_eq!(before.1,after.1);
            let preview=after.0.display.unwrap().preview;assert!(preview.contains("Current incoming request")&&!preview.contains(peer),"Unavailable names use an honest role instead of opaque provider IDs");
            store.import_inbox(&message("channel","chatter",peer,103.0,"Ordinary channel discussion"),"")?;
            store.import_inbox(&message("channel","other",peer,104.0,"<@different-reader> Requested context"),"")?;
            let mention=message("channel","targeted",peer,105.0,&format!("<@{owner}> Requested follow-up"));store.import_inbox(&mention,"")?;
            store.import_inbox(&message("group","group-new",peer,106.0,"Incoming group request"),"")?;
            assert_eq!(store.inbox(100)?.len(),3);
            store.resolve_signal(&incoming.id,"discarded",&[])?;
            drop(store);let store=Store::open(&path)?;assert_eq!(store.slack_arrival_cutoff(None)?,100.0,"Restart does not move source admission time");
            store.import_inbox(&old,"")?;store.import_inbox(&own,"")?;store.import_inbox(&incoming,"")?;
            assert_eq!(store.inbox_item(&incoming.id)?.unwrap().state,InboxState::Done,"History/edit replay cannot reopen a settled message");
            let recovered=message("direct","outage",peer,107.0,"Missed incoming source request");store.import_inbox(&recovered,"")?;store.import_inbox(&recovered,"")?;
            let later=message("direct","later",peer,108.0,"Fresh incoming request");store.import_inbox(&later,"")?;
            assert_eq!(store.inbox(100)?.len(),5);assert_eq!(store.inbox(100)?.iter().filter(|item|item.state==InboxState::Waiting).count(),4);
            assert!(store.routing_text(&incoming,10000)?.contains("Revised old context")||store.routing_text(&incoming,10000)?.contains("Earlier request context"));
            assert!(store.routing_text(&incoming,10000)?.contains("Own reply context"));
            drop(store);std::fs::remove_dir_all(root)?;
        }Ok(())
    }
}
