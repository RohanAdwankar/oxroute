import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
const browser=await(process.env.BROWSER==='webkit'?webkit:chromium).launch(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{});
try{
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',e=>errors.push(String(e)));
 const agent={id:'keyboard-reading',name:'Reading history',backend:'codex',model:'fixture',status:'complete',updatedAt:Date.now()/1000};
 const timeline=Array.from({length:160},(_,index)=>({id:index+1,agentId:agent.id,kind:'said',at:1,detail:'',text:`Entry ${index+1}\n\nEvidence remains visible while reading history.\n\n\`\`\`rust\nfn measure(value: usize) -> usize { value + ${index} }\n\`\`\``}));
 await page.addInitScript(()=>{window.repeatedMotions=0;document.addEventListener('keydown',event=>{if(event.repeat&&['j','k'].includes(event.key))window.repeatedMotions++;},true);localStorage.setItem('oxroute.scalePanes','on');localStorage.setItem('oxroute.theme','dark');window.SharedWorker=undefined;window.EventSource=class extends EventTarget{close(){}};});
 await page.route('**/api/**',r=>{
  const path=new URL(r.request().url()).pathname;
  if(path==='/api/version')return r.continue();
  assert.equal(r.request().method(),'GET','Reading never changes conversations or settings');
  if(path==='/api/state')return r.fulfill({json:{mode:'ask',agents:[agent],archived:[],tasks:[],taskNotes:[],messages:{},inbox:[],tags:{},boards:[],paneLinks:{},sources:[],models:[],backends:[]}});
  if(path==='/api/terminals')return r.fulfill({json:[]});
  return r.fulfill({json:{agent,timeline,delivery:'start'}});
 });
 await page.goto(`${process.env.TEST_URL}/?agent=${agent.id}`);await page.locator('[data-entry="160"]').waitFor();
 const pane=page.locator('[data-agent-pane]'),transcript=page.locator('[data-transcript]');
 const hold=async(key,count)=>{for(let n=0;n<count;n++){await page.keyboard.down(key);await page.waitForTimeout(16);}await page.keyboard.up(key);};
 await page.getByRole('tab',{name:agent.name,exact:true}).click();
 for(const width of [420,635,1000]){
  await pane.evaluate((node,width)=>node.style.maxWidth=`${width}px`,width);await page.waitForTimeout(100);
  const metrics=()=>transcript.evaluate(node=>({top:node.scrollTop,height:node.scrollHeight,viewport:node.clientHeight,windowY:window.scrollY}));
  await transcript.evaluate(node=>node.scrollTop=Math.floor((node.scrollHeight-node.clientHeight)/2));await page.waitForTimeout(50);
  const start=await metrics();
  await hold('k',20);
  assert.ok(Math.abs((await metrics()).top-(start.top-1800))<=2,`Up steps stay in scroll coordinates at width ${width}: ${JSON.stringify({start,now:await metrics()})}`);
  await hold('j',20);
  assert.ok(Math.abs((await metrics()).top-start.top)<=2,`Equal down/up steps return to the same content at width ${width}`);
  await page.keyboard.press('7');await page.keyboard.press('k');assert.ok(Math.abs((await metrics()).top-(start.top-630))<=2);
  for(const key of ['ArrowDown','ArrowUp'])await page.keyboard.press(key);
  assert.ok(Math.abs((await metrics()).top-(start.top-630))<=2);
  const beforeManual=(await metrics()).top;await page.mouse.move(250,300);await page.mouse.wheel(0,250);await page.waitForFunction(top=>document.querySelector('[data-transcript]').scrollTop!==top,beforeManual);await page.waitForTimeout(250);
  const manual=(await metrics()).top;await page.keyboard.press('k');assert.ok(Math.abs((await metrics()).top-(manual-90))<=2,'Keyboard movement starts at the manually selected position');
  await page.keyboard.type('999j');const bottom=(await metrics()).top;assert.ok(Math.abs(bottom-((await metrics()).height-(await metrics()).viewport))<=2);
  await page.keyboard.press('k');assert.ok(Math.abs((await metrics()).top-(bottom-90))<=2,'Large counts cannot accumulate motion past the scroll boundary');
  await page.keyboard.type('999k');assert.ok((await metrics()).top<=1);
  await page.keyboard.press('g');await page.keyboard.press('g');await page.waitForFunction(()=>document.querySelector('[data-transcript]').scrollTop<=1);
  await page.mouse.move(250,300);await page.mouse.wheel(0,300);await page.waitForFunction(()=>document.querySelector('[data-transcript]').scrollTop>0);
  await page.keyboard.press('G');await page.waitForFunction(()=>{const node=document.querySelector('[data-transcript]');return node.scrollHeight-node.clientHeight-node.scrollTop<=2;});
  assert.equal((await metrics()).height,start.height,'Scrolling cannot grow the transcript');assert.equal((await metrics()).windowY,0);
 }
 assert.ok(await page.evaluate(()=>window.repeatedMotions>0),'Exercise held-key repeat events, without releasing between steps');
 await pane.evaluate(node=>node.style.maxWidth="");await page.waitForTimeout(100);
 if(process.env.SCREENSHOT)await page.screenshot({path:process.env.SCREENSHOT});
 assert.deepEqual(errors,[]);console.log('Counted and repeated keyboard motions preserve exact reading positions at fractional pane scales; mouse scrolling, gg/G, arrow keys and transcript dimensions remain intact.');
}finally{await browser.close();}
