use super::*;

pub(super) fn start(hub:Arc<Hub>,path:PathBuf) {
    tokio::spawn(async move {
        let reader=match Reader::new("https://slack.com/api/",path) {Ok(reader)=>reader,Err(error)=>{tracing::warn!(%error,"Slack identity reader unavailable");return;}};
        loop {
            if let Err(error)=refresh(&hub,&reader).await {tracing::warn!(%error,"Slack identity refresh incomplete");}
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
}

pub(super) async fn refresh(hub:&Arc<Hub>,reader:&Reader)->Result<()> {
    let account=reader.get("auth.test",&[]).await?;
    let team=account["team_id"].as_str().context("Slack profile has no team")?;
    let owner=account["user_id"].as_str().context("Slack profile has no user")?;
    let known=hub.store.slack_names(team)?;let at=now();let mut changed=false;
    for user in hub.store.slack_name_candidates(team,owner)?.into_iter().filter(|user|known.get(user).is_none_or(|profile|profile.retry_at<=at)).take(50) {
        let previous=known.get(&user);
        let result=reader.get("users.info",&[("user",&user),("team_id",team)]).await;
        let name=result.as_ref().ok().and_then(|body|{
            let profile=&body["user"];
            if profile["id"].as_str()!=Some(user.as_str()) {return None;}
            [profile["profile"]["display_name"].as_str(),profile["profile"]["real_name"].as_str(),profile["name"].as_str()].into_iter().flatten().map(str::trim).find(|name|!name.is_empty()).map(str::to_owned)
        });
        let resolved=name.is_some();
        let name=name.or_else(||previous.map(|profile|profile.name.clone())).unwrap_or_default();
        changed|=previous.map(|profile|profile.name.as_str())!=Some(name.as_str());
        hub.store.save_slack_name(&crate::store::SlackName{team:team.into(),user,name,checked_at:if resolved {at}else{previous.map_or(0.0,|profile|profile.checked_at)},retry_at:at+if resolved{86400.0}else{900.0}})?;
    }
    if changed {hub.emit(Event::Sync);}Ok(())
}
