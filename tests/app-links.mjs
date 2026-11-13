import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
const browser=await(process.env.TEST_BROWSER==='webkit'?webkit:chromium).launch(process.env.WEBKIT_EXECUTABLE?{executablePath:process.env.WEBKIT_EXECUTABLE}:{});
const agent={id:'link-fixture',name:'Link handling',backend:'codex',model:'fixture',status:'complete',updatedAt:1};
const external='https://outside.test/docs?q=one#section';
try{for(const standalone of [false,true]){
 const context=await browser.newContext({viewport:{width:1100,height:800}}),page=await context.newPage();
 await page.addInitScript(standalone=>{
  const media=window.matchMedia.bind(window);window.matchMedia=query=>{const result=media(query);if(query==='(display-mode: standalone)')Object.defineProperty(result,'matches',{value:standalone});return result;};
  window.SharedWorker=undefined;window.EventSource=class extends EventTarget{close(){}};
 },standalone);
 await context.route('https://outside.test/**',r=>r.fulfill({contentType:'text/html',body:'<p>External document</p>'}));
 await page.route('**/api/**',r=>{
  const url=new URL(r.request().url());if(url.pathname==='/api/version')return r.continue();
  if(url.pathname==='/api/state')return r.fulfill({json:{mode:'ask',agents:[agent],archived:[],messages:{},tasks:[],taskNotes:[],inbox:[],paneLinks:{},tags:{},boards:[],sources:[],models:[],backends:[]}});
  if(url.pathname==='/api/terminals')return r.fulfill({json:[]});
  if(url.pathname===`/api/agents/${agent.id}`)return r.fulfill({json:{agent,timeline:[{id:1,agentId:agent.id,at:1,kind:'answer',text:`[**External docs**](${external})\n\n[Local file](/api/attachments/fixture.txt)`,detail:'',output:'',origin:'',reaction:''}],delivery:'start'}});
  return r.fulfill({contentType:'text/plain',body:'Fixture file'});
 });
 const address=`${process.env.TEST_URL}/?agent=${agent.id}`;await page.goto(address);await page.locator('[data-composer]').waitFor();
 const link=page.getByRole('link',{name:'External docs',exact:true});await link.waitFor();assert.equal(await link.getAttribute('target'),'_blank');
 // All ordinary browser links and explicit modifier gestures retain their targets.
 const controls=await page.evaluate(external=>{
  const checks=[];
  for(const extra of [{href:'/api/attachments/test.txt'},{href:'mailto:test@example.invalid'},{href:external,download:'file'},{href:external,metaKey:true},{href:external,ctrlKey:true},{href:external,shiftKey:true},{href:external,altKey:true}]){
   const a=document.createElement('a');a.href=extra.href;a.target='_blank';if(extra.download)a.download=extra.download;a.textContent='test';document.body.append(a);
   a.addEventListener('click',e=>e.preventDefault());a.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,...extra}));checks.push(a.target);a.remove();
  }
  return checks;
 },external);assert.ok(controls.every(target=>target==='_blank'));
 if(process.env.SCREENSHOT&&standalone)await page.screenshot({path:process.env.SCREENSHOT});
 const opened=page.waitForEvent('popup');await link.click();const popup=await opened;await popup.waitForURL(external);assert.equal(page.url(),address);await popup.close();
 const manifest=await(await page.request.get(new URL('/manifest.webmanifest',address).href)).json();assert.equal(manifest.scope,'/');

 await context.close();
}console.log('External links preserve native new-window navigation in browser and app modes; Oxroute has an explicit same-origin app scope. Internal files, downloads, non-web schemes and modifier gestures retain their behavior.');}finally{await browser.close();}
