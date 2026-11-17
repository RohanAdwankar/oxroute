import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
const agents=Array.from({length:24},(_,i)=>({id:`card-${i}`,name:`Conversation ${i} with a longer title`,status:'complete',backend:'codex',model:'fixture',updatedAt:1}));
const focusAgent={...agents[0],id:'fixture-focus',name:'Focus'};
const browser=await(process.env.BROWSER==='webkit'?webkit:chromium).launch(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{});
try{
 const page=await browser.newPage({viewport:{width:1100,height:750}});
 await page.addInitScript(ids=>{sessionStorage.setItem('oxroute.sessionTabs',JSON.stringify(ids));window.SharedWorker=undefined;window.EventSource=class extends EventTarget{close(){}};},agents.map(a=>a.id));
 await page.route('**/api/**',route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/api/version')return route.continue();
  if(path==='/api/focus/agent')return route.fulfill({json:focusAgent});
  if(path==='/api/state')return route.fulfill({json:{mode:'ask',nextActionSuggestions:false,agents,archived:[],tasks:[],taskNotes:[],messages:{},inbox:[],paneLinks:{},tags:{},boards:[],sources:[],models:[],backends:[]}});
  const agent=[...agents,focusAgent].find(a=>path===`/api/agents/${a.id}`);
  return route.fulfill({json:agent?{agent,timeline:[],delivery:'start'}:[]});
 });
 await page.goto(`${process.env.TEST_URL}/?agent=card-0`);
 const nav=page.getByRole('navigation',{name:'Session tabs',exact:true}),focus=nav.getByRole('tab',{name:'Focus',exact:true});await focus.waitFor();
 const start=await focus.boundingBox();
 await nav.evaluate(el=>{const scroll=[el,...el.querySelectorAll('*')].find(node=>getComputedStyle(node).overflowX==='auto'&&node.scrollWidth>node.clientWidth);scroll.scrollLeft=scroll.scrollWidth;});await page.waitForTimeout(100);
 const end=await focus.boundingBox();assert.ok(Math.abs(start.x-end.x)<1,`Focus moved from ${start.x} to ${end.x}`);
 assert.ok(await nav.evaluate(el=>[el,...el.querySelectorAll('*')].some(node=>node.scrollLeft>0)),'Conversation tabs remain horizontally scrollable');
 assert.ok(await nav.evaluate(el=>el.offsetHeight-el.clientHeight<2),'Scrollbar consumes no toolbar height');
 const last=nav.getByRole('tab',{name:agents.at(-1).name,exact:true});await last.click();await last.press('Home');await focus.focus();
 assert.equal(await focus.evaluate(el=>el===document.activeElement),true);
 if(process.env.SCREENSHOT)await page.screenshot({path:process.env.SCREENSHOT});
 console.log('Focus stays pinned during tab scrolling; native scrollbar is hidden and session tabs remain navigable.');
}finally{await browser.close();}
