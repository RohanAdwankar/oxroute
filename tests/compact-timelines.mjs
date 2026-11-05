// Use a disposable native daemon; no inference services are invoked.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chromium} from 'playwright';
const api=process.env.TEST_NATIVE_URL, web=process.env.TEST_URL, database=process.env.TEST_DATABASE;
assert.ok(api&&web&&database);
const call=async(path,body,headers={})=>{const response=await fetch(api+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});assert.ok(response.ok,await response.clone().text());return response.json();};
const agent=await call('/api/agents',{}), other=await call('/api/agents',{});
const seed=spawnSync('uv',['run','--no-project','python','-c',`
import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
for i in range(620):
 kind='said' if i%5==0 else 'worked'
 output=('Output '+str(i)+' Δ\\n')*2000 if kind=='worked' else ''
 c.execute('INSERT INTO entries(agent_id,at,kind,text,detail,output) VALUES(?,?,?,?,?,?)',(sys.argv[2],i+1,kind,'Message '+str(i) if kind=='said' else 'Command','step '+str(i) if kind=='worked' else '',output))
 c.execute('INSERT INTO entries(agent_id,at,kind,text,detail,output) VALUES(?,?,?,?,?,?)',(sys.argv[3],i+1,'worked','Other command','','Other agent output'))
c.commit(); c.execute('PRAGMA wal_checkpoint(TRUNCATE)');c.close()
`,database,agent.id,other.id],{encoding:'utf8'});assert.equal(seed.status,0,seed.stderr);
const full=await call(`/api/agents/${agent.id}`),compact=await call(`/api/agents/${agent.id}`,undefined,{'x-oxroute-compact':'1'});
assert.equal(compact.timeline.length,full.timeline.length);
assert.ok(compact.hasEarlier);
assert.ok(JSON.stringify(compact).length<JSON.stringify(full).length/10);
for(const [i,entry] of compact.timeline.entries()) {
 const original=full.timeline[i];
 assert.deepEqual({...entry,output:original.output,outputDeferred:undefined},{...original,outputDeferred:undefined});
 if(entry.kind==='worked'){assert.equal(entry.output,'');assert.equal(entry.outputDeferred,true);}
}
let requests=0,fail=true;
const browser=await chromium.launch(),page=await browser.newPage({viewport:{width:1280,height:900}});
try{
 await page.addInitScript(()=>{window.SharedWorker=class{port={postMessage(){},close(){}}};localStorage.setItem('oxroute.verbose','off');});
 const state=await call('/api/state');
 await page.route('**/api/**',async route=>{const r=route.request(),url=new URL(r.url());if(url.pathname==='/api/version')return route.continue();if(url.pathname==='/api/state')return route.fulfill({json:{...state,agents:[agent],archived:[],tasks:[],taskNotes:[],reviews:{},messages:{}}});if(url.pathname.endsWith('/outputs')){requests++;if(fail)return route.fulfill({status:503,json:{error:'Temporary output failure'}});}await route.fulfill({response:await page.request.fetch(api+url.pathname+url.search,{method:r.method(),data:r.postDataBuffer()??undefined,headers:r.headers()})});});
 await page.goto(`${web}/?agent=${agent.id}`);
 await page.getByText('Message 615',{exact:true}).waitFor();
 assert.equal(requests,0,'Folded logs do not download output');
 const group=page.locator('[data-agent-pane] details').last();
 await group.locator('summary').click();
 await page.getByRole('alert').getByText('Error: Temporary output failure',{exact:false}).waitFor();
 fail=false;
 await page.getByRole('button',{name:'Retry',exact:true}).click();
 const expected='Output 619 Δ\n'.repeat(2000);
 await page.waitForFunction(text=>[...document.querySelectorAll('[data-agent-pane] pre')].some(node=>node.textContent===text),expected);
 assert.equal(requests,2,'Opening a group uses one batch, with explicit retry on failure');
 assert.equal(await page.getByText('Other agent output',{exact:true}).count(),0);
 const beforeTyping=requests;
 await page.locator('[data-composer]').fill('Keep this draft');
 assert.equal(requests,beforeTyping,'Typing does not refetch tool output');
 if(process.env.ARTIFACT_DIR)await page.screenshot({path:process.env.ARTIFACT_DIR+'/tool-output-open.png'});
 await group.locator('summary').click();
 await page.waitForFunction(()=>document.querySelectorAll('[data-agent-pane] pre').length===0);
 await page.getByRole('button',{name:'Load earlier messages',exact:true}).click();
 await page.getByText('Message 0',{exact:true}).waitFor();
 assert.equal(await page.locator('[data-composer]').inputValue(),'Keep this draft');
 console.log(`Compact timeline: ${JSON.stringify(full).length} -> ${JSON.stringify(compact).length} bytes; full history, scoped complete output, batch loading, retry, folding and draft preservation passed.`);
}finally{await page.goto('about:blank');await page.unrouteAll({behavior:'wait'});await browser.close();}
