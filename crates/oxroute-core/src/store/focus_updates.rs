use super::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct FocusUpdate {
    pub request_id: String,
    pub kind: String,
    pub outcome_id: String,
    pub source_agent_id: String,
    pub source_request_entry_id: i64,
    pub source_context_entry_id: i64,
    pub focus_cycle: i64,
    pub revision_entry_id: i64,
    #[serde(default)] pub text: String,
    #[serde(default)] pub existing_entry_id: Option<i64>,
    #[serde(default)] pub evidence_entry_ids: Vec<i64>,
    #[serde(default)] pub qualification: String,
    #[serde(default)] pub task_id: Option<String>,
    #[serde(default)] pub supersedes: Vec<String>,
    #[serde(default,skip_serializing_if="Option::is_none")] pub task_reopen_scope: Option<TaskReopenScope>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct TaskReopenScope {
    pub entry_id:i64,
    pub revision_entry_id:i64,
    pub outcome_ids:Vec<String>,
}

impl Store {
    pub fn task_reopen_entries(&self,agent:&str)->Result<Vec<Value>> {
        self.read(|c| {
            let mut q=c.prepare("SELECT t.id,CAST(k.value AS INTEGER),s.value FROM tasks t JOIN kv k ON k.key='task-reopened-entry:'||t.id
                LEFT JOIN kv s ON s.key='focus-task-reopen:'||(SELECT value FROM kv WHERE key='focus.agent')||':'||t.id||':'||k.value
                WHERE t.agent_id=?1 ORDER BY t.updated_at DESC LIMIT 10")?;
            let rows=q.query_map([agent],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,Option<String>>(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
            rows.into_iter().map(|(task,entry,scope)|Ok(json!({"taskId":task,"entryId":entry,"scope":scope.map(|scope|serde_json::from_str::<Value>(&scope)).transpose()?}))).collect()
        })
    }

    pub fn focus_update_receipt(&self, focus: &str, update: &FocusUpdate) -> Result<Option<Value>> {
        let payload=serde_json::to_string(update)?;
        self.read(|c| receipt(c,focus,&update.request_id,&payload))
    }

    /// A visible entry and its publication receipt commit together, never at wake acceptance.
    pub fn publish_focus_update(&self, focus: &str, u: &FocusUpdate, at: f64) -> Result<(Value,Option<Entry>)> {
        uuid::Uuid::parse_str(&u.request_id).context("requestId must be a UUID")?;
        anyhow::ensure!(matches!(u.kind.as_str(),"progress"|"decision"|"completion"),"choose progress, decision or completion");
        anyhow::ensure!(!u.outcome_id.trim().is_empty()&&u.outcome_id.len()<=200,"outcomeId must identify one stable outcome");
        anyhow::ensure!(u.text.len()<=16000&&u.evidence_entry_ids.len()<=10&&u.supersedes.len()<=10,"update is too large");
        let payload=serde_json::to_string(u)?;
        self.with(|c| {
            let tx=rusqlite::Transaction::new_unchecked(c,rusqlite::TransactionBehavior::Immediate)?;
            if let Some(saved)=receipt(&tx,focus,&u.request_id,&payload)? {return Ok((saved,None));}
            anyhow::ensure!(human(&tx,focus)?==u.focus_cycle,"Focus context changed; inspect the new user message");
            anyhow::ensure!(u.source_agent_id!=focus&&tx.query_row("SELECT EXISTS(SELECT 1 FROM agents WHERE id=?1)",[&u.source_agent_id],|r|r.get::<_,bool>(0))?,"choose an existing source conversation");
            anyhow::ensure!(human(&tx,&u.source_agent_id)?==u.source_context_entry_id,"source context changed; inspect newer messages before publishing");
            for (id,source_only) in [(u.source_request_entry_id,true),(u.revision_entry_id,false)] {
                let valid=id==0||tx.query_row("SELECT EXISTS(SELECT 1 FROM entries WHERE id=?1 AND kind IN ('you','received') AND (agent_id=?2 OR (?3=0 AND agent_id=?4)))",params![id,u.source_agent_id,source_only,focus],|r|r.get::<_,bool>(0))?;
                anyhow::ensure!(valid,"request and revision references must identify actual originating human entries");
            }
            anyhow::ensure!(u.revision_entry_id>=u.source_request_entry_id,"outcome revision precedes its originating request");
            if let Some(task)=&u.task_id {
                anyhow::ensure!(tx.query_row("SELECT EXISTS(SELECT 1 FROM tasks WHERE id=?1 AND agent_id=?2)",params![task,u.source_agent_id],|r|r.get::<_,bool>(0))?,"task does not belong to the cited source conversation");
            }
            if let Some(scope)=&u.task_reopen_scope {scope_reopen(&tx,focus,u,scope)?;}
            let reopened=outcome_reopened(&tx,focus,u)?;
            let revision=format!("{}:{reopened}",u.revision_entry_id);
            let newer:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM focus_updates WHERE focus_id=?1 AND source_agent=?2 AND outcome_id=?3 AND CAST(json_extract(payload,'$.revisionEntryId') AS INTEGER)>?4)",params![focus,u.source_agent_id,u.outcome_id,u.revision_entry_id],|r|r.get(0))?;
            anyhow::ensure!(!newer,"this outcome already has a newer user revision");
            if u.kind=="completion" {
                anyhow::ensure!(matches!(u.qualification.as_str(),"prepared"|"validated"|"live"),"qualify completion as prepared, validated or live");
                anyhow::ensure!(!u.evidence_entry_ids.is_empty(),"completion needs cited result evidence");
                for id in &u.evidence_entry_ids {
                    let valid:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM entries WHERE id=?1 AND agent_id=?2 AND id>?3 AND ((kind='said' AND trim(text)!='') OR (kind='worked' AND trim(detail)!='' AND trim(output)!='')))",params![id,u.source_agent_id,u.source_request_entry_id.max(u.revision_entry_id).max(reopened)],|r|r.get(0))?;
                    anyhow::ensure!(valid,"cite actual source result entries after the current request or reopen");
                }
            } else {anyhow::ensure!(u.qualification.is_empty(),"qualification only applies to completion");}
            anyhow::ensure!(u.kind!="progress"||u.supersedes.is_empty(),"progress updates cannot erase pending decisions");
            for old in &u.supersedes {
                let valid:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM focus_updates WHERE request_id=?1 AND focus_id=?2 AND outcome_id=?3 AND source_agent=?4)",params![old,focus,u.outcome_id,u.source_agent_id],|r|r.get(0))?;
                anyhow::ensure!(valid,"supersedes must reference this outcome's existing update");
            }
            if u.kind!="progress"||u.existing_entry_id.is_none() {
                let old:Option<(String,String)>=tx.query_row("SELECT u.request_id,u.receipt FROM focus_updates u JOIN entries e ON e.id=u.entry_id WHERE u.focus_id=?1 AND u.source_agent=?2 AND u.outcome_id=?3 AND u.revision=?4 AND u.kind=?5 AND u.qualification=?6 AND u.superseded_by IS NULL AND (?5 IN ('completion','progress') OR u.focus_cycle=?7) AND (?5!='progress' OR (e.text=?8 AND json_extract(u.payload,'$.evidenceEntryIds')=?9))",params![focus,u.source_agent_id,u.outcome_id,revision,u.kind,u.qualification,u.focus_cycle,u.text,serde_json::to_string(&u.evidence_entry_ids)?],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
                if let Some((_,old))=old.filter(|(id,_)|!u.supersedes.contains(id)) {
                    save_receipt(&tx,focus,u,&payload,&old)?;tx.commit()?;
                    return Ok((serde_json::from_str(&old)?,None));
                }
            }
            let (entry,new)=if let Some(id)=u.existing_entry_id {
                anyhow::ensure!(u.text.is_empty(),"existingEntryId classifies a visible message without sending it again");
                let entry=tx.query_row("SELECT id,agent_id,at,kind,text,detail,output,origin,reaction,slack_url,item_id FROM entries WHERE id=?1 AND agent_id=?2 AND kind='said'",params![id,focus],read_entry).optional()?.context("choose an existing Focus message")?;
                (entry,false)
            } else {
                anyhow::ensure!(!u.text.trim().is_empty(),"provide update text");
                let text=if u.kind=="completion" {format!("{}: {}",match u.qualification.as_str(){"prepared"=>"Prepared","validated"=>"Validated",_=>"Live"},u.text)}else{u.text.clone()};
                let entry=tx.query_row("INSERT INTO entries(agent_id,at,kind,text) VALUES(?1,?2,'said',?3) RETURNING id,agent_id,at,kind,text,detail,output,origin,reaction,slack_url,item_id",params![focus,at,text],read_entry)?;
                (entry,true)
            };
            tx.execute("UPDATE focus_updates SET superseded_by=?4 WHERE focus_id=?1 AND source_agent=?2 AND outcome_id=?3 AND kind='completion' AND revision!=?5 AND superseded_by IS NULL",params![focus,u.source_agent_id,u.outcome_id,u.request_id,revision])?;
            for old in &u.supersedes {tx.execute("UPDATE focus_updates SET superseded_by=?2 WHERE request_id=?1",params![old,u.request_id])?;}
            let result=json!({"status":"completed","meaning":"Visible Focus update recorded; no task approval or closure.","requestId":u.request_id,"entryId":entry.id,"kind":u.kind,"qualification":u.qualification});
            tx.execute("INSERT INTO focus_updates(request_id,focus_id,source_agent,outcome_id,source_request,focus_cycle,kind,qualification,entry_id,payload,receipt,revision) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12) ON CONFLICT(entry_id) DO UPDATE SET request_id=excluded.request_id,source_agent=excluded.source_agent,outcome_id=excluded.outcome_id,source_request=excluded.source_request,focus_cycle=excluded.focus_cycle,kind=excluded.kind,qualification=excluded.qualification,payload=excluded.payload,receipt=excluded.receipt,revision=excluded.revision,superseded_by=NULL",params![u.request_id,focus,u.source_agent_id,u.outcome_id,u.source_request_entry_id,u.focus_cycle,u.kind,u.qualification,entry.id,payload,result.to_string(),revision])?;
            save_receipt(&tx,focus,u,&payload,&result.to_string())?;
            tx.commit()?;Ok((result,new.then_some(entry)))
        })
    }

    pub fn focus_update_context(&self, focus:&str) -> Result<Value> {
        let cycle=self.last_human_entry(focus)?;
        self.read(|c| {
            let mut q=c.prepare("SELECT payload,entry_id,revision,superseded_by FROM focus_updates WHERE focus_id=?1 ORDER BY entry_id DESC LIMIT 30")?;
            let rows=q.query_map([focus],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?,r.get::<_,Option<String>>(3)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
            let mut updates=Vec::new();
            for (payload,entry,revision,superseded) in rows {
                let u:FocusUpdate=serde_json::from_str(&payload)?;
                updates.push(json!({"requestId":u.request_id,"entryId":entry,"kind":u.kind,"outcomeId":u.outcome_id,"sourceAgentId":u.source_agent_id,"sourceRequestEntryId":u.source_request_entry_id,"revisionEntryId":u.revision_entry_id,"qualification":u.qualification,"evidenceEntryIds":u.evidence_entry_ids,"taskId":u.task_id,"taskReopenScope":u.task_reopen_scope,"current":superseded.is_none()&&current(c,focus,&u,&revision)?,"supersededBy":superseded,"sourceContextAdvanced":human(c,&u.source_agent_id)?!=u.source_context_entry_id,"focusContextAdvanced":cycle!=u.focus_cycle}));
            }
            let mut q=c.prepare("SELECT payload,revision FROM focus_updates WHERE focus_id=?1 AND kind='decision' AND focus_cycle=?2 AND entry_id>?2 AND superseded_by IS NULL")?;
            let mut decisions=0;
            for row in q.query_map(params![focus,cycle],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))? {
                let (payload,revision)=row?;
                if current(c,focus,&serde_json::from_str(&payload)?,&revision)? {decisions+=1;}
            }
            Ok(json!({"focusCycle":cycle,"unansweredDecisions":decisions,"recentUpdates":updates}))
        })
    }

    pub fn unclassified_focus_messages(&self, focus:&str) -> Result<Vec<Entry>> {
        let cycle=self.last_human_entry(focus)?;
        self.read(|c| {
            let mut q=c.prepare("SELECT id,agent_id,at,kind,text,detail,output,origin,reaction,slack_url,item_id FROM entries e WHERE agent_id=?1 AND id>?2 AND kind='said' AND trim(text)!='' AND NOT EXISTS(SELECT 1 FROM focus_updates u WHERE u.entry_id=e.id) ORDER BY id DESC LIMIT 4")?;
            let rows=q.query_map(params![focus,cycle],read_entry)?.collect::<rusqlite::Result<Vec<_>>>()?;Ok(rows)
        })
    }
}

fn receipt(c:&Connection,focus:&str,id:&str,payload:&str)->Result<Option<Value>> {
    let row:Option<(String,String,String)>=c.query_row("SELECT focus_id,payload,receipt FROM focus_update_receipts WHERE request_id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    row.map(|(owner,saved,result)|{anyhow::ensure!(owner==focus&&saved==payload,"requestId already belongs to another update");Ok(serde_json::from_str(&result)?)}).transpose()
}
fn save_receipt(c:&Connection,focus:&str,u:&FocusUpdate,payload:&str,result:&str)->Result<()> {
    c.execute("INSERT INTO focus_update_receipts(request_id,focus_id,payload,receipt) VALUES(?1,?2,?3,?4)",params![u.request_id,focus,payload,result])?;Ok(())
}
fn human(c:&Connection,agent:&str)->Result<i64> {
    Ok(c.query_row("SELECT COALESCE(MAX(id),0) FROM entries WHERE agent_id=?1 AND kind IN ('you','received')",[agent],|r|r.get(0))?)
}
fn reopened(c:&Connection,task:Option<&str>)->Result<i64> {
    let Some(task)=task else {return Ok(0)};
    Ok(c.query_row("SELECT CAST(value AS INTEGER) FROM kv WHERE key=?1",[format!("task-reopened-entry:{task}")],|r|r.get(0)).optional()?.unwrap_or(0))
}
fn scope_key(focus:&str,task:&str,entry:i64)->String {format!("focus-task-reopen:{focus}:{task}:{entry}")}
fn scope_reopen(c:&Connection,focus:&str,u:&FocusUpdate,scope:&TaskReopenScope)->Result<()> {
    let task=u.task_id.as_deref().context("taskReopenScope requires taskId")?;
    anyhow::ensure!(scope.entry_id>0&&scope.entry_id==reopened(c,Some(task))?,"task reopen changed; inspect its current scope before classifying");
    let human:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM entries WHERE id=?1 AND kind IN ('you','received') AND agent_id IN (?2,?3))",params![scope.revision_entry_id,focus,u.source_agent_id],|r|r.get(0))?;
    anyhow::ensure!(human,"reopen scope must cite the actual source or Focus human request");
    anyhow::ensure!(!scope.outcome_ids.is_empty()&&scope.outcome_ids.len()<=10&&scope.outcome_ids.iter().all(|id|!id.trim().is_empty()&&id.len()<=200),"identify the reopened outcomes explicitly");
    let mut scope=scope.clone();scope.outcome_ids.sort();scope.outcome_ids.dedup();
    let payload=serde_json::to_string(&scope)?;let key=scope_key(focus,task,scope.entry_id);
    let saved:Option<String>=c.query_row("SELECT value FROM kv WHERE key=?1",[&key],|r|r.get(0)).optional()?;
    anyhow::ensure!(saved.as_ref().is_none_or(|saved|*saved==payload),"this task reopen already has a different outcome classification");
    c.execute("INSERT OR IGNORE INTO kv VALUES(?1,?2)",params![key,payload])?;
    // Normalize historical metadata, preserving visible entries and receipt payloads.
    c.execute("UPDATE focus_updates SET revision=CAST(json_extract(payload,'$.revisionEntryId') AS TEXT)||':0'
        WHERE focus_id=?1 AND json_extract(payload,'$.taskId')=?2 AND revision=CAST(json_extract(payload,'$.revisionEntryId') AS TEXT)||':'||?3
        AND outcome_id NOT IN (SELECT value FROM json_each(?4))",params![focus,task,scope.entry_id,serde_json::to_string(&scope.outcome_ids)?])?;
    Ok(())
}
fn outcome_reopened(c:&Connection,focus:&str,u:&FocusUpdate)->Result<i64> {
    let entry=reopened(c,u.task_id.as_deref())?;
    let Some(task)=&u.task_id else {return Ok(entry)};
    let scope:Option<String>=c.query_row("SELECT value FROM kv WHERE key=?1",[scope_key(focus,task,entry)],|r|r.get(0)).optional()?;
    Ok(if let Some(scope)=scope {let scope:TaskReopenScope=serde_json::from_str(&scope)?;if scope.outcome_ids.contains(&u.outcome_id){entry}else{0}}else{entry})
}
fn current(c:&Connection,focus:&str,u:&FocusUpdate,revision:&str)->Result<bool> {
    Ok(revision==format!("{}:{}",u.revision_entry_id,outcome_reopened(c,focus,u)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{now,new_id};
    fn fixture()->(Store,PathBuf) {
        let path=std::env::temp_dir().join(format!("{}.sqlite3",new_id("focus-updates")));
        let store=Store::open(&path).unwrap();
        for id in ["focus","source","other"] {
            store.save_agent(&Agent{id:id.into(),name:id.into(),backend:Backend::Codex,model:"fixture".into(),session_id:String::new(),cwd:"/tmp".into(),status:AgentStatus::Complete,activity:String::new(),permalink:String::new(),last_activity:now(),updated_at:now(),stall_reason:None,stall_alerted:false,pinned:false}).unwrap();
        }
        (store,path)
    }
    fn update(kind:&str,source:&str,request:i64)->FocusUpdate {
        FocusUpdate{request_id:uuid::Uuid::new_v4().to_string(),kind:kind.into(),outcome_id:"requested-result".into(),source_agent_id:source.into(),source_request_entry_id:request,source_context_entry_id:request,focus_cycle:0,revision_entry_id:request,text:"The requested result is available; its remaining limits are recorded.".into(),existing_entry_id:None,evidence_entry_ids:vec![],qualification:if kind=="completion"{"prepared".into()}else{String::new()},task_id:None,supersedes:vec![],task_reopen_scope:None}
    }
    fn add(store:&Store,source:&str,kind:EntryKind)->i64 {store.add_entry(source,now(),kind,"Representative source evidence","","").unwrap().id}
    #[test]
    fn completions_are_independent_of_pending_decisions_and_progress() {
        let (store,path)=fixture();
        let source=add(&store,"source",EntryKind::You);
        for index in 0..2 {let mut u=update("decision","source",source);u.outcome_id=format!("decision-{index}");store.publish_focus_update("focus",&u,now()).unwrap();}
        for index in 0..105 {let mut progress=update("progress","source",source);progress.text=format!("Recorded progress step {index}");store.publish_focus_update("focus",&progress,now()).unwrap();}
        let progress=update("progress","source",source);let original_progress=store.publish_focus_update("focus",&progress,now()).unwrap().0;
        let mut repeated=progress.clone();repeated.request_id=uuid::Uuid::new_v4().to_string();let count=store.timeline("focus",1000).unwrap().len();
        assert_eq!(store.publish_focus_update("focus",&repeated,now()).unwrap().0,original_progress);
        assert_eq!(store.timeline("focus",1000).unwrap().len(),count,"Unchanged progress does not flood with fresh request IDs");
        repeated.request_id=uuid::Uuid::new_v4().to_string();repeated.text="A materially changed progress result".into();assert!(store.publish_focus_update("focus",&repeated,now()).unwrap().1.is_some());
        assert_eq!(store.focus_update_context("focus").unwrap()["unansweredDecisions"],2);
        let other=add(&store,"other",EntryKind::You);let evidence=add(&store,"other",EntryKind::Said);
        let mut completion=update("completion","other",other);completion.evidence_entry_ids=vec![evidence];
        let (original,entry)=store.publish_focus_update("focus",&completion,now()).unwrap();assert!(entry.is_some());
        assert_eq!(store.focus_update_context("focus").unwrap()["unansweredDecisions"],2,"Completion needing no response does not add or erase decisions");
        let mut duplicate=completion.clone();duplicate.request_id=uuid::Uuid::new_v4().to_string();
        assert_eq!(store.publish_focus_update("focus",&duplicate,now()).unwrap().0,original);
        add(&store,"other",EntryKind::You);
        assert_eq!(store.publish_focus_update("focus",&duplicate,now()).unwrap().0,original,"Accepted duplicate IDs retain their original receipt after source changes");
        let mut stale=completion.clone();stale.request_id=uuid::Uuid::new_v4().to_string();assert!(store.publish_focus_update("focus",&stale,now()).is_err());
        drop(store);let store=Store::open(&path).unwrap();
        assert_eq!(store.publish_focus_update("focus",&completion,now()).unwrap().0,original,"Receipt survives restart independently of freshness");
        drop(store);std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn explicit_supersession_resolves_a_decision_without_touching_approval() {
        let (store,path)=fixture();let request=add(&store,"source",EntryKind::You);
        let original=update("decision","source",request);let original_receipt=store.publish_focus_update("focus",&original,now()).unwrap().0;
        let mut question=update("decision","source",request);question.supersedes=vec![original.request_id];
        let replacement=store.publish_focus_update("focus",&question,now()).unwrap().0;
        assert_ne!(replacement["entryId"],original_receipt["entryId"],"Explicit replacement publishes the current decision rather than deduplicating to the obsolete question");
        assert_eq!(store.focus_update_context("focus").unwrap()["unansweredDecisions"],1);
        let evidence=add(&store,"source",EntryKind::Said);let mut completion=update("completion","source",request);completion.evidence_entry_ids=vec![evidence];
        store.publish_focus_update("focus",&completion,now()).unwrap();
        assert_eq!(store.focus_update_context("focus").unwrap()["unansweredDecisions"],1,"Prepared completion does not implicitly clear approval questions");
        let mut progress=update("progress","source",request);progress.supersedes=vec![question.request_id.clone()];assert!(store.publish_focus_update("focus",&progress,now()).is_err());
        let mut resolution=update("decision","source",request);resolution.outcome_id="other-outcome".into();resolution.supersedes=vec![question.request_id.clone()];assert!(store.publish_focus_update("focus",&resolution,now()).is_err());
        completion.request_id=uuid::Uuid::new_v4().to_string();completion.qualification="validated".into();completion.supersedes=vec![question.request_id];
        store.publish_focus_update("focus",&completion,now()).unwrap();
        assert_eq!(store.focus_update_context("focus").unwrap()["unansweredDecisions"],0);
        assert!(store.tasks().unwrap().is_empty());drop(store);std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn user_revisions_and_task_reopens_require_fresh_result_evidence() {
        let (store,path)=fixture();let request=add(&store,"source",EntryKind::You);let evidence=add(&store,"source",EntryKind::Said);
        let mut task=TaskItem{id:"task-result".into(),text:"Requested outcome".into(),status:crate::model::TaskStatus::Done,parent_task_id:String::new(),blocked_by_task_id:String::new(),agent_id:"source".into(),position:0.0,images:vec![],created_at:now(),updated_at:now()};store.save_task(&task).unwrap();
        let mut u=update("completion","source",request);u.task_id=Some(task.id.clone());u.evidence_entry_ids=vec![evidence];let original=store.publish_focus_update("focus",&u,now()).unwrap().0;
        task.status=crate::model::TaskStatus::Incomplete;store.save_task(&task).unwrap();
        let mut reopened=u.clone();reopened.request_id=uuid::Uuid::new_v4().to_string();assert!(store.publish_focus_update("focus",&reopened,now()).is_err());
        reopened.evidence_entry_ids=vec![add(&store,"source",EntryKind::Said)];let fresh=store.publish_focus_update("focus",&reopened,now()).unwrap().0;assert_ne!(fresh["entryId"],original["entryId"]);
        assert_eq!(store.tasks().unwrap()[0].status,crate::model::TaskStatus::Incomplete,"Stage notification never closes or approves tracked work");
        let correction=add(&store,"focus",EntryKind::You);let mut revised=reopened.clone();revised.request_id=uuid::Uuid::new_v4().to_string();revised.focus_cycle=correction;revised.revision_entry_id=correction;
        assert!(store.publish_focus_update("focus",&revised,now()).is_err());revised.evidence_entry_ids=vec![add(&store,"source",EntryKind::Said)];store.publish_focus_update("focus",&revised,now()).unwrap();
        reopened.request_id=uuid::Uuid::new_v4().to_string();reopened.focus_cycle=correction;assert!(store.publish_focus_update("focus",&reopened,now()).is_err(),"An older outcome revision cannot reappear after a correction");
        assert_eq!(store.publish_focus_update("focus",&u,now()).unwrap().0,original);
        drop(store);std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn source_inspection_context_is_distinct_from_outcome_revision() {
        let (store,path)=fixture();let request=add(&store,"source",EntryKind::You);let evidence=add(&store,"source",EntryKind::Said);
        let unrelated=add(&store,"source",EntryKind::You);let mut u=update("completion","source",request);u.source_context_entry_id=unrelated;u.evidence_entry_ids=vec![evidence];
        store.publish_focus_update("focus",&u,now()).unwrap();
        let relevant=add(&store,"source",EntryKind::You);let mut correction=update("progress","source",request);correction.source_context_entry_id=relevant;correction.revision_entry_id=relevant;
        store.publish_focus_update("focus",&correction,now()).unwrap();
        let mut stale=u.clone();stale.request_id=uuid::Uuid::new_v4().to_string();stale.source_context_entry_id=relevant;
        assert!(store.publish_focus_update("focus",&stale,now()).is_err(),"A registered newer relevant revision supersedes old evidence");
        stale.revision_entry_id=relevant;assert!(store.publish_focus_update("focus",&stale,now()).is_err(),"Result must follow the relevant revision, not merely a refreshed inspection");
        stale.evidence_entry_ids=vec![add(&store,"source",EntryKind::Said)];store.publish_focus_update("focus",&stale,now()).unwrap();
        drop(store);std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn independent_outcomes_survive_a_scoped_task_reopen_without_republication() {
        let (store,path)=fixture();let request=add(&store,"source",EntryKind::You);let evidence=add(&store,"source",EntryKind::Said);
        let mut task=TaskItem{id:"shared-work".into(),text:"Deliver requested work".into(),status:TaskStatus::Done,parent_task_id:String::new(),blocked_by_task_id:String::new(),agent_id:"source".into(),position:0.0,images:vec![],created_at:now(),updated_at:now()};store.save_task(&task).unwrap();
        let mut prior=update("completion","source",request);prior.task_id=Some(task.id.clone());prior.evidence_entry_ids=vec![evidence];
        let prior_receipt=store.publish_focus_update("focus",&prior,now()).unwrap().0;
        let audit=add(&store,"source",EntryKind::You);task.status=TaskStatus::Incomplete;store.save_task(&task).unwrap();
        let visible=add(&store,"focus",EntryKind::Said);let count=store.timeline("focus",100).unwrap().len();
        let mut classified=prior.clone();classified.request_id=uuid::Uuid::new_v4().to_string();classified.outcome_id="artifact-delivery".into();classified.source_context_entry_id=audit;classified.text.clear();classified.existing_entry_id=Some(visible);
        assert!(store.publish_focus_update("focus",&classified,now()).is_err(),"An unclassified reopen stays conservative");
        classified.task_reopen_scope=Some(TaskReopenScope{entry_id:audit,revision_entry_id:audit,outcome_ids:vec!["independent-audit".into()]});
        let (receipt,entry)=store.publish_focus_update("focus",&classified,now()).unwrap();assert!(entry.is_none());assert_eq!(receipt["entryId"],visible);
        assert_eq!(store.timeline("focus",100).unwrap().len(),count,"Classification never republishes the result");
        let context=store.focus_update_context("focus").unwrap();assert!(context["recentUpdates"].as_array().unwrap().iter().any(|u|u["requestId"]==prior.request_id&&u["current"]==true),"Independent completed outcomes remain current");
        let mut same=classified.clone();same.request_id=uuid::Uuid::new_v4().to_string();same.outcome_id="independent-audit".into();same.existing_entry_id=None;same.text="The independent audit result is prepared.".into();
        assert!(store.publish_focus_update("focus",&same,now()).is_err(),"The actual reopened outcome still needs new evidence");
        same.evidence_entry_ids=vec![add(&store,"source",EntryKind::Said)];store.publish_focus_update("focus",&same,now()).unwrap();
        let correction=add(&store,"source",EntryKind::You);task.status=TaskStatus::Done;store.save_task(&task).unwrap();task.status=TaskStatus::Incomplete;store.save_task(&task).unwrap();
        let mut revised=classified.clone();revised.request_id=uuid::Uuid::new_v4().to_string();revised.source_context_entry_id=correction;
        assert!(store.publish_focus_update("focus",&revised,now()).is_err(),"An old scope cannot exempt a new reopen");
        revised.revision_entry_id=correction;revised.task_reopen_scope=Some(TaskReopenScope{entry_id:correction,revision_entry_id:correction,outcome_ids:vec![revised.outcome_id.clone()]});
        assert!(store.publish_focus_update("focus",&revised,now()).is_err(),"A genuine same-outcome correction rejects old results");
        revised.evidence_entry_ids=vec![add(&store,"source",EntryKind::Said)];store.publish_focus_update("focus",&revised,now()).unwrap();
        assert_eq!(store.publish_focus_update("focus",&prior,now()).unwrap().0,prior_receipt,"Retries preserve original publication receipts");
        assert_eq!(store.tasks().unwrap()[0].status,TaskStatus::Incomplete);
        drop(store);std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn focus_originated_requests_can_cite_recorded_tool_results() {
        let (store,path)=fixture();let request=add(&store,"focus",EntryKind::You);
        let output=store.add_work_entry("source",now(),"Inspection","Read artifact metadata","records=2","").unwrap().id;
        let mut u=update("completion","source",0);u.focus_cycle=request;u.revision_entry_id=request;u.evidence_entry_ids=vec![output];
        store.publish_focus_update("focus",&u,now()).unwrap();
        let empty=store.add_work_entry("source",now(),"Inspection","Read artifact metadata","","").unwrap().id;
        let foreign=store.add_work_entry("other",now(),"Inspection","Read artifact metadata","records=2","").unwrap().id;
        let coordination=add(&store,"source",EntryKind::Coordination);
        for evidence in [empty,foreign,coordination] {
            let mut invalid=u.clone();invalid.request_id=uuid::Uuid::new_v4().to_string();invalid.outcome_id=format!("other-{evidence}");invalid.evidence_entry_ids=vec![evidence];
            assert!(store.publish_focus_update("focus",&invalid,now()).is_err(),"Only recorded results from the cited source qualify");
        }
        drop(store);std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn unclassified_history_can_be_disposed_without_republication() {
        let (store,path)=fixture();let source=add(&store,"source",EntryKind::You);
        let legacy=add(&store,"focus",EntryKind::Said);let count=store.timeline("focus",100).unwrap().len();
        assert_eq!(store.unclassified_focus_messages("focus").unwrap().len(),1);
        assert_eq!(store.focus_update_context("focus").unwrap()["unansweredDecisions"],0,"Unknown legacy prose is not asserted to be a decision");
        let mut u=update("progress","source",source);u.text.clear();u.existing_entry_id=Some(legacy);assert!(store.publish_focus_update("focus",&u,now()).unwrap().1.is_none());
        assert!(store.unclassified_focus_messages("focus").unwrap().is_empty());assert_eq!(store.timeline("focus",100).unwrap().len(),count);
        let mut repeated=update("progress","source",source);repeated.text=store.timeline("focus",100).unwrap()[0].text.clone();
        assert_eq!(store.publish_focus_update("focus",&repeated,now()).unwrap().0["entryId"],legacy);
        assert_eq!(store.timeline("focus",100).unwrap().len(),count,"Legacy adoption and structured publication share the visible-text duplicate identity");
        drop(store);std::fs::remove_file(path).unwrap();
    }
}
