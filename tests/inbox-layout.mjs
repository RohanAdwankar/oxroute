// Render-only fixtures cannot mutate the live daemon or external sources.
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const browser=await chromium.launch();
try{
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
 page.on('pageerror',error=>errors.push(String(error)));
 await page.addInitScript(()=>{window.SharedWorker=undefined;window.EventSource=class extends EventTarget{close(){}};});
 const at=Date.now()/1000;
 let items=[['direct','Source participant','Current incoming observations'],['group','Group · Source participant, Source collaborator','New group request']].map(([id,label,text],index)=>({signal:{id,source:'slack-inbox',conversation:`workspace:reader:${id}`,threadKey:'conversation',externalId:id,author:'provider-author',label:'provider-label',text,attachments:[],at:at-index,root:true},display:{label,preview:`Source participant: ${text}`,text:`Source participant: Earlier relevant context\n\nSource collaborator: ${text}`},state:'waiting',outcome:'',agentIds:[],sourceUrl:'https://example.invalid/source'}));
 await page.route('**/api/**',route=>route.fulfill({json:[]}));
 await page.route('**/api/version',route=>route.continue());
 await page.route('**/api/state',route=>route.fulfill({json:{mode:'ask',agents:[],archived:[],messages:{},tasks:[],taskNotes:[],inbox:items,inboxWaiting:items.length,inboxClearThrough:25,paneLinks:{},quoteThreads:[],tags:{},boards:[],sources:[],models:[],backends:[]}}));
 const contexts=new Map(items.map(item=>[item.signal.id,item.display.text]));let contextReads=0;
 for(const item of items)item.display.text="";
 await page.route('**/api/intake/*',route=>{contextReads++;const id=new URL(route.request().url()).pathname.split('/').at(-1),item=items.find(item=>item.signal.id===id);return route.fulfill({json:{...item,display:{...item.display,text:contexts.get(id)}}});});
 const session=await page.context().newCDPSession(page);
 for(const width of [1280,390])for(const zoom of [.8,1,1.25]){
  // Browser zoom changes effective CSS viewport and device pixel ratio together.
  await session.send('Emulation.setDeviceMetricsOverride',{width:Math.round(width/zoom),height:Math.round(900/zoom),deviceScaleFactor:zoom,mobile:false});
  await page.goto(process.env.TEST_URL);
  const inbox=page.locator('aside').filter({has:page.getByText('Inbox',{exact:true})}),clear=inbox.getByRole('button',{name:'Clear all inbox arrivals',exact:true});await clear.waitFor();
  assert.ok(await clear.isEnabled());assert.equal(await inbox.locator('textarea').count(),0);assert.equal(await inbox.getByRole('button',{name:'add to the inbox',exact:true}).count(),0);
  assert.equal(await inbox.getByText('provider-author',{exact:false}).count(),0);await inbox.getByText('Source participant',{exact:true}).waitFor();
  const box=await clear.boundingBox(),viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));assert.ok(box.x>=0&&box.x+box.width<=viewport.width&&box.y>=0&&box.y+box.height<=viewport.height,'Bulk action remains reachable at narrow widths and zoom');
  const text=await inbox.getByText('Current incoming observations',{exact:false}).evaluate(node=>{const css=getComputedStyle(node);return {font:parseFloat(css.fontSize),line:parseFloat(css.lineHeight),height:node.getBoundingClientRect().height};});assert.ok(text.line>=text.font&&text.height>=text.font);
  await clear.focus();assert.ok(await clear.evaluate(node=>node===document.activeElement),'Bulk action remains keyboard reachable');
  if(process.env.SCREENSHOT)await page.screenshot({path:`${process.env.SCREENSHOT}-${width}-${zoom}.png`,clip:{x:0,y:0,width:viewport.width,height:viewport.height},captureBeyondViewport:false});
  if(width===1280&&zoom===1){const divider=page.getByRole('separator',{name:'resize inbox',exact:true});const initial=await divider.boundingBox();await page.mouse.move(initial.x+2,initial.y+initial.height/2);await page.mouse.down();await page.mouse.move(initial.x-30,initial.y+initial.height/2);await page.mouse.up();assert.ok((await divider.boundingBox()).x<initial.x,'Existing sidebar resizing is retained');}
  await inbox.locator('[data-inbox-item]').last().click();await inbox.getByRole('button',{name:'collapse inbox',exact:true}).click();await page.getByLabel('Conversation context',{exact:true}).getByText('Earlier relevant context',{exact:false}).waitFor();assert.equal(await page.getByRole('link',{name:'Open source message',exact:true}).getAttribute('href'),'https://example.invalid/source');
 }
 assert.ok(contextReads>0,'Opening an arrival retrieves its retained full conversation separately from list previews');
 items=[];await page.goto(process.env.TEST_URL);const button=page.getByRole('button',{name:'Show or hide the inbox',exact:true});await button.click();await page.getByText('New incoming messages and direct mentions appear here.',{exact:true}).waitFor();assert.ok(await page.getByRole('button',{name:'Clear all inbox arrivals',exact:true}).isDisabled());
 if(process.env.SCREENSHOT)await page.screenshot({path:`${process.env.SCREENSHOT}-empty.png`});
 assert.deepEqual(errors,[]);console.log('Inbox desktop/narrow rendering passes at 80%, 100% and 125% browser zoom metrics: readable source names, accurate source time, keyboard-reachable Clear all, preserved resizing/context/source navigation, empty state and removed manual input.');
}finally{await browser.close();}
