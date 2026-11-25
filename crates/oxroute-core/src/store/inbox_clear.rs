use super::*;

impl Store {
    /// Items, their dismissal boundary and the full pending count share one SQLite snapshot.
    pub fn inbox_snapshot(&self,limit:usize)->Result<(Vec<InboxItem>,i64,usize)> {
        let (mut items,through,waiting)=self.read(|c|{
            let tx=c.unchecked_transaction()?;
            let through=tx.query_row("SELECT COALESCE(MAX(sequence),0) FROM inbox_arrivals",[],|r|r.get::<_,i64>(0))?;
            let waiting=tx.query_row("SELECT count(DISTINCT json_array(s.source,s.conversation,CASE WHEN s.source IN ('slack-inbox','outlook-inbox') THEN s.thread_key ELSE s.id END)) FROM signals s JOIN inbox_arrivals a ON a.signal_id=s.id JOIN inbox_attention v ON v.id=s.id WHERE v.state='response_needed' AND a.sequence<=?1",[through],|r|r.get::<_,usize>(0))?;
            let mut query=tx.prepare("WITH ranked AS (SELECT s.id,MAX(CASE v.state WHEN 'response_needed' THEN 3 WHEN 'unreviewed' THEN 2 ELSE 0 END) OVER (PARTITION BY s.source,s.conversation,CASE WHEN s.source IN ('slack-inbox','outlook-inbox') THEN s.thread_key ELSE s.id END) AS priority,MAX(s.at) OVER (PARTITION BY s.source,s.conversation,CASE WHEN s.source IN ('slack-inbox','outlook-inbox') THEN s.thread_key ELSE s.id END) AS latest,ROW_NUMBER() OVER (PARTITION BY s.source,s.conversation,CASE WHEN s.source IN ('slack-inbox','outlook-inbox') THEN s.thread_key ELSE s.id END ORDER BY (s.state='waiting') DESC,s.at DESC,s.rowid DESC) AS ordinal FROM signals s JOIN inbox_arrivals a ON a.signal_id=s.id JOIN inbox_attention v ON v.id=s.id WHERE a.sequence<=?1) SELECT s.* FROM ranked r JOIN signals s ON s.id=r.id WHERE r.ordinal=1 ORDER BY r.priority DESC,r.latest DESC,s.rowid DESC LIMIT ?2")?;
            let items=query.query_map(params![through,limit as i64],read_item)?.collect::<rusqlite::Result<Vec<_>>>()?;drop(query);
            tx.commit()?;Ok((items,through,waiting))
        })?;
        self.decorate_inbox(&mut items,false)?;self.decorate_inbox_groups(&mut items,through)?;Ok((items,through,waiting))
    }

    pub fn clear_inbox(&self,request:&str,through:i64,focus:&str)->Result<usize> {
        self.with(|c|{
            let tx=c.unchecked_transaction()?;
            let prior:Option<(i64,usize)>=tx.query_row("SELECT through_sequence,count FROM inbox_dismissals WHERE request_id=?1",[request],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
            if let Some((boundary,count))=prior {anyhow::ensure!(boundary==through,"dismissal requestId belongs to another snapshot");return Ok(count);}
            let current:i64=tx.query_row("SELECT COALESCE(MAX(sequence),0) FROM inbox_arrivals",[],|r|r.get(0))?;
            anyhow::ensure!(through>=0&&through<=current,"invalid Inbox snapshot boundary");
            tx.execute("INSERT INTO entries(agent_id,at,kind,text,detail,item_id) VALUES(?1,?2,'you','Clear pending Inbox arrivals',?3,?4)",params![focus,crate::model::now(),serde_json::json!({"through":through}).to_string(),request])?;
            let entry=tx.last_insert_rowid();
            tx.execute("UPDATE inbox_arrivals SET dismissed_by=?2 WHERE sequence<=?1 AND signal_id IN (SELECT id FROM signals WHERE state='waiting')",params![through,entry])?;
            let count=tx.execute("UPDATE signals SET state='done',outcome='dismissed' WHERE state='waiting' AND id IN (SELECT signal_id FROM inbox_arrivals WHERE dismissed_by=?1)",[entry])?;
            tx.execute("INSERT INTO inbox_dismissals VALUES(?1,?2,?3,?4)",params![request,through,entry,count])?;
            tx.commit()?;Ok(count)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clear_is_snapshot_bounded_human_provenanced_and_durable()->Result<()> {
        let root=std::env::temp_dir().join(crate::model::new_id("clear-inbox"));std::fs::create_dir_all(&root)?;let path=root.join("state.sqlite3");
        let store=Store::open(&path)?;
        let message=|id:usize|Signal{id:format!("arrival-{id}"),source:"fixture".into(),conversation:"context".into(),thread_key:id.to_string(),external_id:id.to_string(),author:"source-author".into(),label:"Incoming source".into(),text:"Retained source evidence".into(),attachments:vec![],at:id as f64,root:true};
        for id in 0..251 {store.put_signal(&message(id))?;}
        let (page,through,waiting)=store.inbox_snapshot(200)?;assert_eq!(page.len(),200);assert_eq!(waiting,251);
        store.put_signal(&message(251))?;
        assert_eq!(store.clear_inbox("dismissal-request",through,"coordinator")?,251,"Dismiss every pending page at the actual click boundary");
        let (_,next,waiting)=store.inbox_snapshot(200)?;assert_eq!(waiting,1);assert!(next>through);assert_eq!(store.inbox_item("arrival-251")?.unwrap().state,InboxState::Waiting,"A concurrent arrival survives");
        assert_eq!(store.clear_inbox("dismissal-request",through,"coordinator")?,251,"A lost response is retried without clearing new messages");
        assert!(store.clear_inbox("dismissal-request",next,"coordinator").is_err());assert!(store.clear_inbox("future-request",next+1,"coordinator").is_err());
        store.read(|c|{assert_eq!(c.query_row("SELECT count(*) FROM entries WHERE kind='you' AND item_id='dismissal-request'",[],|r|r.get::<_,usize>(0))?,1);assert_eq!(c.query_row("SELECT count(*) FROM signals",[],|r|r.get::<_,usize>(0))?,252);assert_eq!(c.query_row("SELECT count(*) FROM inbox_arrivals WHERE dismissed_by IS NOT NULL",[],|r|r.get::<_,usize>(0))?,251);Ok(())})?;
        drop(store);let store=Store::open(&path)?;store.put_signal(&message(1))?;assert_eq!(store.inbox_snapshot(200)?.2,1,"Sync and restart do not undo the dismissal");
        assert_eq!(store.inbox_item("arrival-1")?.unwrap().signal.text,"Retained source evidence");
        assert_eq!(store.clear_inbox("second-click",next,"coordinator")?,1);assert_eq!(store.inbox_snapshot(200)?.2,0);assert_eq!(store.clear_inbox("empty-click",next,"coordinator")?,0);
        drop(store);std::fs::remove_dir_all(root)?;Ok(())
    }
}
