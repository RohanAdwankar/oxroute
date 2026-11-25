use super::*;
use serde::{Deserialize,Serialize};

/// Local response assessment is independent of routing, source history and task completion.
#[derive(Clone,Debug,Default,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct InboxReview {
    pub revision:i64,
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
        if review.revision!=item.revision||review.resolved_by.is_none() {
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
