// Real browser pixels, unequal animation lengths and delayed asset readiness.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const fixtures=process.env.REAL_GIFS?await Promise.all(['before','after'].map(async side=>(await readFile(`/tmp/oxroute-comparison-${side}.gif`)).toString('base64'))):JSON.parse(execFileSync('uv',['run','--no-project','--with','pillow','python','-c',`
from PIL import Image
import io,json,base64
result=[]
for durations,colors in [([120,180],['red','green']),([160,220,280],['blue','yellow','purple'])]:
 images=[Image.new('RGB',(96,64),color) for color in colors]
 data=io.BytesIO();images[0].save(data,format='GIF',save_all=True,append_images=images[1:],duration=durations,loop=0,disposal=2)
 result.append(base64.b64encode(data.getvalue()).decode())
print(json.dumps(result))
`],{encoding:'utf8'}));
const agent={id:'animation-source',name:'Animation source',backend:'codex',model:'fixture',status:'complete',updatedAt:Date.now()/1000};
const path='comparison.gif',id='animation-review';
const review={id,agentId:agent.id,title:'Compare animation timing',description:'',status:'pending',full:false,snapshot:{repository:'/workspace/proposal',remote:'origin',remoteUrl:'https://example.invalid/proposal.git',branch:'proposal',baseRef:'main',baseCommit:'a'.repeat(40),headCommit:'b'.repeat(40),files:[{path,patch:'Binary files differ',image:{before:true,after:true}}]}};
const browser=await chromium.launch();
try{
 const page=await browser.newPage({viewport:{width:1280,height:900}});
 await page.route('**/api/state',r=>r.fulfill({json:{mode:'ask',agents:[agent],archived:[],messages:{},tasks:[],taskNotes:[],inbox:[],paneLinks:{},quoteThreads:[],tags:{},boards:[],sources:[],models:[],backends:[]}}));
 await page.route('**/api/terminals',r=>r.fulfill({json:[]}));await page.route('**/api/events',r=>r.fulfill({contentType:'text/event-stream',body:': local\n\n'}));
 await page.route('**/api/agents/*',r=>r.fulfill({json:{agent,timeline:[{id:1,agentId:agent.id,at:1,kind:'review',text:review.title,detail:id}],delivery:'start'}}));
 await page.route(`**/reviews/${id}`,r=>r.fulfill({json:review}));
 let release,invalid=true;const gate=new Promise(done=>release=done);
 await page.route(`**/reviews/${id}/image?*`,async r=>{const after=new URL(r.request().url()).searchParams.get('side')==='after';if(after&&invalid){invalid=false;return r.fulfill({contentType:'image/gif',body:'Invalid animation data'});}if(after)await gate;await r.fulfill({contentType:'image/gif',body:Buffer.from(fixtures[after?1:0],'base64')});});
 await page.goto(`${process.env.TEST_URL}/?agent=${agent.id}&review=${id}`);
 const container=page.locator(`[aria-label="Image comparison ${path}"]`);
 await container.waitFor();await container.getByRole('alert').waitFor();await container.getByRole('button',{name:'Retry comparison',exact:true}).click();await page.waitForTimeout(350);
 assert.equal(await container.getByRole('img').count(),0,'Neither animation starts while its peer is still loading');
 release();await container.getByRole('img').first().waitFor();await container.getByRole('img').last().waitFor();
 if(!process.env.REAL_GIFS){
 const samples=await container.evaluate(async element=>{
  const samples=[],start=performance.now();
  await new Promise(done=>{const sample=()=>{const t=performance.now()-start;const colors=[...element.querySelectorAll('canvas[role=img]')].map(canvas=>[...canvas.getContext('2d').getImageData(0,0,1,1).data].slice(0,3).join(','));samples.push({t,colors});if(t<1450)requestAnimationFrame(sample);else done();};sample();});return samples;
 });
 const green='0,128,0',blue='0,0,255';
 assert.ok(samples.some(s=>s.t>350&&s.t<570&&s.colors[0]===green),'The shorter animation holds its final frame until joint replay');
 assert.ok(samples.filter(s=>s.t>350&&s.t<570).every(s=>s.colors[0]===green),'Shorter loops never restart independently');
 assert.ok(samples.some(s=>s.t>670&&s.t<750&&s.colors[0]==='255,0,0'&&s.colors[1]===blue),'Both animations replay together at the longer duration');
 assert.ok(samples.find(s=>s.colors[0]===green).t<160,'Before retains its encoded frame timing');
 assert.ok(samples.find(s=>s.colors[1]==='255,255,0').t<200,'After retains its encoded frame timing');
 await container.getByRole('button',{name:'Replay comparison',exact:true}).dblclick();
 await page.waitForFunction(()=>{const canvases=[...document.querySelectorAll('canvas[role=img]')];return canvases.length===2&&canvases.map(c=>[...c.getContext('2d').getImageData(0,0,1,1).data].slice(0,3).join(',')).join(';')==='255,0,0;0,0,255';});
 }
 if(process.env.REAL_GIFS){
  assert.deepEqual(await container.locator('canvas').evaluateAll(items=>items.map(c=>[c.width,c.height])),[[1280,720],[1280,720]]);await page.waitForTimeout(2500);
  if(process.env.ACTUAL_LOOP){
   const hashes=()=>container.locator('canvas').evaluateAll(async items=>Promise.all(items.map(async canvas=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data))].join(','))));
   await page.waitForTimeout(22500);const first=await hashes();await page.waitForTimeout(20000);const held=await hashes();assert.equal(held[0],first[0],'The actual shorter GIF holds its final frame');assert.notEqual(held[1],first[1],'The actual longer GIF continues at its own timing');await page.waitForTimeout(10000);assert.notEqual((await hashes())[0],held[0],'The actual pair replays after the longer GIF completes');
  }
 }
 for(const width of[1280,390]){await page.setViewportSize({width,height:900});if(process.env.SCREENSHOT)await page.screenshot({path:`${process.env.SCREENSHOT}-${width}.png`});}
 await page.reload();await container.getByRole('img').first().waitFor();await container.getByRole('img').last().waitFor();
 console.log('Both GIFs wait for readiness, retain individual frame timing, hold the shorter final frame and replay jointly; shared replay and desktop/mobile rendering pass.');
}finally{await browser.close();}
