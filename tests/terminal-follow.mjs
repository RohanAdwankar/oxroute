import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { resolve, join } from 'node:path';
assert.ok(process.env.TEST_URL && process.env.TEST_DAEMON);
await mkdir(resolve('.tmp'), { recursive: true });
const root = await mkdtemp(resolve('.tmp/terminal-follow-'));
const listen = server => new Promise(done => server.listen(0, '127.0.0.1', () => done(server.address().port)));
const reserve = createServer(), port = await listen(reserve);
await new Promise(done => reserve.close(done));
const native = `http://127.0.0.1:${port}`, config = join(root, 'config.toml');
await writeFile(config, `owner = "fixture"\nlisten = "127.0.0.1:${port}"\nworkspace = ${JSON.stringify(root)}\n[limits]\nmin_free_bytes = 0\n[paths]\ndatabase = ${JSON.stringify(join(root, 'test.sqlite3'))}\nartifacts = ${JSON.stringify(join(root, 'artifacts'))}\nattachments = ${JSON.stringify(join(root, 'attachments'))}\n`);
const launch = () => spawn(process.env.TEST_DAEMON, [], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, HOME: root, SHELL: '/bin/bash', CODEX_HOME: join(root, 'codex'), OXROUTE_CONFIG: config, OXROUTE_CODEX_URL: 'ws://127.0.0.1:9', OXROUTE_CODEX_CLI: '/bin/false' } });
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
  let ready = false;
  for (let i = 0; i < 100; i++) { try { ready = (await fetch(native + '/api/health')).ok; } catch {} if (ready) break; await new Promise(done => setTimeout(done, 100)); }
  assert.ok(ready); assert.ok((await api('/api/state')).artifactRoot.includes('/.tmp/'));
  const agent = await api('/api/agents', {});
  await api('/api/rename', { agent: agent.id, name: 'Shared shell session' });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(`${base}/?agent=${agent.id}`);
  await page.getByLabel('Choose visible agents', { exact: true }).click();
  await page.getByRole('button', { name: 'New follow terminal', exact: true }).click();
  await page.locator('[data-terminal-pane]').waitFor();
  const [terminal] = await api('/api/terminals');
  const pane = page.locator(`[data-terminal-pane="${terminal.id}"]`);
  assert.equal(terminal.following, true);
  assert.equal(terminal.followAgentId, agent.id);
  assert.deepEqual(terminal.granted, [agent.id]);
  const target = `/api/terminals/${terminal.id}`;
  const toggle = pane.getByRole('button', { name: 'Follow agent', exact: true });
  await toggle.waitFor();
  const editor = pane.locator('.xterm:visible .xterm-helper-textarea');
  const history = async () => (await api(`${target}/history`)).text;
  const until = async check => {
    for (let i = 0; i < 150; i++) { if (await check()) return; await new Promise(done => setTimeout(done, 50)); }
    assert.fail('Runtime condition did not settle');
  };
  const execute = async command => {
    const response = await api(`${target}/execute`, { agentId: agent.id, command });
    let result;
    try { await until(async () => { result = await api(target); return result.execution?.id === response.id && !result.execution.running; }); } catch (error) { console.error(JSON.stringify({ execution: result?.execution, screen: await history() })); throw error; }
    return result.execution;
  };
  // Wait for the initial shell prompt and UI adoption, without sending setup into the shell.
  await until(async () => (await history()).includes('$'));
  await editor.focus();
  const draft = 'printf "draft:%s:%s\\n" "$shared_value" "${PWD##*/}"';
  await page.keyboard.type(draft);
  await until(async () => (await history()).includes(draft));
  const first = await execute(`shared_value='retained'; mkdir -p 'shell work'; cd 'shell work'; sleep 60 & shared_job=$!`);
  assert.equal(first.exitCode, 0);
  assert.equal(first.cwd, join(root, 'shell work'));
  assert.equal((await execute('[[ $shared_value == retained ]] && kill -0 "$shared_job" && printf "agent:%s\\n" "$shared_value"')).exitCode, 0);
  await editor.focus(); await page.keyboard.press('Enter');
  await until(async () => (await history()).includes('draft:retained:shell work'));
  assert.equal((await execute('false')).exitCode, 1, 'Exit codes come from the shared process');
  assert.equal((await execute('[[ $? == 1 ]]')).exitCode, 0, 'The next command sees the previous shell exit status');
  assert.equal((await execute('for sample in first second; do\n printf \"%s\\n\" \"$sample\"\ndone')).exitCode, 0, 'Multiline shell syntax uses normal Bash parsing');
  const running = await api(`${target}/execute`, { agentId: agent.id, command: 'sleep 1; printf "finished-agent\\n"' });
  await editor.focus(); await page.keyboard.type('x');
  await pane.getByRole('alert').filter({ hasText: 'Agent command has priority' }).waitFor();
  await until(async () => { const result = await api(target); return result.execution?.id === running.id && !result.execution.running; });
  await toggle.click();
  await until(async () => !(await api('/api/terminals'))[0].following);
  await editor.focus(); await page.keyboard.type('printf "human-first\\n"');
  // This is scheduling arbitration in a disposable shell, not an access probe.
  const busy = await fetch(native + `${target}/execute`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: agent.id, command: 'printf agent-waits' }) });
  assert.equal(busy.ok, false);
  assert.ok((await busy.text()).includes('User input has priority'));
  await page.keyboard.press('Enter');
  await until(async () => (await history()).split('\n').some(line => line.trim() === 'human-first'));
  await toggle.click();
  await until(async () => (await api('/api/terminals'))[0].following);
  // Taking control in normal mode can interrupt a command and leave the shell reusable.
  const interrupted = await api(`${target}/execute`, { agentId: agent.id, command: 'sleep 60; shared_value=overwritten' });
  const { execFileSync } = await import('node:child_process');
  await until(async () => execFileSync('tmux', ['-L', `oxroute-terminals-127.0.0.1_${port}`, 'display-message', '-p', '-t', terminal.id, '#{pane_current_command}']).toString().trim() === 'sleep');
  await toggle.click();
  await until(async () => !(await api('/api/terminals'))[0].following);
  await editor.focus(); await page.keyboard.press('Control+c');
  let stopped;
  await until(async () => { stopped = (await api(target)).execution; return stopped.id === interrupted.id && !stopped.running; });
  assert.ok(stopped.interrupted || stopped.exitCode === 130, JSON.stringify(stopped));
  await toggle.click();
  await until(async () => (await api('/api/terminals'))[0].following);
  // Changing priority preserves the shell process, its state, and the execution endpoint.
  assert.equal((await execute('priority_shell=$BASHPID')).exitCode, 0);
  const route = `${target}/execute`;
  await page.waitForTimeout(2100); // Let the opted-in shell's user-input lease expire after Ctrl-C.
  for (const following of [false, true, false, true]) {
    await toggle.click();
    await until(async () => (await api('/api/terminals')).find(item => item.id === terminal.id).following === following);
    const info = (await api('/api/terminals')).find(item => item.id === terminal.id);
    assert.equal(info.sharedShell, true);
    assert.equal(info.followAgentId, agent.id);
    assert.deepEqual(info.granted, [agent.id]);
    const response = await api(route, { agentId: agent.id, command: '[[ $BASHPID == "$priority_shell" && $shared_value == retained ]] && kill -0 "$shared_job"' });
    let result;
    await until(async () => { result = (await api(target)).execution; return result.id === response.id && !result.running; });
    assert.equal(result.exitCode, 0);
    assert.equal(result.cwd, first.cwd);
  }
  // The tmux shell and command record survive losing their daemon attachment.
  daemon.kill('SIGTERM'); await new Promise(done => daemon.once('exit', done));
  daemon = launch();
  await until(async () => { try { return (await fetch(native + '/api/health')).ok; } catch { return false; } });
  assert.equal((await execute('[[ $shared_value == retained ]] && kill -0 "$shared_job" && kill "$shared_job" && printf "shared-shell-ready\\n"')).exitCode, 0);

  await until(async () => pane.locator('.xterm-rows > div').evaluateAll(lines => lines.some(line => line.textContent.trim() === 'shared-shell-ready')));
  await pane.getByRole('alert').waitFor({ state: 'hidden' });
  await page.getByRole('status').waitFor({ state: 'hidden' });
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  // Ordinary terminals keep their original shell and remain independently writable.
  const normal = (await api('/api/terminals', { agentId: agent.id })).terminal;
  assert.equal(normal.sharedShell, false);
  assert.equal(normal.following, false);
  const ordinary = page.locator(`[data-terminal-pane="${normal.id}"]`);
  await ordinary.waitFor();
  await ordinary.getByRole('button', { name: 'Revoke', exact: true }).waitFor();
  const ordinaryEditor = ordinary.locator('.xterm:visible .xterm-helper-textarea');
  await ordinaryEditor.focus();
  await page.keyboard.type('printf "ordinary-user-ready\\n"');
  const ownerInput = page.waitForResponse(response => new URL(response.url()).pathname === `/api/terminals/${normal.id}/input`
    && response.request().method() === 'POST' && response.request().postDataJSON().data.includes('\r'));
  await page.keyboard.press('Enter');
  assert.ok((await ownerInput).ok());
  const immediate = performance.now();
  await api(`/api/terminals/${normal.id}/input`, { agentId: agent.id, data: 'printf "ordinary-shell-ready\\n"\r' });
  assert.ok(performance.now() - immediate < 2000, 'Ordinary granted input succeeds without a user-idle delay');
  await until(async () => (await api(`/api/terminals/${normal.id}/history`)).text.split('\n').some(line => line.trim() === 'ordinary-shell-ready'));
  await until(async () => (await api(`/api/terminals/${normal.id}/history`)).text.split('\n').some(line => line.trim() === 'ordinary-user-ready'));
  const ended = await execute('exit 7');
  assert.equal(ended.disconnected, true, 'Shell termination does not leave an execution running forever');
  assert.equal(ended.exitCode, null, 'A lost shell is not reported as successful execution');
  await pane.getByRole('button', { name: 'Revoke', exact: true }).click();
  await until(async () => { const info = (await api('/api/terminals')).find(item => item.id === terminal.id); return !info.following && !info.granted.length; });
  page.once('dialog', dialog => dialog.accept());
  await pane.getByRole('button', { name: 'End terminal session', exact: true }).click();
  await until(async () => !(await api('/api/terminals')).some(item => item.id === terminal.id));
  await assert.rejects(access(join(root, 'terminal-shells', terminal.id)), { code: 'ENOENT' });
  assert.deepEqual(errors, []);
  console.log('Real Bash: shared cwd, unexported variables, jobs, preserved user draft, exit codes, agent/user priority, interrupt recovery, daemon reattachment, revocation, ordinary terminals and browser follow controls pass.');

} finally {
  await browser.close(); proxy.closeAllConnections(); await new Promise(done => proxy.close(done));
  daemon.kill('SIGTERM'); if (daemon.exitCode === null) await new Promise(done => daemon.once('exit', done));
  const { execFileSync } = await import('node:child_process');
  try { execFileSync('tmux', ['-L', `oxroute-terminals-127.0.0.1_${port}`, 'kill-server'], { stdio: 'ignore' }); } catch {}
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
