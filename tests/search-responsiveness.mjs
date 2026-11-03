import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.TEST_URL;
assert.ok(base);
const agents = Array.from({length: 12}, (_, i) => ({id: `session-${i}`, name: `Session ${i}`, status: 'complete', backend: 'codex', model: 'test', updatedAt: 0}));
const state = {mode:'ask',agents,archived:[],messages:{},tasks:[],taskNotes:[],inbox:[],paneLinks:{},quoteThreads:[],tags:{},boards:[],sources:[],models:[],backends:[]};
const browser = await chromium.launch();
const page = await browser.newPage();
const gates = new Map();
const pending = query => { let release; const promise = new Promise(resolve => { release = resolve; }); gates.set(query,{promise,release}); };
pending('quartz'); pending('cobalt');
const warmed = new Set(), requests = new Map(), failures = [];
await page.addInitScript(() => { window.SharedWorker = class {port = {postMessage(){},close(){}}}; });
await page.route('**/api/**', async route => {
 const url = new URL(route.request().url()), path = url.pathname;
 if(path==='/api/version') return route.continue();
 if(path==='/api/state') return route.fulfill({json:state});
 if(path==='/api/terminals') return route.fulfill({json:[]});
 if(path==='/api/client-failures') { failures.push(route.request().postDataJSON()); return route.fulfill({json:{}}); }
 if(path==='/api/search/native') return route.fulfill({json:[{backend:'codex',sessionId:'native',name:'Native session',preview:'Native words',updatedAt:1}]});
 if(path==='/api/native-preview') return route.fulfill({json:[{role:'user',text:'Native conversation is available'}]});
 if(path==='/api/search') {
  const query=url.searchParams.get('q'); requests.set(query,route.request());
  if(gates.has(query)) await gates.get(query).promise;
  return route.fulfill({json:[{at:1,kind:'said',text:`${query} result`,detail:'',origin:'',destinations:[{agentId:agents[0].id,agentName:agents[0].name,entryId:7}]}]});
 }
 if(path.includes('/context/')) return route.fulfill({json:[{id:7,agentId:agents[0].id,kind:'said',text:'Matching context',detail:'',at:1}]});
 if(path.startsWith('/api/agents/')) {
  const id=path.split('/').at(-1); warmed.add(id);
  await new Promise(resolve=>setTimeout(resolve,100));
  return route.fulfill({json:{agent:agents.find(a=>a.id===id),timeline:[],hasEarlier:false,delivery:'start'}});
 }
 return route.fulfill({json:[]});
});
try {
 await page.goto(base);
 await page.getByRole('button',{name:'Search sessions',exact:true}).click();
 const input=page.getByRole('searchbox',{name:'search all sessions',exact:true});
 const dialog=page.getByRole('dialog',{name:'Session search',exact:true});
 const count=warmed.size;
 await input.fill('quartz');
 await dialog.getByText('Native conversation is available',{exact:true}).waitFor();
 assert.ok(requests.has('quartz'));
 assert.equal(warmed.size,count,'Prefetch pauses during interactive search');
 gates.get('quartz').release();
 await dialog.getByText('quartz result',{exact:true}).waitFor();
 await dialog.getByText('Matching context',{exact:true}).waitFor();
 await input.fill('cobalt');
 await page.waitForFunction(()=>document.querySelector('[aria-label="search all sessions"]').value==='cobalt');
 while(!requests.has('cobalt')) await page.waitForTimeout(20);
 await input.fill('topaz');
 await dialog.getByText('topaz result',{exact:true}).waitFor();
 assert.ok(requests.get('cobalt').failure(),'Superseded requests are aborted');
 gates.get('cobalt').release();
 await page.getByRole('button',{name:'Close search',exact:true}).click();
 for(let i=0;i<100&&warmed.size<agents.length;i++) await page.waitForTimeout(20);
 assert.equal(warmed.size,agents.length,'Conversation prefetch resumes after closing search');
 assert.equal(failures.length,0,'Cancellation does not report a client failure');
 console.log('Native results remain usable during a slow stored search; stale reads cancel; conversation prefetch pauses and resumes.');
} finally { for(const gate of gates.values())gate.release(); await page.unrouteAll({behavior:'wait'}); await browser.close(); }
