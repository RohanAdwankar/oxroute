import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const agent = { id: 'responsive-pins', name: 'Pin responsiveness', backend: 'codex', status: 'working', updatedAt: 1 };
  await page.addInitScript(() => {
    window.SharedWorker = undefined;
    window.EventSource = class extends EventTarget { close() {} };
    window.storageCompletions = [];
    window.completedWrites = 0;
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = transaction.apply(this, args);
      if (args[1] === 'readwrite') {
        Object.defineProperty(tx, 'oncomplete', { set(handler) {
          tx.addEventListener('complete', event => window.storageCompletions.push(() => { handler(event); window.completedWrites++; }));
        } });
      }
      return tx;
    };
  });
  await page.route('**/api/state', r => r.fulfill({ json: { mode: 'ask', agents: [agent], archived: [], tasks: [], taskNotes: [], inbox: [], paneLinks: {}, tags: {}, boards: [], messages: {}, sources: [], models: [], backends: [] } }));
  await page.route('**/api/terminals', r => r.fulfill({ json: [] }));
  await page.route('**/api/agents/*', r => r.fulfill({ json: { agent, timeline: [], delivery: 'start' } }));
  const deliveries = [];
  await page.route('**/api/say', r => { deliveries.push(r.request().postDataJSON()); return r.fulfill({ json: {} }); });
  await page.goto(`${process.env.TEST_URL}/?agent=${agent.id}`);
  const composer = page.locator('[data-composer]');
  const pins = page.locator('[data-pinned-message]');
  await composer.fill('First direction');
  await composer.press('Enter');
  await pins.waitFor();
  await page.waitForFunction(() => window.storageCompletions.length > 0);
  await composer.press('Enter');
  await pins.waitFor({ state: 'detached', timeout: 1500 });
  assert.equal(deliveries[0].text, 'First direction', 'Explicit send must not wait for storage');
  await composer.fill('Next direction');
  await composer.press('Enter');
  await pins.waitFor();
  await pins.getByRole('button', { name: 'Discard pinned message' }).click();
  await pins.waitFor({ state: 'detached', timeout: 1500 });
  await page.evaluate(() => {
    window.releaseStorage = setInterval(() => window.storageCompletions.splice(0).forEach(done => done()), 10);
  });
  await page.waitForFunction(() => window.completedWrites === 4);
  await page.reload();
  await composer.waitFor();
  assert.equal(await pins.count(), 0, 'Sent and discarded messages stay removed after storage catches up');
  if (process.env.SCREENSHOT) {
    await composer.fill('Ready when you are'); await composer.press('Enter'); await pins.waitFor();
    await page.screenshot({ path: process.env.SCREENSHOT });
  }
  console.log('Explicit send and discard stay responsive during slow storage, with removals preserved after reload.');
} finally { await browser.close(); }
