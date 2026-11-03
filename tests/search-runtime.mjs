// Read-only measurement against an explicitly selected representative runtime.
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { chromium } from 'playwright';
const web=process.env.TEST_URL, native=process.env.TEST_NATIVE_URL, queries=JSON.parse(process.env.TEST_QUERIES??'[]');
assert.ok(web&&native&&queries.length);
const proxy=createServer((req,res)=>{
 const target=req.url.startsWith('/api/')&&req.url!=='/api/version'?native:web;
 const upstream=request(target+req.url,{method:req.method,headers:req.headers},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res)});
 upstream.on('error',()=>res.destroy());res.on('close',()=>upstream.destroy());req.pipe(upstream);
});
await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch();
const page=await browser.newPage({viewport:{width:1280,height:900}});
await page.addInitScript(()=>{window.SharedWorker=class{port={postMessage(){},close(){}}};});
const timings=[];
try{
 await page.goto(`http://127.0.0.1:${proxy.address().port}`);
 await page.getByRole('button',{name:'Search sessions',exact:true}).click();
 const input=page.getByRole('searchbox',{name:'search all sessions',exact:true});
 for(const query of queries){
  const start=performance.now();await input.fill(query);
  await page.waitForFunction(()=>[...document.querySelectorAll('[role="dialog"]')].some(dialog=>dialog.getAttribute('aria-label')==='Session search'&&dialog.textContent.includes('Oxroute sessions')),null,{polling:'raf'});
  const visibleMs=Math.round(performance.now()-start);
  const apiStart=performance.now();
  const response=await fetch(`${native}/api/search?q=${encodeURIComponent(query)}`);
  assert.equal(response.status,200);const hits=await response.json();assert.ok(hits.length);
  const destination=hits[0].destinations[0];
  const context=await(await fetch(`${native}/api/agents/${destination.agentId}/context/${destination.entryId}`)).json();
  assert.ok(context.some(entry=>entry.id===destination.entryId));
  assert.ok(context.every(entry=>entry.agentId===destination.agentId));
  timings.push({query,visibleMs,apiMs:Math.round(performance.now()-apiStart)});
 }
 await page.getByRole('dialog',{name:'Session search',exact:true}).getByText('Loading context…',{exact:true}).waitFor({state:'detached'});
 if(process.env.SCREENSHOT)await page.screenshot({path:process.env.SCREENSHOT});
 console.log(JSON.stringify({timings,context:'Context includes the exact matching entry in its own conversation'}));
}finally{await browser.close();proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}
