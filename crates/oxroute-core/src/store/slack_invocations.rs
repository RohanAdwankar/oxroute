use super::*;

impl Store {
    /// Repair only provisional titles proven to contain the old adapter's added marker.
    pub fn repair_slack_invocation_titles(&self,account:&serde_json::Value)->Result<usize> {
        let team=account["account"].as_str().filter(|s|!s.is_empty()).context("Slack workspace identity is required")?;
        let owner=account["owner"].as_str().filter(|s|!s.is_empty()).context("Slack owner identity is required")?;
        self.with(|c|{
            let tx=c.unchecked_transaction()?;
            let mut query=tx.prepare("SELECT s.id,s.text,m.text,a.id,a.name,m.conversation,m.ts,s.conversation FROM signals s JOIN bindings b ON b.source=s.source AND b.conversation=s.conversation AND b.thread_key=s.thread_key JOIN agents a ON a.id=b.agent_id JOIN slack_inbox_messages m ON m.conversation=?1||':'||?2||':'||s.conversation AND m.ts=s.external_id AND m.sender=?2 AND m.owner=?2 AND m.human=1 AND m.thread='' WHERE s.source='slack' AND s.author=?2 AND s.label='dm' AND s.root=1 AND s.thread_key=s.external_id AND NOT EXISTS(SELECT 1 FROM kv WHERE key='manual-title:'||a.id)")?;
            let rows=query.query_map(params![team,owner],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?,r.get::<_,String>(6)?,r.get::<_,String>(7)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;drop(query);
            let mut changed=0;
            for (signal,normalized,raw,agent,prior,conversation,message,channel) in rows {
                let original=raw.trim_start();
                // The old adapter added this exact prefix only for a leading structured list.
                if normalized!=format!("- {original}") {continue;}
                let Some(request)=original.strip_prefix("• ") else {continue};
                let invocation=serde_json::json!({"providerConversation":conversation,"providerMessage":message,"prefixBytes":raw.len()-original.len()+"• ".len(),"basis":"Retained authenticated source and exact prior adapter normalization"});
                tx.execute("INSERT OR IGNORE INTO kv(key,value) VALUES(?1,?2)",params![crate::source::slack::invocation_key(&channel,&message),invocation.to_string()])?;
                if prior!=crate::naming::provisional(original) {continue;}
                let title=crate::naming::provisional(request);
                changed+=tx.execute("UPDATE agents SET name=?2 WHERE id=?1 AND name=?3 AND NOT EXISTS(SELECT 1 FROM kv WHERE key='manual-title:'||?1)",params![agent,title,prior])?;
                let proof=serde_json::json!({"signalId":signal,"providerConversation":conversation,"providerMessage":message,"priorTitle":prior,"title":title,"basis":"Exact prior adapter normalization and retained authenticated provider source"});
                tx.execute("INSERT INTO kv(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![format!("title-invocation-repair:{agent}"),proof.to_string()])?;
            }
            tx.commit()?;Ok(changed)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn title_repairs_require_matching_source_and_automatic_origin()->Result<()> {
        for (team,owner) in [("workspace-a","reader-a"),("workspace-b","reader-b")] {
            let store=Store::in_memory()?;let conversation=format!("{team}:{owner}:direct");
            for (id,raw,manual,matches) in [("eligible","• Inspect .config evidence",false,true),("manual","• Keep explicit title",true,true),("literal","- • Keep literal content",false,false),("uncertain","• Keep unverified title",false,false)] {
                let at=100.0;let external=format!("{id}-message");
                let text=if matches {format!("- {raw}")}else{raw.into()};
                let signal=Signal{id:id.into(),source:"slack".into(),conversation:"direct".into(),thread_key:external.clone(),external_id:external.clone(),author:owner.into(),label:"dm".into(),text,attachments:vec![],at,root:true};
                store.put_signal(&signal)?;let name=crate::naming::provisional(raw);
                store.with(|c|{c.execute("INSERT INTO agents(id,name,backend,model,cwd,status,last_activity,updated_at) VALUES(?1,?2,'codex','fixture','/work','complete',1,1)",params![id,name])?;
                    c.execute("INSERT INTO slack_inbox_messages VALUES(?1,'direct',?2,?3,100,?3,100,'',?2,1,?4)",params![conversation,owner,external,raw])?;Ok(())})?;
                store.bind("slack","direct",&external,id)?;if manual {store.manual_title(id,&name)?;}
            }
            let before=store.with(|c|{let mut q=c.prepare("SELECT text FROM signals ORDER BY id")?;let rows=q.query_map([],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;Ok(rows)})?;
            assert_eq!(store.repair_slack_invocation_titles(&serde_json::json!({"account":"other-workspace","owner":owner}))?,0);
            let account=serde_json::json!({"account":team,"owner":owner});assert_eq!(store.repair_slack_invocation_titles(&account)?,1);
            assert_eq!(store.agent("eligible")?.unwrap().name,"Inspect .config evidence");
            assert_eq!(store.agent("manual")?.unwrap().name,"• Keep explicit title");
            assert_eq!(store.agent("literal")?.unwrap().name,"- • Keep literal content");
            assert_eq!(store.agent("uncertain")?.unwrap().name,"• Keep unverified title");
            assert_eq!(store.repair_slack_invocation_titles(&account)?,0,"Repair is idempotent and never renames a useful established title");
            let after=store.with(|c|{let mut q=c.prepare("SELECT text FROM signals ORDER BY id")?;let rows=q.query_map([],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;Ok(rows)})?;assert_eq!(before,after,"Source history is never rewritten");
        }Ok(())
    }
}
