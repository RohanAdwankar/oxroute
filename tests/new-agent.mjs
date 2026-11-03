// Run against an explicitly selected disposable daemon and production frontend.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';

const web = process.env.TEST_URL, api = process.env.TEST_NATIVE_URL, database = process.env.TEST_DATABASE;
assert.ok(web && api && database);
const state = async () => (await fetch(`${api}/api/state`)).json();
const count = async () => (await state()).agents.length;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
try {
  await page.addInitScript(() => { window.SharedWorker = class { port = { postMessage() {}, close() {} }; }; });
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/api/version') return route.continue();
    const response = await page.request.fetch(api + url.pathname + url.search, {
      method: request.method(), data: request.postDataBuffer() ?? undefined, headers: { 'content-type': 'application/json' },
    });
    if (url.pathname === '/api/agents' && request.method() === 'POST') await new Promise(resolve => setTimeout(resolve, 200));
    await route.fulfill({ response });
  });
  await page.goto(web);
  const plus = page.locator('[data-app-header]').getByRole('button', { name: 'New agent', exact: true });
  const burst = () => plus.evaluate(button => { for (let i = 0; i < 12; i++) button.click(); });
  const before = await count();
  await burst();
  await page.locator('[data-agent-pane]').waitFor();
  const first = new URL(page.url()).searchParams.get('agent');
  assert.equal(await count(), before + 1, 'Concurrent clicks create one blank agent');
  const reuse = () => page.waitForResponse(response => new URL(response.url()).pathname === `/api/agents/${first}` && response.ok());
  await Promise.all([reuse(), burst()]);
  assert.equal(await count(), before + 1, 'Later clicks reuse the blank agent');
  await page.reload();
  await page.locator('[data-agent-pane]').waitFor();
  await Promise.all([reuse(), plus.click()]);
  assert.equal(await count(), before + 1, 'Reload preserves the blank agent');
  // Seed an accepted user message without invoking an inference service.
  const seed = spawnSync('uv', ['run', '--no-project', 'python', '-c', `
import sqlite3,sys,time
c=sqlite3.connect(sys.argv[1]); c.execute("INSERT INTO entries(agent_id,at,kind,text) VALUES(?,?,?,?)",(sys.argv[2],time.time(),'you','Investigate the network latency')); c.commit()
`, database, first], { encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr);
  await plus.click();
  await page.waitForURL(url => url.searchParams.has('agent') && url.searchParams.get('agent') !== first);
  const second = new URL(page.url()).searchParams.get('agent');
  assert.equal(await count(), before + 2, 'A message allows another blank agent');
  await page.getByRole('button', { name: 'archive session', exact: true }).click();
  await page.locator('[data-agent-pane]').waitFor({ state: 'detached' });
  await plus.click();
  await page.locator('[data-agent-pane]').waitFor();
  assert.ok((await state()).archived.some(agent => agent.id === second));
  assert.notEqual(new URL(page.url()).searchParams.get('agent'), first);
  assert.notEqual(new URL(page.url()).searchParams.get('agent'), second);
  assert.equal(await count(), before + 2, 'An archived blank is replaced by a new agent');
  if (process.env.ARTIFACT_DIR) await page.screenshot({ path: `${process.env.ARTIFACT_DIR}/reused-blank-agent.png` });
  console.log('New agent clicks coalesce, reuse blanks across reloads, and allow new agents after a message or archive.');
} finally { await page.goto('about:blank'); await page.unrouteAll({ behavior: 'wait' }); await browser.close(); }
