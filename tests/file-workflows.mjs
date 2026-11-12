// Validate production frontend artifacts against an isolated real daemon.
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
await mkdir(resolve('.tmp'),{recursive:true});
const root=await mkdtemp(resolve('.tmp/file-workflows-'));
const server=createServer();await new Promise(done=>server.listen(0,'127.0.0.1',done));const port=server.address().port;await new Promise(done=>server.close(done));
const native=`http://127.0.0.1:${port}`,config=join(root,'config.toml'),fixtures=join(root,'fixtures');
await mkdir(fixtures);await mkdir(join(root,'artifacts'));await mkdir(join(root,'attachments'));
await writeFile(config,`owner = "fixture"\nlisten = "127.0.0.1:${port}"\nworkspace = ${JSON.stringify(root)}\n[limits]\nmin_free_bytes = 0\n[paths]\ndatabase = ${JSON.stringify(join(root,'test.sqlite3'))}\nartifacts = ${JSON.stringify(join(root,'artifacts'))}\nattachments = ${JSON.stringify(join(root,'attachments'))}\n`);
async function run(command,args,env={}){return new Promise((done,fail)=>{const child=spawn(command,args,{stdio:'inherit',env:{...process.env,...env}});child.on('error',fail);child.on('exit',code=>code===0?done():fail(new Error(`${command} exited ${code}`)));});}
let daemon;
try{
 await run('uv',['run','--no-project','--with','python-pptx','--with','reportlab','python','-c',`from pathlib import Path
from PIL import Image, ImageDraw
from pptx import Presentation
from reportlab.pdfgen import canvas
p=Path(${JSON.stringify(fixtures)})
r=Presentation()
for title,body in [('Release plan','Decision needed: approve the rollout window.'),('Validation','Two smoke checks remain before shipping.')]:
 s=r.slides.add_slide(r.slide_layouts[1]);s.shapes.title.text=title;s.placeholders[1].text=body
r.save(p/'proposal.pptx')
c=canvas.Canvas(str(p/'proposal.pdf'));c.drawString(70,750,'Release plan: approve the rollout window.');c.showPage();c.drawString(70,750,'Validation: two smoke checks remain.');c.save()
im=Image.new('RGB',(960,540),'#faf8f4');d=ImageDraw.Draw(im);d.rectangle((90,100,390,270),outline='#333333',width=4);d.rectangle((570,150,870,320),outline='#333333',width=4);d.line((390,185,570,235),fill='#333333',width=4);d.text((150,170),'Source',fill='#333333');d.text((630,220),'Destination',fill='#333333');im.save(p/'diagram.png')
for ext in ['jpg','webp','gif']: im.save(p/f'diagram.{ext}')
(p/'diagram.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect x="90" y="100" width="300" height="170" fill="none" stroke="black"/></svg>')
(p/'proposal.txt').write_text('Release plan\\nApprove the rollout window.\\n')`]);
 daemon=spawn(process.env.TEST_DAEMON??join(process.env.HOME,'.local/bin/oxrouted'),[],{stdio:['ignore','ignore','inherit'],env:{...process.env,OXROUTE_CONFIG:config,OXROUTE_CODEX_URL:'ws://127.0.0.1:9',OXROUTE_CODEX_CLI:'/bin/false'}});
 let ready=false;
 for(let attempt=0;attempt<100;attempt++){try{if((await fetch(`${native}/api/health`)).ok){ready=true;break;}}catch{}await new Promise(done=>setTimeout(done,100));}
 assert.ok(ready,'Disposable daemon started');
 const env={TEST_DAEMON:process.env.TEST_DAEMON??join(process.env.HOME,'.local/bin/oxrouted'),TEST_NATIVE_URL:native,TEST_FIXTURES:fixtures,TEST_URL:process.env.TEST_URL??'http://127.0.0.1:3939'};
 await run(process.execPath,['tests/file-review-preparation.mjs'],env);
 await run(process.execPath,['tests/card-search.mjs'],env);
 await run(process.execPath,['tests/file-reviews.mjs'],env);
 await run(process.execPath,['tests/image-preview.mjs'],env);
 await run(process.execPath,['tests/artifact-links.mjs'],env);
}finally{if(daemon){daemon.kill('SIGTERM');await new Promise(done=>{if(daemon.exitCode!==null)done();else daemon.once('exit',done);});}await rm(root,{recursive:true,force:true});}
