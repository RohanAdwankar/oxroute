// A disposable daemon ignores the invoking environment: no live owner, models, database or Slack bridge, and no Focus session.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,access} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {resolve,join} from 'node:path';
assert.ok(process.env.TEST_DAEMON);
await mkdir(resolve('.tmp'),{recursive:true});const root=await mkdtemp(resolve('.tmp/daemon-isolation-'));
const server=createServer();await new Promise(done=>server.listen(0,'127.0.0.1',done));const port=server.address().port;await new Promise(done=>server.close(done));
const native=`http://127.0.0.1:${port}`,config=join(root,'config.toml'),live=join(root,'live.sqlite3');
await writeFile(config,`owner="fixture"\nlisten="127.0.0.1:${port}"\nworkspace=${JSON.stringify(root)}\n[limits]\nmin_free_bytes=0\n[paths]\ndatabase=${JSON.stringify(join(root,'test.sqlite3'))}\nartifacts=${JSON.stringify(join(root,'artifacts'))}\nattachments=${JSON.stringify(join(root,'attachments'))}\n`);
// Pretend the invoking shell belongs to a live deployment.
Object.assign(process.env,{OXROUTE_OWNER:'U_LIVE',OXROUTE_MODELS:'livemodel=live-model:Live',OXROUTE_DATABASE:live,OXROUTE_SLACK_APP_TOKEN:'xapp-live',OXROUTE_SLACK_BOT_TOKEN:'xoxb-live'});
const {baseEnv}=await import('./daemon-env.mjs');
let daemon;
try{
 daemon=spawn(process.env.TEST_DAEMON,[],{stdio:['ignore','ignore','inherit'],env:{...baseEnv,OXROUTE_CONFIG:config,OXROUTE_CODEX_URL:'ws://127.0.0.1:9',OXROUTE_CODEX_CLI:'/bin/false'}});
 let state;for(let i=0;i<100&&!state;i++){try{state=await (await fetch(`${native}/api/state`)).json();}catch{await new Promise(done=>setTimeout(done,100));}}
 assert.ok(state,'Disposable daemon started');
 assert.equal(state.focus_agent_id??state.focusAgentId??null,null,'No Focus session starts');
 assert.ok(!JSON.stringify(state).includes('livemodel'),'The live model list is not inherited');
 await access(join(root,'test.sqlite3'));await assert.rejects(access(live),'The live database path is not used');
 assert.ok(!Object.keys(baseEnv).some(name=>/^(OXROUTE_|SLACK_|CODEX_SLACK)/.test(name)),'The harness environment carries no live deployment variables');
 console.log('Disposable daemons ignore the invoking environment and start no Focus session.');
}finally{
 if(daemon){daemon.kill('SIGTERM');if(daemon.exitCode===null)await new Promise(done=>daemon.once('exit',done));}
 await rm(root,{recursive:true,force:true});
}
