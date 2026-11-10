import assert from 'node:assert/strict';
import {copyFile, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';

const native=process.env.TEST_NATIVE_URL, web=process.env.TEST_URL, fixtures=process.env.TEST_FIXTURES;
assert.ok(native && web && fixtures, 'Use a disposable runtime');
const snapshot=await (await fetch(`${native}/api/state`)).json();
assert.ok(snapshot.artifactRoot.includes('/.tmp/'));
async function api(path,body){const r=await fetch(native+path,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok,await r.clone().text());return r.json();}
const agent=await api('/api/agents',{id:`agent_${crypto.randomUUID().replaceAll('-','')}`});
const source=join(snapshot.artifactRoot,'diagram.png');
await copyFile(join(fixtures,'diagram.png'),source);
for(const ext of ['png','jpg','webp','gif','svg']) {
 const path=join(snapshot.artifactRoot,`diagram.${ext}`);await copyFile(join(fixtures,`diagram.${ext}`),path);
 const review=await api(`/api/agents/${agent.id}/file-reviews`,{path});assert.equal(review.pages,1);assert.equal(review.text,null);
 const rendered=await fetch(`${native}/api/agents/${agent.id}/file-reviews/${review.id}/pages/1`);assert.ok(rendered.ok);
 assert.deepEqual(Buffer.from(await rendered.arrayBuffer()),await readFile(path),'Image rendering retains source bytes and format');
}

const upload=new FormData();upload.append('agent',agent.id);upload.append('queued','true');upload.append('text','Attached picture');upload.append('files',new Blob([await readFile(source)]),'picture.png');
const uploaded=await fetch(`${native}/api/say-attachments`,{method:'POST',body:upload});assert.ok(uploaded.ok,await uploaded.text());
const view=await api(`/api/agents/${agent.id}`);
const attached=view.timeline.find(entry=>entry.text.includes('Attached: '));assert.ok(attached);
const browser=await chromium.launch();
try {
 const page=await browser.newPage({viewport:{width:1440,height:950}});
 await page.route('**/api/**',async route=>{const url=new URL(route.request().url());await route.fulfill({response:await route.fetch({url:`${native}${url.pathname}${url.search}`})});});
 await page.addInitScript(()=>{window.SharedWorker=undefined;window.EventSource=class extends EventTarget{close(){}};});
 await page.route('**/api/state',route=>route.fulfill({json:{...snapshot,agents:[agent],archived:[],tasks:[],taskNotes:[],messages:{},paneLinks:{},tags:{},boards:[]}}));
 const entry={id:900,agentId:agent.id,kind:'said',text:`![Architecture](/api/artifacts?path=${encodeURIComponent(source)})`,detail:'',at:Date.now()/1000};
 await page.route(`**/api/agents/${agent.id}`,route=>route.fulfill({json:{agent,timeline:[entry,attached],delivery:'start'}}));
 await page.goto(`${web}/?agent=${agent.id}`);
 const thumbnail=page.getByRole('button',{name:'Architecture',exact:true});await thumbnail.evaluate(image=>image.decode());
 await thumbnail.click();
 const dialog=page.getByRole('dialog',{name:'Image preview'});await dialog.waitFor();
 await dialog.getByRole('img',{name:'Document page 1',exact:true}).evaluate(image=>image.decode());
 assert.equal(page.context().pages().length,1,'Click enlarges inside the existing window');
 const original=await page.request.get(new URL(await dialog.getByRole('link',{name:'Download original'}).getAttribute('href'),native).href);
 assert.deepEqual(await original.body(),await readFile(source),'Original download remains intact');
 const svg=dialog.getByLabel('Document annotations'), bounds=await svg.boundingBox();
 await page.mouse.move(bounds.x+bounds.width*.1,bounds.y+bounds.height*.15);await page.mouse.down();await page.mouse.move(bounds.x+bounds.width*.6,bounds.y+bounds.height*.45,{steps:5});await page.mouse.up();
 await page.mouse.click(bounds.x+bounds.width*.3,bounds.y+bounds.height*.3,{button:'right'});
 await page.getByRole('menuitem',{name:'Quote selected area'}).click();
 await dialog.getByRole('button',{name:'Draw',exact:true}).click();
 await page.mouse.move(bounds.x+bounds.width*.2,bounds.y+bounds.height*.6);await page.mouse.down();await page.mouse.move(bounds.x+bounds.width*.7,bounds.y+bounds.height*.65,{steps:8});await page.mouse.up();
 await dialog.getByRole('textbox').fill('Please align these two components.');
 if(process.env.IMAGE_SCREENSHOT)await page.screenshot({path:process.env.IMAGE_SCREENSHOT});
 await dialog.getByRole('button',{name:'Send image reply'}).click();await dialog.getByText('Reply sent',{exact:true}).waitFor();
 const result=await api(`/api/agents/${agent.id}`), reply=result.timeline.find(entry=>entry.kind==='you'&&entry.text.includes('Please align'));
 assert.ok(reply,'Reply is delivered into owning conversation');assert.match(reply.text,/Attached:/);
 const filename=reply.text.split('Attached: ')[1].split(', ')[0];
 const bytes=Buffer.from(await (await fetch(`${native}/api/attachments/${encodeURIComponent(filename)}`)).arrayBuffer());
 assert.ok(bytes.length>1000);assert.notDeepEqual(bytes,await readFile(source),'Reply contains painted image');
 const painted=await page.evaluate(async filename=>{const image=new Image();image.src=`/api/attachments/${encodeURIComponent(filename)}`;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);const data=ctx.getImageData(0,0,canvas.width,canvas.height).data;let red=0;for(let i=0;i<data.length;i+=4)if(data[i]>170&&data[i+1]<100&&data[i+2]<100)red++;return red;},filename);
 assert.ok(painted>100,'Delivered pixels contain the red area and drawing markup');
 assert.equal(await svg.locator('polyline').count(),1);assert.equal(await svg.locator('rect').count(),1);
 await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
 const attachmentImage=page.locator('img[src^="/api/attachments/"]').first();await attachmentImage.focus();await page.keyboard.press('Enter');await dialog.waitFor();await dialog.getByRole('img',{name:'Document page 1',exact:true}).evaluate(image=>image.decode());
 await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
 assert.equal(page.context().pages().length,1);
 console.log('Real image workflow passed: Markdown and attachment enlargement, keyboard/Escape, area quote, freehand drawing, original download and annotated reply delivery.');
} finally {await browser.close();}
