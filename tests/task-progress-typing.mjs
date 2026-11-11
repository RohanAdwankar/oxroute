import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { resolve, join } from 'node:path';
assert.ok(process.env.TEST_URL && process.env.TEST_DAEMON);
await mkdir(resolve('.tmp'), { recursive: true });
const root = await mkdtemp(resolve('.tmp/task-progress-'));
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
  for (let i = 0; i < 3; i++) await api('/api/rename', { agent: agents[i].id, name: i === 2 ? 'Zebra keyboard target' : `Session ${i + 1}` });
  const tasks = [];
  for (let i = 0; i < 180; i++) {
    const task = await api('/api/tasks', { text: `Review item ${i}` });
    tasks.push(await api(`/api/tasks/${task.id}`, { ...task, agentId: agents[0].id }, 'PUT'));
  }
  const page = await browser.newPage({ viewport: { width: 1300, height: 850 } });
  await page.addInitScript(() => {
    localStorage.setItem('oxroute.tasks', 'true');
    window.SharedWorker = undefined;
    window.EventSource = class extends EventTarget { constructor() { super(); window.stream = this; } close() {} };
    window.taskRenders = 0; window.commits = 0;
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true, inject: () => 1, onCommitFiberUnmount() {},
      onCommitFiberRoot(_id, root) {
        window.commits++;
        const visit = fiber => {
          if (!fiber) return;
          if (fiber.stateNode?.matches?.('[data-task-panel]')) {
            const owner = fiber.return;
            if (owner !== window.lastTaskOwner && (owner.flags & 1)) window.taskRenders++;
            window.lastTaskOwner = owner;
          }
          visit(fiber.child); visit(fiber.sibling);
        };
        visit(root.current);
      },
    };
    window.delays = [];
    document.addEventListener('keydown', event => {
      if (!event.target.matches('[data-composer]')) return;
      const start = performance.now();
      requestAnimationFrame(() => window.delays.push(performance.now() - start));
    }, true);
  });
  if (process.env.BROWSER !== 'webkit') await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.goto(`${base}/?agent=${agents[0].id}`);
  const panel = page.locator('[data-task-panel]');
  await panel.locator('[data-task-row]').first().waitFor();
  const composer = page.locator('[data-composer]').first();
  const closedOptions = await panel.locator('option').count();
  await composer.fill('');
  await page.waitForTimeout(300);
  await page.evaluate(() => { window.taskRenders = 0; window.commits = 0; window.delays = []; });
  const typing = page.keyboard.type('Composer input must stay responsive while other agents report progress. ', { delay: 20 });
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(100);
    await page.evaluate(({ agentId, text }) => window.stream.onmessage({ data: JSON.stringify({ type: 'progress', agentId, text }) }), { agentId: agents[0].id, text: `Progress phase ${i}` });
  }
  await typing;
  assert.equal(await composer.inputValue(), 'Composer input must stay responsive while other agents report progress. ');
  const result = await page.evaluate(() => {
    const delays = window.delays.sort((a, b) => a - b);
    return { renders: window.taskRenders, commits: window.commits, keys: delays.length, p95: delays[Math.floor(delays.length * .95)], max: delays.at(-1) };
  });
  console.log(JSON.stringify({ browser: process.env.BROWSER ?? 'chromium-4x', closedOptions, ...result }));
  assert.ok(result.commits >= 5, 'The page still processes every progress event');
  if (!process.env.BASELINE) assert.equal(result.renders, 0, 'Unrelated progress must not render the task panel');
  await page.evaluate(agentId => window.stream.onmessage({ data: JSON.stringify({ type: 'timeline', entry: { id: 999, agentId, kind: 'said', text: 'Live streamed reply', at: 1, detail: '', output: '', origin: '' } }) }), agents[0].id);
  await page.locator('[data-entry="999"]').getByText('Live streamed reply', { exact: true }).waitFor();
  const assign = panel.getByRole('combobox', { name: 'assign Review item 0', exact: true });
  await assign.focus();
  const choices = await assign.locator('option').evaluateAll(options => options.map(option => option.value));
  assert.ok(agents.every(agent => choices.includes(agent.id)), 'Every live session remains assignable');
  assert.ok(['', 'new-agent', 'fork-agent'].every(value => choices.includes(value)), 'Unassigning, starting and forking remain available');
  const current = choices.indexOf(await assign.inputValue());
  const adjacent = [current - 1, current + 1].find(index => agents.some(agent => agent.id === choices[index]));
  assert.notEqual(adjacent, undefined, 'The fixture has an adjacent session for native arrow selection');
  let assigned = choices[adjacent];
  await assign.press(adjacent < current ? 'ArrowUp' : 'ArrowDown');
  await page.keyboard.press('Enter');
  assert.equal(await assign.inputValue(), assigned, 'Native arrow and Enter select the neighboring session');
  await page.waitForFunction(async ({ endpoint, id, agentId }) => (await (await fetch(endpoint + '/api/tasks')).json()).some(task => task.id === id && task.agentId === agentId), { endpoint: base, id: tasks[0].id, agentId: assigned });
  await page.evaluate(() => window.stream.onmessage({ data: JSON.stringify({ type: 'sync' }) }));
  await page.waitForFunction(({ id, agentId }) => document.querySelector(`[aria-label="assign Review item 0"]`)?.value === agentId, { id: tasks[0].id, agentId: assigned });
  assert.equal(new URL(page.url()).searchParams.get('agent'), agents[0].id, 'Dropdown keys never navigate the page');
  await page.keyboard.press('Escape');
  await assign.focus();
  await assign.getByRole('option', { name: 'Zebra keyboard target', exact: true }).waitFor({ state: 'attached' });
  await composer.focus();
  await assign.click();
  await page.keyboard.press('z');
  await page.keyboard.press('Enter');
  assigned = agents[2].id;
  assert.equal(await assign.inputValue(), assigned, 'Pointer opening retains native typeahead and Enter');
  await page.waitForFunction(async ({ endpoint, id, agentId }) => (await (await fetch(endpoint + '/api/tasks')).json()).some(task => task.id === id && task.agentId === agentId), { endpoint: base, id: tasks[0].id, agentId: assigned });
  await assign.click();
  await page.keyboard.press('Escape');
  assert.equal(await assign.inputValue(), assigned, 'Escape retains the selection');
  assert.equal(await assign.evaluate(node => node === document.activeElement), true, 'Escape does not invoke page-level blur or navigation');
  assert.equal(new URL(page.url()).searchParams.get('agent'), agents[0].id);
  const status = panel.getByRole('combobox', { name: 'status for Review item 0', exact: true });
  await status.selectOption('blocked');
  const why = panel.getByPlaceholder('Why blocked? A sentence or a commit');
  await why.fill('Waiting on a prerequisite'); await why.press('Enter');
  await page.evaluate(() => window.stream.onmessage({ data: JSON.stringify({ type: 'sync' }) }));
  const blocker = panel.getByRole('combobox', { name: 'blocking task for Review item 0', exact: true });
  await blocker.focus();
  assert.equal(await blocker.locator('option').count(), tasks.length - 1, 'All other tasks remain selectable as dependencies');
  const dependencies = await blocker.locator('option').evaluateAll(options => options.map(option => option.value));
  const dependencyAt = dependencies.indexOf(await blocker.inputValue());
  const dependencyNext = dependencyAt > 0 ? dependencyAt - 1 : dependencyAt + 1;
  const dependency = dependencies[dependencyNext];
  await blocker.press(dependencyNext < dependencyAt ? 'ArrowUp' : 'ArrowDown');
  await page.keyboard.press('Enter');
  assert.equal(await blocker.inputValue(), dependency, 'Native dependency keyboard selection changes the value');
  assert.equal(new URL(page.url()).searchParams.get('agent'), agents[0].id, 'Dependency keys do not open a different conversation');
  await page.waitForFunction(async ({ endpoint, id, blocker }) => (await (await fetch(endpoint + '/api/tasks')).json()).some(task => task.id === id && task.blockedByTaskId === blocker), { endpoint: base, id: tasks[0].id, blocker: dependency });
  await api('/api/rename', { agent: assigned, name: 'Renamed session' });
  await page.evaluate(() => window.stream.onmessage({ data: JSON.stringify({ type: 'sync' }) }));
  await page.waitForFunction(() => document.querySelector('[aria-label="assign Review item 0"] option:checked')?.textContent === 'Renamed session');
  await composer.focus();
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  const final = await api('/api/tasks');
  assert.equal(final.length, tasks.length, 'Every task remains available');
  assert.equal(final.find(task => task.id === tasks[0].id).agentId, assigned);
  console.log('Native arrows/Enter, pointer-opened typeahead, Escape and persisted assignment/dependency choices pass; stream isolation remains intact.');

} finally {
  await browser.close(); proxy.closeAllConnections(); await new Promise(done => proxy.close(done));
  daemon.kill('SIGTERM'); if (daemon.exitCode === null) await new Promise(done => daemon.once('exit', done));
  await rm(root, { recursive: true, force: true });
}
