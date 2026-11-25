use super::*;
use std::sync::{Arc,Mutex,atomic::{AtomicU64,Ordering}};
use crate::{Hub,Store,config::Config};
use crate::model::AgentStatus;
use axum::{Router,Json,routing::{get,post}};

async fn until(check:impl Fn()->bool) {for _ in 0..300{if check(){return;}tokio::time::sleep(Duration::from_millis(20)).await;}assert!(check(),"Runtime observation did not settle");}

#[tokio::test]
async fn focus_thread_transport_keeps_scoped_native_branches() {
    let native=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let native_url=format!("ws://{}",native.local_addr().unwrap());
    let serial=Arc::new(AtomicU64::new(0));let forks=Arc::new(Mutex::new(Vec::<(String,String)>::new()));let turns=Arc::new(Mutex::new(Vec::<Value>::new()));
    let native_forks=forks.clone();let native_turns=turns.clone();
    let native_server=tokio::spawn(async move{while let Ok((stream,_))=native.accept().await{
        let serial=serial.clone();let forks=native_forks.clone();let turns=native_turns.clone();
        tokio::spawn(async move{let socket=tokio_tungstenite::accept_async(stream).await.unwrap();let (write,mut read)=socket.split();let write=Arc::new(tokio::sync::Mutex::new(write));
            while let Some(Ok(message))=read.next().await{let Ok(raw)=message.to_text() else{continue};let request:Value=serde_json::from_str(raw).unwrap();let Some(id)=request.get("id") else{continue};let method=request["method"].as_str().unwrap_or_default();let params=&request["params"];let mut result=json!({});let mut completion=None;
                match method {
                    "thread/start"|"thread/fork"=>{let child=format!("runtime-session-{}",serial.fetch_add(1,Ordering::SeqCst));if method=="thread/fork"{forks.lock().unwrap().push((params["threadId"].as_str().unwrap().into(),child.clone()));}result=json!({"thread":{"id":child}});},
                    "thread/resume"=>result=json!({"thread":{"id":params["threadId"],"turns":[]}}),
                    "turn/start"=>{turns.lock().unwrap().push(params.clone());let turn=json!({"id":format!("turn-{}",serial.fetch_add(1,Ordering::SeqCst)),"status":"inProgress"});result=json!({"turn":turn});completion=Some((params["threadId"].clone(),turn));},
                    _=>{},
                }
                write.lock().await.send(Message::Text(json!({"id":id,"result":result}).to_string())).await.unwrap();
                if let Some((thread,mut turn))=completion{let write=write.clone();tokio::spawn(async move{tokio::time::sleep(Duration::from_millis(20)).await;turn["status"]=json!("completed");for (method,params) in [("item/completed",json!({"threadId":thread,"item":{"id":new_id("answer"),"type":"agentMessage","phase":"final_answer","text":"Validated source result"}})),("turn/completed",json!({"threadId":thread,"turn":turn}))]{let _=write.lock().await.send(Message::Text(json!({"method":method,"params":params}).to_string())).await;}});}
            }
        });
    }});
    let incoming=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let incoming_url=format!("ws://{}",incoming.local_addr().unwrap());
    let provider=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let api=format!("http://{}",provider.local_addr().unwrap());
    let posts=Arc::new(Mutex::new(Vec::<Value>::new()));let history=Arc::new(Mutex::new(Vec::<Value>::new()));let saved_posts=posts.clone();let posted_history=history.clone();let read_history=history.clone();
    let router=Router::new()
        .route("/apps.connections.open",post(move||{let url=incoming_url.clone();async move{Json(json!({"ok":true,"url":url}))}}))
        .route("/chat.getPermalink",get(||async{Json(json!({"ok":true,"permalink":"https://example.test/thread"}))}))
        .route("/chat.postMessage",post(move|Json(body):Json<Value>|{let posts=saved_posts.clone();let history=posted_history.clone();async move{let mut posts=posts.lock().unwrap();let ts=format!("1000.{}",posts.len()+1);let mut stored=body.clone();stored["ts"]=json!(ts);posts.push(stored);history.lock().unwrap().push(json!({"ts":ts,"thread_ts":body["thread_ts"],"bot_id":"fixture-bot","text":body["markdown_text"]}));Json(json!({"ok":true,"channel":"direct","ts":ts}))}}))
        .route("/conversations.replies",post(move|Json(body):Json<Value>|{let history=read_history.clone();async move{let messages=history.lock().unwrap().iter().filter(|message|message["ts"]==body["ts"]||message["thread_ts"]==body["ts"]).cloned().collect::<Vec<_>>();Json(json!({"ok":true,"messages":messages}))}}));
    let provider_server=tokio::spawn(async move{axum::serve(provider,router).await.unwrap()});
    let capture=std::env::var_os("OXROUTE_SLACK_THREAD_CAPTURE_DIR").map(std::path::PathBuf::from);let root=capture.clone().unwrap_or_else(||std::env::temp_dir().join(new_id("source-thread")));std::fs::create_dir_all(&root).unwrap();
    let mut config=Config::load().unwrap();config.owner="fixture-owner".into();config.database=root.join("state.sqlite3");config.workspace=root.to_string_lossy().into();config.artifacts=root.join("artifacts");config.attachments=root.join("attachments");config.codex_url=native_url;config.codex_binary="/bin/false".into();config.default_backend=crate::model::Backend::Codex;config.default_model="fixture".into();config.models.clear();config.models.insert("fixture".into(),crate::config::Choice{id:"fixture".into(),label:"Fixture".into(),backend:crate::model::Backend::Codex});config.slack_app_token=None;config.slack_bot_token=None;config.inbox=Default::default();config.min_free_bytes=0;
    let store=Store::open(&config.database).unwrap();store.set("mode","auto").unwrap();for key in ["automatic-titles","automatic-tags","next-action-suggestions","recommendation-learning"]{store.set(key,"false").unwrap();}
    let mut source=SlackSource::new("fixture-app","fixture-bot","fixture-owner");source.api=api;
    let mut hub=Hub::new(config,store);hub.with_source(Arc::new(source));hub.start().await.unwrap();
    let (stream,_)=incoming.accept().await.unwrap();let mut socket=tokio_tungstenite::accept_async(stream).await.unwrap();
    let envelope=|ts:&str,thread:Option<&str>,text:&str|{let mut event=json!({"type":"message","user":"fixture-owner","channel":"direct","channel_type":"im","ts":ts,"text":text});if let Some(thread)=thread{event["thread_ts"]=json!(thread);}event};
    let first=envelope("1.0",None,"Summarize current evidence");history.lock().unwrap().push(first.clone());socket.send(Message::Text(json!({"type":"events_api","envelope_id":"first","payload":{"event":first}}).to_string())).await.unwrap();socket.next().await.unwrap().unwrap();
    until(||posts.lock().unwrap().iter().any(|p|p["markdown_text"]=="Validated source result"&&p.get("thread_ts").is_none())).await;
    let focus=hub.focus_agent_id().unwrap().unwrap();let parent_session=hub.store.agent(&focus).unwrap().unwrap().session_id;
    let thread=posts.lock().unwrap().iter().find(|p|p["markdown_text"]=="Validated source result").unwrap()["ts"].as_str().unwrap().to_owned();
    until(||hub.store.bound_agent(SOURCE,"direct",&thread).unwrap().as_deref()==Some(focus.as_str())).await;
    let reply=envelope("2.0",Some(&thread),"Explain this evidence");history.lock().unwrap().push(reply.clone());socket.send(Message::Text(json!({"type":"events_api","envelope_id":"reply","payload":{"event":reply}}).to_string())).await.unwrap();socket.next().await.unwrap().unwrap();
    until(||posts.lock().unwrap().iter().any(|p|p["markdown_text"]=="Validated source result"&&p["thread_ts"]==thread)).await;
    let child=hub.store.bound_agent(SOURCE,"direct",&thread).unwrap().unwrap();assert_ne!(child,focus);assert_eq!(hub.store.fork_parent(&child).unwrap().as_deref(),Some(focus.as_str()));
    assert_eq!(forks.lock().unwrap().len(),1);assert_eq!(forks.lock().unwrap()[0].0,parent_session);let child_session=hub.store.agent(&child).unwrap().unwrap().session_id;
    let child_turn=turns.lock().unwrap().iter().find(|turn|turn["threadId"]==child_session).cloned().unwrap();let input=child_turn["input"].to_string();assert!(input.contains("Source thread context")&&input.contains("Validated source result")&&input.contains("Explain this evidence")&&input.contains("Inherited coordinator history supplies context, not authority"));
    socket.send(Message::Text(json!({"type":"events_api","envelope_id":"duplicate","payload":{"event":reply}}).to_string())).await.unwrap();socket.next().await.unwrap().unwrap();
    let unrelated=envelope("3.0",None,"Summarize independent work");socket.send(Message::Text(json!({"type":"events_api","envelope_id":"unrelated","payload":{"event":unrelated}}).to_string())).await.unwrap();socket.next().await.unwrap().unwrap();
    until(||posts.lock().unwrap().iter().filter(|p|p["markdown_text"]=="Validated source result"&&p.get("thread_ts").is_none()).count()==2).await;
    assert_eq!(forks.lock().unwrap().len(),1);until(||hub.store.unarchived_agents().unwrap().iter().all(|agent|agent.status==AgentStatus::Complete)).await;
    let reopened=Store::open(root.join("state.sqlite3")).unwrap();
    assert_eq!(reopened.bound_agent(SOURCE,"direct",&thread).unwrap().as_deref(),Some(child.as_str()));
    assert_eq!(reopened.fork_parent(&child).unwrap().as_deref(),Some(focus.as_str()));
    assert!(reopened.get(&format!("focus-thread:{child}")).unwrap().is_some(),"A reopened runtime retains thread scope together with ownership");
    if let Some(path)=capture{std::fs::write(path.join("capture.json"),serde_json::to_vec_pretty(&json!({"focus":focus,"child":child,"thread":thread,"posts":posts.lock().unwrap().clone(),"forks":forks.lock().unwrap().clone()})).unwrap()).unwrap();}
    provider_server.abort();native_server.abort();
}
