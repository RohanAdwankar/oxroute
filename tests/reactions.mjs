import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const agent = { id: 'reaction-fixture', name: 'Reaction fixture', backend: 'codex', model: 'fixture', status: 'complete', updatedAt: Date.now()/1000 };
const history = Array.from({ length: 80 }, (_, i) => ({ id: i + 1, agentId: agent.id, kind: 'said', text: `Message ${i + 1}\n\n${'Some context to review. '.repeat(20)}\n\n\`\`\`js\nconst value = ${i};\n\`\`\``, at: Date.now()/1000, detail: '', output: '', origin: '', reaction: '' }));
history.at(-1).text = 'Latest answer';
const browser = await chromium.launch();
let release, releaseHistory;
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 750 } });
  await page.addInitScript(() => { window.SharedWorker = undefined; window.EventSource = class extends EventTarget { constructor() { super(); window.testStream = this; } close() {} }; });
  const emit = event => page.evaluate(event => window.testStream.onmessage({ data: JSON.stringify(event) }), event);
  let reads = 0, holdHistory = false, historyArrived;
  await page.route('**/api/state', route => { reads++; return route.fulfill({ json: { mode: 'ask', agents: [agent], archived: [], messages: { [agent.id]: 'Latest answer' }, tasks: [], taskNotes: [], inbox: [], paneLinks: {}, tags: {}, boards: [], sources: [], models: [], backends: [] } }); });
  await page.route('**/api/terminals', route => route.fulfill({ json: [] }));
  await page.route('**/api/agents/*', async route => {
    reads++;
    const view = { agent, timeline: structuredClone(history), delivery: 'start' };
    if (holdHistory) { historyArrived(); await new Promise(resolve => { releaseHistory = resolve; }); }
    return route.fulfill({ json: view });
  });
  let fail = false, arrived;
  await page.route('**/api/react', async route => {
    arrived();
    await new Promise(resolve => { release = resolve; });
    if (fail) return route.fulfill({ status: 500, json: { error: 'Reaction could not be saved' } });
    const body = route.request().postDataJSON();
    const entry = history.find(entry => entry.id === body.entry);
    entry.reaction = body.reaction;
    await emit({ type: 'reaction', agentId: agent.id, entryId: entry.id, reaction: entry.reaction });
    await route.fulfill({ status: 204 });
  });
  await page.goto(`${process.env.TEST_URL ?? 'http://127.0.0.1:3942'}/?agent=${agent.id}`);
  const row = page.locator('[data-entry="79"]');
  await row.waitFor();
  await page.waitForTimeout(100);
  const before = reads;
  const composer = page.locator('[data-composer]');
  await composer.fill('Keep writing while the reaction saves');
  for (const [choice, expected] of [['Thumbs up', 'true'], ['Thumbs down', 'true'], ['Thumbs down', 'false']]) {
    const pending = new Promise(resolve => { arrived = resolve; });
    await row.click({ button: 'right' });
    await page.getByRole('button', { name: choice, exact: true }).click();
    await pending;
    assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isEnabled(), true, 'A pending reaction must not lock the composer');
    const saved = page.waitForResponse('**/api/react');
    const start = performance.now();
    release();
    await saved;
    await row.click({ button: 'right' });
    await page.waitForFunction(({ choice, expected }) => document.querySelector(`[aria-label="${choice}"]`)?.getAttribute('aria-pressed') === expected, { choice, expected }, { timeout: 1000 });
    await page.keyboard.press('Escape');
    console.log(`${choice} ${expected === 'true' ? 'set' : 'cleared'} in ${Math.round(performance.now() - start)} ms after save.`);
  }
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  fail = true;
  const pending = new Promise(resolve => { arrived = resolve; });
  await row.click({ button: 'right' });
  await page.getByRole('button', { name: 'Thumbs up', exact: true }).click();
  await pending; release();
  await page.getByText('Reaction could not be saved', { exact: true }).waitFor();
  await row.click({ button: 'right' });
  assert.equal(await page.getByRole('button', { name: 'Thumbs up', exact: true }).getAttribute('aria-pressed'), 'false');
  await page.keyboard.press('Escape');
  assert.equal(await composer.inputValue(), 'Keep writing while the reaction saves');
  await page.waitForTimeout(100);
  assert.equal(reads, before, 'Reactions must not reload the snapshot or conversation');
  holdHistory = true;
  const historyPending = new Promise(resolve => { historyArrived = resolve; });
  const historyResponse = page.waitForResponse('**/api/agents/*');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await historyPending;
  await emit({ type: 'reaction', agentId: agent.id, entryId: 79, reaction: 'up' });
  releaseHistory(); await historyResponse;
  await row.click({ button: 'right' });
  assert.equal(await page.getByRole('button', { name: 'Thumbs up', exact: true }).getAttribute('aria-pressed'), 'true', 'A stale history response cannot erase a streamed reaction');
  await page.keyboard.press('Escape');
  holdHistory = false;
  await page.getByRole('button', { name: 'Show the fleet', exact: true }).click();
  await page.getByText('Latest answer', { exact: true }).waitFor();
  console.log('Reactions update in place, preserve typing, clear and switch, and surface failures without a global refresh.');
} finally { release?.(); releaseHistory?.(); for (const context of browser.contexts()) for (const page of context.pages()) await page.unrouteAll({ behavior: 'ignoreErrors' }); await browser.close(); }
