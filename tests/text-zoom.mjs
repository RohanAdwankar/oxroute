import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
const agent={id:'reading-fixture',name:'Reading sample',cwd:'/workspace',backend:'codex',model:'fixture',status:'complete',updatedAt:Date.now()/1000};
const text='Longer reading content wraps naturally as the requested text size increases while the application controls retain their geometry.';
const browser=await(process.env.BROWSER==='webkit'?webkit:chromium).launch();
try{
 const page=await browser.newPage({viewport:{width:1280,height:850}});
 await page.route('**/api/state',route=>route.fulfill({json:{mode:'ask',agents:[agent],archived:[],messages:{[agent.id]:text},tasks:[],taskNotes:[],inbox:[],paneLinks:{},tags:{},boards:[],sources:[],models:[],backends:[]}}));
 await page.route('**/api/events',route=>route.fulfill({contentType:'text/event-stream',body:': fixture\n\n'}));
 await page.route('**/api/agents/*',route=>route.fulfill({json:{agent,timeline:[{id:1,agentId:agent.id,kind:'said',text,detail:'',at:Date.now()/1000}],delivery:'start'}}));
 await page.goto(`${process.env.TEST_URL}/?agent=${agent.id}`);
 const content=page.locator('[data-entry="1"]').getByText(text,{exact:true}),composer=page.locator('[data-composer]'),settings=page.getByRole('button',{name:'Settings',exact:true});await content.waitFor();await composer.fill('Retain this draft.');
 const inspect=()=>page.evaluate(()=>{const header=document.querySelector('[data-app-header]'),settings=document.querySelector('button[aria-label="Settings"]'),content=document.querySelector('[data-entry="1"] p');return{font:parseFloat(getComputedStyle(content).fontSize),line:parseFloat(getComputedStyle(content).lineHeight),bar:header.getBoundingClientRect().height,cell:settings.getBoundingClientRect().height,icon:settings.querySelector('svg').getBoundingClientRect().height,overflow:document.documentElement.scrollWidth>innerWidth};});
 for(const width of[1280,390]){
  await page.setViewportSize({width,height:850});await page.keyboard.press('Meta+0');const before=await inspect();
  for(let i=0;i<5;i++)await page.keyboard.press('Meta+-');
  const smaller=await inspect();assert.ok(Math.abs(smaller.font-before.font*.5)<.1);assert.ok(Math.abs(smaller.icon-before.icon*.5)<.1&&Math.abs(smaller.cell-before.cell*.5)<.1,'Zoom-out controls retain their proportion to reading text');assert.ok(!smaller.overflow);await page.keyboard.press('Meta+0');
  for(let i=0;i<5;i++)await page.keyboard.press('Meta+=');
  let after=await inspect();assert.ok(Math.abs(after.font-before.font*1.5)<.1);assert.deepEqual([after.bar,after.cell,after.icon],[before.bar,before.cell,before.icon],'Text growth retains toolbar and icon geometry');assert.ok(after.line>=after.font&&!after.overflow,'Larger text has line space and reflows within the viewport');
  for(let i=0;i<5;i++)await page.keyboard.press('Meta+-');assert.equal((await inspect()).font,before.font);
  for(let i=0;i<10;i++)await page.keyboard.press('Control+Shift+=');after=await inspect();assert.ok(Math.abs(after.font-before.font*2)<.1);assert.deepEqual([after.bar,after.cell,after.icon],[before.bar,before.cell,before.icon]);
  if(width===1280){const time=await page.locator('[data-message-time]').first().boundingBox(),body=await content.boundingBox();assert.ok(time.x+time.width<=body.x,'Timestamp text cannot overlap the growing message');}
  await page.reload();await content.waitFor();assert.equal((await inspect()).font,after.font,'Reading size survives reload');assert.equal(await composer.inputValue(),'Retain this draft.');
  if(process.env.SCREENSHOT)await page.screenshot({path:process.env.SCREENSHOT.replace('.png',`-${width}.png`)});
  await page.keyboard.press('Control+0');assert.equal((await inspect()).font,before.font);await composer.fill('Retain this draft.');
 }
 await page.keyboard.press('=');assert.equal(await composer.inputValue(),'Retain this draft.=','Unmodified input remains available');
 console.log('Repeated Cmd/Ctrl plus, minus and reset scale reading text with stable icons and toolbar, preserve drafts and reload size, and reflow at desktop/mobile widths including 200%.');
}finally{await browser.close();}
