use super::*;
use serde::{Serialize,Deserialize};

#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct InboxDestination {pub agent_id:String,pub blocked:bool}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct InboxMember {
    pub id:String,pub revision:i64,pub at:f64,pub preview:String,pub state:String,pub attention:String,pub source_url:Option<String>,
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct InboxGroup {pub key:String,pub history_count:usize,pub latest_at:f64,pub members:Vec<InboxMember>,pub draft:Option<String>}

impl Store {
    pub(super) fn inbox_destination_from(c:&Connection,signal:&Signal)->Result<Option<InboxDestination>> {
        let mut target=c.query_row("SELECT agent_id FROM bindings WHERE source=?1 AND conversation=?2 AND thread_key=?3",params![signal.source,signal.conversation,signal.thread_key],|r|r.get::<_,String>(0)).optional()?;
        if target.is_none()&&signal.source==crate::inbox::SLACK {
            let parts=signal.conversation.split(':').collect::<Vec<_>>();
            if let [team,owner,channel]=parts.as_slice() {
                let account:Option<String>=c.query_row("SELECT value FROM kv WHERE key='source-account:slack'",[],|r|r.get(0)).optional()?;
                if let Some(account)=account {
                    let account:serde_json::Value=serde_json::from_str(&account)?;
                    if account["account"]==*team&&account["owner"]==*owner {
                        target=c.query_row("SELECT agent_id FROM bindings WHERE source='slack' AND conversation=?1 AND thread_key=?2",params![channel,signal.thread_key],|r|r.get(0)).optional()?;
                    }
                }
            }
        }
        target.map(|agent_id|{
            let blocked=c.query_row("SELECT archived!=0 OR (status='stalled' AND COALESCE(stall_reason,'')='stopped') FROM agents WHERE id=?1",[&agent_id],|r|r.get::<_,bool>(0)).optional()?.unwrap_or(true);
            Ok(InboxDestination{agent_id,blocked})
        }).transpose()
    }
    pub fn inbox_destination(&self,signal:&Signal)->Result<Option<InboxDestination>> {self.read(|c|Self::inbox_destination_from(c,signal))}
    pub(crate) fn decorate_inbox_groups(&self,items:&mut[InboxItem],through:i64)->Result<()> {
        self.read(|c|{
            for item in items.iter_mut().filter(|item|crate::inbox::imported(&item.signal.source)) {
                let mut query=c.prepare("SELECT s.*,v.state AS attention,u.value AS source_url,r.value AS review_json FROM signals s JOIN inbox_arrivals a ON a.signal_id=s.id JOIN inbox_attention v ON v.id=s.id LEFT JOIN kv u ON u.key='inbox-url:'||s.id LEFT JOIN kv r ON r.key='inbox-review:'||s.id WHERE s.source=?1 AND s.conversation=?2 AND s.thread_key=?3 AND a.sequence<=?4 ORDER BY s.at,s.external_id")?;
                let mut rows=query.query(params![item.signal.source,item.signal.conversation,item.signal.thread_key,through])?;let mut members=vec![];let mut draft=None;
                while let Some(row)=rows.next()? {
                    if let Some(raw)=row.get::<_,Option<String>>("review_json")? {if let Some(text)=serde_json::from_str::<super::InboxReview>(&raw)?.draft {draft=Some(text);}}
                    members.push(InboxMember{id:row.get("id")?,revision:row.get("revision")?,at:row.get("at")?,preview:row.get::<_,String>("text")?.chars().take(200).collect(),state:row.get("state")?,attention:row.get("attention")?,source_url:row.get::<_,Option<String>>("source_url")?.filter(|url|reqwest::Url::parse(url).is_ok_and(|u|matches!(u.scheme(),"http"|"https")))});
                }
                let state=if members.iter().any(|m|m.attention=="response_needed") {"response_needed"}else if members.iter().any(|m|m.attention=="unreviewed") {"unreviewed"}else if members.iter().any(|m|m.attention=="answered") {"answered"}else if members.iter().any(|m|m.attention=="resolved") {"resolved"}else{"no_response_needed"};
                if let Some(review)=&mut item.review {review.state=state.into();}
                let latest_at=members.last().map(|m|m.at).unwrap_or(item.signal.at);
                let history_count=c.query_row("SELECT count(*) FROM inbox_messages WHERE source=?1 AND conversation=?2 AND thread_key=?3",params![item.signal.source,item.signal.conversation,item.signal.thread_key],|r|r.get(0))?;
                item.group=Some(InboxGroup{history_count,key:serde_json::to_string(&(&item.signal.source,&item.signal.conversation,&item.signal.thread_key))?,latest_at,members,draft});
            }Ok(())
        })
    }
}

impl Store {
    pub fn inbox_destination_pending(&self,signal:&Signal)->Result<bool> {
        if signal.source!=crate::inbox::SLACK {return Ok(false);}
        let parts=signal.conversation.split(':').collect::<Vec<_>>();
        let [_,_,channel]=parts.as_slice() else{return Ok(false)};
        self.read(|c|Ok(!c.query_row("SELECT EXISTS(SELECT 1 FROM kv WHERE key='source-account:slack')",[],|r|r.get::<_,bool>(0))?&&c.query_row("SELECT EXISTS(SELECT 1 FROM bindings WHERE source='slack' AND conversation=?1 AND thread_key=?2)",params![channel,signal.thread_key],|r|r.get::<_,bool>(0))?))
    }
    pub fn save_inbox_assessment(&self,id:&str,revision:i64,context_revision:i64,state:&str,reason:&str)->Result<bool> {
        anyhow::ensure!(matches!(state,"response_needed"|"no_response_needed"|"answered")&&!reason.trim().is_empty()&&reason.len()<=1200,"Invalid source response assessment");
        self.with(|c|{
            let tx=c.unchecked_transaction()?;let mut item=tx.query_row("SELECT * FROM signals WHERE id=?1",[id],read_item)?;
            Self::decorate_inbox_review(&tx,&mut item)?;
            if item.revision!=revision||item.context_revision!=context_revision {return Ok(false);}
            let mut review=item.review.unwrap_or_default();
            if review.resolved_by.is_none() {review.state=state.into();review.reason=reason.into();review.context_revision=context_revision;
                tx.execute("INSERT INTO kv(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![format!("inbox-review:{id}"),serde_json::to_string(&review)?])?;
            }
            tx.commit()?;Ok(true)
        })
    }
}

impl Store {
    pub fn inbox_action_evidence(&self,id:&str,action:&super::InboxAction)->Result<serde_json::Value> {
        self.read(|c|{
            let anchor=c.query_row("SELECT * FROM signals WHERE id=?1",[id],read_item)?;
            let scope=if action.members.is_empty(){vec![super::InboxScope{id:id.into(),revision:action.revision}]}else{action.members.clone()};
            anyhow::ensure!(scope.len()<=5000&&scope.iter().any(|s|s.id==id),"Invalid group snapshot");
            let mut evidence=Vec::new();let mut remaining=20000usize;let mut truncated=false;let mut seen=HashSet::new();
            for member in scope {
                anyhow::ensure!(seen.insert(member.id.clone()),"Duplicate group member");
                let item=c.query_row("SELECT * FROM signals WHERE id=?1",[&member.id],read_item)?;
                anyhow::ensure!(item.revision==member.revision&&item.signal.source==anchor.signal.source&&item.signal.conversation==anchor.signal.conversation&&item.signal.thread_key==anchor.signal.thread_key,"Group snapshot changed; refresh before acting");
                if remaining>0 {
                    let text=item.signal.text.chars().take(remaining.min(2000)).collect::<String>();truncated|=text.chars().count()<item.signal.text.chars().count();remaining=remaining.saturating_sub(text.chars().count());
                    evidence.push(serde_json::json!({"sourceId":member.id,"at":item.signal.at,"author":item.signal.author,"text":text}));
                }else{truncated=true;}
            }
            Ok(serde_json::json!({"messages":evidence,"contextTruncated":truncated}))
        })
    }
}

#[derive(Serialize,Deserialize,Clone)]
#[serde(rename_all="camelCase")]
pub struct InboxHistoryMessage {pub id:String,pub at:f64,pub author:String,pub text:String,pub source_url:Option<String>}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct InboxHistory {pub messages:Vec<InboxHistoryMessage>,pub has_earlier:bool}
impl Store {
    pub fn inbox_thread_history(&self,id:&str,cursor:Option<&str>)->Result<InboxHistory> {
        self.read(|c|{
            let item=c.query_row("SELECT * FROM signals WHERE id=?1",[id],read_item)?;
            let parts=item.signal.conversation.split(':').collect::<Vec<_>>();
            let profiles=if item.signal.source==crate::inbox::SLACK {inbox_display::slack_names(c,parts.first().copied().unwrap_or_default())?}else{HashMap::new()};
            let label=|id:&str|profiles.get(id).map(|p|p.name.clone()).filter(|s|!s.is_empty()).unwrap_or_else(||if parts.get(1)==Some(&id){"You"}else{"Source participant"}.into());
            let before=cursor.map(|cursor|c.query_row("SELECT at FROM inbox_messages WHERE source=?1 AND conversation=?2 AND thread_key=?3 AND external_id=?4",params![item.signal.source,item.signal.conversation,item.signal.thread_key,cursor],|r|r.get::<_,f64>(0))).transpose()?;
            let mut query=c.prepare("SELECT external_id,at,author,substr(text,1,4000) FROM inbox_messages WHERE source=?1 AND conversation=?2 AND thread_key=?3 AND (?4 IS NULL OR at<?4 OR (at=?4 AND external_id<?5)) ORDER BY at DESC,external_id DESC LIMIT 101")?;
            let mut rows=query.query(params![item.signal.source,item.signal.conversation,item.signal.thread_key,before,cursor.unwrap_or_default()])?;let mut messages=Vec::new();
            while let Some(row)=rows.next()? {
                let id:String=row.get(0)?;let raw:String=row.get(3)?;
                let source_url=if item.signal.source==crate::inbox::SLACK {parts.get(2).map(|channel|format!("https://app.slack.com/archives/{channel}/p{}",id.replace('.',"")))}else{None};
                messages.push(InboxHistoryMessage{id,at:row.get(1)?,author:label(&row.get::<_,String>(2)?),text:inbox_display::display_mentions(&raw,|id|label(id)),source_url});
            }
            let has_earlier=messages.len()>100;messages.truncate(100);messages.reverse();Ok(InboxHistory{messages,has_earlier})
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn source(id:&str,thread:&str,at:f64)->Signal {Signal{id:id.into(),source:crate::inbox::SLACK.into(),conversation:"workspace:reader:direct".into(),thread_key:thread.into(),external_id:id.into(),author:"participant".into(),text:format!("Retained source message {id}"),at,label:"Thread source".into(),attachments:vec![],root:false}}
    fn action(item:&InboxItem,kind:&str,target:Option<&str>)->super::super::InboxAction {
        super::super::InboxAction{request_id:uuid::Uuid::new_v4().to_string(),revision:item.revision,context_revision:item.context_revision,action:kind.into(),target:target.map(str::to_owned),targets:vec![],members:item.group.as_ref().unwrap().members.iter().map(|m|super::super::InboxScope{id:m.id.clone(),revision:m.revision}).collect(),recommendation_id:None,draft:None}
    }
    #[test]
    fn exact_thread_binding_group_scope_and_origin_survive_restart()->Result<()> {
        let dir=std::env::temp_dir().join(crate::model::new_id("thread-scope"));std::fs::create_dir_all(&dir)?;let path=dir.join("state.sqlite3");
        let store=Store::open(&path)?;store.set("inbox-dm:workspace:direct","true")?;
        store.with(|c|{for id in ["original","alternate"] {c.execute("INSERT INTO agents(id,name,backend,model,cwd,status,last_activity,updated_at) VALUES(?1,'Source owner','codex','fixture','/work','complete',1,1)",[id])?;}Ok(())})?;
        store.set("source-account:slack",r#"{"account":"workspace","owner":"reader","actor":"source-bot"}"#)?;
        store.bind("slack","direct","100.1","original")?;
        let first=source("101.1","100.1",101.1);store.import_inbox(&first,"https://example.test/first")?;
        assert_eq!(store.inbox_destination(&first)?.unwrap().agent_id,"original","An original binding wins before its root is collected");
        assert!(store.inbox_destination(&source("201.1","200.1",201.1))?.is_none(),"Unrelated roots are isolated");
        let mut other=first.clone();other.conversation="another:reader:direct".into();assert!(store.inbox_destination(&other)?.is_none(),"Workspace identity cannot be inferred from a channel/root collision");
        other.conversation="workspace:another-reader:direct".into();assert!(store.inbox_destination(&other)?.is_none(),"Account identity is preserved");
        let second=source("102.1","100.1",102.1);store.import_inbox(&second,"https://example.test/second")?;
        let assessed=store.inbox_item(&first.id)?.unwrap();store.save_inbox_assessment(&first.id,assessed.revision,assessed.context_revision,"response_needed","Source request remains unanswered")?;assert_eq!(store.inbox_review(&first.id)?.state,"response_needed");assert_eq!(store.inbox_snapshot(100)?.2,1);
        let snapshot=store.inbox(100)?.remove(0);assert_eq!(snapshot.group.as_ref().unwrap().members.len(),2);
        let resolve=action(&snapshot,"resolve",None);let route=action(&snapshot,"route",Some("original"));
        let later=source("103.1","100.1",103.1);store.import_inbox(&later,"https://example.test/later")?;
        store.save_inbox_action(&snapshot.signal.id,&resolve,"",None,None)?;
        assert_eq!(store.inbox_review(&first.id)?.state,"resolved");assert_eq!(store.inbox_review(&second.id)?.state,"resolved");assert_eq!(store.inbox_review(&later.id)?.state,"unreviewed","A later arrival survives a group resolution snapshot");
        store.save_inbox_action(&snapshot.signal.id,&route,"",None,Some("Internal source handoff"))?;
        assert_eq!(store.inbox_item(&later.id)?.unwrap().state,InboxState::Waiting,"A later arrival survives a group route snapshot");
        assert_eq!(store.inbox_item(&first.id)?.unwrap().state,InboxState::Done);
        let original_root=Signal{author:"reader".into(),..source("100.1","100.1",100.1)};store.import_inbox(&original_root,"")?;
        let history=store.inbox_thread_history(&later.id,None)?;assert_eq!(history.messages.len(),4);assert_eq!(history.messages[0].id,"100.1","A root collected later stays first in source chronology");
        let item=store.inbox(100)?.remove(0);let manual=action(&item,"route_manual",Some("alternate"));store.save_inbox_action(&item.signal.id,&manual,"",None,Some("Explicit manual reroute"))?;
        let fourth=source("104.1","100.1",104.1);store.import_inbox(&fourth,"")?;assert_eq!(store.inbox_destination(&fourth)?.unwrap().agent_id,"alternate","Accepted manual rerouting takes precedence over the original binding");
        drop(store);let store=Store::open(&path)?;assert_eq!(store.inbox_destination(&fourth)?.unwrap().agent_id,"alternate");
        assert_eq!(store.inbox(100)?.len(),1);assert_eq!(store.inbox(100)?[0].group.as_ref().unwrap().members.len(),4);
        store.set_agent_status("alternate",crate::model::AgentStatus::Working,1.0)?;store.stall_agent("alternate","stopped",2.0)?;assert!(store.inbox_destination(&fourth)?.unwrap().blocked,"Inheritance cannot resume a stopped owner");
        drop(store);std::fs::remove_dir_all(dir)?;Ok(())
    }
}
