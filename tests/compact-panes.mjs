import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const agent = { id: 'compact-fixture', name: 'Compact fixture', cwd: '/workspace', backend: 'codex', model: 'test', status: 'complete', updatedAt: Date.now()/1000 };
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.route('**/api/state', r => r.fulfill({ json: { mode: 'ask', agents: [agent], archived: [], messages: {}, tasks: [], taskNotes: [], inbox: [], paneLinks: {}, tags: {}, boards: [], sources: [], models: [], backends: [] } }));
  await page.route('**/api/events', r => r.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' }));
  await page.route('**/api/agents/*', r => r.fulfill({ json: { agent, timeline: [{ id: 1, agentId: agent.id, kind: 'said', text: 'A readable conversation in a narrow pane.', detail: '', at: 1 }], delivery: 'start' } }));
  await page.goto(`${process.env.TEST_URL ?? 'http://localhost:3941'}/?agent=${agent.id}`);
  const pane = page.locator('[data-agent-pane]');
  const time = pane.locator('[data-message-time]');
  const transcript = pane.locator('[data-transcript]');
  const composer = pane.locator('[data-composer]');
  await time.waitFor();
  assert.equal(await composer.getAttribute('placeholder'), '');
  const widePadding = await transcript.evaluate(el => parseFloat(getComputedStyle(el).paddingLeft));
  await pane.evaluate(el => { el.style.maxWidth = '240px'; });
  await page.waitForTimeout(100);
  assert.equal(await time.isVisible(), false);
  assert.ok(await transcript.evaluate(el => parseFloat(getComputedStyle(el).paddingLeft)) < widePadding);
  await composer.fill('The draft remains usable.');
  assert.equal(await composer.inputValue(), 'The draft remains usable.');
  assert.ok((await composer.boundingBox()).width > 100);
  assert.ok(await composer.evaluate(el => el.closest('footer').scrollWidth <= el.closest('footer').clientWidth));
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  await pane.evaluate(el => { el.style.maxWidth = ''; });
  await time.waitFor();
  assert.equal(await composer.inputValue(), 'The draft remains usable.');
  console.log('Narrow pane spacing, timestamps, composer fit and wide restoration pass.');
} finally { await browser.close(); }
