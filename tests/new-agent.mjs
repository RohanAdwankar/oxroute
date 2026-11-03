// Run against an explicitly selected disposable daemon and production frontend.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const web = process.env.TEST_URL, api = process.env.TEST_NATIVE_URL;
assert.ok(web && api);
const call = async (path, body) => {
  const response = await fetch(api + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  assert.ok(response.ok, await response.clone().text());
  return response.json();
};
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
let releaseCreation, holdCreation = true, failCreation = false, creates = 0, sends = 0;
try {
  await page.addInitScript(() => { window.SharedWorker = class { port = { postMessage() {}, close() {} }; }; });
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/api/version') return route.continue();
    if (url.pathname === '/api/agents' && request.method() === 'POST') {
      creates++;
      if (holdCreation) await new Promise(resolve => { releaseCreation = resolve; });
      if (failCreation) return route.fulfill({ status: 503, json: { error: 'Temporary creation failure' } });
    }
    if (url.pathname === '/api/say') sends++;
    await route.fulfill({ response: await page.request.fetch(api + url.pathname + url.search, {
      method: request.method(), data: request.postDataBuffer() ?? undefined, headers: { 'content-type': 'application/json' },
    }) });
  });
  await page.goto(web);
  const plus = page.locator('[data-app-header]').getByRole('button', { name: 'New agent', exact: true });
  const burst = () => plus.evaluate(button => { for (let i = 0; i < 12; i++) button.click(); });
  const created = () => page.waitForResponse(response => new URL(response.url()).pathname === '/api/agents' && response.request().method() === 'POST' && response.ok());
  const composer = page.locator('[data-agent-pane] [data-composer]');
  await burst();
  await composer.waitFor({ timeout: 1000 });
  const first = new URL(page.url()).searchParams.get('agent');
  await composer.fill('Compare the available options');
  await burst();
  assert.equal(new URL(page.url()).searchParams.get('agent'), first);
  assert.equal(await composer.inputValue(), 'Compare the available options');
  assert.equal(creates, 1, 'Concurrent and later clicks reuse the unsaved agent');
  assert.equal((await call('/api/state')).agents.some(agent => agent.id === first), false, 'The panel is usable before the daemon receives creation');
  await composer.press('Enter');
  await page.getByText('Compare the available options', { exact: true }).waitFor();
  assert.equal(sends, 0, 'Submission appears immediately and waits for creation internally');
  await composer.fill('Retain this draft');
  if (process.env.ARTIFACT_DIR) await page.screenshot({ path: `${process.env.ARTIFACT_DIR}/instant-agent.png` });
  holdCreation = false;
  await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname === '/api/say' && response.ok()), Promise.resolve().then(() => releaseCreation())]);
  assert.equal(await composer.inputValue(), 'Retain this draft', 'Saving does not remount the composer');
  assert.equal(sends, 1);
  const view = await call(`/api/agents/${first}`);
  assert.equal(view.timeline.filter(entry => entry.kind === 'you' && entry.text === 'Compare the available options').length, 1);
  await call('/api/rename', { agent: first, name: 'A used card' });
  assert.equal((await call('/api/agents', { id: first })).name, 'A used card', 'Retrying creation cannot reset a used card');
  await Promise.all([created(), plus.click()]);
  const second = new URL(page.url()).searchParams.get('agent');
  assert.notEqual(second, first, 'A submitted message allows another blank agent');
  await page.reload();
  await composer.waitFor();
  await burst();
  assert.equal(new URL(page.url()).searchParams.get('agent'), second, 'Reload preserves the blank agent');
  assert.equal(creates, 2);
  await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname === '/api/archive' && response.ok()), page.getByRole('button', { name: 'archive session', exact: true }).click()]);
  await page.locator('[data-agent-pane]').waitFor({ state: 'detached' });
  failCreation = true;
  await plus.click();
  await page.getByText('Temporary creation failure', { exact: true }).waitFor();
  const third = new URL(page.url()).searchParams.get('agent');
  assert.notEqual(third, second, 'An archived blank allows a new card');
  await composer.fill('Keep this message through a retry');
  failCreation = false;
  await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname === '/api/say' && response.ok()), composer.press('Enter')]);
  assert.equal(new URL(page.url()).searchParams.get('agent'), third, 'A failed creation retries the same card when sending');
  assert.ok((await call(`/api/agents/${third}`)).timeline.some(entry => entry.kind === 'you' && entry.text === 'Keep this message through a retry'));
  console.log('Instant agent rendering, typing and submission before persistence; blank reuse, stable composer, idempotency, reload, archive and creation failure recovery passed.');
} finally {
  releaseCreation?.();
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
  await browser.close();
}
