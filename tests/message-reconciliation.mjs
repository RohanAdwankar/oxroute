import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const url = process.env.TEST_URL ?? 'http://localhost:3943';
const agent = { id: 'upload-fixture', name: 'Upload fixture', status: 'complete', backend: 'codex', model: 'fixture', updatedAt: Date.now()/1000 };
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.addInitScript(() => { window.EventSource = class { constructor() { window.testStream = this; } close() {} }; });
  const entries = [];
  await page.route('**/api/state', r => r.fulfill({ json: { mode: 'ask', agents: [agent], archived: [], messages: {}, tasks: [], taskNotes: [], inbox: [], paneLinks: {}, tags: {}, boards: [], sources: [], models: [], backends: [] } }));
  await page.route('**/api/agents/*', r => r.fulfill({ json: { agent, timeline: entries, delivery: 'start' } }));
  await page.route('**/api/terminals', r => r.fulfill({ json: [] }));
  let saved;
  const savedPromise = new Promise(resolve => saved = resolve);
  await page.route('**/api/say-attachments', async r => {
    const request = r.request();
    const form = await new Request(request.url(), { method: 'POST', headers: request.headers(), body: request.postDataBuffer() }).formData();
    const entry = { id: 1, agentId: agent.id, kind: 'you', at: Date.now()/1000, text: `${form.get('text')}\n\nAttached: stored_${crypto.randomUUID()}.svg`, detail: '', output: '', origin: '', reaction: '', requestId: form.get('requestId') ?? '' };
    entries.push(entry);
    await page.evaluate(entry => window.testStream.onmessage({ data: JSON.stringify({ type: 'timeline', entry }) }), entry);
    await page.waitForTimeout(200);
    saved();
    await page.waitForTimeout(500);
    await r.fulfill({ json: { ok: true } });
  });
  await page.goto(`${url}/?agent=${agent.id}`);
  const text = `Attachment ${crypto.randomUUID()}`;
  await page.locator('[data-composer]').fill(text);
  await page.locator('input[type=file]').first().setInputFiles({ name: 'drawing.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16"/></svg>') });
  await page.locator('[data-composer]').press('Enter');
  await savedPromise;
  assert.equal(await page.locator('[data-transcript] [data-entry]').filter({ hasText: text }).count(), 1, 'Saved upload replaces its local preview before HTTP acknowledgement despite renamed files');
  await page.waitForTimeout(600);
  assert.equal(await page.locator('[data-transcript] [data-entry]').filter({ hasText: text }).count(), 1);
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  console.log('Uploaded message replaces its optimistic preview exactly once.');
} finally { for (const context of browser.contexts()) for (const page of context.pages()) await page.unrouteAll({ behavior: 'ignoreErrors' }); await browser.close(); }
