use super::*;
use serde::{Deserialize,Serialize};

#[derive(Clone,Debug,Default,PartialEq,Serialize,Deserialize)]
#[serde(rename_all="snake_case")]
pub enum IntakeMode {Immediate,#[default] Standard,Excluded}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct IntakePolicy {
    pub source:String,
    pub account:String,
    /// Empty selects the entire source account; otherwise match the provider ID exactly.
    pub sender:String,
    pub label:String,
    pub mode:IntakeMode,
    pub delegation_entry_id:i64,
    pub effective_at:f64,
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct IntakeArrival {
    pub request_id:String,
    pub signal_id:String,
    pub source:String,
    pub account:String,
    pub sender:String,
    pub item_id:String,
    pub revision:String,
    pub delegation_entry_id:i64,
}
fn read_policies(c:&Connection)->Result<Vec<IntakePolicy>> {
    let value:Option<String>=c.query_row("SELECT value FROM kv WHERE key='intake.policies'",[],|r|r.get(0)).optional()?;
    Ok(value.map(|value|serde_json::from_str(&value)).transpose()?.unwrap_or_default())
}
fn policy_for<'a>(policies:&'a[IntakePolicy],source:&str,account:&str,sender:&str)->Option<&'a IntakePolicy> {
    policies.iter().find(|p|p.source==source&&p.account==account&&p.sender==sender).or_else(||policies.iter().find(|p|p.source==source&&p.account==account&&p.sender.is_empty()))
}
fn excluded(policies:&[IntakePolicy],source:&str,conversation:&str,sender:&str)->bool {
    let account=if source==crate::inbox::SLACK{conversation.split(':').next().unwrap_or_default()}else{conversation};
    policy_for(policies,source,account,sender).is_some_and(|p|p.mode==IntakeMode::Excluded)
}

impl Store {
    pub fn intake_delegation_at(&self,entry:i64)->Result<f64> {
        self.read(|c|c.query_row("SELECT at FROM entries WHERE id=?1 AND kind='you'",[entry],|r|r.get(0)).context("policy delegation must cite an actual human entry"))
    }
    pub(crate) fn collected_signal_id(&self,signal:&Signal)->Result<Option<String>> {
        self.read(|c|Ok(c.query_row("SELECT id FROM signals WHERE source=?1 AND conversation=?2 AND ((source='slack-inbox' AND external_id=?3) OR (source!='slack-inbox' AND thread_key=?4))",params![signal.source,signal.conversation,signal.external_id,signal.thread_key],|r|r.get(0)).optional()?))
    }
    pub fn intake_policies(&self)->Result<Vec<IntakePolicy>> {
        self.read(read_policies)
    }
    pub fn save_intake_policy(&self,policy:&IntakePolicy)->Result<()> {
        anyhow::ensure!(crate::inbox::imported(&policy.source)&&!policy.account.trim().is_empty(),"a supported source and provider account are required");
        anyhow::ensure!(policy.account.len()<=1000&&policy.sender.len()<=1000&&policy.label.len()<=200&&policy.effective_at.is_finite(),"invalid intake identity");
        self.with(|c|{
            let tx=c.unchecked_transaction()?;
            anyhow::ensure!(tx.query_row("SELECT kind='you' FROM entries WHERE id=?1",[policy.delegation_entry_id],|r|r.get::<_,bool>(0)).optional()?.unwrap_or(false),"policy delegation must cite an actual human entry");
            let value:Option<String>=tx.query_row("SELECT value FROM kv WHERE key='intake.policies'",[],|r|r.get(0)).optional()?;
            let mut policies:Vec<IntakePolicy>=value.map(|value|serde_json::from_str(&value)).transpose()?.unwrap_or_default();
            policies.retain(|item|(&item.source,&item.account,&item.sender)!=(&policy.source,&policy.account,&policy.sender));
            anyhow::ensure!(policies.len()<100,"too many intake policies");policies.push(policy.clone());
            tx.execute("INSERT INTO kv(key,value) VALUES('intake.policies',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[serde_json::to_string(&policies)?])?;
            Self::reconcile_intake_exclusions(&tx)?;
            tx.commit()?;Ok(())
        })
    }
    pub fn intake_policy(&self,source:&str,account:&str,sender:&str)->Result<Option<IntakePolicy>> {
        self.read(|c|{let policies=read_policies(c)?;Ok(policy_for(&policies,source,account,sender).cloned())})
    }
    pub fn intake_signal_excluded(&self,signal:&Signal)->Result<bool> {
        self.read(|c|Self::intake_excluded_from(c,signal))
    }
    pub(super) fn intake_excluded_from(c:&Connection,signal:&Signal)->Result<bool> {
        Ok(excluded(&read_policies(c)?,&signal.source,&signal.conversation,&signal.author))
    }
    pub(super) fn reconcile_intake_exclusions(c:&Connection)->Result<()> {
        let policies=read_policies(c)?;
        if !policies.iter().any(|policy|policy.mode==IntakeMode::Excluded){return Ok(());}
        let mut query=c.prepare("SELECT id,source,conversation,author FROM signals")?;
        let rows=query.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;drop(query);
        for (id,source,conversation,sender) in rows {
            if excluded(&policies,&source,&conversation,&sender){c.execute("DELETE FROM inbox_arrivals WHERE signal_id=?1",[id])?;}
        }
        Ok(())
    }
    pub fn intake_context(&self)->Result<serde_json::Value> {
        let (pending,total)=self.read(|c|{
            let total:usize=c.query_row("SELECT count(*) FROM signals WHERE source IN ('slack-inbox','outlook-inbox') AND state='waiting' AND EXISTS(SELECT 1 FROM inbox_attention v WHERE v.id=signals.id AND v.state IN ('response_needed','unreviewed')) AND EXISTS(SELECT 1 FROM inbox_arrivals a WHERE a.signal_id=signals.id)",[],|r|r.get(0))?;
            let mut query=c.prepare("SELECT * FROM signals WHERE source IN ('slack-inbox','outlook-inbox') AND state='waiting' AND EXISTS(SELECT 1 FROM inbox_attention v WHERE v.id=signals.id AND v.state IN ('response_needed','unreviewed')) AND EXISTS(SELECT 1 FROM inbox_arrivals a WHERE a.signal_id=signals.id) ORDER BY at DESC,rowid DESC LIMIT 50")?;
            let items=query.query_map([],read_item)?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok((items,total))
        })?;
        let pending=pending.into_iter().map(|item|serde_json::json!({"signalId":item.signal.id,"source":item.signal.source,"conversation":item.signal.conversation,"sender":item.signal.author,"label":item.signal.label,"at":item.signal.at,"excerpt":item.signal.text.chars().take(1000).collect::<String>(),"contextUrl":format!("/api/intake/{}",item.signal.id)})).collect::<Vec<_>>();
        Ok(serde_json::json!({"policies":self.intake_policies()?,"defaultMode":"standard","standardIntervalSeconds":1200,"pending":pending,"pendingCount":total,"contextTruncated":total>50}))
    }
    pub(crate) fn queue_intake_arrival(&self,signal_id:&str,signal:&Signal,sender:&str,revision:&str,activity:f64)->Result<bool> {
        if sender.is_empty(){return Ok(false)}
        if !self.read(|c|Ok(c.query_row("SELECT EXISTS(SELECT 1 FROM inbox_arrivals a JOIN signals s ON s.id=a.signal_id WHERE s.id=?1 AND s.state='waiting' AND a.dismissed_by IS NULL AND EXISTS(SELECT 1 FROM inbox_attention v WHERE v.id=s.id AND v.state IN ('response_needed','unreviewed')))",[signal_id],|r|r.get::<_,bool>(0))?))? {return Ok(false)}
        let account=if signal.source==crate::inbox::SLACK {signal.conversation.split(':').next().unwrap_or_default()}else{&signal.conversation};
        let Some(policy)=self.intake_policy(&signal.source,account,sender)? else{return Ok(false)};
        if policy.mode!=IntakeMode::Immediate||activity<policy.effective_at{return Ok(false)}
        let payload=IntakeArrival{request_id:uuid::Uuid::new_v4().to_string(),signal_id:signal_id.into(),source:signal.source.clone(),account:account.into(),sender:sender.into(),item_id:signal.external_id.clone(),revision:revision.into(),delegation_entry_id:policy.delegation_entry_id};
        self.with(|c|{
            let focus:Option<String>=c.query_row("SELECT value FROM kv WHERE key='focus.agent'",[],|r|r.get(0)).optional()?;
            let Some(focus)=focus else{return Ok(false)};
            let id=serde_json::to_string(&(&payload.source,&signal.conversation,&payload.item_id,&payload.revision))?;
            Ok(c.execute("INSERT OR IGNORE INTO focus_turn_events(id,focus_id,agent_id,outcome,at,payload) VALUES(?1,?2,?2,'intake',?3,?4)",params![id,focus,crate::model::now(),serde_json::to_string(&payload)?])?>0)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn verified_identity_policy_and_durable_arrivals()->Result<()> {
        let root=std::env::temp_dir().join(crate::model::new_id("intake-policy"));std::fs::create_dir_all(&root)?;let path=root.join("state.sqlite3");
        let store=Store::open(&path)?;store.set("focus.agent","coordinator")?;
        let user=store.add_entry("coordinator",10.0,EntryKind::You,"Delegate scoped source requests","","")?;
        let mut policy=IntakePolicy{source:crate::inbox::SLACK.into(),account:"workspace-a".into(),sender:"provider-author".into(),label:"Selected source".into(),mode:IntakeMode::Immediate,delegation_entry_id:user.id,effective_at:20.0};
        store.save_intake_policy(&policy)?;
        let signal=Signal{id:"intake-item".into(),source:policy.source.clone(),conversation:"workspace-a:reader:direct".into(),thread_key:"conversation".into(),external_id:"25.1".into(),author:policy.sender.clone(),label:"Untrusted display label".into(),text:"Prepare the revised artifact within the existing scope".into(),attachments:vec![],at:25.1,root:true};
        store.set("inbox-dm:workspace-a:direct","1")?;
        store.import_inbox(&signal,"https://example.invalid/message")?;
        assert!(!store.pending_focus_events("coordinator")?,"Unverified ingestion alone never inherits collector authority");
        assert!(!store.queue_intake_arrival(&signal.id,&signal,"another-author","25.1",25.1)?);
        assert!(!store.queue_intake_arrival(&signal.id,&signal,&policy.sender,"19.0",19.0)?,"Enabling a policy does not replay older requests");
        assert!(store.queue_intake_arrival(&signal.id,&signal,&policy.sender,"25.1",25.1)?);
        assert!(!store.queue_intake_arrival(&signal.id,&signal,&policy.sender,"25.1",25.1)?,"Repeated collection deduplicates source revisions");
        assert!(store.queue_intake_arrival(&signal.id,&signal,&policy.sender,"26.0",26.0)?,"Edits are independent revisions");
        drop(store);let store=Store::open(&path)?;
        let batch=store.claim_focus_events("coordinator")?.unwrap();assert_eq!(batch.events.len(),2,"Bursts coalesce into a durable batch");assert!(batch.events.iter().all(|event|event.intake.as_ref().is_some_and(|item|item.delegation_entry_id==user.id&&item.sender==policy.sender)));
        store.accept_turn_receipt(&batch.receipt,30.0)?;
        assert!(!store.pending_focus_events("coordinator")?);
        assert!(!store.queue_intake_arrival(&signal.id,&signal,&policy.sender,"26.0",26.0)?);
        assert_eq!(store.inbox_item(&signal.id)?.unwrap().state,InboxState::Waiting,"Wake acceptance does not fabricate work completion or remove manual routing");
        policy.mode=IntakeMode::Standard;store.save_intake_policy(&policy)?;
        assert!(!store.queue_intake_arrival(&signal.id,&signal,&policy.sender,"27.0",27.0)?);
        assert!(store.intake_policy(&policy.source,"workspace-b",&policy.sender)?.is_none(),"Identities are account-scoped");
        let receipt=store.add_entry("coordinator",31.0,EntryKind::Coordination,"A delegated report","","source")?;policy.delegation_entry_id=receipt.id;assert!(store.save_intake_policy(&policy).is_err(),"Agent context cannot mint a human delegation");
        drop(store);std::fs::remove_dir_all(root)?;Ok(())
    }
    #[test]
    fn exclusions_preserve_context_and_unrelated_work_across_restart()->Result<()> {
        for (account,sender,peer) in [("workspace-a","service-a","human-a"),("workspace-b","service-b","human-b")] {
            let root=std::env::temp_dir().join(crate::model::new_id("exclusion"));std::fs::create_dir_all(&root)?;let path=root.join("state.sqlite3");let store=Store::open(&path)?;
            store.slack_arrival_cutoff(Some(1.0))?;store.set("focus.agent","coordinator")?;
            let consent=store.add_entry("coordinator",2.0,EntryKind::You,"Exclude the selected source sender","","")?;
            store.set(&format!("inbox-dm:{account}:shared"),"1")?;store.set("inbox-dm:other-account:shared","1")?;
            let message=|id:&str,source:&str,conversation:String,author:&str|Signal{id:id.into(),source:source.into(),conversation,thread_key:"conversation".into(),external_id:id.into(),author:author.into(),label:"Source context".into(),text:format!("Retained source context {id}"),attachments:vec![],at:20.0,root:true};
            let selected=message("selected",crate::inbox::SLACK,format!("{account}:reader:shared"),sender);
            let human=message("human",crate::inbox::SLACK,selected.conversation.clone(),peer);
            let other=message("other",crate::inbox::SLACK,"other-account:reader:shared".into(),sender);
            let mail=message("mail",crate::inbox::OUTLOOK,"mailbox-account".into(),sender);
            for signal in [&selected,&human,&other,&mail]{store.import_inbox(signal,"https://example.invalid/source")?;}
            store.with(|c|{c.execute("INSERT INTO tasks(id,text,status,created_at,updated_at) VALUES('retained-task','Retained work','waiting_for_human',1,1)",[])?;Ok(())})?;
            store.set("review:retained-review",r#"{"status":"pending"}"#)?;
            let mut policy=IntakePolicy{source:crate::inbox::SLACK.into(),account:account.into(),sender:sender.into(),label:"Selected sender".into(),mode:IntakeMode::Immediate,delegation_entry_id:consent.id,effective_at:2.0};
            store.save_intake_policy(&policy)?;assert!(store.queue_intake_arrival(&selected.id,&selected,sender,"first",20.0)?);
            policy.mode=IntakeMode::Excluded;store.save_intake_policy(&policy)?;
            assert!(!store.pending_focus_events("coordinator")?,"Queued intake cannot route an excluded source");
            assert!(!store.queue_intake_arrival(&selected.id,&selected,sender,"next",21.0)?);
            assert_eq!(store.inbox(100)?.len(),3);assert_eq!(store.inbox_item(&selected.id)?.unwrap().state,InboxState::Waiting,"Exclusion is not resolution");
            assert!(store.intake_signal_excluded(&selected)?);assert!(!store.intake_signal_excluded(&human)?);assert!(!store.intake_signal_excluded(&other)?);assert!(!store.intake_signal_excluded(&mail)?);
            let mut newer=selected.clone();newer.id="later-context".into();newer.external_id="later-context".into();newer.at=30.0;newer.text="Retained later source context".into();
            assert!(store.import_inbox(&newer,"https://example.invalid/source")?.is_none());
            drop(store);let store=Store::open(&path)?;
            store.import_inbox(&selected,"https://example.invalid/source")?;store.import_inbox(&newer,"https://example.invalid/source")?;
            assert_eq!(store.inbox(100)?.len(),3,"Replay and restart cannot re-admit the excluded identity");
            assert!(store.inbox_item(&selected.id)?.unwrap().display.unwrap().text.contains(&newer.text),"Excluded messages remain readable source context");
            assert_eq!(store.read(|c|Ok(c.query_row("SELECT status FROM tasks WHERE id='retained-task'",[],|r|r.get::<_,String>(0))?))?,"waiting_for_human");
            assert_eq!(store.get("review:retained-review")?.unwrap(),r#"{"status":"pending"}"#);
            assert_eq!(store.intake_context()?["pendingCount"],3);
            drop(store);std::fs::remove_dir_all(root)?;
        }Ok(())
    }

}
