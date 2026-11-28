import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {chromium} from 'playwright';

// A path is whatever the user points at; the daemon decides whether it is a readable file.
const native=process.env.TEST_NATIVE_URL, web=process.env.TEST_URL, fixtures=process.env.TEST_FIXTURES, database=process.env.TEST_DATABASE;
assert.ok(native && web && fixtures && database, 'Set TEST_NATIVE_URL, TEST_URL, TEST_FIXTURES and TEST_DATABASE to a disposable runtime');
const api=async(path,body)=>{const r=await fetch(native+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok,await r.clone().text());return r.json();};
const agent=await api('/api/agents',{id:`agent_${crypto.randomUUID().replaceAll('-','')}`});
await mkdir(join(fixtures,'notes'),{recursive:true});
const file=join(fixtures,'notes','plan.md'), missing=join(fixtures,'notes','absent.md'), plain=join(fixtures,'notes','plain.md');
await writeFile(file,'# Rollout plan\n\nShip on Friday.\n');await writeFile(plain,'Plain text path target.\n');
const db=new DatabaseSync(database);db.exec('PRAGMA busy_timeout=5000');
db.prepare("INSERT INTO entries(agent_id,at,kind,text) VALUES(?,?,'said',?)").run(agent.id,Date.now()/1000,`The plan is at \`${file}\` but \`${missing}\` is gone. Also see ${plain} in prose.`);
const browser=await chromium.launch(), page=await browser.newPage({viewport:{width:1100,height:700}});
try {
  await page.goto(`${web}/?agent=${agent.id}`);
  const open=async target=>{await target.click({button:'right'});await page.getByRole('button',{name:'Open as review',exact:true}).click();};
  await open(page.locator('code',{hasText:file}).first());
  const dialog=page.getByRole('dialog',{name:'File review'});
  await dialog.getByText('Ship on Friday.').waitFor();
  await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  await open(page.locator('code',{hasText:missing}).first());
  await page.getByText(`Cannot read ${missing}`).waitFor();
  await page.keyboard.press('Escape');
  // Selected prose works the same way as inline code.
  await page.evaluate(path=>{const node=[...document.querySelectorAll('.message-markdown p')].map(p=>p.lastChild).find(n=>n?.textContent?.includes(path));const at=node.textContent.indexOf(path),range=document.createRange();range.setStart(node,at);range.setEnd(node,at+path.length);getSelection().removeAllRanges();getSelection().addRange(range);},plain);
  await page.locator('.message-markdown p').first().click({button:'right'});
  await page.getByRole('button',{name:'Open as review',exact:true}).click();
  await dialog.getByText('Plain text path target.').waitFor();
  console.log('Right-clicking an inline-code path or selected prose opens a snapshot review of that file, and an unreadable path shows a short error.');
} finally {await browser.close();}
