import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright';

const repository = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'oxroute-upload-'));
await symlink(join(repository, 'node_modules'), join(directory, 'node_modules'));
for (const name of ['app', 'public']) await cp(join(repository, name), join(directory, name), { recursive: true });
for (const name of ['next.config.ts', 'tsconfig.json', 'package.json', 'package-lock.json', 'postcss.config.mjs']) await cp(join(repository, name), join(directory, name));
const bytes = Buffer.alloc(100 * 1024 * 1024);
for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
const expected = createHash('sha256').update(bytes).digest('hex');
const file = join(directory, 'large.bin');
await writeFile(file, bytes);
let received;
const uploaded = new Promise(resolve => { received = resolve; });
const daemon = createServer(async (request, response) => {
  try {
    assert.equal(request.url, '/api/say-attachments');
    const form = await new Request(`http://localhost${request.url}`, {
      method: request.method, headers: request.headers, body: request, duplex: 'half',
    }).formData();
    const attachment = form.get('files');
    assert.equal(attachment.name, 'large.bin');
    assert.equal(attachment.size, bytes.length);
    assert.equal(createHash('sha256').update(Buffer.from(await attachment.arrayBuffer())).digest('hex'), expected);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
    received();
  } catch (error) {
    response.writeHead(500); response.end(String(error));
    received(error);
  }
});
await new Promise(resolve => daemon.listen(0, '127.0.0.1', resolve));
const reserve = createServer();
await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const web = spawn(process.execPath, [join(repository, 'node_modules/next/dist/bin/next'), 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(port)], {
  cwd: directory,
  env: { ...process.env, OXROUTE_DAEMON: `http://127.0.0.1:${daemon.address().port}`, OXROUTE_DIST: '.next' },
  detached: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
web.stdout.on('data', data => { log += data; });
web.stderr.on('data', data => { log += data; });
let browser;
try {
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90000;
  while (true) {
    try { if ((await fetch(base, { signal: AbortSignal.timeout(10000) })).ok) break; } catch {}
    if (Date.now() > deadline || web.exitCode !== null) throw new Error(`Web startup failed: ${log}`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 750 } });
  const agent = { id: 'upload-fixture', name: 'Upload fixture', backend: 'codex', model: 'fixture', status: 'complete', updatedAt: Date.now()/1000 };
  await page.addInitScript(() => { window.SharedWorker = undefined; window.EventSource = class extends EventTarget { close() {} }; });
  await page.route('**/api/state', route => route.fulfill({ json: { mode: 'ask', agents: [agent], archived: [], messages: {}, tasks: [], taskNotes: [], inbox: [], paneLinks: {}, quoteThreads: [], tags: {}, boards: [], sources: [], models: [], backends: [] } }));
  await page.route('**/api/terminals', route => route.fulfill({ json: [] }));
  await page.route('**/api/agents/*', route => route.fulfill({ json: { agent, timeline: [], delivery: 'start' } }));
  await page.goto(`${base}/?agent=${agent.id}`);
  await page.locator('input[type=file]').first().setInputFiles(file);
  await page.locator('[data-uploads]').getByText('large.bin', { exact: true }).waitFor();
  if (process.env.SCREENSHOT) {
    await page.addStyleTag({ content: 'nextjs-portal { display: none; }' });
    await page.screenshot({ path: process.env.SCREENSHOT });
  }
  await page.locator('[data-composer]').fill('Attached file.');
  const [response] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/say-attachments'), { timeout: 120000 }),
    page.getByRole('button', { name: 'Send message', exact: true }).click(),
  ]);
  assert.equal(response.status(), 200);
  assert.equal(await uploaded, undefined);
  console.log('A 100 MiB file passes from the composer through the actual Next rewrite with its filename, size and SHA-256 unchanged.');
} catch (error) {
  console.error(log);
  throw error;
} finally {
  await browser?.close();
  if (web.exitCode === null) {
    process.kill(-web.pid, 'SIGTERM');
    await once(web, 'exit');
  }
  daemon.closeAllConnections();
  await new Promise(resolve => daemon.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
