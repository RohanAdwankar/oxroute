import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const agent={id:'stream-fixture',name:'Output streaming',backend:'codex',model:'fixture',status:'complete',updatedAt:1};
const entries=[1,2].map(id=>({id,agentId:agent.id,at:id,kind:'worked',text:'Inspect state',detail:'Read current state',output:'',outputDeferred:true,origin:''}));
const state={mode:'ask',agents:[agent],archived:[],messages:{},reviews:{},tasks:[],taskNotes:[],inbox:[],paneLinks:{},tags:{},boards:[],sources:[],models:[],backends:[]};
const browser=await chromium.launch();
try {
 const page=await browser.newPage();let reads=0;
 await page.addInitScript(()=>{window.SharedWorker=undefined;window.EventSource=class extends EventTarget{constructor(){super();window.stream=this;}close(){}};localStorage.setItem('oxroute.verbose','off');});
 await page.route('**/api/**',async route=>{const path=new URL(route.request().url()).pathname;if(path==='/api/version')return route.continue();if(path==='/api/state')return route.fulfill({json:state});if(path.endsWith('/outputs')){reads++;await new Promise(done=>setTimeout(done,250));return route.fulfill({json:{1:'First completed output',2:'Second completed output'}});}return route.fulfill({json:path===`/api/agents/${agent.id}`?{agent,timeline:entries,delivery:'start'}:[]});});
 await page.goto(`${process.env.TEST_URL}/?agent=${agent.id}`);await page.locator('[data-agent-pane] details summary').first().click();
 await page.evaluate(entry=>{window.refresh=setInterval(()=>window.stream.onmessage({data:JSON.stringify({type:'timeline',entry})}),20);},entries[1]);
 await page.getByText('Second completed output',{exact:true}).waitFor({timeout:2000});
 assert.ok(reads<5,'Live rerenders do not cancel and restart output reads');
 await page.evaluate(()=>clearInterval(window.refresh));
 assert.equal(await page.getByText('Loading output…',{exact:true}).count(),0);
 if(process.env.SCREENSHOT)await page.screenshot({path:process.env.SCREENSHOT});
 console.log('Completed output remains visible during faster live timeline updates.');
} finally {await browser.close();}
