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
    #[serde(default)]
    pub evidence_message_ids:Vec<String>,
    #[serde(default)]
    pub resolution_entries:Vec<i64>,
    pub draft:Option<String>,
    pub resolved_by:Option<i64>,
}

impl Store {
    pub(super) fn decorate_inbox_review(c:&Connection,item:&mut InboxItem)->Result<()> {
        item.context_revision=c.query_row("SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM kv WHERE key=?1),0)",[format!("inbox-context-revision:{}:{}",item.signal.source,item.signal.conversation)],|r|r.get(0))?;
        let saved:Option<String>=c.query_row("SELECT value FROM kv WHERE key=?1",[format!("inbox-review:{}",item.signal.id)],|r|r.get(0)).optional()?;
        let mut review=saved.map(|s|serde_json::from_str::<InboxReview>(&s)).transpose()?.unwrap_or_default();
        if review.revision!=item.revision||!(review.resolved_by.is_some()||matches!(review.state.as_str(),"answered"|"no_response_needed")||(review.state=="response_needed"&&review.context_revision==item.context_revision)) {
            let advice:Option<String>=c.query_row("SELECT value FROM kv WHERE key=?1",[format!("routing-advice:{}",item.signal.id)],|r|r.get(0)).optional()?;
            let advice=advice.map(|s|serde_json::from_str::<crate::recommendations::RoutingAdvice>(&s)).transpose()?;
            review.state=if item.state==InboxState::Done {"routed".into()}else if let Some(advice)=&advice {advice.choice.attention.clone()}else if crate::inbox::imported(&item.signal.source) {"unreviewed".into()}else{"response_needed".into()};
            review.reason=advice.map(|a|a.choice.reason).unwrap_or_default();review.resolved_by=None;
        }
        if review.resolved_by.is_none() {
            let triage=c.query_row("SELECT state,reason,resolution_entries FROM inbox_focus_attention WHERE id=?1",[&item.signal.id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?))).optional()?;
            if let Some((state,reason,entries))=triage {review.state=state;review.reason=reason;review.resolution_entries=entries.map(|s|serde_json::from_str(&s)).transpose()?.unwrap_or_default();}
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
            let incoming=Signal{id:"incoming".into(),source:crate::inbox::SLACK.into(),conversation:format!("workspace:{owner}:direct"),thread_key:"100".into(),external_id:"101".into(),author:sender.into(),text:"Source request with retained context".into(),at:101.0,label:"Source conversation".into(),attachments:vec![],root:true};
            store.import_inbox(&incoming,"")?;let (item,revision)=store.inbox_version(&incoming.id)?.unwrap();
            assert_eq!(item.review.unwrap().state,"unreviewed");assert_eq!(store.inbox_snapshot(100)?.2,0);
            let context=serde_json::json!({"contextRevision":item.context_revision});
            let choice=|attention:&str|crate::recommendations::RoutePrediction{evidence_message_ids:if attention=="answered"{vec!["102".into()]}else{vec![]},attention:attention.into(),action:"spawn".into(),agent_ids:vec![],reason:"Source-grounded assessment".into()};
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
pub struct InboxScope {pub id:String,pub revision:i64}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct InboxAction {
    #[serde(default)]
    pub members:Vec<InboxScope>,
    pub request_id:String,
    pub revision:i64,
    pub context_revision:i64,
    pub action:String,
    pub target:Option<String>,
    #[serde(default)]
    pub targets:Vec<String>,
    pub recommendation_id:Option<i64>,
    pub draft:Option<String>,
}
#[derive(Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct InboxRoute {
    pub request_id:String,
    pub target:String,
    pub text:String,
    #[serde(default)]
    pub quiet_epoch:Option<String>,
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
            if action.action=="draft" {anyhow::ensure!(item.context_revision==action.context_revision,"Source conversation changed; refresh before acting");}
            let scope=if action.members.is_empty() {vec![InboxScope{id:id.into(),revision:action.revision}]}else{action.members.clone()};
            anyhow::ensure!(scope.len()<=5000&&scope.iter().any(|m|m.id==id),"Invalid group snapshot");
            let mut seen=HashSet::new();let mut members=Vec::new();
            for scope in scope {
                anyhow::ensure!(seen.insert(scope.id.clone()),"Duplicate group member");
                let mut member=tx.query_row("SELECT * FROM signals WHERE id=?1",[&scope.id],read_item)?;
                anyhow::ensure!(member.revision==scope.revision,"A source message changed; inspect the current group");
                anyhow::ensure!(member.signal.source==item.signal.source&&member.signal.conversation==item.signal.conversation&&member.signal.thread_key==item.signal.thread_key,"Group members must belong to one verified source thread");
                Self::decorate_inbox_review(&tx,&mut member)?;members.push(member);
            }
            let mut review=item.review.clone().unwrap_or_default();
            if matches!(action.action.as_str(),"route"|"route_manual") {
                anyhow::ensure!(item.state==InboxState::Waiting&&!Self::intake_excluded_from(&tx,&item.signal)?,"Source is no longer available for routing");
                let target=action.target.as_deref().context("Choose an existing suggested conversation")?;
                anyhow::ensure!(tx.query_row("SELECT EXISTS(SELECT 1 FROM agents WHERE id=?1 AND archived=0)",[target],|r|r.get::<_,bool>(0))?,"Suggested conversation is unavailable");
                if action.action!="route_manual" {if let Some(bound)=Self::inbox_destination_from(&tx,&item.signal)? {
                    anyhow::ensure!(!bound.blocked&&bound.agent_id==target,"Confirmed destination changed or is unavailable");
                } else {
                    let raw:String=tx.query_row("SELECT value FROM kv WHERE key=?1",[format!("routing-advice:{id}")],|r|r.get(0)).context("Prediction changed; refresh before routing")?;
                    let advice:crate::recommendations::RoutingAdvice=serde_json::from_str(&raw)?;
                    anyhow::ensure!(item.context_revision==action.context_revision&&Some(advice.recommendation_id)==action.recommendation_id&&advice.choice.action=="existing"&&advice.choice.agent_ids.first().is_some_and(|a|a==target),"Prediction changed; inspect the current target");
                }}
                tx.execute("INSERT INTO bindings(source,conversation,thread_key,agent_id) VALUES(?1,?2,?3,?4) ON CONFLICT(source,conversation,thread_key) DO UPDATE SET agent_id=excluded.agent_id",params![item.signal.source,item.signal.conversation,item.signal.thread_key,target])?;
                let fresh=members.iter().filter(|m|m.state==InboxState::Waiting).collect::<Vec<_>>();
                let targets=if action.targets.is_empty() {vec![target.to_owned()]}else{action.targets.clone()};
                anyhow::ensure!(targets.first().is_some_and(|t|t==target)&&targets.iter().collect::<HashSet<_>>().len()==targets.len(),"Invalid target selection");
                if action.action=="route" {anyhow::ensure!(targets.len()==1,"A prediction selects one exact destination");}
                for target in &targets {
                    anyhow::ensure!(tx.query_row("SELECT EXISTS(SELECT 1 FROM agents WHERE id=?1 AND archived=0)",[target],|r|r.get::<_,bool>(0))?,"Selected conversation is unavailable");
                    let quiet_epoch=tx.query_row("SELECT value FROM kv WHERE key=?1",[format!("quiet-stop:{target}")],|r|r.get::<_,String>(0)).optional()?;
                    let queued=InboxRoute{request_id:format!("{}:{target}",action.request_id),target:target.into(),quiet_epoch,text:format!("{}\n\nAccepted incoming messages:\n{}",route_text.context("Internal source context is required")?,fresh.iter().map(|m|format!("[{}] {}: {}",m.review.as_ref().map(|r|r.state.as_str()).unwrap_or("unreviewed"),m.signal.id,m.signal.text)).collect::<Vec<_>>().join("\n\n"))};
                    tx.execute("INSERT INTO kv(key,value) VALUES(?1,?2)",params![format!("inbox-route:{}",queued.request_id),serde_json::to_string(&queued)?])?;
                }
                for member in fresh {tx.execute("UPDATE signals SET state='done',outcome='routed internally',agent_ids=?2 WHERE id=?1",params![member.signal.id,serde_json::to_string(&targets)?])?;}
            }
            let detail=serde_json::json!({"signal":id,"action":action});
            tx.execute("INSERT INTO entries(agent_id,at,kind,text,detail,item_id) VALUES(?1,?2,'you',?3,?4,?5)",params![actor,crate::model::now(),match action.action.as_str(){"resolve"=>"Mark Inbox item resolved","reopen"=>"Review Inbox item again","draft"=>"Generate local Inbox draft","save_draft"=>"Edit local Inbox draft",_=>"Route Inbox item internally"},detail.to_string(),action.request_id])?;
            let entry=tx.last_insert_rowid();
            match action.action.as_str() {
                "resolve"|"reopen"=>{
                    for mut member in members {
                        Self::decorate_inbox_review(&tx,&mut member)?;
                        let mut changed=member.review.unwrap_or_default();changed.state=if action.action=="resolve" {"resolved"}else{"unreviewed"}.into();
                        changed.reason=if action.action=="resolve" {"Marked resolved by you"}else{""}.into();changed.resolved_by=(action.action=="resolve").then_some(entry);
                        tx.execute("INSERT INTO kv(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![format!("inbox-review:{}",member.signal.id),serde_json::to_string(&changed)?])?;
                        if action.action=="reopen" {tx.execute("DELETE FROM kv WHERE key=?1",[format!("routing-advice:{}",member.signal.id)])?;}
                        if member.signal.id==id {review=changed;}
                    }
                },
                "draft"|"save_draft"=>{let text=draft.context("Local draft is required")?;anyhow::ensure!(text.len()<=16000,"Draft is too long");review.draft=Some(text.into());review.draft_revision=Some(action.revision);review.draft_context_revision=Some(action.context_revision);},
                "route"|"route_manual"=>{},_=>anyhow::bail!("Invalid Inbox action")
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
            let action=|kind:&str|InboxAction{targets:vec![],members:vec![],request_id:uuid::Uuid::new_v4().to_string(),revision:item.revision,context_revision:item.context_revision,action:kind.into(),target:None,recommendation_id:None,draft:None};
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

impl Store {
    pub fn inbox_authenticated_users(&self,signal:&Signal)->Result<Vec<String>> {self.read(|c|Self::inbox_users_from(c,signal))}
    fn inbox_users_from(c:&Connection,signal:&Signal)->Result<Vec<String>> {
        if signal.source==crate::inbox::SLACK {return Ok(signal.conversation.split(':').nth(1).map(|s|vec![s.to_owned()]).unwrap_or_default());}
        let saved:Option<String>=c.query_row("SELECT value FROM kv WHERE key=?1",[format!("source-account:outlook:{}",signal.conversation)],|r|r.get(0)).optional()?;
        Ok(saved.map(|s|serde_json::from_str(&s)).transpose()?.unwrap_or_default())
    }
    pub(super) fn validate_response_evidence(c:&Connection,signal:&Signal,state:&str,evidence:&[String])->Result<()> {
        anyhow::ensure!(evidence.len()<=20,"Too many response evidence records");
        if state=="response_needed" {return Ok(());}
        anyhow::ensure!(!evidence.is_empty(),"A terminal response assessment requires retained source evidence");
        anyhow::ensure!(state!="no_response_needed"||evidence.contains(&signal.external_id),"No-response assessment must cite the exact incoming source message");
        let parts=signal.conversation.split(':').collect::<Vec<_>>();
        let direct=if signal.source==crate::inbox::SLACK&&parts.len()==3 {c.query_row("SELECT EXISTS(SELECT 1 FROM kv WHERE key=?1)",[format!("inbox-dm:{}:{}",parts[0],parts[2])],|r|r.get::<_,bool>(0))?}else{false};
        let owners=Self::inbox_users_from(c,signal)?;let mut answered=false;
        let activity=c.query_row("SELECT activity FROM slack_inbox_messages WHERE conversation=?1 AND ts=?2",params![signal.conversation,signal.external_id],|r|r.get::<_,f64>(0)).optional()?.unwrap_or(signal.at);
        for id in evidence {
            let record=c.query_row("SELECT author,at,thread_key FROM inbox_messages WHERE source=?1 AND conversation=?2 AND external_id=?3",params![signal.source,signal.conversation,id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,f64>(1)?,r.get::<_,String>(2)?))).optional()?.context("Response evidence is outside the retained source conversation")?;
            anyhow::ensure!(record.2==signal.thread_key||direct,"Response evidence belongs to a different source thread");
            answered|=record.1>activity&&owners.iter().any(|owner|owner.eq_ignore_ascii_case(&record.0));
        }
        anyhow::ensure!(state!="answered"||answered,"An answer requires a later authenticated-user source reply");
        Ok(())
    }
}

#[cfg(test)]
mod evidence_tests {
    use super::*;
    #[test]
    fn reviewed_source_evidence_projects_without_closing_work()->Result<()> {
        for (owner,sender) in [("reader-a","source-a"),("reader-b","source-b")] {
            let store=Store::in_memory()?;let conversation=format!("workspace:{owner}:direct");store.set("inbox-dm:workspace:direct","true")?;
            let raw=serde_json::json!({"ts":"100","thread_ts":"100","user":sender,"text":"Source observation"});store.observe_slack_dm(&conversation,&raw,110.0)?;
            let signal=Signal{id:"incoming".into(),source:crate::inbox::SLACK.into(),conversation:conversation.clone(),thread_key:"100".into(),external_id:"100".into(),author:sender.into(),text:"Source observation".into(),at:100.0,label:"Source conversation".into(),attachments:vec![],root:true};store.import_inbox(&signal,"")?;
            let item=store.inbox_item(&signal.id)?.unwrap();
            assert!(store.save_inbox_assessment(&signal.id,item.revision,item.context_revision,"answered","Reply is required",&["100".into()]).is_err(),"An incoming participant is not a later owner answer");
            assert!(store.save_inbox_assessment(&signal.id,item.revision,item.context_revision,"no_response_needed","Context only",&["missing".into()]).is_err(),"Missing source evidence cannot suppress an obligation");
            store.save_inbox_assessment(&signal.id,item.revision,item.context_revision,"no_response_needed","Source statement asks nothing further",&["100".into()])?;
            assert_eq!(store.inbox_review(&signal.id)?.evidence_message_ids,vec!["100"]);
            store.cache_inbox_context(&Signal{text:"Edited source observation".into(),..signal.clone()})?;assert_eq!(store.inbox_review(&signal.id)?.state,"unreviewed","Changed cited evidence requires fresh semantic inspection");store.cache_inbox_context(&signal)?;
            let entry=store.add_entry("coordinator",111.0,EntryKind::Said,"Source context reviewed against the current request","","")?.id;
            let mut triage=store.focus_inbox(Some("slack"),Some("direct:100"))?.items.remove(0);triage.state="resolved".into();triage.summary="Current source review establishes resolution".into();triage.resolution_entries=vec![entry];
            store.update_focus_inbox(&super::super::FocusInboxUpdate{items:vec![triage],..Default::default()},112.0)?;
            let projected=store.inbox_item(&signal.id)?.unwrap();assert_eq!(projected.review.unwrap().state,"resolved");assert_eq!(projected.state,InboxState::Waiting,"Source routing and tasks remain independent");assert_eq!(store.inbox_snapshot(100)?.2,0);
            let mut edited=raw.clone();edited["text"]=serde_json::json!("Changed source request");edited["edited"]=serde_json::json!({"ts":"113"});store.observe_slack_dm(&conversation,&edited,114.0)?;
            store.import_inbox(&Signal{text:"Changed source request".into(),..signal.clone()},"")?;
            assert_eq!(store.inbox_review(&signal.id)?.state,"unreviewed","A stale disposition cannot suppress an edited request");
        }Ok(())
    }
}
