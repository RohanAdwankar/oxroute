import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const agent = { id: 'upload-test', name: 'Upload test', backend: 'codex', model: 'test', status: 'complete', updatedAt: Date.now()/1000 };
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  await page.route('**/api/state', r => r.fulfill({ json: {
    mode: 'ask', agents: [agent], archived: [], messages: {}, tasks: [], taskNotes: [], inbox: [],
    paneLinks: {}, tags: {}, boards: [], sources: [], models: [], backends: [],
  } }));
  await page.route('**/api/events', r => r.fulfill({ contentType: 'text/event-stream', body: ': test\n\n' }));
  await page.route('**/api/agents/*', r => r.fulfill({ json: { agent, timeline: [], delivery: 'start' } }));
  let submitted;
  await page.route('**/api/say-attachments', r => {
    submitted = r.request().postDataBuffer().toString();
    return r.fulfill({ json: { ok: true } });
  });
  await page.goto(`${process.env.TEST_URL ?? 'http://localhost:3941'}/?agent=${agent.id}`);
  const files = ['report.pdf', 'data.csv', 'archive.zip', 'unknown'].map(name => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from('file payload') }));
  const picker = page.locator('input[type=file]').first();
  assert.equal(await picker.getAttribute('accept'), null);
  await picker.setInputFiles(files);
  await page.getByRole('button', { name: 'remove report.pdf' }).waitFor();
  await picker.evaluate(input => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['drop payload'], 'dropped.txt', { type: 'text/plain' }));
    input.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await page.getByRole('button', { name: 'remove dropped.txt' }).waitFor();
  assert.equal(await page.locator('[data-uploads] img').count(), 0);
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  const sent = page.waitForResponse(response => response.url().endsWith('/api/say-attachments'));
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await sent;
  for (const file of files) assert.ok(submitted?.includes(`filename="${file.name}"`));
  assert.ok(submitted.includes('filename="dropped.txt"'));
  console.log('General file selection, attachment chips, and multipart submission passed. No agent or Slack requests sent.');
} finally { await browser.close(); }
