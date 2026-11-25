// Exercise real daemon list/detail data without forwarding any browser writes.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {fixtureState} from './fixture-state.mjs';

export async function verifyPopulatedInbox(native,web,{allowEmpty=false,screenshots}={}) {
 const read=async path=>{const r=await fetch(native+path);assert.ok(r.ok,`${path}: ${r.status}`);return r.json();};
 const snapshot=await read('/api/state'),seen=new Set();
 const items=snapshot.inbox.filter(item=>{
  const key=JSON.stringify([item.signal.source,item.signal.conversation,item.signal.threadKey]);
  if(item.state!=='waiting'||!['slack-inbox','outlook-inbox'].includes(item.signal.source)||seen.has(key))return false;
  seen.add(key);return true;
 }).slice(0,2);
 if(items.length<2){assert.ok(allowEmpty,'Two populated source conversations are required');console.log('Live source sample has fewer than two distinct pending conversations; populated source coverage is unavailable, separate real-daemon fixture checks remain required.');return;}
 const details=await Promise.all(items.map(item=>read(`/api/intake/${encodeURIComponent(item.signal.id)}`)));
 for(let n=0;n<items.length;n++){
  assert.equal(details[n].signal.id,items[n].signal.id);assert.equal(details[n].signal.at,items[n].signal.at);
  if(items[n].signal.source==='slack-inbox')assert.equal(items[n].display.text,'','List previews do not repeat full source histories');
 }
 const text=item=>item.display?.text||item.signal.text;
 assert.ok(details.every(item=>text(item).length>0),'Full source context stays accessible');
 const browser=await chromium.launch();let release,held=false,failed=false;
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',error=>errors.push(String(error)));
  await page.addInitScript(()=>{window.SharedWorker=undefined;window.EventSource=class extends EventTarget{close(){}};});
  const gate=new Promise(done=>release=done);
  await page.route('**/api/**',async route=>{
   const url=new URL(route.request().url()),path=url.pathname;
   if(path==='/api/version')return route.continue();
   if(path==='/api/state')return route.fulfill({json:{...fixtureState(snapshot,[]),inbox:snapshot.inbox,inboxWaiting:snapshot.inboxWaiting,inboxClearThrough:snapshot.inboxClearThrough}});
   const n=items.findIndex(item=>path===`/api/intake/${encodeURIComponent(item.signal.id)}`);
   if(n>=0){
    if(n===0&&!held){held=true;await gate;}
    if(n===1&&!failed){failed=true;return route.fulfill({status:503,json:{error:'Source context temporarily unavailable'}});}
    return route.fulfill({json:details[n]});
   }
   if(path.startsWith('/api/routing-recommendations/'))return route.fulfill({json:null});
   return route.fulfill({json:[]});
  });
  await page.goto(web);
  const row=n=>page.locator('[data-inbox-item]').filter({has:page.locator(`time[datetime="${new Date(items[n].signal.at*1000).toISOString()}"]`)}).first();
  const context=page.getByLabel('Conversation context',{exact:true});
  const content=async n=>{await context.waitFor();await page.waitForFunction(expected=>document.querySelector('[aria-label="Conversation context"]')?.textContent===expected,text(details[n]));};
  const choose=async n=>{
   if(!await row(n).isVisible())await page.getByRole('button',{name:'Show or hide the inbox',exact:true}).click();
   await row(n).click();
   assert.ok(await page.getByRole('button',{name:'Clear all inbox arrivals',exact:true}).isEnabled(),'Presentation clearing remains available without being invoked');
   if(await page.evaluate(()=>innerWidth<640))await page.getByRole('button',{name:'collapse inbox',exact:true}).click();
  };
  await row(0).click();await page.waitForFunction(()=>document.querySelector('[aria-label="Conversation context"]')?.textContent.includes('Loading conversation'));
  await row(1).click();await page.getByRole('button',{name:'Retry conversation context',exact:true}).click();await content(1);
  release();await page.waitForTimeout(100);await content(1);
  if(screenshots)await mkdir(screenshots,{recursive:true});
  const session=await page.context().newCDPSession(page);
  for(const width of [1280,390])for(const zoom of [.8,1,1.25]){
   await session.send('Emulation.setDeviceMetricsOverride',{width:Math.round(width/zoom),height:Math.round(900/zoom),deviceScaleFactor:zoom,mobile:false});
   await choose(0);await content(0);await choose(1);await content(1);
   await page.keyboard.press('Escape');await choose(1);await content(1);
   if(items[1].sourceUrl)assert.equal(await page.getByRole('link',{name:'Open source message',exact:true}).getAttribute('href'),items[1].sourceUrl);
   const box=await context.boundingBox();assert.ok(box&&box.width>0&&box.height>0);
   if(screenshots)await page.screenshot({path:`${screenshots}/populated-${width}-${zoom}.png`});
  }
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({populatedInboxItems:snapshot.inbox.length,sourceContextLengths:details.map(item=>text(item).length),openSwitchReturnRetry:true,lateResponsesIsolated:true,browserWritesForwarded:0,desktopNarrowZoom:true}));
 }finally{release?.();for(const context of browser.contexts())for(const page of context.pages())await page.unrouteAll({behavior:'wait'});await browser.close();}
}
