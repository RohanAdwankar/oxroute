import assert from 'node:assert/strict';
import {copyFile, writeFile, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';

// Explicit disposable runtime: never write review decisions to the shared daemon.
const native=process.env.TEST_NATIVE_URL, web=process.env.TEST_URL, fixtures=process.env.TEST_FIXTURES;
assert.ok(native && web && fixtures, 'Set TEST_NATIVE_URL, TEST_URL and TEST_FIXTURES to a disposable runtime');
const snapshot=await (await fetch(`${native}/api/state`)).json();
assert.ok(snapshot.artifactRoot.includes('/.tmp/'), 'File review tests require a disposable artifact root');
async function api(path,body){const r=await fetch(native+path,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok,await r.clone().text());return r.json();}
const agent=await api('/api/agents',{id:`agent_${crypto.randomUUID().replaceAll("-", "")}`});
const paths={};
for(const ext of ['pdf','pptx','txt']){paths[ext]=join(snapshot.artifactRoot,`proposal.${ext}`);await copyFile(join(fixtures,`proposal.${ext}`),paths[ext]);}
const create=path=>api(`/api/agents/${agent.id}/file-reviews`,{path});
const pdf=await create(paths.pdf), slides=await create(paths.pptx), text=await create(paths.txt);
assert.equal(pdf.pages,2);assert.equal(slides.pages,2);assert.match(text.text,/Release plan/);
for(const review of [pdf,slides]){const result=await fetch(`${native}/api/agents/${agent.id}/file-reviews/${review.id}/pages/2`);assert.ok(result.ok,await result.clone().text());assert.equal(result.headers.get('content-type'),'image/png');assert.ok((await result.arrayBuffer()).byteLength>1000);}
const escaped=await fetch(`${native}/api/agents/${agent.id}/file-reviews`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({path:'/etc/passwd'})});assert.ok(!escaped.ok);
assert.ok(!(await fetch(`${native}/api/agents/other/file-reviews/${pdf.id}`)).ok);
const browser=await chromium.launch();
try{
 const page=await browser.newPage({viewport:{width:1440,height:950}});
 await page.route('**/api/**',async route=>{const url=new URL(route.request().url());const result=await route.fetch({url:`${native}${url.pathname}${url.search}`});await route.fulfill({response:result});});
 await page.addInitScript(()=>{window.SharedWorker=undefined;window.EventSource=class extends EventTarget{close(){}};});
 const textMessage=['pdf','pptx','txt'].map(ext=>`[Review ${ext}](/api/artifacts?path=${encodeURIComponent(paths[ext])})`).join('\n\n');
 await page.route('**/api/state',route=>route.fulfill({json:{...snapshot,agents:[agent],archived:[],tasks:[],taskNotes:[],messages:{},paneLinks:{},tags:{},boards:[]}}));
 await page.route(`**/api/agents/${agent.id}`,route=>route.fulfill({json:{agent,timeline:[{id:1,agentId:agent.id,kind:'said',text:textMessage,detail:'',at:Date.now()/1000}],delivery:'start'}}));
 await page.goto(`${web}/?agent=${agent.id}`);
 await page.getByRole('button',{name:'Review',exact:true}).nth(1).click();
 const dialog=page.getByRole('dialog',{name:'File review'});
 const picture=dialog.getByRole('img',{name:'Document page 1'});await picture.evaluate(image=>image.decode());
 const svg=dialog.locator('svg'), bounds=await svg.boundingBox();
 await page.mouse.move(bounds.x+bounds.width*.1,bounds.y+bounds.height*.1);await page.mouse.down();await page.mouse.move(bounds.x+bounds.width*.7,bounds.y+bounds.height*.35,{steps:5});await page.mouse.up();
 await page.mouse.click(bounds.x+bounds.width*.4,bounds.y+bounds.height*.2,{button:'right'});
 await page.getByRole('menuitem',{name:'Quote selected area'}).click();
 await dialog.getByRole('button',{name:'Draw',exact:true}).click();
 await page.mouse.move(bounds.x+bounds.width*.2,bounds.y+bounds.height*.5);await page.mouse.down();await page.mouse.move(bounds.x+bounds.width*.6,bounds.y+bounds.height*.55,{steps:7});await page.mouse.up();
 await dialog.getByRole('textbox',{name:'File review feedback'}).fill('Move the decision above the rollout details.');
 if(process.env.SCREENSHOT)await page.screenshot({path:process.env.SCREENSHOT});
 await dialog.getByRole('button',{name:'Request revision',exact:true}).click();
 await dialog.getByText('changes requested',{exact:true}).waitFor();
 const revised=await api(`/api/agents/${agent.id}/file-reviews/${slides.id}`);
 assert.equal(revised.annotations.length,2);assert.equal(revised.annotations[0].page,1);assert.ok(revised.annotations[0].region[2]>.5);assert.ok(revised.annotations[1].strokes[0].length>3);
 let view=await api(`/api/agents/${agent.id}`);const sent=view.timeline.find(entry=>entry.kind==='you'&&entry.text.includes('Move the decision'));
 assert.ok(sent,'Revision is delivered into the owning conversation');assert.ok(sent.text.includes(slides.sha256));assert.match(sent.text,/Attached:/);
 const attachment=sent.text.split('Attached: ')[1].split(', ')[0];const bytes=await (await fetch(`${native}/api/attachments/${encodeURIComponent(attachment)}`)).arrayBuffer();assert.ok(bytes.byteLength>1000);
 await dialog.getByRole('button',{name:'Close file review'}).click();
 await page.getByRole('button',{name:'Review',exact:true}).first().click();await dialog.getByRole('img',{name:'Document page 1',exact:true}).evaluate(image=>image.decode());
 await dialog.getByRole('button',{name:'Approve this version'}).click();await dialog.getByText('approved',{exact:true}).waitFor();
 assert.equal((await api(`/api/agents/${agent.id}/file-reviews/${pdf.id}`)).status,'approved');
 assert.equal((await create(paths.pdf)).id,pdf.id);
 await writeFile(paths.pdf, await readFile(join(fixtures,'proposal.pdf')).then(bytes=>Buffer.concat([bytes,Buffer.from('\n% revised source\n')])));
 const replacement=await create(paths.pdf);assert.notEqual(replacement.id,pdf.id);assert.equal(replacement.status,'pending');
 const original=await (await fetch(`${native}/api/agents/${agent.id}/file-reviews/${pdf.id}/original`)).arrayBuffer();assert.deepEqual(Buffer.from(original),await readFile(join(fixtures,'proposal.pdf')),'Approved original survives source edits');
 await dialog.getByRole('button',{name:'Close file review'}).click();await page.getByRole('button',{name:'Review',exact:true}).nth(2).click();
 const pre=dialog.locator('pre');await pre.waitFor();await pre.evaluate(element=>{const range=document.createRange();range.selectNodeContents(element);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);});await pre.click({button:'right'});
 await page.getByRole('menuitem',{name:'Quote selected text'}).click();await dialog.getByRole('textbox',{name:'File review feedback'}).fill('Clarify the two remaining checks.');
 await dialog.getByRole('button',{name:'Request revision',exact:true}).click();await dialog.getByText('changes requested',{exact:true}).waitFor();
 assert.match((await api(`/api/agents/${agent.id}/file-reviews/${text.id}`)).annotations[0].quote,/Release plan/);
 console.log('Real PDF/PPTX/text reviews: rendering, area quotes, drawing feedback with image delivery, text quotes, approval isolation, immutable originals and path/owner confinement passed.');
}finally{await browser.close();}
