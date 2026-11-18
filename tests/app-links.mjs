import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
const browser=await(process.env.TEST_BROWSER==='webkit'?webkit:chromium).launch(process.env.WEBKIT_EXECUTABLE?{executablePath:process.env.WEBKIT_EXECUTABLE}:{});
const agent={id:'link-fixture',name:'Link handling',backend:'codex',model:'fixture',status:'complete',updatedAt:1};
const external='https://outside.test/docs?q=one#section';
const title='Improve deployment 🧭 & access';
const body='## Summary\nKeep café + symbols: % # ? & =\n\n- Preserve original text';
const compare=`https://github.com/example/project/compare/main...feature?expand=1&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}&labels=review+ready#changes`;
const other=`https://outside.test/compare/main...feature?title=${encodeURIComponent(title)}`;
const issue=`https://github.com/example/project/issues/new?title=${encodeURIComponent(title)}`;
const malformed=['https://[invalid','https://example.invalid:bad/document','/api/attachments/view%ZZ.pdf'];
const damaged=malformed.map((href,index)=>`[Unparseable link ${index+1}](${href})`).join('\n\n')+'\n\n![Unparseable image](/api/attachments/preview%FF.png)';
try{for(const standalone of [false,true]){
 const context=await browser.newContext({viewport:{width:1100,height:800}}),page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(String(error)));
 await page.addInitScript(standalone=>{
  const media=window.matchMedia.bind(window);window.matchMedia=query=>{const result=media(query);if(query==='(display-mode: standalone)')Object.defineProperty(result,'matches',{value:standalone});return result;};
  window.SharedWorker=undefined;window.EventSource=class extends EventTarget{close(){}};
 },standalone);
 await context.route('https://github.com/**',r=>r.fulfill({contentType:'text/html',body:'<p>PR form</p>'}));
 await context.route('https://outside.test/**',r=>r.fulfill({contentType:'text/html',body:'<p>External document</p>'}));
 await page.route('**/api/**',r=>{
  const url=new URL(r.request().url());if(url.pathname==='/api/version')return r.continue();
  if(url.pathname==='/api/state')return r.fulfill({json:{mode:'ask',agents:[agent],archived:[],messages:{},tasks:[],taskNotes:[],inbox:[],paneLinks:{},tags:{},boards:[],sources:[],models:[],backends:[]}});
  if(url.pathname==='/api/terminals')return r.fulfill({json:[]});
  if(url.pathname===`/api/agents/${agent.id}`)return r.fulfill({json:{agent,timeline:[{id:1,agentId:agent.id,at:1,kind:'answer',text:`[**External docs**](${external})\n\n[Local file](/api/attachments/fixture.txt)\n\n[Prefilled PR](${compare})\n\n[New PR](https://github.com/example/project/pull/new/feature?title=${encodeURIComponent(title)})\n\n[Other site](${other})\n\n[Issue form](${issue})\n\n${damaged}`,detail:'',output:'',origin:'',reaction:''}],delivery:'start'}});
  return r.fulfill({contentType:'text/plain',body:'Fixture file'});
 });
 const address=`${process.env.TEST_URL}/?agent=${agent.id}`;await page.goto(address);await page.locator('[data-composer]').waitFor();
 for(let index=0;index<malformed.length;index++)await page.getByRole('link',{name:`Unparseable link ${index+1}`,exact:true}).waitFor();
 assert.equal(await page.getByRole('img',{name:'Unparseable image',exact:true}).count(),1);
 assert.equal(await page.getByTitle('Review submitted file',{exact:true}).count(),1,'Only valid file links receive a review control');
 assert.deepEqual(errors,[],'Untrusted link classification cannot crash the conversation');
 const link=page.getByRole('link',{name:'External docs',exact:true});await link.waitFor();assert.equal(await link.getAttribute('target'),'_blank');
 const pr=page.getByRole('link',{name:'Prefilled PR',exact:true});
 const encoded=await pr.getAttribute('href'),parsed=new URL(encoded);
 assert.equal(parsed.searchParams.get('title'),title);assert.equal(parsed.searchParams.get('body'),body);
 assert.equal(parsed.pathname,new URL(compare).pathname);assert.equal(parsed.hash,'#changes');
 assert.ok(parsed.search.includes('labels=review+ready'),'Unrelated query values keep their representation');
 for(const key of ['title','body']){
  const raw=parsed.search.slice(1).split('&').find(field=>field.startsWith(`${key}=`)).slice(key.length+1);
  assert.match(raw,/^(?:%[0-9a-f]{2})+$/,'Every UTF-8 byte is escaped, including ordinary letters');
 }
 assert.equal(new URL(await page.getByRole('link',{name:'New PR',exact:true}).getAttribute('href')).searchParams.get('title'),title);
 assert.equal(await page.getByRole('link',{name:'Other site',exact:true}).getAttribute('href'),other);
 assert.equal(await page.getByRole('link',{name:'Issue form',exact:true}).getAttribute('href'),issue);
 const prPopup=page.waitForEvent('popup');await pr.click();const form=await prPopup;await form.waitForURL(encoded);
 assert.equal(new URL(form.url()).searchParams.get('body'),body);await form.close();
 const nativeMenu=await link.locator('strong').evaluate(element=>element.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2})));
 assert.equal(nativeMenu,true,'Links retain the browser menu with Copy Link Address');
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

 await page.reload();await page.locator('[data-composer]').waitFor();
 assert.deepEqual(errors,[],'Malformed links remain harmless after reload');
 await context.close();
}console.log('External links preserve native new-window navigation in browser and app modes; Oxroute has an explicit same-origin app scope. Internal files, downloads, non-web schemes and modifier gestures retain their behavior.');}finally{await browser.close();}
