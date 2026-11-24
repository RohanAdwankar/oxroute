import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const owner={id:'outcome-source',name:'Source outcome',status:'complete',backend:'codex',model:'fixture',updatedAt:Date.now()/1000};
const incoming=(id,label,text,display)=>({signal:{id,source:'slack-inbox',conversation:'workspace:reader:'+id,threadKey:'conversation',externalId:id,author:'provider-author',label,text,attachments:[],at:Date.now()/1000,root:true},display,state:'waiting',outcome:'',agentIds:[],suggested:owner.id,sourceUrl:'https://example.invalid/source'});
const items=[incoming('direct-source','provider-author','provider-author: Current observations',{label:'Source participant',text:'Source participant: Current observations'}),incoming('group-source','mpdm-provider-generated','provider-author: Shared observations',{label:'Group · Source participant, Source collaborator',text:'Source participant: Shared observations\n\nSource collaborator: Current response'})];
const browser=await chromium.launch();
try{
 const page=await browser.newPage({viewport:{width:1280,height:900}});
 await page.addInitScript(()=>{window.SharedWorker=undefined;window.EventSource=class extends EventTarget{close(){}};});
 await page.route('**/api/**',route=>route.fulfill({json:[]}));
 await page.route('**/api/version',route=>route.continue());
 await page.route('**/api/state',route=>route.fulfill({json:{mode:'ask',agents:[owner],archived:[],messages:{},tasks:[],taskNotes:[],inbox:items,paneLinks:{},quoteThreads:[],tags:{},boards:[],sources:[],models:[],backends:[]}}));
 await page.route('**/api/events',route=>route.fulfill({contentType:'text/event-stream',body:': fixture\n\n'}));await page.route('**/api/terminals',route=>route.fulfill({json:[]}));
 await page.route('**/api/agents/*',route=>route.fulfill({json:{agent:owner,timeline:[],delivery:'start'}}));
 page.on('pageerror',error=>console.error(error));
 await page.goto(process.env.TEST_URL);const inbox=page.locator('aside').filter({has:page.getByText('Inbox',{exact:true})});await inbox.locator('[data-inbox-item]').first().waitFor();
 assert.equal(await inbox.getByText('provider-author',{exact:true}).count(),0);assert.equal(await inbox.getByText('mpdm-provider-generated',{exact:true}).count(),0);
 await inbox.getByText('Source participant',{exact:true}).waitFor();await inbox.getByText('Group · Source participant, Source collaborator',{exact:true}).waitFor();
 await inbox.locator('[data-inbox-item]').last().click();await page.getByLabel('Conversation context',{exact:true}).getByText('Source participant: Shared observations',{exact:false}).waitFor();assert.equal(await page.getByRole('link',{name:'Open source message',exact:true}).getAttribute('href'),'https://example.invalid/source');
 for(const width of[1280,390]){await page.setViewportSize({width,height:900});if(process.env.SCREENSHOT)await page.screenshot({path:`${process.env.SCREENSHOT}-${width}.png`});}
 await page.reload();await inbox.getByText('Group · Source participant, Source collaborator',{exact:true}).waitFor();
 console.log('Authoritative display labels and structured author text render in direct/group Inbox rows and full context; stable source navigation and reload remain available on desktop/mobile.');
}finally{await browser.close();}
