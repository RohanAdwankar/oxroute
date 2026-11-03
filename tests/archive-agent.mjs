// Use an explicitly selected disposable daemon and production frontend.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
const web = process.env.TEST_URL, api = process.env.TEST_NATIVE_URL, database = process.env.TEST_DATABASE;
assert.ok(web && api && database);
const call = async (path, body) => {
  const response = await fetch(api + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  assert.ok(response.ok, await response.clone().text());
  return response.json();
};
const owner = await call('/api/agents', {}), other = await call('/api/agents', {});
await call('/api/rename', { agent: owner.id, name: 'Deployment follow-up' });
const tasks = ['incomplete', 'done', 'waiting_for_human', 'blocked', 'complete'].map((status, index) => ({
  id: `task_${crypto.randomUUID().replaceAll('-', '')}`, text: ['Check deployment health', 'Review chart changes', 'Confirm maintenance window', 'Run dependent validation', 'Previously approved task'][index],
  status, agentId: owner.id,
}));
const foreign = { id: `task_${crypto.randomUUID().replaceAll('-', '')}`, text: 'Another agent’s subtask', status: 'incomplete', agentId: other.id };
const seed = spawnSync('uv', ['run', '--no-project', 'python', '-c', `
import json,sqlite3,sys
c=sqlite3.connect(sys.argv[1]); rows=json.loads(sys.argv[2])
for t in rows:
 c.execute("INSERT INTO tasks (id,text,status,agent_id,parent_task_id,blocked_by_task_id,position,images,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",(t['id'],t['text'],t['status'],t['agentId'],rows[0]['id'] if t is rows[-1] else '',rows[-1]['id'] if t['status']=='blocked' else '',0,'[]',1,1))
c.commit()
`, database, JSON.stringify([...tasks, foreign])], { encoding: 'utf8' });
assert.equal(seed.status, 0, seed.stderr);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.addInitScript(() => { window.SharedWorker = class { port = { postMessage() {}, close() {} }; }; });
let fail = false;
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/version') return route.continue();
  if (fail && url.pathname === '/api/archive') return route.fulfill({ status: 503, json: { error: 'Temporary archive failure' } });
  await route.fulfill({ response: await page.request.fetch(api + url.pathname + url.search, {
    method: route.request().method(), data: route.request().postDataBuffer() ?? undefined, headers: { 'content-type': 'application/json' },
  }) });
});
const open = async () => {
  await page.goto(`${web}/?agent=${owner.id}`);
  await page.getByRole('button', { name: 'archive session', exact: true }).click();
  await page.getByRole('dialog').waitFor();
};
const assigned = async () => (await call('/api/tasks')).filter(task => task.agentId === owner.id);
try {
  await open();
  const modal = page.getByRole('dialog');
  for (const task of tasks) await modal.getByText(task.text, { exact: true }).waitFor();
  assert.equal(await modal.getByText(foreign.text, { exact: true }).count(), 0);
  if (process.env.ARTIFACT_DIR) await page.screenshot({ path: `${process.env.ARTIFACT_DIR}/archive-tasks.png` });
  await page.setViewportSize({ width: 420, height: 640 });
  const bounds = await modal.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 420 && bounds.y + bounds.height <= 640);
  await page.setViewportSize({ width: 1280, height: 900 });
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal((await call('/api/state')).archived.some(agent => agent.id === owner.id), false);
  assert.deepEqual((await assigned()).map(task => task.status).sort(), tasks.map(task => task.status).sort());
  await open();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 0);
  await open();
  fail = true;
  await modal.getByRole('button', { name: 'Mark all complete and archive', exact: true }).click();
  await modal.getByRole('alert').getByText('Temporary archive failure').waitFor();
  assert.equal((await call('/api/state')).archived.some(agent => agent.id === owner.id), false);
  assert.deepEqual((await assigned()).map(task => task.status).sort(), tasks.map(task => task.status).sort());
  fail = false;
  await modal.getByRole('button', { name: 'Archive without changing tasks', exact: true }).click();
  await modal.waitFor({ state: 'detached' });
  assert.equal((await call('/api/state')).archived.some(agent => agent.id === owner.id), true);
  assert.deepEqual((await assigned()).map(task => task.status).sort(), tasks.map(task => task.status).sort());
  await page.goto(`${web}/?agent=${owner.id}`);
  await page.getByRole('button', { name: 'restore session', exact: true }).click();
  await page.getByRole('button', { name: 'archive session', exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.getByRole('button', { name: 'archive session', exact: true }).click();
  await modal.getByRole('button', { name: 'Mark all complete and archive', exact: true }).click();
  await modal.waitFor({ state: 'detached' });
  assert.ok((await assigned()).every(task => task.status === 'complete'));
  assert.equal((await call('/api/tasks')).find(task => task.id === foreign.id).status, 'incomplete');
  assert.equal((await call('/api/state')).archived.some(agent => agent.id === owner.id), true);
  await page.goto(`${web}/?agent=${other.id}`);
  await page.getByRole('button', { name: 'archive session', exact: true }).click();
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
  const empty = await call('/api/agents', {});
  await page.goto(`${web}/?agent=${empty.id}`);
  await page.evaluate(() => {
    window.archiveDialogs = 0;
    new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes)
        if (node instanceof Element && (node.matches('dialog') || node.querySelector('dialog'))) window.archiveDialogs++;
    }).observe(document.body, { childList: true, subtree: true });
  });
  fail = true;
  await page.getByRole('button', { name: 'archive session', exact: true }).click();
  await page.getByText('Temporary archive failure', { exact: true }).waitFor();
  assert.equal((await call('/api/state')).archived.some(agent => agent.id === empty.id), false);
  assert.equal(await page.getByRole('button', { name: 'archive session', exact: true }).count(), 1);
  fail = false;
  const archived = page.waitForResponse(response => new URL(response.url()).pathname === '/api/archive' && response.ok());
  await page.getByRole('button', { name: 'archive session', exact: true }).click();
  await archived;
  await page.getByRole('button', { name: 'archive session', exact: true }).waitFor({ state: 'detached' });
  assert.equal((await call('/api/state')).archived.some(agent => agent.id === empty.id), true);
  assert.equal(await page.evaluate(() => window.archiveDialogs), 0);
  if (process.env.ARTIFACT_DIR) await page.screenshot({ path: `${process.env.ARTIFACT_DIR}/empty-agent-archived.png` });
  console.log('Archive modal: task list, cancellation, Escape, failure recovery, archive-only, restore, bulk completion, ownership scope, and empty sessions passed.');
} finally { await page.goto('about:blank'); await page.unrouteAll({ behavior: "wait" }); await browser.close(); }
