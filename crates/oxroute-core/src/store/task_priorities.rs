//! Evidence-backed sidebar order. Human movement continues to use task positions.
use super::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct TaskPriority {
    #[serde(default,skip_serializing_if="String::is_empty")]
    pub task_id: String,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub review_id: Option<String>,
    pub basis: String,
    pub next_action: String,
    pub reason: String,
    pub next_actor: String,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub human_reason: Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub unblocks: Option<String>,
    pub urgency: String,
    pub impact: String,
    pub effort: String,
    pub deadline_at: Option<f64>,
    pub evidence_entry_ids: Vec<i64>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub after_response_entry_id: Option<i64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct TaskPriorityOrder {pub request_id:String, pub focus_context_entry_id:i64, pub items:Vec<TaskPriority>}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct TaskPriorityState {pub decision_revision:Option<String>,pub position:f64, pub basis:String, pub stale:bool, pub needs_review:bool, pub recommendation:Option<TaskPriority>}

#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct ReviewPriorityState {pub id:String,pub agent_id:String,pub title:String,pub status:String,#[serde(flatten)]pub state:TaskPriorityState}

// Task facts invalidate stale actions. Advanced conversation context requests
// reconciliation without assuming an unrelated message resolved the outcome.
pub(super) fn states(c:&Connection, all:bool)->Result<HashMap<String,TaskPriorityState>> {
    let mut query=c.prepare(&format!("SELECT t.id,
        json_array(t.text,t.status,t.agent_id,t.parent_task_id,t.blocked_by_task_id,t.updated_at,
            COALESCE(n.revision,0),
            (SELECT json_array(b.status,b.updated_at,b.agent_id,
                (SELECT COALESCE(MAX(rowid),0) FROM task_notes WHERE task_id=b.id))
             FROM tasks b WHERE b.id=t.blocked_by_task_id)),
        p.basis,p.details,
        json_array((SELECT COALESCE(MAX(id),0) FROM entries WHERE agent_id=t.agent_id AND kind IN ('you','received','said','asked')),
            (SELECT COALESCE(MAX(id),0) FROM entries WHERE agent_id=(SELECT agent_id FROM tasks WHERE id=t.blocked_by_task_id) AND kind IN ('you','received','said','asked'))),t.position
        FROM tasks t
        LEFT JOIN (SELECT task_id,MAX(rowid) revision FROM task_notes GROUP BY task_id) n ON n.task_id=t.id
        LEFT JOIN task_priorities p ON p.task_id=t.id WHERE t.status!='complete' {}",if all {""} else {"AND p.task_id IS NOT NULL"}))?;
    let reviewed_context:Option<String>=c.query_row("SELECT value FROM kv WHERE key='task-priority-focus-context'",[],|r|r.get(0)).optional()?;
    let context_changed=reviewed_context.as_deref()!=Some(focus_context(c)?.to_string().as_str());
    let rows=query.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,Option<String>>(3)?,r.get::<_,String>(4)?,r.get::<_,f64>(5)?)))?;
    rows.map(|row| {
        let (id,task_basis,saved,details,source_context,position)=row?;
        let task_basis=fingerprint(&task_basis);
        let basis=format!("{}:{}",task_basis,fingerprint(&source_context));
        let stale=saved.as_ref().is_some_and(|saved|saved.split(':').next()!=Some(task_basis.as_str()));
        let needs_review=saved.as_ref().is_some_and(|saved|*saved!=basis || context_changed);
        let mut recommendation:Option<TaskPriority>=if stale {None} else {details.map(|details|serde_json::from_str(&details)).transpose()?};
        let decision_revision=filter_responses(c,&mut recommendation)?;
        Ok((id,TaskPriorityState{decision_revision,position,basis,stale,needs_review,recommendation}))
    }).collect()
}
pub(super) fn review_states(c:&Connection,all:bool)->Result<HashMap<String,ReviewPriorityState>> {
    let mut q=c.prepare(&format!("SELECT r.value,p.value,
        (SELECT COALESCE(MAX(id),0) FROM entries WHERE agent_id=json_extract(r.value,'$.agentId') AND kind IN ('you','received','said','asked')),o.value
        FROM kv r LEFT JOIN kv p ON p.key='focus-review-priority:'||json_extract(r.value,'$.id')
        LEFT JOIN kv o ON o.key='review-status:'||json_extract(r.value,'$.id')
        WHERE r.key GLOB 'review:*' AND json_type(r.value,'$.id')='text' AND json_type(r.value,'$.agentId')='text'
        AND COALESCE(json_extract(r.value,'$.decision.status'),'')!='approved' AND COALESCE(json_extract(r.value,'$.staleNotified'),0)=0 {}",if all {""}else{"AND p.key IS NOT NULL"}))?;
    let context:Option<String>=c.query_row("SELECT value FROM kv WHERE key='task-priority-focus-context'",[],|r|r.get(0)).optional()?;
    let advanced=context.as_deref()!=Some(focus_context(c)?.to_string().as_str());
    let rows=q.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,i64>(2)?,r.get::<_,Option<String>>(3)?)))?;
    rows.map(|row| {
        let (raw,saved,source,observed)=row?;let meta:Value=serde_json::from_str(&raw)?;
        let observed:Option<Value>=observed.map(|s|serde_json::from_str(&s)).transpose()?;
        let status=observed.as_ref().filter(|o|o["subject"]==meta["subject"]).and_then(|o|o["status"].as_str()).unwrap_or("unverified").to_owned();
        let basis=format!("{}:{}",fingerprint(&raw),fingerprint(&(source,&status)));
        let saved:Option<Value>=saved.map(|s|serde_json::from_str(&s)).transpose()?;
        let stale=saved.as_ref().is_some_and(|s|status!="pending"||s["basis"].as_str().and_then(|b|b.split(':').next())!=basis.split(':').next());
        let needs_review=saved.as_ref().is_some_and(|s|stale||s["basis"]!=basis||advanced);
        let mut recommendation:Option<TaskPriority>=if stale {None}else{saved.as_ref().map(|s|serde_json::from_value(s["item"].clone())).transpose()?};
        let decision_revision=filter_responses(c,&mut recommendation)?;
        let id=meta["id"].as_str().context("review identity missing")?.to_owned();
        Ok((id.clone(),ReviewPriorityState{id,agent_id:meta["agentId"].as_str().context("review owner missing")?.into(),title:meta["title"].as_str().unwrap_or("Change review").into(),status,state:TaskPriorityState{decision_revision,position:saved.as_ref().and_then(|s|s["position"].as_f64()).unwrap_or(f64::MAX),basis,stale,needs_review,recommendation}}))
    }).collect()
}
#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct DecisionReference {pub id:String,pub revision:String}

fn identity(item:&TaskPriority)->&str {item.review_id.as_deref().unwrap_or(&item.task_id)}
fn decision_revision(item:&TaskPriority)->String {fingerprint(&(identity(item),item.basis.split(':').next(),&item.evidence_entry_ids,item.after_response_entry_id))}
fn filter_responses(c:&Connection,item:&mut Option<TaskPriority>)->Result<Option<String>> {
 let Some(value)=item else{return Ok(None)};let revision=decision_revision(value);
 let consumed:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM kv WHERE key=?1)",[format!("decision-response:{}:{revision}",identity(value))],|row|row.get(0))?;
 if consumed&&value.next_actor=="human" {*item=None;}Ok(Some(revision))
}
pub(super) fn consume_decision(c:&Connection,entry:&Entry,reference:&DecisionReference)->Result<()> {
 anyhow::ensure!(!reference.id.is_empty()&&!reference.revision.is_empty()&&reference.revision.len()<=100,"Invalid decision reference");
 let known:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM tasks WHERE id=?1 UNION SELECT 1 FROM kv WHERE key='review:'||?1)",[&reference.id],|row|row.get(0))?;
 if !known {return Ok(())}
 let receipt=json!({"entryId":entry.id,"agentId":entry.agent_id,"revision":reference.revision}).to_string();
 c.execute("INSERT OR IGNORE INTO kv VALUES(?1,?2)",params![format!("decision-response:{}:{}",reference.id,reference.revision),receipt])?;
 c.execute("INSERT INTO kv VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE json_extract(kv.value,'$.entryId')<json_extract(excluded.value,'$.entryId')",params![format!("decision-latest-response:{}",reference.id),receipt])?;Ok(())
}
pub(super) fn consume_quotes(c:&Connection,entry:&Entry)->Result<()> {
 if let Some(raw)=entry.detail.strip_prefix("diff-attachments:") {
  for quote in serde_json::from_str::<Vec<Value>>(raw)? {
   if let Some(reference)=quote.get("decision").filter(|value|!value.is_null()) {consume_decision(c,entry,&serde_json::from_value(reference.clone())?)?;}
  }
 }Ok(())
}

fn review_revision(states:&HashMap<String,ReviewPriorityState>)->String {
    let mut values:Vec<_>=states.iter().map(|(id,state)|(id,&state.state.basis)).collect();values.sort();fingerprint(&values)
}
fn fingerprint(value:&impl std::hash::Hash)->String {
    use std::hash::Hasher;
    let mut hash=std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hash);
    format!("{:016x}",hash.finish())
}
fn focus_context(c:&Connection)->Result<i64> {
    Ok(c.query_row("SELECT COALESCE(MAX(id),0) FROM entries WHERE agent_id=(SELECT value FROM kv WHERE key='focus.agent') AND kind IN ('you','received')",[],|row|row.get(0))?)
}
fn revision(states:&HashMap<String,TaskPriorityState>)->String {
    let mut revisions:Vec<_>=states.iter().map(|(id,state)|(id,&state.basis)).collect();
    revisions.sort();
    fingerprint(&revisions)
}
impl Store {
    pub fn review_priority_states(&self,all:bool)->Result<HashMap<String,ReviewPriorityState>> {self.read(|c|review_states(c,all))}

    pub fn task_priority_states(&self)->Result<HashMap<String,TaskPriorityState>> {self.read(|c|states(c,true))}

    pub fn task_priority_advice(&self)->Result<HashMap<String,TaskPriorityState>> {
        self.read(|c|states(c,false))
    }
    pub fn task_priority_review(&self)->Result<Value> {
        let states=self.task_priority_states()?;
        let reviews=self.review_priority_states(true)?;
        let context=self.read(focus_context)?;
        let revision=fingerprint(&(revision(&states),review_revision(&reviews),context));
        Ok(json!({"changed":self.get("task-priority-reviewed-revision")?.as_deref()!=Some(&revision),"revision":revision,"focusContextEntryId":context,
            "nextDeadlineAt":states.values().filter_map(|state|state.recommendation.as_ref()?.deadline_at).min_by(f64::total_cmp),
            "reviewTaskIds":states.iter().filter(|(_,state)|state.needs_review).map(|(id,_)|id).collect::<Vec<_>>(),
            "reviewIds":reviews.iter().filter(|(_,s)|s.state.needs_review).map(|(id,_)|id).collect::<Vec<_>>(),
            "staleTaskIds":states.iter().filter(|(_,state)|state.stale).map(|(id,_)|id).collect::<Vec<_>>()}))
    }

    /// Advice and order commit together; a retry never overwrites a newer manual move.
    pub fn prioritize_tasks(&self,focus:&str,order:&TaskPriorityOrder)->Result<Value> {
        uuid::Uuid::parse_str(&order.request_id)?;
        anyhow::ensure!(order.items.len()<=100,"at most 100 task priorities");
        let payload=serde_json::to_string(order)?;
        self.with(|c| {
            let tx=c.unchecked_transaction()?;
            let key=format!("task-priority-receipt:{}",order.request_id);
            let receipt:Option<String>=tx.query_row("SELECT value FROM kv WHERE key=?1",[&key],|r|r.get(0)).optional()?;
            if let Some(receipt)=receipt {
                let saved:Value=serde_json::from_str(&receipt)?;
                anyhow::ensure!(saved["payload"]==payload && saved["focusId"]==focus,"requestId already used for another priority order");
                return Ok(saved["receipt"].clone());
            }
            let context=focus_context(&tx)?;
            anyhow::ensure!(context==order.focus_context_entry_id,"Focus context advanced; reconcile latest human instructions before prioritizing");
            let current=states(&tx,true)?;let reviews=review_states(&tx,true)?;
            let mut seen=HashSet::new();let mut ordered=Vec::new();
            for item in &order.items {
                let (key,owner,blocker)=if let Some(id)=&item.review_id {
                    let review=reviews.get(id).context("choose a current pending review")?;
                    anyhow::ensure!(review.status=="pending","inspect the actual current review before prioritizing; stale or unverified artifacts are not ready decisions");
                    anyhow::ensure!(review.state.basis==item.basis,"review evidence changed; inspect the current review");
                    anyhow::ensure!(item.next_actor=="human","a review decision requires human action");
                    if !item.task_id.is_empty() {anyhow::ensure!(tx.query_row("SELECT EXISTS(SELECT 1 FROM tasks WHERE id=?1 AND agent_id=?2)",params![item.task_id,review.agent_id],|r|r.get::<_,bool>(0))?,"linked task does not belong to the review owner");}
                    (format!("review:{id}"),review.agent_id.clone(),String::new())
                }else{
                    anyhow::ensure!(current.get(&item.task_id).is_some_and(|state|state.basis==item.basis),"task evidence changed; inspect current task and source before prioritizing");
                    let (status,owner,blocker):(String,String,String)=tx.query_row("SELECT status,agent_id,blocked_by_task_id FROM tasks WHERE id=?1",[&item.task_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
                    anyhow::ensure!(status!="complete","completed tasks cannot be promoted");
                    (format!("task:{}",item.task_id),owner,blocker)
                };
                let first=seen.insert(key);anyhow::ensure!(first||item.review_id.is_some(),"duplicate task priority");
                for text in [&item.next_action,&item.reason] {anyhow::ensure!(!text.trim().is_empty() && text.chars().count()<=160,"next action and reason must be concise and nonempty");}
                anyhow::ensure!(["human","agent","other"].contains(&item.next_actor.as_str()) && ["urgent","normal"].contains(&item.urgency.as_str()) && ["substantial","routine"].contains(&item.impact.as_str()) && ["small","substantial"].contains(&item.effort.as_str()),"invalid priority dimensions");
                if item.next_actor=="human" {
                    for text in [&item.human_reason,&item.unblocks] {
                        anyhow::ensure!(text.as_ref().is_some_and(|text|!text.trim().is_empty()&&text.chars().count()<=160),"human decisions need a concise reason human input is required and what it unblocks");
                    }
                }
                anyhow::ensure!(item.deadline_at.is_none_or(|deadline|deadline.is_finite() && deadline>0.0),"invalid factual deadline");
                anyhow::ensure!(!item.evidence_entry_ids.is_empty() && item.evidence_entry_ids.len()<=10,"cite actual source evidence");
                for evidence in &item.evidence_entry_ids {
                    let valid:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM entries WHERE id=?1 AND (agent_id=?2 OR agent_id=?3 OR agent_id=(SELECT agent_id FROM tasks WHERE id=?4)))",params![evidence,owner,focus,blocker],|r|r.get(0))?;
                    anyhow::ensure!(valid,"priority evidence must belong to the task owner, blocker owner or Focus");
                }
                if item.next_actor=="human" {
                    let previous:Option<String>=tx.query_row("SELECT value FROM kv WHERE key=?1",[format!("decision-latest-response:{}",identity(item))],|row|row.get(0)).optional()?;
                    if let Some(previous)=previous {
                        let response=serde_json::from_str::<Value>(&previous)?["entryId"].as_i64().context("decision response entry missing")?;
                        anyhow::ensure!(item.after_response_entry_id==Some(response),"Decision already answered; a new follow-up must explicitly address the recorded response");
                        let mut fresh=false;
                        for id in &item.evidence_entry_ids {fresh|=tx.query_row("SELECT EXISTS(SELECT 1 FROM entries WHERE id=?1 AND id>?3 AND ((agent_id=?2 AND ((kind IN ('you','said','asked') AND length(trim(text))>0) OR (kind='worked' AND length(trim(output))>0))) OR (agent_id=?4 AND kind='you' AND length(trim(text))>0)))",params![id,owner,response,focus],|row|row.get::<_,bool>(0))?;}
                        anyhow::ensure!(fresh,"Address the response with fresh owning-source evidence before presenting a new follow-up");
                    }
                }
                if first {ordered.push(item);}
            }
            let task_ids:HashSet<_>=ordered.iter().filter(|i|i.review_id.is_none()).map(|i|i.task_id.as_str()).collect();
            let remaining:Vec<String>={let mut q=tx.prepare("SELECT id FROM tasks ORDER BY position,created_at")?;let ids=q.query_map([],|r|r.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?;ids};
            tx.execute("INSERT INTO kv VALUES('task-priority-reviewed-revision',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[fingerprint(&(revision(&current),review_revision(&reviews),context))])?;
            tx.execute("INSERT INTO kv VALUES('task-priority-focus-context',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[context.to_string()])?;
            tx.execute("DELETE FROM task_priorities",[])?;
            tx.execute("DELETE FROM kv WHERE key GLOB 'focus-review-priority:*'",[])?;
            for (position,item) in ordered.iter().enumerate() {
                if let Some(id)=&item.review_id {
                    let source:i64=tx.query_row("SELECT COALESCE(MAX(id),0) FROM entries WHERE agent_id=?1 AND kind IN ('you','received','said','asked')",[&reviews[id].agent_id],|r|r.get(0))?;
                    tx.execute("INSERT INTO kv VALUES(?1,?2)",params![format!("focus-review-priority:{id}"),json!({"basis":item.basis,"item":item,"sourceContext":source,"position":position}).to_string()])?;
                }else{
                    tx.execute("UPDATE tasks SET position=?2 WHERE id=?1",params![item.task_id,position as f64])?;
                    tx.execute("INSERT INTO task_priorities VALUES(?1,?2,?3)",params![item.task_id,item.basis,serde_json::to_string(item)?])?;
                }
            }
            for (at,id) in remaining.iter().filter(|id|!task_ids.contains(id.as_str())).enumerate(){tx.execute("UPDATE tasks SET position=?2 WHERE id=?1",params![id,(ordered.len()+at) as f64])?;}
            let receipt=json!({"status":"completed","requestId":order.request_id,"taskIds":ordered.iter().filter(|i|!i.task_id.is_empty()).map(|i|&i.task_id).collect::<Vec<_>>(),"reviewIds":ordered.iter().filter_map(|i|i.review_id.as_ref()).collect::<Vec<_>>(),"meaning":"Decision order persisted; no task status, ownership or consent changed."});
            tx.execute("INSERT INTO kv VALUES(?1,?2)",params![key,json!({"focusId":focus,"payload":payload,"receipt":receipt}).to_string()])?;
            tx.commit()?;
            Ok(receipt)
        })
    }
}
