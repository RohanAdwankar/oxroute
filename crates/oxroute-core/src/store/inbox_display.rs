use super::*;
use serde::{Deserialize,Serialize};

#[derive(Clone,Serialize,Deserialize)]
pub(crate) struct SlackName {
    pub team:String,
    pub user:String,
    pub name:String,
    pub checked_at:f64,
    pub retry_at:f64,
}

impl Store {
    pub(crate) fn slack_names(&self,team:&str)->Result<HashMap<String,SlackName>> {
        self.read(|c|slack_names(c,team))
    }

    pub(crate) fn save_slack_name(&self,profile:&SlackName)->Result<()> {
        self.set(&format!("inbox-slack-name:{}:{}",profile.team,profile.user),&serde_json::to_string(profile)?)
    }

    pub(crate) fn slack_name_candidates(&self,team:&str,owner:&str)->Result<Vec<String>> {
        self.read(|c|{
            let prefix=format!("{team}:{owner}:");
            let mut query=c.prepare("SELECT author FROM inbox_messages WHERE source='slack-inbox' AND substr(conversation,1,length(?1))=?1 AND author!='' GROUP BY author ORDER BY MAX(at) DESC")?;
            let mut users=query.query_map([prefix],|row|row.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            let channels:Option<String>=c.query_row("SELECT value FROM kv WHERE key=?1",[format!("inbox-conversations:{team}:{owner}")],|row|row.get(0)).optional()?;
            if let Some(channels)=channels {
                let channels:serde_json::Value=serde_json::from_str(&channels)?;
                if let Some(channels)=channels.as_object() {for channel in channels.values().filter(|channel|channel["is_im"]==true) {
                    if let Some(user)=channel["user"].as_str().or(channel["name"].as_str()).filter(|id|!id.is_empty()) {if !users.iter().any(|id|id==user) {users.push(user.into());}}
                }}
            }
            Ok(users)
        })
    }

    pub(crate) fn decorate_inbox(&self,items:&mut[InboxItem])->Result<()> {
        self.read(|c|{
            let mut names=HashMap::new();
            let mut channels=HashMap::new();
            for item in items {
                let signal=&item.signal;
                if signal.source!=crate::inbox::SLACK {continue;}
                let parts=signal.conversation.split(':').collect::<Vec<_>>();
                let [team,owner,channel]=parts.as_slice() else {continue;};
                if !names.contains_key(*team) {names.insert(team.to_string(),slack_names(c,team)?);}
                let account=format!("{team}:{owner}");
                if !channels.contains_key(&account) {
                    let value:Option<String>=c.query_row("SELECT value FROM kv WHERE key=?1",[format!("inbox-conversations:{account}")],|row|row.get(0)).optional()?;
                    channels.insert(account.clone(),value.map(|value|serde_json::from_str::<serde_json::Value>(&value)).transpose()?.unwrap_or_default());
                }
                let profiles=&names[*team];let metadata=&channels[&account][*channel];
                let mut query=c.prepare("SELECT author,text FROM inbox_messages WHERE source=?1 AND conversation=?2 AND thread_key=?3 ORDER BY at,external_id")?;
                let messages=query.query_map(params![signal.source,signal.conversation,signal.thread_key],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
                let display_name=|id:&str|profiles.get(id).map(|profile|profile.name.as_str()).filter(|name|!name.is_empty()).unwrap_or(id).to_string();
                let peers=messages.iter().map(|(author,_)|author.as_str()).filter(|author|!author.is_empty()&&*author!=*owner).fold(Vec::new(),|mut peers,author|{if !peers.contains(&author) {peers.push(author);}peers});
                let label=if metadata["is_mpim"]==true {
                    if let Some(name)=metadata["name"].as_str().filter(|name|!name.is_empty()&&!name.starts_with("mpdm-")) {name.into()}
                    else if peers.is_empty() {"Group conversation".into()}
                    else {format!("Group · {}",peers.iter().take(3).map(|id|display_name(id)).collect::<Vec<_>>().join(", "))}
                }else if metadata["is_im"]==true||c.query_row("SELECT EXISTS(SELECT 1 FROM kv WHERE key=?1)",[format!("inbox-dm:{team}:{channel}")],|row|row.get::<_,bool>(0))? {
                    metadata["user"].as_str().filter(|id|profiles.contains_key(*id)).map(display_name)
                        .or_else(||profiles.get(&signal.label).filter(|profile|!profile.name.is_empty()).map(|profile|profile.name.clone()))
                        .or_else(||(peers.len()==1).then(||display_name(peers[0])))
                        .unwrap_or_else(||signal.label.clone())
                }else {signal.label.clone()};
                let text=if messages.is_empty(){signal.text.clone()}else{messages.iter().map(|(author,text)|format!("{}: {text}",display_name(author))).collect::<Vec<_>>().join("\n\n")};
                item.display=Some(crate::model::InboxDisplay{label,text});
            }
            Ok(())
        })
    }
}

fn slack_names(c:&Connection,team:&str)->Result<HashMap<String,SlackName>> {
    let prefix=format!("inbox-slack-name:{team}:");let mut query=c.prepare("SELECT value FROM kv WHERE substr(key,1,length(?1))=?1")?;
    let values=query.query_map([prefix],|row|row.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    values.into_iter().map(|value|{let profile:SlackName=serde_json::from_str(&value)?;Ok((profile.user.clone(),profile))}).collect()
}
