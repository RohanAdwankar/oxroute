import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const agents = ['alpha', 'bravo'].map(id => ({ id, name: id, status: 'complete', backend: 'codex', model: 'fixture', updatedAt: 1 }));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 650 }, deviceScaleFactor: 1 });
  await page.route('**/api/state', r => r.fulfill({ json: { mode: 'ask', agents, archived: [], messages: {}, tasks: [], taskNotes: [], inbox: [], paneLinks: {}, tags: {}, boards: [], sources: [], models: [], backends: [] } }));
  await page.route('**/api/events', r => r.fulfill({ contentType: 'text/event-stream', body: ': test\n\n' }));
  await page.route('**/api/terminals', r => r.fulfill({ json: [] }));
  await page.route('**/api/agents/*', r => {
    const agent = agents.find(a => r.request().url().endsWith('/' + a.id));
    return r.fulfill({ json: { agent, delivery: 'start', timeline: [
      { id: 1, kind: 'you', text: 'A highlighted message should meet the pane edge cleanly.', at: 1 },
      { id: 2, kind: 'said', text: 'A plain message.\n\n```text\nA code highlight\n```', at: 2 },
      { id: 3, kind: 'you', text: 'Another highlighted message.', at: 3 }
    ].map(entry => ({ ...entry, agentId: agent.id, detail: '', output: '', origin: '', reaction: '' })) } });
  });
  await page.goto(`${process.env.TEST_URL ?? 'http://127.0.0.1:3941'}/?agent=alpha`);
  const pane = page.locator('[data-agent-pane="alpha"]');
  await pane.locator('[data-entry="1"]').waitFor();
  await page.getByLabel('Choose visible agents').click();
  await page.getByRole('checkbox', { name: 'bravo', exact: true }).check();
  await page.getByLabel('Choose visible agents').click();
  await pane.locator('[data-composer]').focus();
  const screenshot = await page.screenshot(process.env.SCREENSHOT ? { path: process.env.SCREENSHOT } : {});
  const box = await pane.boundingBox();
  const next = await page.locator('[data-agent-pane="bravo"]').boundingBox();
  assert.equal(box.x + box.width, next.x, 'Panes stay flush');
  const ys = await pane.locator('[data-entry]').evaluateAll(nodes => nodes.map(n => { const b = n.getBoundingClientRect(); return Math.floor(b.y + b.height / 2); }));
  const colors = await page.evaluate(async ({ image, x, ys }) => {
    const img = new Image(); img.src = image; await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
    const actual = ys.map(y => [...ctx.getImageData(x, y, 1, 1).data]);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--color-edge').trim();
    ctx.fillRect(0, 0, 1, 1);
    return { actual, expected: [...ctx.getImageData(0, 0, 1, 1).data] };
  }, { image: `data:image/png;base64,${screenshot.toString('base64')}`, x: Math.floor(box.x + box.width) - 1, ys });
  for (const color of colors.actual) assert.deepEqual(color, colors.expected, 'Highlighted and plain rows keep the same continuous edge');
  console.log('Highlighted messages and code render in adjacent flush panes.');
} finally { await browser.close(); }
