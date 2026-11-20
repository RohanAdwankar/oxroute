//! Evidence-backed sidebar order. Human movement continues to use task positions.
use super::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct TaskPriority {
    pub task_id: String,
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
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct TaskPriorityOrder {pub request_id:String, pub focus_context_entry_id:i64, pub items:Vec<TaskPriority>}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct TaskPriorityState {pub basis:String, pub stale:bool, pub needs_review:bool, pub recommendation:Option<TaskPriority>}

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
            (SELECT COALESCE(MAX(id),0) FROM entries WHERE agent_id=(SELECT agent_id FROM tasks WHERE id=t.blocked_by_task_id) AND kind IN ('you','received','said','asked')))
        FROM tasks t
        LEFT JOIN (SELECT task_id,MAX(rowid) revision FROM task_notes GROUP BY task_id) n ON n.task_id=t.id
        LEFT JOIN task_priorities p ON p.task_id=t.id WHERE t.status!='complete' {}",if all {""} else {"AND p.task_id IS NOT NULL"}))?;
    let reviewed_context:Option<String>=c.query_row("SELECT value FROM kv WHERE key='task-priority-focus-context'",[],|r|r.get(0)).optional()?;
    let context_changed=reviewed_context.as_deref()!=Some(focus_context(c)?.to_string().as_str());
    let rows=query.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,Option<String>>(3)?,r.get::<_,String>(4)?)))?;
    rows.map(|row| {
        let (id,task_basis,saved,details,source_context)=row?;
        let task_basis=fingerprint(&task_basis);
        let basis=format!("{}:{}",task_basis,fingerprint(&source_context));
        let stale=saved.as_ref().is_some_and(|saved|saved.split(':').next()!=Some(task_basis.as_str()));
        let needs_review=saved.as_ref().is_some_and(|saved|*saved!=basis || context_changed);
        let recommendation=if stale {None} else {details.map(|details|serde_json::from_str(&details)).transpose()?};
        Ok((id,TaskPriorityState{basis,stale,needs_review,recommendation}))
    }).collect()
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
    pub fn task_priority_states(&self)->Result<HashMap<String,TaskPriorityState>> {self.read(|c|states(c,true))}

    pub fn task_priority_advice(&self)->Result<HashMap<String,TaskPriorityState>> {
        self.read(|c|states(c,false))
    }
    pub fn task_priority_review(&self)->Result<Value> {
        let states=self.task_priority_states()?;
        let context=self.read(focus_context)?;
        let revision=fingerprint(&(revision(&states),context));
        Ok(json!({"changed":self.get("task-priority-reviewed-revision")?.as_deref()!=Some(&revision),"revision":revision,"focusContextEntryId":context,
            "nextDeadlineAt":states.values().filter_map(|state|state.recommendation.as_ref()?.deadline_at).min_by(f64::total_cmp),
            "reviewTaskIds":states.iter().filter(|(_,state)|state.needs_review).map(|(id,_)|id).collect::<Vec<_>>(),
            "staleTaskIds":states.iter().filter(|(_,state)|state.stale).map(|(id,_)|id).collect::<Vec<_>>()}))
    }

    pub fn clear_stale_task_priorities(&self)->Result<()> {
        self.with(|c| {
            for (id,state) in states(c,false)? {if state.stale {c.execute("DELETE FROM task_priorities WHERE task_id=?1",[id])?;}}
            Ok(())
        })
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
            let current=states(&tx,true)?;
            let mut seen=HashSet::new();
            for item in &order.items {
                anyhow::ensure!(seen.insert(&item.task_id),"duplicate task priority");
                anyhow::ensure!(current.get(&item.task_id).is_some_and(|state|state.basis==item.basis),"task evidence changed; inspect current task and source before prioritizing");
                let (status,owner,blocker):(String,String,String)=tx.query_row("SELECT status,agent_id,blocked_by_task_id FROM tasks WHERE id=?1",[&item.task_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
                anyhow::ensure!(status!="complete","completed tasks cannot be promoted");
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
            }
            let remaining:Vec<String>={let mut q=tx.prepare("SELECT id FROM tasks ORDER BY position,created_at")?;let ids=q.query_map([],|r|r.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?;ids};
            tx.execute("INSERT INTO kv VALUES('task-priority-reviewed-revision',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[fingerprint(&(revision(&current),context))])?;
            tx.execute("INSERT INTO kv VALUES('task-priority-focus-context',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[context.to_string()])?;
            tx.execute("DELETE FROM task_priorities",[])?;
            for (position,id) in order.items.iter().map(|item|&item.task_id).chain(remaining.iter().filter(|id|!seen.contains(id))).enumerate() {
                tx.execute("UPDATE tasks SET position=?2 WHERE id=?1",params![id,position as f64])?;
            }
            for item in &order.items {tx.execute("INSERT INTO task_priorities VALUES(?1,?2,?3)",params![item.task_id,item.basis,serde_json::to_string(item)?])?;}
            let receipt=json!({"status":"completed","requestId":order.request_id,"taskIds":order.items.iter().map(|item|&item.task_id).collect::<Vec<_>>(),"meaning":"Sidebar order persisted; no task status, ownership or consent changed."});
            tx.execute("INSERT INTO kv VALUES(?1,?2)",params![key,json!({"focusId":focus,"payload":payload,"receipt":receipt}).to_string()])?;
            tx.commit()?;
            Ok(receipt)
        })
    }
}
