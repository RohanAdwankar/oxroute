import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const agent = { id: 'scale-fixture', name: 'Scale fixture', cwd: '/workspace', backend: 'codex', model: 'test', status: 'complete', updatedAt: Date.now()/1000 };
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 750 } });
  await page.route('**/api/state', r => r.fulfill({ json: { mode: 'ask', agents: [agent], archived: [], messages: {}, tasks: [], taskNotes: [], inbox: [], paneLinks: {}, tags: {}, boards: [], sources: [], models: [], backends: [] } }));
  await page.route('**/api/events', r => r.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' }));
  await page.route('**/api/agents/*', r => r.fulfill({ json: { agent, timeline: [{ id: 1, agentId: agent.id, kind: 'said', text: 'The conversation, composer and controls scale together as the pane gets smaller.', detail: '', at: 1 }], delivery: 'start' } }));
  const open = () => page.goto(`${process.env.TEST_URL ?? 'http://localhost:3941'}/?agent=${agent.id}`);
  await open();
  const pane = page.locator('[data-agent-pane]');
  const panel = pane.locator('[data-agent-panel]');
  const composer = pane.locator('[data-composer]');
  await composer.waitFor();
  const width = async size => { await pane.evaluate((el, size) => { el.style.maxWidth = `${size}px`; }, size); await page.waitForTimeout(100); };
  const choose = async on => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const choice = page.getByRole('dialog').locator('section').filter({ has: page.getByText('Scale panes with width', { exact: true }) });
    await choice.getByRole('button').nth(on ? 1 : 0).click();
    await page.keyboard.press('Escape');
  };
  await width(640);
  const normalHeight = (await composer.boundingBox()).height;
  await composer.fill('Keep this draft while resizing.');
  await choose(true);
  assert.ok((await composer.boundingBox()).height < normalHeight);
  const middle = parseFloat(await panel.evaluate(el => getComputedStyle(el).zoom));
  assert.ok(middle > 0.7 && middle < 1);
  await pane.locator('[data-entry]').click({ button: 'right' });
  await page.getByRole('button', { name: 'quote reply', exact: true }).click();
  assert.ok((await composer.inputValue()).includes('The conversation, composer and controls'));
  await composer.fill('Keep this draft while resizing.');
  await width(280);
  assert.ok(parseFloat(await panel.evaluate(el => getComputedStyle(el).zoom)) < middle);
  assert.equal(await composer.inputValue(), 'Keep this draft while resizing.');
  assert.ok(await panel.evaluate(el => Math.abs(el.getBoundingClientRect().width - el.parentElement.getBoundingClientRect().width) < 2));
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  await open();
  await width(640);
  assert.ok((await composer.boundingBox()).height < normalHeight, 'Preference survives reload');
  await width(1000);
  assert.equal(parseFloat(await panel.evaluate(el => getComputedStyle(el).zoom)), 1);
  await choose(false);
  await width(640);
  assert.equal((await composer.boundingBox()).height, normalHeight);
  console.log('Adaptive pane sizing, minimum size, drafts, fit, persistence and opt-out pass.');
} finally { await browser.close(); }
