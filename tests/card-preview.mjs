import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const table = ['| Name | Value |', '| --- | --- |', ...Array.from({ length: 20 }, (_, i) => `| Item ${i} | ${i} |`)].join('\n');
const messages = { prose: 'A short message', table, code: '```text\n' + 'output\n'.repeat(20) + '```' };
const agents = Object.keys(messages).map(id => ({
  id, name: id, backend: 'codex', model: 'test', status: 'complete',
  updatedAt: Date.now() / 1000, pinned: false,
}));
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.route('**/api/state', r => r.fulfill({ json: {
    mode: 'ask', agents, archived: [], messages, tasks: [], taskNotes: [], inbox: [],
    paneLinks: {}, tags: {}, boards: [], sources: [], models: [], backends: [],
  } }));
  await page.route('**/api/events', r => r.fulfill({ contentType: 'text/event-stream', body: ': test\n\n' }));
  for (const width of [1280, 500]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(process.env.TEST_URL ?? 'http://localhost:3941');
    await page.locator('article').filter({ has: page.getByRole('button', { name: 'table', exact: true }) }).waitFor();
    const sizes = await page.locator('article').evaluateAll(cards => cards.map(card => ({
      height: card.getBoundingClientRect().height,
      preview: card.querySelector('.message-markdown').parentElement.getBoundingClientRect().height,
    })));
    console.log({ width, sizes });
    assert.ok(sizes.every(size => size.preview <= 61), 'Rich previews fit within three lines');
    assert.ok(Math.max(...sizes.map(s => s.height)) - Math.min(...sizes.map(s => s.height)) <= 1, 'Tables and code do not enlarge cards');
    assert.equal(await page.locator('table tbody tr').count(), 20, 'Table content is preserved');
    if (process.env.SCREENSHOT && width === 1280) await page.screenshot({ path: process.env.SCREENSHOT });
  }
} finally {
  await browser.close();
}
