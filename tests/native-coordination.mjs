// Real disposable daemon and SQLite recovery, using a credential-free local harness.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
const {WebSocketServer}=createRequire(import.meta.url)('next/dist/compiled/ws');
assert.ok(process.env.TEST_DAEMON);
await mkdir(resolve('.tmp'),{recursive:true});const root=await mkdtemp(resolve('.tmp/focus-events-'));
const listen=server=>new Promise(done=>server.listen(0,'127.0.0.1',()=>done(server.address().port)));
const pause=ms=>new Promise(done=>setTimeout(done,ms));
const until=async(check,label)=>{for(let n=0;n<200;n++){if(await check())return;await pause(50);}assert.fail(label);};
const transport=createServer(),rpc=new WebSocketServer({server:transport}),rpcPort=await listen(transport);
const opened=[];
let serial=0,focusThread='',rejectFocus=false,rejected=0,interrupts=0;
const turns=[],sessions=new Map();
const send=(socket,method,params)=>{if(socket.readyState===1)socket.send(JSON.stringify({method,params}));};
const finish=(threadId,status='completed',notify=true)=>{
 const current=sessions.get(threadId);current.turn.status=status;
 current.turn.items=[{id:`answer-${current.turn.id}`,type:'agentMessage',text:'Local investigation result.',phase:'final_answer'}];
 if(notify){for(const item of current.turn.items)send(current.socket,'item/completed',{threadId,item});send(current.socket,'turn/completed',{threadId,turn:current.turn});}
};
rpc.on('connection',socket=>socket.on('message',raw=>{
 const {id,method,params={}}=JSON.parse(raw);if(id===undefined)return;
 let result={};
 if(method==='thread/start'){result={thread:{id:`session-${++serial}`}};opened.push({thread:result.thread.id,...params});}
 if(method==='thread/resume'){
  const saved=sessions.get(params.threadId);if(saved)saved.socket=socket;
  result={thread:{id:params.threadId,turns:saved?[saved.turn]:[]}};
 }
 if(method==='turn/interrupt'){interrupts++;finish(params.threadId,'interrupted');}
 if(method==='turn/start'){
  if(params.threadId===focusThread&&rejectFocus){rejected++;socket.send(JSON.stringify({id,error:{code:-32000,message:'Temporary transport rejection'}}));return;}
  const turn={id:`turn-${++serial}`,status:'inProgress',items:[]};result={turn};
  sessions.set(params.threadId,{turn,socket});turns.push({...params,turn});
  setTimeout(()=>send(socket,'turn/started',{threadId:params.threadId,turn}),5);
 }
 socket.send(JSON.stringify({id,result}));
}));
const reserve=createServer(),port=await listen(reserve);await new Promise(done=>reserve.close(done));
const base=`http://127.0.0.1:${port}`,config=join(root,'config.toml');
await writeFile(config,`owner="fixture"\nlisten="127.0.0.1:${port}"\nworkspace=${JSON.stringify(root)}\n[limits]\nmin_free_bytes=0\n[paths]\ndatabase=${JSON.stringify(join(root,'state.sqlite3'))}\nartifacts=${JSON.stringify(join(root,'artifacts'))}\nattachments=${JSON.stringify(join(root,'attachments'))}\n`);
const env={PATH:process.env.PATH,HOME:root,LANG:'C.UTF-8',RUST_LOG:'warn',CODEX_HOME:join(root,'codex'),OXROUTE_CONFIG:config,OXROUTE_CODEX_URL:`ws://127.0.0.1:${rpcPort}`,OXROUTE_CODEX_CLI:'/bin/false'};
const start=()=>spawn(process.env.TEST_DAEMON,[],{stdio:['ignore','ignore','inherit'],env});let daemon=start();
const stop=async()=>{daemon.kill('SIGKILL');if(daemon.exitCode===null)await new Promise(done=>daemon.once('exit',done));};
const api=async(path,body,method='POST')=>{const r=await fetch(base+path,body===undefined?{}:{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok,`${path}: ${r.status} ${await r.clone().text()}`);return r.json();};
const healthy=()=>until(async()=>{try{return(await fetch(base+'/api/health')).ok;}catch{return false;}},'Daemon did not start');
const focusTurns=()=>turns.filter(turn=>turn.threadId===focusThread);
const worker=async()=>{
 const agent=await api('/api/agents',{}),count=turns.length;
 await api('/api/say',{agent:agent.id,text:'Inspect authorized local evidence'});
 await until(()=>turns.length>count,'Worker did not start');
 return {agent,thread:turns.at(-1).threadId};
};

try {
 await healthy();for(const name of ['automatic-titles','automatic-tags','recommendation-learning','next-action-suggestions'])await api(`/api/${name}`,{enabled:false});
 const current=await worker(),focus=await api('/api/focus/agent',{});await until(()=>turns.length===2,'Focus did not open');focusThread=turns.at(-1).threadId;
 const connection=opened.find(value=>value.thread===current.thread).config['mcp_servers.oxroute_internal'];
 assert.ok(connection.url.endsWith(current.agent.id));
 const mcp=async(method,params={},credential=connection.http_headers.Authorization)=>{
  const response=await fetch(connection.url,{method:'POST',headers:{'content-type':'application/json','accept':'application/json, text/event-stream','authorization':credential},body:JSON.stringify({jsonrpc:'2.0',id:++serial,method,params})});
  if(response.status===401)return {unauthorized:true};
  assert.ok(response.ok);return (await response.json()).result;
 };
 assert.equal((await mcp('initialize',{protocolVersion:'2025-03-26'})).serverInfo.name,'oxroute');
 assert.ok((await mcp('tools/list')).tools.some(tool=>tool.name==='read_conversation'));
 assert.equal((await mcp('tools/list',{},'Bearer invalid')).unauthorized,true);
 const call=async(name,args)=>(await mcp('tools/call',{name,arguments:args}));
 const requestId=crypto.randomUUID(),message={targetId:focus.id,text:'Inspect the current local validation evidence.',requestId};
 const receipt=await call('send_agent_message',message);assert.ok(['queued','completed'].includes(receipt.structuredContent.status));
 assert.equal(receipt.structuredContent.senderId,current.agent.id);
 await call('send_agent_message',message);
 const other=await api('/api/agents',{});
 assert.equal((await call('send_agent_message',{...message,targetId:other.id,requestId:crypto.randomUUID()})).isError,true);
 assert.equal((await call('send_agent_message',{...message,senderId:focus.id})).isError,true);
 const page=await call('read_conversation',{agentId:focus.id,limit:1});
 assert.equal(page.structuredContent.entries.length,1);assert.equal(page.structuredContent.entries[0].origin,current.agent.id);
 const list=await call('list_conversations',{limit:1});assert.equal(list.structuredContent.conversations.length,1);assert.equal(typeof list.structuredContent.nextOffset,'number');
 const entry=(await api(`/api/agents/${focus.id}`)).timeline.filter(entry=>entry.requestId===requestId);assert.equal(entry.length,1);assert.equal(entry[0].kind,'coordination');
 const item={id:'native-result',type:'mcpToolCall',status:'completed',server:'oxroute_internal',tool:'read_conversation',arguments:{agentId:focus.id},result:page};
 send(sessions.get(current.thread).socket,'item/completed',{threadId:current.thread,item});
 await until(async()=>(await api(`/api/agents/${current.agent.id}`)).timeline.some(entry=>entry.text==='Read conversation'),'Native activity did not persist');
 await stop();daemon=start();await healthy();const available=(await mcp('tools/list')).tools;assert.ok(['list_conversations','read_conversation','send_agent_message','publish_focus_update'].every(name=>available.some(tool=>tool.name===name)),'Sender credential and required native tools survive restart');
 await call('send_agent_message',message);assert.equal((await api(`/api/agents/${focus.id}`)).timeline.filter(entry=>entry.requestId===requestId).length,1,'Retry after restart preserves one visible report');
 if(process.env.TEST_CODEX){
  const {createInterface}=await import('node:readline');
  await mkdir(join(root,'native-client'),{recursive:true});
  const client=spawn(process.env.TEST_CODEX,['app-server','--listen','stdio://'],{stdio:['pipe','pipe','ignore'],env:{...process.env,HOME:root,CODEX_HOME:join(root,'native-client')},cwd:root});
  const waiting=new Map();let next=0;client.on('exit',code=>{for(const pending of waiting.values())pending.reject(new Error(`Native runtime exited ${code}`));waiting.clear();});
  const lines=createInterface({input:client.stdout});lines.on('line',line=>{try{const value=JSON.parse(line),pending=waiting.get(value.id);if(pending){waiting.delete(value.id);value.error?pending.reject(new Error(value.error.message)):pending.resolve(value.result);}}catch{}});
  const request=(method,params)=>new Promise((resolve,reject)=>{const id=++next;waiting.set(id,{resolve,reject});client.stdin.write(JSON.stringify({id,method,params})+'\n');setTimeout(()=>{if(waiting.delete(id))reject(new Error(`Native runtime timed out: ${method}`));},20000).unref();});
  try{
   await request('initialize',{clientInfo:{name:'oxroute_fixture',version:'1'},capabilities:{experimentalApi:true}});client.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
   const opened=await request('thread/start',{cwd:root,ephemeral:true,approvalPolicy:'never',sandbox:'read-only',config:{'mcp_servers.oxroute_internal':connection}}),threadId=opened.thread.id;
   const result=await request('mcpServer/tool/call',{threadId,server:'oxroute_internal',tool:'list_conversations',arguments:{limit:1}});
   assert.equal(result.structuredContent.status,'completed');assert.equal(result.structuredContent.conversations.length,1);
   const read=await request('mcpServer/tool/call',{threadId,server:'oxroute_internal',tool:'read_conversation',arguments:{agentId:focus.id,limit:1}});assert.equal(read.structuredContent.entries[0].origin,current.agent.id);
   const sent=await request('mcpServer/tool/call',{threadId,server:'oxroute_internal',tool:'send_agent_message',arguments:message});assert.equal(sent.structuredContent.senderId,current.agent.id);assert.ok(['queued','completed'].includes(sent.structuredContent.status));
   console.log('Installed Codex runtime discovered and invoked the native MCP tool without inference.');
  }finally{client.kill('SIGTERM');lines.close();}
 }
 if(process.env.TEST_URL){
  const {chromium}=await import('playwright');const browser=await chromium.launch();
  try{
   const ui=await browser.newPage();await ui.addInitScript(()=>{window.SharedWorker=undefined;window.EventSource=class extends EventTarget{close(){}};});await ui.route('**/api/**',async route=>{const request=route.request(),path=new URL(request.url());if(path.pathname==='/api/version')return route.continue();if(request.method()!=='GET')return route.fulfill({json:[]});return route.fulfill({response:await ui.request.get(base+path.pathname+path.search,{headers:request.headers()})});});
   await ui.goto(`${process.env.TEST_URL}/?agent=${current.agent.id}`);await ui.getByText('Inspect authorized local evidence',{exact:true}).waitFor();const folded=ui.locator('[data-agent-pane] summary').filter({hasText:'tool call'});if(await folded.count())await folded.first().click();await ui.getByText('Read conversation',{exact:true}).waitFor();await ui.locator('[data-agent-pane] summary').last().click();await ui.getByText('"tool": "read_conversation"',{exact:false}).waitFor();
   if(process.env.SCREENSHOT)await ui.screenshot({path:process.env.SCREENSHOT});
   await ui.goto(`${process.env.TEST_URL}/?agent=${focus.id}`);await ui.getByText('Internal update',{exact:true}).waitFor();
   assert.equal(await ui.locator(`[data-entry="${entry[0].id}"]`).evaluate(node=>node.className.includes('bg-mine')),false);
  }finally{await browser.close();}
 }
 const focusConnection=opened.find(value=>value.thread===focusThread).config['mcp_servers.oxroute_internal'];
 const named=await api('/api/agents',{}),naming={targetId:named.id,text:'Inspect existing artifact evidence.',requestId:crypto.randomUUID(),title:'Artifact evidence'};
 const focusSend=async()=>{const response=await fetch(focusConnection.url,{method:'POST',headers:{'content-type':'application/json',authorization:focusConnection.http_headers.Authorization},body:JSON.stringify({jsonrpc:'2.0',id:++serial,method:'tools/call',params:{name:'send_agent_message',arguments:naming}})});assert.ok(response.ok);return(await response.json()).result;};
 assert.equal((await focusSend()).structuredContent.delivery.recipientTitle,'Artifact evidence','Authenticated native coordination can set a title without another call');
 await api('/api/rename',{agent:named.id,name:'Preferred artifact title'});await focusSend();
 assert.equal((await api(`/api/agents/${named.id}`)).agent.name,'Preferred artifact title');
 await stop();daemon=start();await healthy();await focusSend();
 assert.equal((await api(`/api/agents/${named.id}`)).agent.name,'Preferred artifact title','Persisted request identity prevents stale naming after restart');
 console.log('Native runtime registration, authenticated MCP reads/send receipts, bounds, policy, provenance, retries, restart and UI details passed.');
} finally {await stop();for(const socket of rpc.clients)socket.terminate();await new Promise(done=>rpc.close(done));await new Promise(done=>transport.close(done));await rm(root,{recursive:true,force:true});}
