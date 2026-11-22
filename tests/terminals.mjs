import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { resolve, join } from 'node:path';
import {baseEnv} from './daemon-env.mjs';
assert.ok(process.env.TEST_URL && process.env.TEST_DAEMON);
await mkdir(resolve('.tmp'), { recursive: true });
const root = await mkdtemp(resolve('.tmp/terminal-lifecycle-'));
const listen = server => new Promise(done => server.listen(0, '127.0.0.1', () => done(server.address().port)));
const reserve = createServer(), port = await listen(reserve);
await new Promise(done => reserve.close(done));
const native = `http://127.0.0.1:${port}`, config = join(root, 'config.toml');
await writeFile(config, `owner = "fixture"\nlisten = "127.0.0.1:${port}"\nworkspace = ${JSON.stringify(root)}\n[limits]\nmin_free_bytes = 0\n[paths]\ndatabase = ${JSON.stringify(join(root, 'test.sqlite3'))}\nartifacts = ${JSON.stringify(join(root, 'artifacts'))}\nattachments = ${JSON.stringify(join(root, 'attachments'))}\n`);
const launch = () => spawn(process.env.TEST_DAEMON, [], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...baseEnv, HOME: root, SHELL: '/bin/bash', CODEX_HOME: join(root, 'codex'), OXROUTE_CONFIG: config, OXROUTE_CODEX_URL: 'ws://127.0.0.1:9', OXROUTE_CODEX_CLI: '/bin/false' } });
let daemon = launch();
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
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(native + '/api/health')).ok) break; } catch {}
    await new Promise(done => setTimeout(done, 100));
  }
  assert.ok((await api('/api/state')).artifactRoot.includes('/.tmp/'));
  const agent = await api('/api/agents', {});
  const page = await browser.newPage({ viewport: { width: 1200, height: 750 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(`${base}/?agent=${agent.id}`);
  await page.getByLabel('Choose visible agents').click();
  await page.getByRole('button', { name: 'New terminal', exact: true }).click();
  const pane = page.locator('[data-terminal-pane]');
  await pane.waitFor();
  const id = await pane.getAttribute('data-terminal-pane');
  const typed = pane.locator('.xterm:visible .xterm-helper-textarea');
  await typed.focus();
  await page.keyboard.type("printf '%s' 'user-' 'input'");
  await page.keyboard.press('Enter');
  const terminalApi = async (suffix, body) => {
    const response = await page.request[body ? 'post' : 'get'](`${base}/api/terminals/${id}${suffix}`, body ? { data: body } : {});
    return response;
  };
  const output = async () => Buffer.from((await (await terminalApi('')).json()).bytes).toString();
  const waitOutput = async text => {
    for (let n = 0; n < 100; n++) { if ((await output()).includes(text)) return; await page.waitForTimeout(100); }
    assert.fail(`Terminal never produced ${text}`);
  };
  await waitOutput('user-input');
  assert.equal((await terminalApi('/input', { agentId: agent.id, data: 'printf denied\r' })).ok(), false);
  await terminalApi('/access', { agentId: agent.id });
  await page.getByRole('alertdialog', { name: 'Terminal access request' }).waitFor();
  await page.getByRole('button', { name: 'Allow', exact: true }).click();
  await page.getByRole('button', { name: 'Revoke', exact: true }).waitFor();
  assert.equal((await terminalApi('/input', { agentId: agent.id, data: "printf '%s' 'agent-' 'input'\r" })).ok(), true);
  await waitOutput('agent-input');
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  await page.getByRole('button', { name: 'Revoke', exact: true }).click();
  await page.getByRole('button', { name: 'Revoke', exact: true }).waitFor({ state: 'detached' });
  assert.equal((await terminalApi('/input', { agentId: agent.id, data: 'printf denied\r' })).ok(), false);
  await page.route(`**/api/terminals/${id}?after=*`, async route => {
    await page.waitForTimeout(500);
    await route.continue();
  });
  await page.reload();
  await pane.waitFor();
  await typed.focus();
  await page.keyboard.type("printf '%s' 'reload-' 'works'");
  await page.keyboard.press('Enter');
  await waitOutput('reload-works');
  assert.deepEqual(errors, []);
  page.once('dialog', dialog => dialog.accept());
  await pane.getByRole('button', { name: 'End terminal session' }).click();
  await pane.waitFor({ state: 'detached' });
  console.log('Real terminal user input, agent approval, revocation, reload and ending pass.');
} finally {
  for (const context of browser.contexts()) for (const page of context.pages()) await page.unrouteAll({ behavior: "ignoreErrors" });
  await browser.close(); proxy.closeAllConnections(); await new Promise(done => proxy.close(done));
  daemon.kill('SIGTERM'); if (daemon.exitCode === null) await new Promise(done => daemon.once('exit', done));
  const { execFileSync } = await import('node:child_process');
  try { execFileSync('tmux', ['-L', `oxroute-terminals-127.0.0.1_${port}`, 'kill-server'], { stdio: 'ignore' }); } catch {}
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
