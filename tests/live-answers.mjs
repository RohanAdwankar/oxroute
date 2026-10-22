import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const agent = { id: 'live-fixture', name: 'Live fixture', backend: 'codex', model: 'fixture', status: 'working', updatedAt: Date.now()/1000 };
const entry = (id, text) => ({ id, agentId: agent.id, kind: 'said', text, at: Date.now()/1000, detail: '', output: '', origin: '' });
const history = [entry(1, 'Earlier context.')];
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 750 } });
  await page.addInitScript(() => { window.SharedWorker = undefined; window.EventSource = class { constructor() { window.testStream = this; } close() {} }; });
  let holdSnapshot = false, snapshotArrived, releaseSnapshot;
  const snapshotWaiting = new Promise(resolve => { snapshotArrived = resolve; });
  const snapshotHeld = new Promise(resolve => { releaseSnapshot = resolve; });
  await page.route('**/api/state', async route => {
    const snapshot = { mode: 'ask', agents: [{ ...agent, name: holdSnapshot ? 'Snapshot fetched' : agent.name }], archived: [], messages: { [agent.id]: history.at(-1).text }, tasks: [], taskNotes: [], inbox: [], paneLinks: {}, quoteThreads: [], tags: {}, boards: [], sources: [], models: [], backends: [] };
    if (holdSnapshot) { snapshotArrived(); await snapshotHeld; }
    return route.fulfill({ json: snapshot });
  });
  await page.route('**/api/terminals', route => route.fulfill({ json: [] }));
  let hold = false, arrived, release;
  const waiting = new Promise(resolve => { arrived = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/agents/*', async route => {
    const timeline = [...history];
    if (hold) { arrived(); await held; }
    return route.fulfill({ json: { agent: { ...agent, name: hold ? 'History fetched' : agent.name }, timeline, delivery: 'start' } });
  });
  const emit = event => page.evaluate(event => window.testStream.onmessage({ data: JSON.stringify(event) }), event);
  await page.goto(`${process.env.TEST_URL ?? 'http://127.0.0.1:3942'}/?agent=${agent.id}`);
  await page.locator('[data-entry="1"]').waitFor();
  hold = true; holdSnapshot = true;
  await emit({ type: 'sync' });
  await Promise.all([waiting, snapshotWaiting]);
  history[0] = { ...history[0], text: 'Earlier context updated live.' };
  await emit({ type: 'timeline', entry: history[0] });
  const answer = entry(2, 'The answer is ready now.');
  history.push(answer);
  const started = performance.now();
  await emit({ type: 'timeline', entry: answer });
  await page.locator('[data-entry="2"]').waitFor({ timeout: 1000 });
  console.log(`Live answer rendered in ${Math.round(performance.now()-started)} ms while the older history response stayed pending.`);
  release(); releaseSnapshot();
  await page.getByText('History fetched', { exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Snapshot fetched', exact: true }).waitFor();
  const retained = await page.locator('[data-entry="2"]').count() === 1 && (await page.locator('[data-entry="1"]').innerText()).includes(history[0].text);
  hold = false; holdSnapshot = false;
  await page.getByRole('button', { name: 'Show the fleet', exact: true }).click();
  const previewRetained = await page.getByText(answer.text, { exact: true }).count() === 1;
  await page.getByRole('button', { name: 'Snapshot fetched', exact: true }).click();
  await page.locator('[data-entry="2"]').waitFor();
  history.push(entry(3, 'An answer received while the tab was away.'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const refreshed = await page.locator('[data-entry="3"]').waitFor({ timeout: 2000 }).then(() => true, () => false);
  console.log(JSON.stringify({ retained, previewRetained, refreshed }));
  assert.deepEqual({ retained, previewRetained, refreshed }, { retained: true, previewRetained: true, refreshed: true }, 'New answers survive delayed reads and reconcile when the window regains focus');
  history.push(entry(4, 'An answer recovered when the tab becomes visible.'));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.locator('[data-entry="4"]').waitFor({ timeout: 2000 });
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  console.log('Live answers survive stale history responses; returning to the web UI immediately reconciles missed answers.');
} finally { for (const context of browser.contexts()) for (const page of context.pages()) await page.unrouteAll({ behavior: 'ignoreErrors' }); await browser.close(); }
