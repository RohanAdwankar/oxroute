import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
const agents=['Storage review','Network review','New investigation'].map((name,index)=>({id:`home-${index}`,name,backend:'codex',model:'fixture',status:'complete',updatedAt:100-index}));
const task={id:'home-approval',text:'Approve validated storage work',agentId:agents[0].id,status:'done',images:[],parentTaskId:'',blockedByTaskId:'',createdAt:1,updatedAt:1};
const extra=Array.from({length:24},(_,index)=>({...task,id:`extra-${index}`,agentId:agents[1].id,text:`Review prepared result ${index+1} ${'long-path-segment/'.repeat(12)} and its validation evidence`}));
const state={mode:'ask',nextActionSuggestions:true,agents:agents.slice(0,2),archived:[],messages:{},tasks:[task,...extra],taskNotes:[],inbox:[],paneLinks:{},tags:{},boards:[],sources:[],models:[],backends:[]};
const browser=await(process.env.BROWSER==='webkit'?webkit:chromium).launch(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{});
try{
 const page=await browser.newPage({viewport:{width:1100,height:850},colorScheme:'dark'}),writes=[],errors=[];let historyReads=0,sends=0,releaseReply,releaseChoice;const replyGate=new Promise(done=>{releaseReply=done;}),choiceGate=new Promise(done=>{releaseChoice=done;});
 page.on('pageerror',error=>errors.push(String(error)));
 await page.addInitScript(()=>{window.SharedWorker=undefined;window.homeStreams=[];window.EventSource=class extends EventTarget{constructor(){super();window.homeStreams.push(this);}close(){}};});
 await page.route('**/api/**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname;
  if(path==='/api/version')return route.continue();
  if(path==='/api/state')return route.fulfill({json:state});
  if(path==='/api/focus')return route.fulfill({json:{suggestions:state.agents.map(agent=>({agent,nextActions:{entryId:1,actions:[{label:'Inspect evidence',message:'Inspect the validation evidence'},{label:'Explain options',message:'Explain the options'}]}})),feedback:{}}});
  if(path==='/api/terminals')return route.fulfill({json:[]});
  if(path.endsWith('/messages')){historyReads++;return route.fulfill({json:[]});}
  if(path==='/api/say'){writes.push({path,...request.postDataJSON()});sends++;if(sends===1)await replyGate;if(sends===3)await choiceGate;if(sends===1||sends===3)return route.fulfill({status:503,json:{error:'Temporary submission failure'}});return route.fulfill({json:{}});}
  if(path===`/api/tasks/${task.id}`){const body=request.postDataJSON();writes.push({path,...body});Object.assign(task,body);return route.fulfill({json:task});}
  if(path==='/api/archive'){const body=request.postDataJSON();writes.push({path,...body});state.archived.push(state.agents.find(agent=>agent.id===body.agent));state.agents=state.agents.filter(agent=>agent.id!==body.agent);return route.fulfill({json:state});}
  if(path==='/api/client-failures')return route.fulfill({json:{}});
  assert.equal(request.method(),'GET',`Unexpected mutation ${path}`);
  const agent=agents.find(agent=>path===`/api/agents/${agent.id}`);
  return route.fulfill({json:agent?{agent,timeline:[],delivery:'start'}:[]});
 });
 await page.goto(process.env.TEST_URL);
 const card=id=>page.locator(`[data-home-card="${id}"]`),first=card(agents[0].id);
 await first.getByRole('group',{name:`Suggested next steps for ${agents[0].name}`,exact:true}).waitFor();
 const reply=first.getByRole('textbox',{name:`Reply to ${agents[0].name}`,exact:true});
 await reply.fill('A custom question outside the suggested options.');assert.equal(historyReads,0,'Typing a reply never fetches or expands history');
 await page.evaluate(task=>localStorage.setItem(`oxroute.taskReply.${task.id}`,'A saved task-specific question.'),task);
 await page.reload();
 await first.getByRole('textbox',{name:`Reply about ${task.text}`,exact:true}).waitFor();
 assert.equal(await first.getByRole('textbox',{name:`Reply about ${task.text}`,exact:true}).inputValue(),'A saved task-specific question.');
 assert.equal(await reply.inputValue(),'A custom question outside the suggested options.');
 const send=first.getByRole('form',{name:`Reply to ${agents[0].name}`,exact:true}).getByRole('button',{name:'Send reply',exact:true});
 await send.click();await first.getByText('Queued',{exact:true}).waitFor();assert.equal(await reply.inputValue(),'','The composer clears before acknowledgement');
 await first.getByText('You: A custom question outside the suggested options.',{exact:true}).waitFor();
 releaseReply();await first.getByRole('alert').getByText('Temporary submission failure',{exact:true}).waitFor();
 assert.equal(await reply.inputValue(),'A custom question outside the suggested options.','Failure restores the draft');
 await send.click();await first.getByText('Reply sent',{exact:true}).waitFor();assert.equal(writes[0].requestId,writes[1].requestId,'Retry keeps the original request identity');
 assert.equal(writes.at(-1).text,'A custom question outside the suggested options.');assert.equal(writes.at(-1).queued,true);
 await first.getByRole('button',{name:'Inspect evidence',exact:true}).click();await first.getByText('Queued for conversation',{exact:true}).waitFor();
 assert.equal(await first.getByRole('button',{name:'Inspect evidence',exact:true}).count(),0,'Choices update before acknowledgement');
 releaseChoice();await first.getByRole('button',{name:'Inspect evidence',exact:true}).waitFor();
 await first.getByRole('button',{name:'Inspect evidence',exact:true}).click();await first.getByText('Sent to conversation',{exact:true}).waitFor();assert.equal(writes.at(-1).text,'Inspect the validation evidence');
 assert.equal(writes[2].requestId,writes[3].requestId,'Choice retries remain idempotent');
 const crowded=card(agents[1].id);assert.ok((await crowded.boundingBox()).height<750,'Large task lists stay bounded within the viewport');
 const last=crowded.getByRole('button',{name:extra.at(-1).text,exact:true});
 const visible=await last.evaluate(button=>{let scroll=button.parentElement;while(scroll&&!(scroll.scrollHeight>scroll.clientHeight&&['auto','scroll'].includes(getComputedStyle(scroll).overflowY)))scroll=scroll.parentElement;if(!scroll)return false;scroll.scrollTop=scroll.scrollHeight;const a=button.getBoundingClientRect(),b=scroll.getBoundingClientRect();return a.top>=b.top&&a.bottom<=b.bottom;});
 assert.ok(visible,'Every task remains reachable by scrolling inside the card');
 await first.getByRole('button',{name:'Approve',exact:true}).click();await first.getByRole('button',{name:'Approve',exact:true}).waitFor({state:'detached'});assert.equal(task.status,'complete');
 const before=await first.boundingBox();state.agents=[agents[2],agents[1],agents[0]];
 await page.evaluate(()=>window.homeStreams.at(-1).onmessage({data:JSON.stringify({type:'sync'})}));
 await page.getByRole('button',{name:'Show 1 new cards',exact:true}).waitFor();
 assert.equal(await card(agents[2].id).count(),0,'Arrivals stay buffered until requested');
 assert.deepEqual(await page.locator('[data-home-card]').evaluateAll(nodes=>nodes.map(node=>node.dataset.homeCard)),[agents[0].id,agents[1].id]);
 assert.equal((await first.boundingBox()).y,before.y,'New arrivals do not move the current card');
 await page.getByRole('button',{name:'Show 1 new cards',exact:true}).click();await card(agents[2].id).waitFor();
 assert.equal(await page.locator('[data-home-card]').first().getAttribute('data-home-card'),agents[2].id);
 for(const item of await page.locator('[data-home-card]').all()){
  assert.ok(await item.evaluate(el=>el.scrollWidth<=el.clientWidth),'Card contents do not create a horizontal scrollbar');
  assert.equal(await item.locator(':scope > span[aria-hidden]').count(),0,'Jump badges stay hidden until f');
 }
 await page.keyboard.press('Escape');await page.keyboard.press('f');await page.locator('[data-jump]').waitFor();
 await page.keyboard.press('Escape');await page.locator('[data-jump]').waitFor({state:'detached'});
 if(process.env.SCREENSHOT)await page.screenshot({path:process.env.SCREENSHOT});
 await card(agents[1].id).getByRole('button',{name:`Archive ${agents[1].name}`,exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Archive without changing tasks',exact:true}).click();await card(agents[1].id).waitFor({state:'detached'});
 assert.equal(new URL(page.url()).searchParams.has('agent'),false,'Quick actions leave Home open');
 await page.keyboard.press('Escape');await page.keyboard.press('f');await page.locator('[data-jump]').waitFor();
 const target=await card(agents[2].id).getByRole('button',{name:agents[2].name,exact:true}).boundingBox();
 const label=await page.locator('[data-jump] span').evaluateAll((labels,target)=>labels.find(label=>{const box=label.getBoundingClientRect();return Math.abs(box.left-target.x)<2&&Math.abs(box.top-target.y)<2;})?.textContent,target);
 assert.ok(label,'The f overlay includes the card title');await page.keyboard.type(label);
 await page.locator(`[data-agent-pane="${agents[2].id}"]`).waitFor();
 assert.equal(new URL(page.url()).searchParams.get('agent'),agents[2].id,'A jump hint opens the intended conversation');
 assert.deepEqual(errors,[]);
 console.log('Fleet geometry, on-demand hints and existing Home suggestions, custom queued replies, draft restoration, approvals, archive and buffered stable arrivals pass without automatic history loading.');
}finally{await browser.close();}
