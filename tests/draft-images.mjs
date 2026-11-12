import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
const browser=await(process.env.BROWSER==='webkit'?webkit:chromium).launch(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{});
const agent={id:'draft-picture',name:'Draft picture',backend:'codex',model:'fixture',status:'complete',updatedAt:1};
try{
 const page=await browser.newPage({viewport:{width:1280,height:900}}),writes=[];
 await page.addInitScript(()=>{
  window.SharedWorker=undefined;window.EventSource=class extends EventTarget{close(){}};
  const fetch=window.fetch;window.fetch=async(input,init)=>{
   if(init?.body instanceof FormData){window.sentImages=await Promise.all(init.body.getAll('files').map(async file=>btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer())))));}
   return fetch(input,init);
  };
 });
 await page.route('**/api/**',async r=>{
  const path=new URL(r.request().url()).pathname;
  if(path==='/api/version')return r.continue();
  if(r.request().method()==='POST'){
   assert.equal(path,'/api/say-attachments','Editing an attachment must not upload, review or send it');
   const form=await new Response(r.request().postDataBuffer(),{headers:{'content-type':r.request().headers()['content-type']}}).formData();
   writes.push({text:form.get('text'),files:await Promise.all(form.getAll('files').map(async f=>({name:f.name,type:f.type,bytes:Buffer.from(await f.arrayBuffer())})))});
   return r.fulfill({json:{ok:true}});
  }
  if(path==='/api/state')return r.fulfill({json:{mode:'ask',agents:[agent],archived:[],messages:{},tasks:[],taskNotes:[],inbox:[],paneLinks:{},tags:{},boards:[],sources:[],models:[],backends:[]}});
  if(path==='/api/terminals')return r.fulfill({json:[]});
  return r.fulfill({json:{agent,timeline:[],delivery:'start'}});
 });
 await page.goto(`${process.env.TEST_URL}/?agent=${agent.id}`);
 const composer=page.locator('[data-composer]');await composer.fill('Keep the original draft');
 await composer.evaluate(async input=>{
  const canvas=document.createElement('canvas');canvas.width=400;canvas.height=240;const c=canvas.getContext('2d');c.fillStyle='white';c.fillRect(0,0,400,240);
  const blob=await new Promise(done=>canvas.toBlob(done,'image/png'));
  const data=new DataTransfer();data.items.add(new File([blob],'clipboard.png',{type:'image/png'}));
  input.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));
 });
 const thumbnail=page.getByRole('button',{name:'Annotate clipboard.png',exact:true});await thumbnail.click();
 const dialog=page.getByRole('dialog',{name:'Image preview',exact:true});await dialog.waitFor();
 await dialog.getByRole('img',{name:'Document page 1',exact:true}).evaluate(async image=>image.decode());
 await dialog.getByRole('button',{name:'Close file review',exact:true}).click();
 assert.equal(writes.length,0);assert.equal(await composer.inputValue(),'Keep the original draft');
 await thumbnail.focus();await page.keyboard.press('Enter');await dialog.waitFor();
 await dialog.getByRole('button',{name:'Pen',exact:true}).click();
 const surface=dialog.locator('svg[preserveAspectRatio="none"]');const box=await surface.boundingBox();
 await page.mouse.move(box.x+box.width*.2,box.y+box.height*.3);await page.mouse.down();await page.mouse.move(box.x+box.width*.6,box.y+box.height*.6,{steps:8});await page.mouse.up();
 await dialog.getByRole('textbox',{name:'File review feedback',exact:true}).fill('Inspect the marked area');
 if(process.env.SCREENSHOT)await page.screenshot({path:process.env.SCREENSHOT});
 await dialog.getByRole('button',{name:'Apply image annotations',exact:true}).click();await dialog.waitFor({state:'detached'});
 assert.equal(writes.length,0,'Apply updates only the local composer');
 await page.getByRole('button',{name:'Annotate clipboard-annotated.png',exact:true}).waitFor();
 assert.equal(await composer.inputValue(),'Keep the original draft\n\nInspect the marked area');
 await page.getByRole('button',{name:'Show the fleet',exact:true}).click();
 await page.getByRole('tab',{name:agent.name,exact:true}).click();await composer.waitFor();
 await page.getByRole('button',{name:'Annotate clipboard-annotated.png',exact:true}).waitFor();
 await page.getByRole('button',{name:'Send message',exact:true}).click();
 await page.waitForTimeout(150);assert.equal(writes.length,1);
 assert.equal(writes[0].files.length,1);assert.equal(writes[0].files[0].type,'image/png');
 const marked=await page.evaluate(async encoded=>{
  const image=new Image();image.src='data:image/png;base64,'+encoded;await image.decode();const c=document.createElement('canvas');c.width=image.width;c.height=image.height;const ctx=c.getContext('2d');ctx.drawImage(image,0,0);const data=ctx.getImageData(0,0,c.width,c.height).data;let count=0;for(let i=0;i<data.length;i+=4)if(data[i]>150&&data[i+1]<100&&data[i+2]<100)count++;return count;
 },await page.evaluate(()=>window.sentImages[0]));
 assert.ok(marked>30,'Delivered image includes the visible drawing');
 assert.equal(writes[0].text.replaceAll('\r\n','\n'),'Keep the original draft\n\nInspect the marked area');
 console.log('Pasted image previews open the shared annotator; cancel is safe, apply edits the draft locally, and navigation/send preserve the marked image and text without premature uploads.');
}finally{await browser.close();}
