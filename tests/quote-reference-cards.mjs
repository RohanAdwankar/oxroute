// Durable references, historical attachments and exact navigation share one renderer.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium,webkit} from 'playwright';
const base=process.env.TEST_URL||'http://127.0.0.1:3969',version=(await(await fetch(base+'/api/version')).json()).version;
const focus={id:'coordination-owner',name:'Decision context',backend:'codex',status:'complete',updatedAt:1},worker={...focus,id:'execution-owner',name:'Execution context'};
const title='Choose the storage retention window and compare the reversible operating tradeoffs before the next scheduled evaluation.',ids=[12,18,19];
const text=`Source conversation: ${worker.id}\nEvidence entries: ${ids.join(', ')}\nSelected title:\n> ${title}\n\n`;
const quote={text,path:'Decision title',rows:[{text:title,old:null,next:null}],decision:{id:'scoped-choice',revision:'saved-revision'}};
const reference={agentId:worker.id,contextAgentId:focus.id,title,evidenceEntryIds:ids};
const entry=(id,text,agentId=focus.id,detail='')=>({id,text,agentId,detail,kind:'said',at:id,output:'',origin:''});
const original={...entry(12,'Original scoped decision with its retained explanation.'),publicationKind:'decision'},evidence=entry(18,'Execution evidence without the original decision.',worker.id),later=entry(19,'An unrelated later coordinator result.');
const reply={...entry(60,text+'Keep the existing retention window.',focus.id,'diff-attachments:'+JSON.stringify([quote])),kind:'you'};
const timeline=[...Array.from({length:45},(_,n)=>entry(n+1,`Earlier context ${n+1}. Retained discussion and independent work remain available.`)).filter(e=>e.id!==12),original,reply].sort((a,b)=>a.id-b.id);
const browser=await(process.env.TEST_BROWSER==='webkit'?webkit:chromium).launch(process.env.WEBKIT_EXECUTABLE?{executablePath:process.env.WEBKIT_EXECUTABLE}:{});
try{
 const page=await browser.newPage({viewport:{width:1280,height:850}});const mutations=[];
 await page.addInitScript(()=>{window.SharedWorker=undefined;window.EventSource=class extends EventTarget{constructor(){super();window.fixtureEvents=this;}close(){}};});
 await page.route('**/api/**',r=>{
  const url=new URL(r.request().url()),path=url.pathname,json=value=>r.fulfill({json:value});
  if(path==='/api/focus/agent')return json(focus);
  if(r.request().method()!=='GET'){mutations.push(path);return json({});}
  if(path==='/api/version')return json({version});
  if(path==='/api/state')return json({mode:'ask',agents:[focus,worker],archived:[],messages:{},tasks:[],taskNotes:[],inbox:[],paneLinks:{},quoteThreads:[],tags:{},boards:[],sources:[],models:[],backends:[],focusAgentId:focus.id});
  if(path==='/api/terminals'||path==='/api/browsers')return json([]);
  if(path==='/api/focus')return json({suggestions:[],feedback:{}});
  if(path==='/api/focus/task-priorities')return json({priorities:{},reviews:{},review:{changed:false}});
  if(path==='/api/entries')return json([original,evidence,later].filter(e=>url.searchParams.get('ids').split(',').map(Number).includes(e.id)));
  if(path.startsWith('/api/agents/')){const agent=path.endsWith(worker.id)?worker:focus;return json({agent,timeline:agent.id===focus.id?timeline:[evidence],delivery:'start'});}
  throw Error('Unexpected read '+path);
 });
 await page.goto(`${base}/?agent=${focus.id}&entry=${reply.id}`);
 const card=page.locator(`[data-entry="${reply.id}"]`).getByRole('link',{name:`Open quoted decision: ${title}`,exact:true});await card.waitFor();
 assert.ok((await card.getAttribute('href')).includes('entry=12'),'Historical quote targets its cited original coordinator context rather than newer execution evidence');
 assert.equal(await page.locator(`[data-entry="${reply.id}"] pre`).count(),0);await page.getByText('Keep the existing retention window.',{exact:true}).waitFor();
 const visible=async id=>page.waitForFunction(id=>{const e=document.querySelector(`[data-entry="${id}"]`),box=e?.closest('[data-transcript]');if(!e||!box)return false;const r=e.getBoundingClientRect(),b=box.getBoundingClientRect();return r.top>=b.top&&r.top<b.bottom;},id);await card.click();await visible(original.id);await page.goBack();await visible(reply.id);await card.waitFor();
 const typed={...reply,id:61,detail:'diff-attachments:'+JSON.stringify([{...quote,reference}])};timeline.push(typed);await page.evaluate(entry=>window.fixtureEvents.onmessage({data:JSON.stringify({type:'timeline',entry})}),typed);await page.locator('[data-entry="61"]').getByRole('link',{name:`Open quoted decision: ${title}`,exact:true}).waitFor();
 for(const width of[1280,390])for(const zoom of[0.75,1,1.5]){
  await page.setViewportSize({width,height:850});await page.evaluate(zoom=>document.documentElement.style.zoom=String(zoom),zoom);await card.scrollIntoViewIfNeeded();
  assert.ok(await card.evaluate(e=>e.scrollWidth<=e.clientWidth+1),'Card wraps without horizontal scrolling');
  if(process.env.SCREENSHOT){await mkdir(process.env.SCREENSHOT,{recursive:true});await page.screenshot({path:`${process.env.SCREENSHOT}/quoted-reference-${process.env.TEST_BROWSER||'chromium'}-${width}-${zoom}.png`});}
 }
 assert.deepEqual(mutations,[],'Opening and returning never sends, approves or completes work');
 console.log('Historical and typed decision cards wrap, retain replies and exact cited context; event rendering, navigation/back and desktop/narrow zoom pass without mutations.');
}finally{await browser.close();}
