import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { resolve, join } from 'node:path';
import {baseEnv} from './daemon-env.mjs';
assert.ok(process.env.TEST_URL && process.env.TEST_DAEMON);
await mkdir(resolve('.tmp'), { recursive: true });
const root = await mkdtemp(resolve('.tmp/task-history-'));
const listen = server => new Promise(done => server.listen(0, '127.0.0.1', () => done(server.address().port)));
const reserve = createServer(), port = await listen(reserve);
await new Promise(done => reserve.close(done));
const native = `http://127.0.0.1:${port}`, config = join(root, 'config.toml');
await writeFile(config, `owner = "fixture"\nlisten = "127.0.0.1:${port}"\nworkspace = ${JSON.stringify(root)}\n[limits]\nmin_free_bytes = 0\n[paths]\ndatabase = ${JSON.stringify(join(root, 'test.sqlite3'))}\nartifacts = ${JSON.stringify(join(root, 'artifacts'))}\nattachments = ${JSON.stringify(join(root, 'attachments'))}\n`);
const daemon = spawn(process.env.TEST_DAEMON, [], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...baseEnv, CODEX_HOME: join(root, 'codex'), OXROUTE_CONFIG: config, OXROUTE_CODEX_URL: 'ws://127.0.0.1:9', OXROUTE_CODEX_CLI: '/bin/false' } });
const proxy = createServer((req, res) => {
  const target = new URL(req.url, req.url.startsWith('/api/') && !req.url.startsWith('/api/version') ? native : process.env.TEST_URL);
  const upstream = request(target, { method: req.method, headers: req.headers }, reply => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(upstream); res.on('close', () => upstream.destroy());
});
const base = `http://127.0.0.1:${await listen(proxy)}`;
async function api(path, body, method = 'POST') {
  const response = await fetch(native + path, body === undefined ? {} : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.ok(response.ok, await response.clone().text()); return response.json();
}
const browser = await (process.env.BROWSER === 'webkit' ? webkit : chromium).launch(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {});
try {
  let ready = false;
  for (let i = 0; i < 100; i++) { try { ready = (await fetch(native + '/api/health')).ok; } catch {} if (ready) break; await new Promise(done => setTimeout(done, 100)); }
  assert.ok(ready); assert.ok((await api('/api/state')).artifactRoot.includes('/.tmp/'));
  const agent = await api('/api/agents', {});
  await api('/api/rename', { agent: agent.id, name: 'Background workflow validation session' });
  const waiting = await api('/api/tasks', { text: 'Check queued delivery and retained workflow details', agentId: agent.id });
  await api(`/api/tasks/${waiting.id}`, { ...waiting, status: 'waiting_for_human', note: 'Choose the remaining delivery window.' }, 'PUT');
  const task = await api('/api/tasks', { text: 'Review retry settings', agentId: agent.id });
  const history = Array.from({ length: 4 }, (_, i) => `Update ${i}: ${'Runtime evidence retained for inspection. '.repeat(60)}`.trim());
  for (const text of history) await api(`/api/tasks/${task.id}/notes`, { text, agentId: agent.id });
  await api(`/api/tasks/${task.id}`, { ...task, status: 'done', note: 'Ready to inspect.' }, 'PUT');
  const completed = await api('/api/tasks', { text: 'Finished delivery', agentId: agent.id });
  await api(`/api/tasks/${completed.id}`, { ...completed, status: 'complete', note: 'Approved.', approved: true }, 'PUT');
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.addInitScript(() => {
    localStorage.setItem('oxroute.tasks', 'true');
    localStorage.setItem('oxroute.taskWidth', '320');
    sessionStorage.setItem('oxroute.windowTasks', 'false');
  });
  await page.goto(`${base}/?agent=${agent.id}`);
  const panel = page.locator('[data-task-panel]');
  const row = panel.locator('[data-task-row]').filter({ has: page.locator('[data-task-open]', { hasText: task.text }) });
  const disclosure = row.getByLabel('Task history', { exact: true });
  await disclosure.waitFor();
  assert.equal(await panel.getByText(completed.text, { exact: true }).count(), 0);
  assert.ok((await row.boundingBox()).height < 170, 'Long progress notes do not determine the default row height');
  for (const text of history) assert.equal(await row.locator('li').filter({ hasText: text }).isVisible(), false);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 850 });
    for (const text of [task.text, waiting.text]) {
      const item = panel.locator('[data-task-row]').filter({ has: page.locator('[data-task-open]', { hasText: text }) });
      const status = await item.getByRole('combobox', { name: `status for ${text}`, exact: true }).boundingBox();
      const history = await item.getByLabel('Task history', { exact: true }).boundingBox();
      const remove = await item.getByRole('button', { name: `delete ${text}`, exact: true }).boundingBox();
      assert.ok(Math.abs(history.y + history.height / 2 - status.y - status.height / 2) < 2, 'History shares the status center at every width');
      assert.ok(Math.abs(history.x + history.width / 2 - remove.x - remove.width / 2) < 2, 'History aligns beneath delete');
      assert.ok(history.x >= 0 && history.x + history.width <= width, `Controls stay inside the viewport: ${JSON.stringify({width,history,remove})}`);
    }
    if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT.replace('.png', `-${width}.png`) });
  }
  await page.setViewportSize({ width: 1280, height: 850 });
  await disclosure.focus(); await page.keyboard.press('Enter');
  for (const text of history) await row.locator('li').filter({ hasText: text }).waitFor({ state: 'visible' });
  await disclosure.click();
  await disclosure.blur();
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  await row.getByRole('button', { name: 'Approve', exact: true }).click();
  await row.waitFor({ state: 'detached' });
  const saved = await api('/api/tasks');
  assert.equal(saved.find(item => item.id === task.id).status, 'complete');
  assert.equal((await api('/api/task-notes')).filter(note => note.taskId === task.id).length, history.length + 2);
  assert.deepEqual(errors, []);
  console.log('Real daemon: compact review rows, collapsed readable history, keyboard expansion, persisted approval and completed-task filtering pass.');

} finally {
  await browser.close(); proxy.closeAllConnections(); await new Promise(done => proxy.close(done));
  daemon.kill('SIGTERM'); if (daemon.exitCode === null) await new Promise(done => daemon.once('exit', done));
  await rm(root, { recursive: true, force: true });
}
