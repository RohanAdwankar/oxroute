// Real Chromium + disposable daemon + local app-server transport. No accounts,
// external sites, credentials or shared services are used by this fixture.
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

assert.ok(process.env.TEST_DAEMON && process.env.TEST_URL);
const { WebSocketServer } = createRequire(import.meta.url)('next/dist/compiled/ws');
await mkdir(resolve('.tmp'), { recursive: true });
const root = await mkdtemp(resolve('.tmp/browser-handoff-'));
const listen = server => new Promise(done => server.listen(0, '127.0.0.1', () => done(server.address().port)));
const pause = ms => new Promise(done => setTimeout(done, ms));
const until = async check => { for (let i = 0; i < 150; i++) { if (await check()) return; await pause(100); } assert.fail('Condition did not settle'); };
const rpcHttp = createServer(), rpc = new WebSocketServer({ server: rpcHttp });
const rpcPort = await listen(rpcHttp);
const turns = [];
let sequence = 0;
rpc.on('connection', socket => socket.on('message', raw => {
  const { id, method, params = {} } = JSON.parse(raw);
  if (id === undefined) return;
  let result = {};
  if (method === 'thread/start') result = { thread: { id: `thread-${++sequence}` } };
  if (method === 'thread/resume') result = { thread: { id: params.threadId } };
  if (method === 'turn/start') {
    const turn = { id: `turn-${++sequence}`, status: 'completed' };
    result = { turn };
    if (!params.outputSchema) turns.push(params.input);
    setTimeout(() => {
      for (const [method, extra] of [['turn/started', { turn }], ['item/completed', { item: { id: 'reply-' + sequence, type: 'agentMessage', text: 'Browser task resumed.', phase: 'final_answer' } }], ['turn/completed', { turn }]]) {
        if (socket.readyState === 1) socket.send(JSON.stringify({ method, params: { threadId: params.threadId, ...extra } }));
      }
    }, 20);
  }
  socket.send(JSON.stringify({ id, result }));
}));
const reserve = createServer(), port = await listen(reserve);
await new Promise(done => reserve.close(done));
const native = `http://127.0.0.1:${port}`, config = join(root, 'config.toml');
await writeFile(config, `owner = "fixture"\nlisten = "127.0.0.1:${port}"\nworkspace = ${JSON.stringify(root)}\n[limits]\nmin_free_bytes = 0\n[paths]\ndatabase = ${JSON.stringify(join(root, 'test.sqlite3'))}\nartifacts = ${JSON.stringify(join(root, 'artifacts'))}\nattachments = ${JSON.stringify(join(root, 'attachments'))}\n`);
const sandbox = process.env.TEST_BROWSER_SANDBOX ?? 'false';
assert.ok(['true', 'false'].includes(sandbox));
const start = () => spawn(process.env.TEST_DAEMON, [], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, HOME: root, CODEX_HOME: join(root, 'codex'), OXROUTE_CONFIG: config, OXROUTE_CODEX_URL: `ws://127.0.0.1:${rpcPort}`, OXROUTE_CODEX_CLI: '/bin/false', OXROUTE_BROWSER_EXECUTABLE: process.env.TEST_BROWSER_EXECUTABLE ?? chromium.executablePath(), OXROUTE_BROWSER_SANDBOX: sandbox, OXROUTE_NEXT_ACTION_SUGGESTIONS: 'false' } });
let daemon = start();
const proxy = createServer((req, res) => {
  const target = new URL(req.url, req.url.startsWith('/api/') && !req.url.startsWith('/api/version') ? native : process.env.TEST_URL);
  const upstream = request(target, { method: req.method, headers: req.headers }, reply => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(upstream); res.on('close', () => upstream.destroy());
});
const base = `http://127.0.0.1:${await listen(proxy)}`;
const fixture = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(`<!doctype html><title>Shared browser demo</title><style>body{font:20px system-ui;padding:56px;background:#fafafa;color:#222}input,button{font:inherit;padding:12px;margin:8px 0;border:1px solid #999;background:white}h1{font-size:32px}p{color:#555}label{display:block}</style><h1>Browser handoff</h1><p>The agent and you share this page.</p><label>Project name<br><input id="project" value="" autocomplete="off"></label><button id="save" onclick="document.querySelector('#result').textContent='Saved: '+document.querySelector('#project').value;sessionStorage.setItem('saved',document.querySelector('#project').value)">Save project</button><p id="result" aria-live="polite">Ready</p><a href="/second" target="_blank">Open another tab</a>`);
});
const site = `http://127.0.0.1:${await listen(fixture)}`;
async function api(path, body, method = 'POST') {
  const response = await fetch(native + path, body === undefined ? {} : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.ok(response.ok, await response.clone().text()); return response.json();
}
const browser = await chromium.launch();
const errors = [];
let page;
try {
  await until(async () => { try { return (await fetch(native + '/api/health')).ok; } catch { return false; } });
  const agent = await api('/api/agents', {});
  const other = await api('/api/agents', {});
  await api('/api/rename', { agent: agent.id, name: 'Browser handoff demo' });
  page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(`${base}/?agent=${agent.id}`);
  await page.getByLabel('Choose visible agents', { exact: true }).click();
  await page.getByRole('button', { name: 'New browser', exact: true }).click();
  const pane = page.locator('[data-browser-pane]');
  await pane.waitFor();
  const [info] = await api('/api/browsers');
  assert.equal(info.agentId, agent.id);
  const target = `/api/browsers/${info.id}`;
  const act = input => api(target + '/action', { agentId: agent.id, ...input });
  const text = async () => JSON.stringify((await api(target + '/snapshot')).nodes);
  assert.equal((await api('/api/browsers', { agentId: agent.id })).id, info.id, 'Reopening reuses the conversation browser');
  assert.ok(!Object.hasOwn(info, 'controller'), 'Agent metadata never exposes human credentials');
  await assert.rejects(() => api(target + '/action', { agentId: other.id, action: 'type', text: 'wrong owner' }));
  await assert.rejects(() => act({ action: 'navigate', url: 'file:///etc/passwd' }));
  await act({ action: 'navigate', url: site });
  await until(async () => (await text()).includes('Project name'));
  const isolation = await api(target + '/isolation');
  assert.equal(isolation.requested, sandbox === 'true');
  const expectedIsolation = process.env.TEST_EXPECT_ISOLATION ?? (process.platform === 'linux' ? sandbox === 'true' ? 'verified' : 'disabled' : 'unsupported');
  assert.equal(isolation.status, expectedIsolation);
  if (process.platform === 'linux') assert.ok(isolation.renderers.length > 0, 'The browser must identify its real renderer processes');
  if (expectedIsolation === 'verified') {
    assert.ok(isolation.renderers.every(renderer => renderer.verified), 'Every observed renderer is isolated');
  }
  if (process.env.ISOLATION_REPORT) await writeFile(process.env.ISOLATION_REPORT, JSON.stringify(isolation, null, 2) + '\n');
  await act({ action: 'click', x: 160, y: 255 });
  await act({ action: 'key', key: 'Tab' });
  await act({ action: 'key', key: 'Tab', modifiers: 8 });
  await act({ action: 'type', text: 'Agent draft' });
  await until(async () => (await text()).includes('Agent draft'));
  const jpeg = await fetch(native + target + '/frame');
  assert.equal(jpeg.headers.get('content-type'), 'image/jpeg');
  assert.ok((await jpeg.arrayBuffer()).byteLength > 1000);

  await pane.getByRole('button', { name: 'Take control', exact: true }).click();
  await pane.getByText('You have control', { exact: true }).waitFor();
  await assert.rejects(() => act({ action: 'type', text: 'blocked agent' }), /Human has control/);
  const screen = pane.getByRole('application', { name: 'Browser viewport' });
  const box = await screen.boundingBox();
  await screen.click({ position: { x: 160 * box.width / 1280, y: 255 * box.height / 800 } });
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Human edit');
  await until(async () => (await text()).includes('Human edit'));
  assert.ok(!(await text()).includes('blocked agent'));
  await page.reload();
  await pane.getByText('You have control', { exact: true }).waitFor();
  assert.ok((await text()).includes('Human edit'), 'Reloading Oxroute preserves the remote page state and human control');
  if (process.env.SCREENSHOT) { await pane.getByAltText('Shared browser screen').waitFor(); await pause(700); await page.screenshot({ path: process.env.SCREENSHOT }); }
  const previousTurns = turns.length;
  await pane.getByRole('button', { name: 'Resume agent', exact: true }).click();
  await pane.getByText('Agent has control', { exact: true }).waitFor();
  await until(() => turns.length > previousTurns);
  await act({ action: 'key', key: 'Tab' });
  await act({ action: 'key', key: 'Enter' });
  await until(async () => (await text()).includes('Saved: Human edit'));
  await act({ action: 'newTab' });
  const tabs = await api(target);
  assert.equal(tabs.tabs.length, 2);
  const original = tabs.tabs.find(tab => tab.url.startsWith(site));
  await act({ action: 'selectTab', target: original.id });
  assert.ok((await text()).includes('Saved: Human edit'), 'Switching tabs preserves form and page state');
  await act({ action: 'closeTab', target: tabs.target });
  await until(async () => (await api(target)).tabs.length === 1);
  daemon.kill('SIGTERM'); if (daemon.exitCode === null) await new Promise(done => daemon.once('exit', done));
  daemon = start();
  await until(async () => { try { return (await fetch(native + '/api/health')).ok; } catch { return false; } });
  assert.equal((await api('/api/browsers'))[0].human, true, 'Daemon restart restores the browser in human control');
  await page.reload();
  await pane.getByText('You have control', { exact: true }).waitFor();
  await assert.rejects(() => act({ action: 'type', text: 'still paused' }), /Human has control/);
  assert.deepEqual(errors, []);
  await pane.getByRole('button', { name: 'End browser', exact: true }).click();
  await until(async () => !(await api('/api/browsers')).length);
  await assert.rejects(() => act({ action: 'type', text: 'ended session' }), /No such browser/);
  console.log('Real Chromium: agent isolation, screenshots, scaled human input, takeover, preserved state, UI reload, resume wake, tabs, safe daemon restart and cleanup pass.');
} catch (error) {
  console.error(errors);
  if (page) { console.error((await page.locator("body").innerText()).slice(0, 3000)); if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT }); }
  throw error;
} finally {
  await browser.close();
  daemon.kill('SIGTERM'); if (daemon.exitCode === null) await new Promise(done => daemon.once('exit', done));
  for (const server of [proxy, fixture]) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  for (const socket of rpc.clients) socket.terminate(); rpc.close(); await new Promise(done => rpcHttp.close(done));
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
