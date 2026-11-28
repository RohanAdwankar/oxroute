// Deliberately slow CPU, long history and streaming fleet; no backend on the typing path.
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const focus={id:'coordinator',name:'Focus',backend:'codex',model:'fixture',status:'complete',updatedAt:1};
const fleet=Array.from({length:24},(_,n)=>({...focus,id:`worker-${n}`,name:`Workstream ${n}`}));
const archived=Array.from({length:1200},(_,n)=>({...focus,id:`history-${n}`,name:`Past workstream ${n}`}));
const reviews=Object.fromEntries(archived.slice(0,256).map((agent,n)=>[agent.id,[`review-${n}`]]));
const tasks=Array.from({length:1500},(_,n)=>({id:`task_${n.toString(16).padStart(32,'0')}`,text:`Prepare workstream ${n}`,agentId:archived[n%archived.length].id,status:'complete',parentTaskId:'',blockedByTaskId:'',position:n,images:[],createdAt:1,updatedAt:1}));
const text='A completed investigation with **evidence**, [source](https://example.com/) and a proposed next step.\n\n```rust\nfn inspect(value: usize) -> usize {\n    (0..value).map(|n| n * 2).sum()\n}\n```\n';
const timeline=Array.from({length:180},(_,n)=>({id:n+1,agentId:focus.id,kind:'said',text:`Result ${n}\n\n${text}`,at:1,detail:'',output:'',origin:''}));
const patch='@@ -1,120 +1,120 @@\n'+Array.from({length:120},(_,n)=>`-const option${n} = "previous setting ${n}";`).join('\n')+'\n'+Array.from({length:120},(_,n)=>`+const option${n} = "revised setting ${n}";`).join('\n');
const review={agentId:archived[0].id,id:'review-0',title:'Prepared code review',description:'',kind:'git',subject:{repository:'/workspace',branch:'proposal',baseRef:'main',remote:'origin',remoteUrl:'',baseCommit:'a'.repeat(40),headCommit:'b'.repeat(40),files:Array.from({length:3},(_,n)=>({path:`settings-${n}.ts`,patch}))}};
for(let n=0;n<20;n++)timeline[160+n].text+=`\n\n[Prepared code review](#review/review-${n})`;
const browser=await chromium.launch();
try{
 const page=await browser.newPage({viewport:{width:1200,height:900}}),errors=[];page.on('pageerror',error=>errors.push(String(error)));
 await page.addInitScript(()=>{
  window.SharedWorker=undefined;window.EventSource=class extends EventTarget{constructor(){super();window.stream=this;}close(){}};
  window.latencies=[];window.longTasks=[];
  new PerformanceObserver(list=>window.longTasks.push(...list.getEntries().map(entry=>entry.duration))).observe({entryTypes:['longtask']});
  document.addEventListener('keydown',event=>{if(!event.target.matches('[data-composer]'))return;const at=performance.now();requestAnimationFrame(()=>window.latencies.push(performance.now()-at));},true);
 });
 const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/api/version')return route.continue();
  if(path==='/api/state')return route.fulfill({json:{mode:'ask',focusAgentId:focus.id,agents:[focus,...fleet],archived,reviews,messages:{},tasks,taskNotes:[],inbox:[],paneLinks:{},quoteThreads:[],tags:{},boards:[],sources:[],models:[],backends:[]}});
  if(path==='/api/focus/agent')return route.fulfill({json:focus});
  if(path.includes('/reviews/'))return route.fulfill({json:{...review,id:path.split('/').at(-1),agentId:path.split('/')[3]}});
  if(path.startsWith('/api/agents/')){const agent=[focus,...fleet].find(agent=>agent.id===path.split('/')[3]);return route.fulfill({json:{agent,timeline:agent?.id===focus.id?timeline:[],delivery:'start'}});}
  return route.fulfill({json:path==='/api/version'?{version:'fixture'}:[]});
 });
 await page.goto(`${process.env.TEST_URL}/?view=focus`);await page.locator('[data-entry="180"]').waitFor();
 const composer=page.locator('[data-composer]').first();await composer.focus();
 await page.evaluate(()=>{window.latencies=[];window.longTasks=[];let serial=0;window.fleetTimer=setInterval(()=>{window.stream.onmessage({data:JSON.stringify({type:'progress',agentId:`worker-${serial++%24}`,text:`Checking evidence ${serial}`})});if(serial%12===0)window.stream.onmessage({data:JSON.stringify({type:"sync"})});},75);setTimeout(()=>clearInterval(window.fleetTimer),10000);});
 const started=performance.now(),typed='Measured typing during fleet updates must preserve every keystroke.';
 await page.keyboard.type(typed,{delay:20});const elapsed=performance.now()-started;
 await page.evaluate(()=>clearInterval(window.fleetTimer));
 assert.equal(await composer.inputValue(),typed);assert.deepEqual(errors,[]);
 const metrics=await page.evaluate(()=>{const keys=window.latencies.sort((a,b)=>a-b);return{keys:keys.length,median:keys[Math.floor(keys.length*.5)],p95:keys[Math.floor(keys.length*.95)],max:keys.at(-1),longTasks:window.longTasks.length,longTaskMs:window.longTasks.reduce((a,b)=>a+b,0)};});
 console.log(JSON.stringify({...metrics,elapsedMs:elapsed,msPerKey:elapsed/typed.length}));
 const entry={...timeline[0],id:181,text:'Fresh evidence remains **live** after typing.'};
 await page.evaluate(entry=>window.stream.onmessage({data:JSON.stringify({type:'timeline',entry})}),entry);
 await page.locator('[data-entry="181"] strong').getByText('live',{exact:true}).waitFor();
 assert.equal(await composer.inputValue(),typed,'Live transcript updates preserve the draft');
 const diffs=page.locator('pre[data-diff]');
 const count=await diffs.count();
 for(let at=0;at<count;at++)assert.ok((await diffs.nth(at).textContent()).includes('previous setting'),'All source remains readable before styling');
 for(const at of [count-1,0]) {
  const diff=diffs.nth(at);
  await diff.evaluate(node=>node.closest('[data-focus-review]').scrollIntoView({block:'center'}));
  await diff.scrollIntoViewIfNeeded();
  await page.waitForFunction(at=>document.querySelectorAll('pre[data-diff]')[at].getAttribute('aria-busy')==='false',at);
 }
 assert.ok(await page.locator('[data-diff-change]').count(),'Background formatting preserves changed-word emphasis');
 if(process.env.SCREENSHOT)await page.screenshot({path:process.env.SCREENSHOT});
 assert.ok(metrics.p95<100 && metrics.max<250 && elapsed/typed.length<100,`Typing exceeded the responsiveness budget: ${JSON.stringify(metrics)}, elapsed ${elapsed}ms`);
}finally{await browser.close();}
