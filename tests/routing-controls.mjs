import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { resolve, join } from 'node:path';
import { chromium, webkit } from 'playwright';
assert.ok(process.env.TEST_URL && process.env.TEST_DAEMON);
await mkdir(resolve('.tmp'), { recursive: true });
const root = await mkdtemp(resolve('.tmp/routing-controls-'));
const listen = server => new Promise(done => server.listen(0, '127.0.0.1', () => done(server.address().port)));
const reserve = createServer(), port = await listen(reserve);
await new Promise(done => reserve.close(done));
const native = `http://127.0.0.1:${port}`, config = join(root, 'config.toml');
await writeFile(config, `owner = "fixture"\nlisten = "127.0.0.1:${port}"\nworkspace = ${JSON.stringify(root)}\n[limits]\nmin_free_bytes = 0\n[paths]\ndatabase = ${JSON.stringify(join(root, 'test.sqlite3'))}\nartifacts = ${JSON.stringify(join(root, 'artifacts'))}\nattachments = ${JSON.stringify(join(root, 'attachments'))}\n`);
const start = () => spawn(process.env.TEST_DAEMON, [], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, CODEX_HOME: join(root, 'codex'), OXROUTE_CONFIG: config, OXROUTE_CODEX_URL: 'ws://127.0.0.1:9', OXROUTE_CODEX_CLI: '/bin/false' } });
let daemon = start();
const proxy = createServer((req, res) => {
  const target = new URL(req.url, req.url.startsWith('/api/') && !req.url.startsWith('/api/version') ? native : process.env.TEST_URL);
  const upstream = request(target, { method: req.method, headers: req.headers }, reply => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(upstream); res.on('close', () => upstream.destroy());
});
const base = `http://127.0.0.1:${await listen(proxy)}`;
let browser;
async function api(path, body, method = 'POST') {
  const response = await fetch(native + path, body === undefined ? {} : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.ok(response.ok, await response.clone().text()); return response.json();
}
const ready = async () => {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(native + '/api/health')).ok) return; } catch {} await new Promise(done => setTimeout(done, 100)); }
  assert.fail('Disposable daemon unavailable');
};
try {
  await ready();
  browser = await (process.env.BROWSER === 'webkit' ? webkit : chromium).launch(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {});
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  await page.goto(base);
  const inputAuto = page.getByRole('button', { name: 'Route inputs automatically', exact: true });
  const inputAsk = page.getByRole('button', { name: 'Ask me before routing inputs', exact: true });
  const nextAuto = page.getByRole('button', { name: 'Continue next actions automatically', exact: true });
  const check = async (input, next) => {
    await page.waitForFunction(({ input, next }) => document.querySelector('[aria-label="Route inputs automatically"]')?.getAttribute('aria-pressed') === String(input === 'auto') && document.querySelector('[aria-label="Continue next actions automatically"]')?.getAttribute('aria-pressed') === String(next === 'auto'), { input, next });
    const state = await api('/api/state'); assert.equal(state.mode, input); assert.equal(state.nextActionMode, next);
  };
  await check('ask', 'ask');
  await inputAuto.click(); await check('auto', 'ask');
  await nextAuto.click(); await check('auto', 'auto');
  await inputAsk.click(); await check('ask', 'auto');
  await nextAuto.click(); await check('ask', 'ask');
  await nextAuto.click(); await check('ask', 'auto');
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  await page.close();
  daemon.kill('SIGTERM'); if (daemon.exitCode === null) await new Promise(done => daemon.once('exit', done)); daemon = start(); await ready();
  const state = await api('/api/state'); assert.equal(state.mode, 'ask'); assert.equal(state.nextActionMode, 'auto');
  const restored = await browser.newPage(); await restored.goto(base);
  await restored.waitForFunction(() => document.querySelector('[aria-label="Continue next actions automatically"]')?.getAttribute('aria-pressed') === 'true');
  assert.equal(await restored.getByRole('button', { name: 'Ask me before routing inputs', exact: true }).getAttribute('aria-pressed'), 'true');
  console.log('Four independent routing combinations and persisted toolbar settings pass in ' + (process.env.BROWSER ?? 'chromium') + '.');
} finally {
  await browser?.close(); proxy.closeAllConnections(); await new Promise(done => proxy.close(done));
  daemon.kill('SIGTERM'); if (daemon.exitCode === null) await new Promise(done => daemon.once('exit', done));
  await rm(root, { recursive: true, force: true });
}
