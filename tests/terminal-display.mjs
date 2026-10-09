import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const terminal = { id: 'terminal_display', name: 'Shared shell', pending: [], granted: [] };
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 750 } });
  const writes = [], reads = [], errors = [];
  page.on('request', r => { if (r.method() !== 'GET') writes.push(r.url()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.route('**/api/state', r => r.fulfill({ json: { mode: 'ask', agents: [], archived: [], messages: {}, tasks: [], taskNotes: [], inbox: [], paneLinks: {}, tags: {}, boards: [], sources: [], models: [], backends: [] } }));
  await page.route('**/api/events', r => r.fulfill({ contentType: 'text/event-stream', body: ': test\n\n' }));
  await page.route('**/api/terminals', r => r.fulfill({ json: [terminal] }));
  const bytes = [...Buffer.from('Shell history survives theme changes.\r\n')];
  await page.route(`**/api/terminals/${terminal.id}?*`, async r => {
    reads.push(r.request().url());
    if (reads.length > 1) await new Promise(resolve => setTimeout(resolve, 2000));
    await r.fulfill({ json: { terminal, bytes: reads.length === 1 ? bytes : [], end: bytes.length, reset: false } }).catch(() => {});
  });
  await page.goto(`${process.env.TEST_URL ?? 'http://127.0.0.1:3941'}/?agent=${terminal.id}`);
  const pane = page.locator('[data-terminal-pane]');
  await pane.locator('.xterm-rows').getByText('Shell history survives theme changes.').waitFor();
  const foreground = () => pane.locator('.xterm-rows > div').first().evaluate(node => getComputedStyle(node).color);
  const setTheme = async index => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'settings' });
    await dialog.locator('section').filter({ has: page.getByText('Look', { exact: true }) }).getByRole('button').nth(index).click();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
  };
  await setTheme(0);
  const light = await foreground();
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/terminal-light.png` });
  await setTheme(1);
  assert.notEqual(await foreground(), light, 'Terminal palette follows the app theme');
  assert.ok((await pane.locator('.xterm-rows').innerText()).includes('Shell history survives theme changes.'));
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/terminal-dark.png` });
  assert.ok(reads.length >= 2 && reads.every(url => url.includes('wait=true')), 'Output uses waiting reads');
  assert.ok(reads[1].includes(`after=${bytes.length}`), 'Only new output is requested');
  assert.deepEqual(writes, [], 'Display verification never mutates terminal sessions');
  assert.deepEqual(errors, []);
  console.log('Terminal waiting reads and light/dark switching preserve shell history without mutations.');
} finally { await browser.close(); }
