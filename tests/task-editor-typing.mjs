import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { resolve, join } from 'node:path';
assert.ok(process.env.TEST_URL && process.env.TEST_DAEMON);
await mkdir(resolve('.tmp'), { recursive: true });
const root = await mkdtemp(resolve('.tmp/task-editor-'));
const listen = server => new Promise(done => server.listen(0, '127.0.0.1', () => done(server.address().port)));
const reserve = createServer(), port = await listen(reserve);
await new Promise(done => reserve.close(done));
const native = `http://127.0.0.1:${port}`, config = join(root, 'config.toml');
await writeFile(config, `owner = "fixture"\nlisten = "127.0.0.1:${port}"\nworkspace = ${JSON.stringify(root)}\n[limits]\nmin_free_bytes = 0\n[paths]\ndatabase = ${JSON.stringify(join(root, 'test.sqlite3'))}\nartifacts = ${JSON.stringify(join(root, 'artifacts'))}\nattachments = ${JSON.stringify(join(root, 'attachments'))}\n`);
const daemon = spawn(process.env.TEST_DAEMON, [], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, CODEX_HOME: join(root, 'codex'), OXROUTE_CONFIG: config, OXROUTE_CODEX_URL: 'ws://127.0.0.1:9', OXROUTE_CODEX_CLI: '/bin/false' } });
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
  const agents = [];
  for (let i = 0; i < 100; i++) agents.push(await api('/api/agents', {}));
  const tasks = [];
  for (let i = 0; i < 180; i++) {
    const task = await api('/api/tasks', { text: `Review item ${i}` });
    tasks.push(await api(`/api/tasks/${task.id}`, { ...task, agentId: agents[0].id }, 'PUT'));
  }
  const page = await browser.newPage({ viewport: { width: 1300, height: 850 } });
  await page.addInitScript(() => {
    localStorage.setItem('oxroute.tasks', 'true');
    window.delays = [];
    document.addEventListener('keydown', event => {
      if (!event.target.matches('[data-task-panel] textarea, [data-task-panel] input:not([type="search"])')) return;
      const start = performance.now();
      requestAnimationFrame(() => window.delays.push(performance.now() - start));
    }, true);
  });
  if (process.env.BROWSER !== 'webkit') await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const writes = [];
  page.on('request', req => {
    if (req.method() === 'PUT' && new URL(req.url()).pathname.startsWith('/api/tasks/')) writes.push(req.postDataJSON());
  });
  await page.goto(`${base}/?agent=${agents[0].id}`);
  const panel = page.locator('[data-task-panel]');
  await panel.locator('[data-task-open]').first().dblclick();
  const editor = panel.locator('textarea').first();
  await editor.press('End');
  const text = ' Keep every character while editing this task.';
  await page.keyboard.type(text, { delay: 15 });
  assert.equal(await editor.inputValue(), 'Review item 0' + text);
  assert.equal(writes.length, 0, 'Draft keystrokes never save or mutate tasks');
  const delays = await page.evaluate(() => window.delays.sort((a, b) => a - b));
  console.log(JSON.stringify({ browser: process.env.BROWSER ?? 'chromium-4x', keys: delays.length, median: delays[Math.floor(delays.length * .5)], p95: delays[Math.floor(delays.length * .95)], max: delays.at(-1) }));
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  await editor.press('Enter');
  await panel.locator('[data-task-open]').first().waitFor();
  assert.equal(writes.at(-1).text, 'Review item 0' + text);
  await panel.locator('[data-task-open]').first().dblclick();
  await editor.fill('Discard this draft'); await editor.press('Escape');
  await panel.locator('[data-task-open]').first().waitFor();
  assert.equal(writes.length, 1, 'Escape restores the existing task without saving');
  await panel.locator('[data-task-open]').first().dblclick();
  await editor.fill('Saved on blur'); await panel.getByRole('searchbox').click();
  await panel.getByRole('button', { name: 'Saved on blur', exact: true }).waitFor();
  assert.equal(writes.at(-1).text, 'Saved on blur');
  assert.equal((await api('/api/tasks')).find(task => task.id === tasks[0].id).text, 'Saved on blur', 'Edits persist in the real daemon');
  await panel.locator('[data-task-open]').first().dblclick();
  await editor.fill('Keep my draft through live updates');
  const other = tasks.at(-1);
  await api(`/api/tasks/${other.id}`, { ...other, text: 'Updated elsewhere' }, 'PUT');
  await panel.getByRole('button', { name: 'Updated elsewhere', exact: true }).waitFor({ state: 'attached' });
  assert.equal(await editor.inputValue(), 'Keep my draft through live updates');
  await editor.press('Escape');
  const status = panel.getByRole('combobox', { name: 'status for Saved on blur', exact: true });
  await status.selectOption('waiting_for_human');
  const reason = panel.getByPlaceholder('Why waiting for human? A sentence or a commit');
  await reason.fill('Waiting for the planned review'); await reason.press('Enter');
  await page.waitForFunction(({ id }) => document.querySelector(`[aria-label="status for Saved on blur"]`)?.value === 'waiting_for_human', { id: tasks[0].id });
  assert.equal((await api('/api/tasks')).find(task => task.id === tasks[0].id).status, 'waiting_for_human');
  assert.ok((await api('/api/task-notes')).some(note => note.taskId === tasks[0].id && note.text === 'Waiting for the planned review'));
  assert.equal(await panel.locator('[data-task-row]').count(), tasks.length, 'Every task remains available');

} finally {
  await browser.close(); proxy.closeAllConnections(); await new Promise(done => proxy.close(done));
  daemon.kill('SIGTERM'); if (daemon.exitCode === null) await new Promise(done => daemon.once('exit', done));
  await rm(root, { recursive: true, force: true });
}
