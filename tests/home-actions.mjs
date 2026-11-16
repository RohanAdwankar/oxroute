import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
const agents=['Storage review','Network review','New investigation'].map((name,index)=>({id:`home-${index}`,name,backend:'codex',model:'fixture',status:'complete',updatedAt:100-index}));
const task={id:'home-approval',text:'Approve validated storage work',agentId:agents[0].id,status:'done',images:[],parentTaskId:'',blockedByTaskId:'',createdAt:1,updatedAt:1};
const state={mode:'ask',nextActionSuggestions:true,agents:agents.slice(0,2),archived:[],messages:{},tasks:[task],taskNotes:[],inbox:[],paneLinks:{},tags:{},boards:[],sources:[],models:[],backends:[]};
const browser=await(process.env.BROWSER==='webkit'?webkit:chromium).launch(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),writes=[],errors=[];let historyReads=0;
 page.on('pageerror',error=>errors.push(String(error)));
 await page.addInitScript(()=>{window.SharedWorker=undefined;window.homeStreams=[];window.EventSource=class extends EventTarget{constructor(){super();window.homeStreams.push(this);}close(){}};});
 await page.route('**/api/**',route=>{
  const request=route.request(),path=new URL(request.url()).pathname;
  if(path==='/api/version')return route.continue();
  if(path==='/api/state')return route.fulfill({json:state});
  if(path==='/api/focus')return route.fulfill({json:{suggestions:state.agents.map(agent=>({agent,nextActions:{entryId:1,actions:[{label:'Inspect evidence',message:'Inspect the validation evidence'},{label:'Explain options',message:'Explain the options'}]}})),feedback:{}}});
  if(path==='/api/terminals')return route.fulfill({json:[]});
  if(path.endsWith('/messages')){historyReads++;return route.fulfill({json:[]});}
  if(path==='/api/say'){writes.push({path,...request.postDataJSON()});return route.fulfill({json:{}});}
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
 await first.getByRole('form',{name:`Reply to ${agents[0].name}`,exact:true}).getByRole('button',{name:'Send reply',exact:true}).click();await first.getByText('Reply sent',{exact:true}).waitFor();
 assert.equal(writes.at(-1).text,'A custom question outside the suggested options.');assert.equal(writes.at(-1).queued,true);
 await first.getByRole('button',{name:'Inspect evidence',exact:true}).click();await first.getByText('Sent to conversation',{exact:true}).waitFor();assert.equal(writes.at(-1).text,'Inspect the validation evidence');
 await first.getByRole('button',{name:'Approve',exact:true}).click();await first.getByRole('button',{name:'Approve',exact:true}).waitFor({state:'detached'});assert.equal(task.status,'complete');
 const before=await first.boundingBox();state.agents=[agents[2],agents[1],agents[0]];
 await page.evaluate(()=>window.homeStreams.at(-1).onmessage({data:JSON.stringify({type:'sync'})}));
 await page.getByRole('button',{name:'Show 1 new cards',exact:true}).waitFor();
 assert.equal(await card(agents[2].id).count(),0,'Arrivals stay buffered until requested');
 assert.deepEqual(await page.locator('[data-home-card]').evaluateAll(nodes=>nodes.map(node=>node.dataset.homeCard)),[agents[0].id,agents[1].id]);
 assert.equal((await first.boundingBox()).y,before.y,'New arrivals do not move the current card');
 await page.getByRole('button',{name:'Show 1 new cards',exact:true}).click();await card(agents[2].id).waitFor();
 assert.equal(await page.locator('[data-home-card]').first().getAttribute('data-home-card'),agents[2].id);
 if(process.env.SCREENSHOT)await page.screenshot({path:process.env.SCREENSHOT});
 await card(agents[1].id).getByRole('button',{name:`Archive ${agents[1].name}`,exact:true}).click();await card(agents[1].id).waitFor({state:'detached'});
 assert.equal(new URL(page.url()).searchParams.has('agent'),false,'Quick actions leave Home open');
 assert.deepEqual(errors,[]);
 console.log('Home suggestions, custom queued replies, draft restoration, approvals, archive and buffered stable arrivals pass without automatic history loading.');
}finally{await browser.close();}
