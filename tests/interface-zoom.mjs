import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const agent={id:'zoom-source',name:'Source inspection',backend:'codex',model:'fixture',status:'complete',updatedAt:1};
const files=['source.rs','settings.toml'].map(path=>({path,patch:`diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,2 +1,2 @@\n-previous source value\n+current source value\n preserved source context`}));
const review={id:'proportions',agentId:agent.id,title:'Review control proportions',description:'Inspect the exact local source change.',status:'pending',snapshot:{repository:'/workspace',branch:'change',baseRef:'main',remote:'origin',remoteUrl:'https://example.invalid/source',baseCommit:'a'.repeat(40),headCommit:'b'.repeat(40),files}};
const browser=await chromium.launch();
try{
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],writes=[];page.on('pageerror',error=>errors.push(String(error)));
 await page.addInitScript(()=>{window.SharedWorker=undefined;window.EventSource=class extends EventTarget{close(){}};});
 await page.route('**/api/**',route=>{if(route.request().method()!=='GET')writes.push(route.request().url());return route.fulfill({json:[]});});
 await page.route('**/api/version',route=>route.continue());
 await page.route('**/api/state',route=>route.fulfill({json:{mode:'ask',agents:[agent],archived:[],messages:{},tasks:[],taskNotes:[],inbox:[],paneLinks:{},tags:{},boards:[],sources:[],models:[],backends:[]}}));
 await page.route('**/api/agents/*',route=>route.fulfill({json:{agent,timeline:[{id:1,agentId:agent.id,at:1,kind:'said',text:'Retain the source findings and the current reply draft.',detail:''},{id:2,agentId:agent.id,at:2,kind:'review',text:review.title,detail:review.id}],delivery:'start'}}));
 await page.route('**/reviews/proportions',route=>route.fulfill({json:review}));
 const scale=async(value)=>{await page.keyboard.press('Control+0');for(let n=100;n>value;n-=10)await page.keyboard.press('Control+-');for(let n=100;n<value;n+=10)await page.keyboard.press('Control+=');};
 const inspect=()=>page.evaluate(()=>{const icon=document.querySelector('button[aria-label="Settings"] svg'),cell=icon.parentElement,pre=document.querySelector('[aria-label="Diff source.rs"] pre');return{icon:icon.getBoundingClientRect().height,cell:cell.getBoundingClientRect().height,font:parseFloat(getComputedStyle(pre).fontSize),bar:document.querySelector('[data-app-header]').getBoundingClientRect().height};});
 for(const width of[1280,390]){
  await page.setViewportSize({width,height:900});await page.goto(`${process.env.TEST_URL}/?agent=${agent.id}`);
  await page.getByRole('button',{name:`Review ${review.title}`,exact:true}).click();const pane=page.getByRole('region',{name:'Change review',exact:true});await pane.getByRole('region',{name:'Diff source.rs',exact:true}).locator('pre[aria-busy="false"]').waitFor();
  await scale(100);const normal=await inspect();
  for(const value of process.env.ZOOM_REPRO?[50]:[50,80,100,150,200]){
   await scale(value);const current=await inspect(),ratio=(current.icon/normal.icon)/(current.font/normal.font);
   if(process.env.ZOOM_REPRO){assert.ok(ratio>1.8,'Reproduce fixed controls against shrinking diff text');console.log(JSON.stringify({width,normal,current,ratio}));}
   else if(value<100){assert.ok(Math.abs(ratio-1)<.08,`Controls and diff text shrink together at ${value}%: ${JSON.stringify({normal,current,ratio})}`);assert.ok(Math.abs(current.cell/normal.cell-value/100)<.08,'Control hit areas follow the same zoom-out scale');}
   else assert.ok(current.icon<=normal.icon+.1,'Zoom-in retains the established maximum icon size');
   for(const name of ['Back to conversation','Request changes','Approve publication']){const box=await pane.getByRole('button',{name,exact:true}).boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=width+.1,'Review actions remain reachable without overlapping off-screen controls');}
   if(process.env.SCREENSHOT)await page.screenshot({path:`${process.env.SCREENSHOT}-${width}-${value}.png`});
  }
  if(!process.env.ZOOM_REPRO){if(width>=640)await pane.getByRole('navigation',{name:'Changed files'}).getByRole('button',{name:'settings.toml',exact:true}).click();else await pane.getByRole('region',{name:'Diff settings.toml',exact:true}).scrollIntoViewIfNeeded();await pane.getByRole('region',{name:'Diff settings.toml',exact:true}).waitFor();await scale(100);await page.reload();await page.getByRole('button',{name:`Review ${review.title}`,exact:true}).waitFor();}
 }
 assert.deepEqual(errors,[]);assert.deepEqual(writes,[],'Zoom, selection and source inspection never approve or mutate the review');console.log(process.env.ZOOM_REPRO?'Reproduced the reported control/text zoom mismatch.':'Review/navigation controls and diff text scale proportionally when shrinking, retain maximum icon size when growing, preserve file navigation, reset and reload at desktop/narrow widths.');
}finally{await browser.close();}
