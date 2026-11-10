import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';

const browser = await (process.env.TEST_BROWSER === 'webkit' ? webkit : chromium).launch(process.env.WEBKIT_EXECUTABLE ? { executablePath: process.env.WEBKIT_EXECUTABLE } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const agent = { id: 'scroll-reader', name: 'Reading', backend: 'codex', status: 'complete', updatedAt: 1 };
  const timeline = Array.from({ length: 60 }, (_, i) => ({ id: i + 1, agentId: agent.id, kind: 'said', text: `Message ${i + 1}`, at: 1, detail: '', output: '' }));
  await page.addInitScript(() => {
    window.SharedWorker = undefined;
    window.EventSource = class extends EventTarget { close() {} };
    window.scrollWrites = 0;
    const scroll = Element.prototype.scrollTo;
    Element.prototype.scrollTo = function (...args) {
      if (this.hasAttribute('data-transcript')) window.scrollWrites++;
      return scroll.apply(this, args);
    };
  });
  await page.route('**/api/state', r => r.fulfill({ json: { mode: 'ask', agents: [agent], archived: [], tasks: [], taskNotes: [], inbox: [], messages: {}, paneLinks: {}, tags: {}, boards: [], sources: [], models: [], backends: [] } }));
  await page.route('**/api/terminals', r => r.fulfill({ json: [] }));
  await page.route('**/api/agents/*', r => r.fulfill({ json: { agent, timeline, delivery: 'start' } }));
  await page.goto(`${process.env.TEST_URL}/?agent=${agent.id}`);
  await page.locator('[data-entry="60"]').waitFor();
  await page.waitForFunction(() => { const t = document.querySelector('[data-transcript]'); return t.scrollHeight - t.clientHeight - t.scrollTop < 1; });
  await page.evaluate(() => window.scrollWrites = 0);
  for (const width of ['99%', '100%', '98%', '100%']) {
    await page.locator('[data-transcript] > div').evaluate((body, width) => body.style.width = width, width);
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  }
  assert.equal(await page.evaluate(() => window.scrollWrites), 0, 'Resizing an already-followed transcript must not issue redundant scroll commands that can disturb visual viewport panning');
  await page.locator('[data-transcript] > div').evaluate(body => body.appendChild(document.createElement('div')).style.height = '200px');
  await page.waitForFunction(() => { const t = document.querySelector('[data-transcript]'); return t.scrollHeight - t.clientHeight - t.scrollTop < 1; });
  assert.ok(await page.evaluate(() => window.scrollWrites > 0), 'Growing content still follows the tail');
  await page.locator('[data-transcript]').evaluate(t => t.scrollTop -= 300);
  await page.waitForTimeout(100);
  const top = await page.locator('[data-transcript]').evaluate(t => t.scrollTop);
  await page.locator('[data-transcript] > div').evaluate(body => body.appendChild(document.createElement('div')).style.height = '200px');
  await page.waitForTimeout(100);
  assert.equal(await page.locator('[data-transcript]').evaluate(t => t.scrollTop), top, 'Reading older messages stays undisturbed');
  console.log('Resize notifications leave an already-followed transcript alone; growing content still follows, and reading older messages stays put.');
} finally { await browser.close(); }
