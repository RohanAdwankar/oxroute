import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const agent = { id: 'toolbar-scale', name: 'Toolbar scale', cwd: '/workspace', backend: 'codex', model: 'fixture', status: 'complete', updatedAt: 1 };
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 4 });
  await page.route('**/api/state', r => r.fulfill({ json: { mode: 'ask', agents: [agent], archived: [], messages: {}, tasks: [], taskNotes: [], inbox: [], paneLinks: {}, tags: {}, boards: [], sources: [], models: [], backends: [] } }));
  await page.route('**/api/events', r => r.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' }));
  await page.route('**/api/agents/*', r => r.fulfill({ json: { agent, timeline: [{ id: 1, agentId: agent.id, kind: 'said', text: 'Toolbar follows the conversation header.', detail: '', at: 1 }], delivery: 'start' } }));
  await page.goto((process.env.TEST_URL ?? 'http://localhost:3941') + '/?agent=' + agent.id);
  const pane = page.locator('[data-agent-pane]');
  await pane.locator('[data-composer]').fill('Keep this draft.');
  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  await settings.click();
  const dialog = page.getByRole('dialog', { name: 'settings' });
  const scaling = dialog.locator('section').filter({ has: page.getByText('Scale panes with width', { exact: true }) });
  await scaling.getByRole('button').nth(1).click();
  await dialog.getByRole('spinbutton', { name: 'Minimum pane scale' }).fill('50');
  await page.keyboard.press('Escape');
  const inspect = async () => {
    await page.waitForTimeout(100);
    return {
      toolbar: (await settings.boundingBox()).height,
      header: (await pane.locator('[data-pane-header]').boundingBox()).height,
      icon: (await settings.locator('svg').boundingBox()).height,
      scale: await pane.locator('[data-agent-panel]').evaluate(node => Number(getComputedStyle(node).zoom)),
    };
  };
  const wide = await inspect();
  assert.equal(wide.scale, 1);
  await page.setViewportSize({ width: 400, height: 800 });
  const narrow = await inspect();
  assert.equal(narrow.scale, 0.5, 'Narrow/zoomed viewport uses the configured pane scale');
  assert.ok(Math.abs(narrow.toolbar - narrow.header) <= 1, 'Toolbar controls match pane header height');
  assert.ok(Math.abs(narrow.icon - wide.icon * narrow.scale) < 0.5, 'Global icons scale with pane text');
  assert.equal(await pane.locator('[data-composer]').inputValue(), 'Keep this draft.');
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT, clip: { x: 0, y: 0, width: 400, height: 200 } });
  await settings.click();
  await scaling.getByRole('button').nth(0).click();
  await page.keyboard.press('Escape');
  const unscaled = await inspect();
  assert.ok(Math.abs(unscaled.toolbar - unscaled.header) <= 1, 'Disabling adaptive scaling restores both bars together');
  await settings.click();
  await scaling.getByRole('button').nth(1).click();
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1100, height: 800 });
  const expanded = await inspect();
  assert.ok(Math.abs(expanded.toolbar - wide.toolbar) < 0.5, 'Wide panes restore normal toolbar size');
  console.log('Toolbar and icons follow pane scaling, retain settings access and restore together.');
} finally { await browser.close(); }
