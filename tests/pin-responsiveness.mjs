import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { savedPins } from './pin-fixtures.mjs';

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const agent = { id: 'responsive-pins', name: 'Saved messages', backend: 'codex', status: 'working', updatedAt: 1 };
  await page.addInitScript(() => { window.SharedWorker = undefined; window.EventSource = class extends EventTarget { close() {} }; });
  await page.route('**/api/state', r => r.fulfill({ json: { mode: 'ask', agents: [agent], archived: [], tasks: [], taskNotes: [], inbox: [], paneLinks: {}, tags: {}, boards: [], messages: {}, sources: [], models: [], backends: [] } }));
  await page.route('**/api/terminals', r => r.fulfill({ json: [] }));
  await page.route('**/api/agents/*', r => r.fulfill({ json: { agent, timeline: [], delivery: 'start' } }));
  const deliveries = [];
  await page.route('**/api/say', r => { deliveries.push(r.request().postDataJSON()); return r.fulfill({ json: {} }); });
  await page.goto(`${process.env.TEST_URL}/?agent=${agent.id}`);
  await savedPins(page, agent.id, [{ text: 'Saved direction' }, { text: 'Discard saved direction' }]);
  const composer = page.locator('[data-composer]'), pins = page.locator('[data-pinned-message]');
  await pins.first().waitFor();
  await page.evaluate(() => {
    window.storageCompletions = []; window.completedWrites = 0;
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = transaction.apply(this, args);
      if (args[1] === 'readwrite') Object.defineProperty(tx, 'oncomplete', { set(handler) {
        tx.addEventListener('complete', event => window.storageCompletions.push(() => { handler(event); window.completedWrites++; }));
      } });
      return tx;
    };
  });
  await composer.press('Enter');
  await pins.filter({ has: page.getByText('Saved direction', { exact: true }) }).waitFor({ state: 'detached', timeout: 1500 });
  await page.waitForFunction(() => window.storageCompletions.length > 0);
  await pins.getByRole('button', { name: 'Discard pinned message' }).click();
  await pins.waitFor({ state: 'detached', timeout: 1500 });
  await composer.fill('New direction');
  const sent = page.waitForResponse('**/api/say'); await composer.press('Enter'); await sent;
  assert.equal(deliveries.at(-1).text, 'New direction', 'New messages must send without waiting for saved-message storage');
  await page.evaluate(() => { window.releaseStorage = setInterval(() => window.storageCompletions.splice(0).forEach(done => done()), 10); });
  await page.waitForFunction(() => window.completedWrites === 2);
  await page.reload(); await composer.waitFor();
  assert.equal(await pins.count(), 0, 'Sent and discarded saved messages stay removed after storage catches up');
  console.log('Saved-message actions and immediate new sends remain responsive during delayed storage; removals survive reload.');
} finally { await browser.close(); }
