use super::*;
use serde::{Deserialize,Serialize};

/// Local response assessment is independent of routing, source history and task completion.
#[derive(Clone,Debug,Default,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct InboxReview {
    pub revision:i64,
    #[serde(default)]
    pub context_revision:i64,
    #[serde(default)]
    pub draft_revision:Option<i64>,
    #[serde(default)]
    pub draft_context_revision:Option<i64>,
    pub state:String,
    pub reason:String,
    pub draft:Option<String>,
    pub resolved_by:Option<i64>,
}

impl Store {
    pub(super) fn decorate_inbox_review(c:&Connection,item:&mut InboxItem)->Result<()> {
        item.context_revision=c.query_row("SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM kv WHERE key=?1),0)",[format!("inbox-context-revision:{}:{}",item.signal.source,item.signal.conversation)],|r|r.get(0))?;
        let saved:Option<String>=c.query_row("SELECT value FROM kv WHERE key=?1",[format!("inbox-review:{}",item.signal.id)],|r|r.get(0)).optional()?;
        let mut review=saved.map(|s|serde_json::from_str::<InboxReview>(&s)).transpose()?.unwrap_or_default();
        if review.revision!=item.revision||!(review.resolved_by.is_some()||matches!(review.state.as_str(),"answered"|"no_response_needed")) {
            let advice:Option<String>=c.query_row("SELECT value FROM kv WHERE key=?1",[format!("routing-advice:{}",item.signal.id)],|r|r.get(0)).optional()?;
            let advice=advice.map(|s|serde_json::from_str::<crate::recommendations::RoutingAdvice>(&s)).transpose()?;
            review.state=if item.state==InboxState::Done {"routed".into()}else if let Some(advice)=&advice {advice.choice.attention.clone()}else if crate::inbox::imported(&item.signal.source) {"unreviewed".into()}else{"response_needed".into()};
            review.reason=advice.map(|a|a.choice.reason).unwrap_or_default();review.resolved_by=None;
        }
        review.revision=item.revision;item.review=Some(review);Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn arrivals_and_stale_predictions_cannot_claim_an_unanswered_obligation()->Result<()> {
        for (owner,sender) in [("reader-a","source-a"),("reader-b","source-b")] {
            let store=Store::in_memory()?;store.set("inbox-dm:workspace:direct","true")?;
            let incoming=Signal{id:"incoming".into(),source:crate::inbox::SLACK.into(),conversation:format!("workspace:{owner}:direct"),thread_key:"conversation".into(),external_id:"101".into(),author:sender.into(),text:"Source request with retained context".into(),at:101.0,label:"Source conversation".into(),attachments:vec![],root:true};
            store.import_inbox(&incoming,"")?;let (item,revision)=store.inbox_version(&incoming.id)?.unwrap();
            assert_eq!(item.review.unwrap().state,"unreviewed");assert_eq!(store.inbox_snapshot(100)?.2,0);
            let context=serde_json::json!({"contextRevision":item.context_revision});
            let choice=|attention:&str|crate::recommendations::RoutePrediction{attention:attention.into(),action:"spawn".into(),agent_ids:vec![],reason:"Source-grounded assessment".into()};
            store.save_routing_advice(&incoming.id,revision,&context,choice("response_needed"),0)?;
            assert_eq!(store.inbox_snapshot(100)?.2,1);
            let reply=Signal{id:"reply".into(),external_id:"102".into(),author:owner.into(),text:"Relevant later owner source reply".into(),at:102.0,..incoming.clone()};
            store.import_inbox(&reply,"")?;
            assert_eq!(store.inbox_item(&incoming.id)?.unwrap().review.unwrap().state,"unreviewed","New context requires semantic reinspection, never guessed resolution");
            assert!(store.save_routing_advice(&incoming.id,revision,&context,choice("response_needed"),0)?.is_none(),"A late pre-reply prediction cannot restore a stale obligation");
            let updated=store.inbox_item(&incoming.id)?.unwrap();
            store.save_routing_advice(&incoming.id,revision,&serde_json::json!({"contextRevision":updated.context_revision}),choice("answered"),0)?;
            assert_eq!(store.inbox_snapshot(100)?.2,0);assert_eq!(store.inbox_item(&incoming.id)?.unwrap().state,InboxState::Waiting,"Response status never completes routing or tasks");
            let last=store.inbox_item(&incoming.id)?.unwrap().context_revision;store.import_inbox(&reply,"")?;
            assert_eq!(store.inbox_item(&incoming.id)?.unwrap().context_revision,last,"Identical refreshes do not invalidate source context or its response assessment");
        }Ok(())
    }
}

#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct InboxAction {
    pub request_id:String,
    pub revision:i64,
    pub context_revision:i64,
    pub action:String,
    pub target:Option<String>,
    pub recommendation_id:Option<i64>,
    pub draft:Option<String>,
}
#[derive(Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct InboxRoute {
    pub request_id:String,
    pub target:String,
    pub text:String,
}
impl Store {
    pub fn inbox_action_receipt(&self,id:&str,action:&InboxAction)->Result<bool> {
        let expected=serde_json::json!({"signal":id,"action":action}).to_string();
        match self.get(&format!("inbox-action:{}",action.request_id))? {
            Some(saved)=>{anyhow::ensure!(saved==expected,"requestId already belongs to another action");Ok(true)},None=>Ok(false)
        }
    }
    /// A click updates only its current source revision; it cannot mutate external state or tasks.
    pub fn save_inbox_action(&self,id:&str,action:&InboxAction,actor:&str,draft:Option<&str>,route_text:Option<&str>)->Result<()> {
        self.with(|c|{
            let tx=c.unchecked_transaction()?;
            let key=format!("inbox-action:{}",action.request_id);
            let payload=serde_json::json!({"signal":id,"action":action}).to_string();
            if let Some(saved)=tx.query_row("SELECT value FROM kv WHERE key=?1",[&key],|r|r.get::<_,String>(0)).optional()? {anyhow::ensure!(saved==payload,"requestId already belongs to another action");return Ok(());}
            let mut item=tx.query_row("SELECT * FROM signals WHERE id=?1",[id],read_item)?;
            Self::decorate_inbox_review(&tx,&mut item)?;
            anyhow::ensure!(item.revision==action.revision,"Source message changed; inspect its current revision");
            if matches!(action.action.as_str(),"route"|"draft") {anyhow::ensure!(item.context_revision==action.context_revision,"Source conversation changed; refresh before acting");}
            let mut review=item.review.unwrap_or_default();
            if action.action=="route" {
                anyhow::ensure!(item.state==InboxState::Waiting&&!Self::intake_excluded_from(&tx,&item.signal)?,"Source is no longer available for routing");
                let target=action.target.as_deref().context("Choose an existing suggested conversation")?;
                anyhow::ensure!(tx.query_row("SELECT EXISTS(SELECT 1 FROM agents WHERE id=?1 AND archived=0)",[target],|r|r.get::<_,bool>(0))?,"Suggested conversation is unavailable");
                let bound:Option<String>=tx.query_row("SELECT agent_id FROM bindings WHERE source=?1 AND conversation=?2 AND thread_key=?3",params![item.signal.source,item.signal.conversation,item.signal.thread_key],|r|r.get(0)).optional()?;
                if let Some(bound)=bound {anyhow::ensure!(bound==target,"Conversation ownership changed; inspect the current target");}
                else {
                    let raw:String=tx.query_row("SELECT value FROM kv WHERE key=?1",[format!("routing-advice:{id}")],|r|r.get(0)).context("Prediction changed; refresh before routing")?;
                    let advice:crate::recommendations::RoutingAdvice=serde_json::from_str(&raw)?;
                    anyhow::ensure!(Some(advice.recommendation_id)==action.recommendation_id&&advice.choice.action=="existing"&&advice.choice.agent_ids.first().is_some_and(|a|a==target),"Prediction changed; inspect the current target");
                    tx.execute("INSERT INTO bindings(source,conversation,thread_key,agent_id) VALUES(?1,?2,?3,?4)",params![item.signal.source,item.signal.conversation,item.signal.thread_key,target])?;
                }
                let queued=InboxRoute{request_id:action.request_id.clone(),target:target.into(),text:route_text.context("Internal source context is required")?.into()};
                tx.execute("INSERT INTO kv(key,value) VALUES(?1,?2)",params![format!("inbox-route:{}",action.request_id),serde_json::to_string(&queued)?])?;
                tx.execute("UPDATE signals SET state='done',outcome='routed internally',agent_ids=?2 WHERE id=?1",params![id,serde_json::to_string(&vec![target])?])?;
            }
            let detail=serde_json::json!({"signal":id,"action":action});
            tx.execute("INSERT INTO entries(agent_id,at,kind,text,detail,item_id) VALUES(?1,?2,'you',?3,?4,?5)",params![actor,crate::model::now(),match action.action.as_str(){"resolve"=>"Mark Inbox item resolved","reopen"=>"Review Inbox item again","draft"=>"Generate local Inbox draft","save_draft"=>"Edit local Inbox draft",_=>"Route Inbox item internally"},detail.to_string(),action.request_id])?;
            let entry=tx.last_insert_rowid();
            match action.action.as_str() {
                "resolve"=>{review.state="resolved".into();review.reason="Marked resolved by you".into();review.resolved_by=Some(entry);},
                "reopen"=>{review.resolved_by=None;tx.execute("DELETE FROM kv WHERE key=?1",[format!("routing-advice:{id}")])?;},
                "draft"|"save_draft"=>{let text=draft.context("Local draft is required")?;anyhow::ensure!(text.len()<=16000,"Draft is too long");review.draft=Some(text.into());review.draft_revision=Some(action.revision);review.draft_context_revision=Some(action.context_revision);},
                "route"=>{},_=>anyhow::bail!("Invalid Inbox action")
            }
            tx.execute("INSERT INTO kv(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![format!("inbox-review:{id}"),serde_json::to_string(&review)?])?;
            tx.execute("INSERT INTO kv(key,value) VALUES(?1,?2)",params![key,payload])?;
            tx.commit()?;Ok(())
        })
    }
    pub fn inbox_review(&self,id:&str)->Result<InboxReview> {
        self.read(|c|{let mut item=c.query_row("SELECT * FROM signals WHERE id=?1",[id],read_item)?;Self::decorate_inbox_review(c,&mut item)?;Ok(item.review.unwrap_or_default())})
    }
    pub fn finish_inbox_route(&self,id:&str)->Result<()> {self.with(|c|{c.execute("DELETE FROM kv WHERE key=?1",[format!("inbox-route:{id}")])?;Ok(())})}
}

#[cfg(test)]
mod action_tests {
    use super::*;
    #[test]
    fn local_actions_are_revision_bound_durable_and_do_not_resolve_tasks()->Result<()> {
        for owner in ["reader-a","reader-b"] {
            let root=std::env::temp_dir().join(crate::model::new_id("inbox-action"));std::fs::create_dir_all(&root)?;let path=root.join("state.sqlite3");
            let store=Store::open(&path)?;store.set("inbox-dm:workspace:direct","true")?;
            let mut signal=Signal{id:"incoming".into(),source:crate::inbox::SLACK.into(),conversation:format!("workspace:{owner}:direct"),thread_key:"conversation".into(),external_id:"100".into(),author:"source-author".into(),text:"Current source request".into(),at:100.0,label:"Source".into(),attachments:vec![],root:true};
            store.import_inbox(&signal,"https://example.test/source")?;
            store.with(|c|{c.execute("INSERT INTO tasks(id,text,status,created_at,updated_at) VALUES('retained','Retained work','waiting_for_human',1,1)",[])?;Ok(())})?;
            let item=store.inbox_item(&signal.id)?.unwrap();
            let action=|kind:&str|InboxAction{request_id:uuid::Uuid::new_v4().to_string(),revision:item.revision,context_revision:item.context_revision,action:kind.into(),target:None,recommendation_id:None,draft:None};
            let saved=action("save_draft");store.save_inbox_action(&signal.id,&saved,"",Some("Retained local draft"),None)?;
            let resolved=action("resolve");store.save_inbox_action(&signal.id,&resolved,"",None,None)?;store.save_inbox_action(&signal.id,&resolved,"",None,None)?;
            assert_eq!(store.inbox_review(&signal.id)?.state,"resolved");assert_eq!(store.inbox_review(&signal.id)?.draft.as_deref(),Some("Retained local draft"));
            assert_eq!(store.inbox_item(&signal.id)?.unwrap().state,InboxState::Waiting,"Resolve never closes routing/source/task state");
            assert!(store.inbox_action_receipt(&signal.id,&resolved)?);
            let mut collision=resolved.clone();collision.action="draft".into();assert!(store.inbox_action_receipt(&signal.id,&collision).is_err());
            let mut later=signal.clone();later.external_id="101".into();later.author=owner.into();later.text="Later source context".into();later.at=101.0;store.import_inbox(&later,"")?;
            assert_eq!(store.inbox_review(&signal.id)?.state,"resolved","An unrelated new message cannot undo an explicit per-message resolution");
            assert!(store.save_inbox_action(&signal.id,&action("draft"),"",Some("Stale generated text"),None).is_err());
            assert_eq!(store.inbox_review(&signal.id)?.draft.as_deref(),Some("Retained local draft"));
            drop(store);let store=Store::open(&path)?;assert_eq!(store.inbox_review(&signal.id)?.state,"resolved");
            let current=store.inbox_item(&signal.id)?.unwrap();let mut reopen=action("reopen");reopen.context_revision=current.context_revision;store.save_inbox_action(&signal.id,&reopen,"",None,None)?;
            assert_eq!(store.inbox_review(&signal.id)?.state,"unreviewed");
            signal.text="Revised incoming source request".into();store.import_inbox(&signal,"")?;
            assert!(store.save_inbox_action(&signal.id,&action("resolve"),"",None,None).is_err(),"A stale click cannot resolve a revised message");
            store.read(|c|{assert_eq!(c.query_row("SELECT count(*) FROM agents",[],|r|r.get::<_,usize>(0))?,0,"Local actions never create a conversation");assert_eq!(c.query_row("SELECT status FROM tasks WHERE id='retained'",[],|r|r.get::<_,String>(0))?,"waiting_for_human");assert_eq!(c.query_row("SELECT count(*) FROM entries WHERE item_id=?1",[resolved.request_id],|r|r.get::<_,usize>(0))?,1,"A retried click has one human evidence record");Ok(())})?;
            drop(store);std::fs::remove_dir_all(root)?;
        }Ok(())
    }
}
