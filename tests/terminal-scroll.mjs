import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const terminal = { id: 'terminal_scroll', name: 'Shell history', pending: [], granted: [] };
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 750 } });
  const requests = [], errors = [];
  let screen = '\x1b[?1049h' + Array.from({ length: 25 }, (_, i) => `recent command ${i + 1}\r\n`).join('');
  let offset = 0;
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript(id => localStorage.setItem(`oxroute.terminal.${id}`, 'fixture-controller'), terminal.id);
  await page.route('**/api/state', r => r.fulfill({ json: { mode: 'ask', agents: [], archived: [], messages: {}, tasks: [], taskNotes: [], inbox: [], paneLinks: {}, tags: {}, boards: [], sources: [], models: [], backends: [] } }));
  await page.route('**/api/events', r => r.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' }));
  await page.route('**/api/terminals', r => r.fulfill({ json: [terminal] }));
  await page.route(`**/api/terminals/${terminal.id}/**`, async r => {
    const body = r.request().postDataJSON();
    requests.push({ path: new URL(r.request().url()).pathname, body });
    if (r.request().url().endsWith('/scroll')) screen = '\x1b[2J\x1b[H' + (body.lines < 0 ? 'older command from history' : 'latest shell prompt');
    await r.fulfill({ json: { ok: true } });
  });
  await page.route(`**/api/terminals/${terminal.id}?*`, async r => {
    if (!screen) await new Promise(resolve => setTimeout(resolve, 50));
    const bytes = [...Buffer.from(screen)]; screen = ''; offset += bytes.length;
    await r.fulfill({ json: { terminal, bytes, end: offset, reset: false } }).catch(() => {});
  });
  await page.goto(`${process.env.TEST_URL ?? 'http://127.0.0.1:3941'}/?agent=${terminal.id}`);
  const pane = page.locator('[data-terminal-pane]');
  await pane.locator('.xterm-rows').getByText('recent command 25').waitFor();
  await pane.locator('.xterm-screen').hover();
  await page.mouse.wheel(0, -180);
  await page.waitForTimeout(250);
  assert.ok(requests.some(r => r.path.endsWith('/scroll') && r.body.lines < 0), 'Wheel up reaches tmux history');
  assert.equal(requests.filter(r => r.path.endsWith('/input')).length, 0, 'Scrolling does not type arrow keys into the shell');
  await pane.locator('.xterm-rows').getByText('older command from history').waitFor();
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/terminal-history.png` });
  const text = pane.locator('.xterm-rows').getByText('older command from history');
  const cell = await text.boundingBox();
  await page.mouse.move(cell.x + .1, cell.y + cell.height / 2);
  await page.mouse.down();
  await page.mouse.move(cell.x + cell.width / 2, cell.y + cell.height / 2);
  await page.mouse.up();
  await pane.locator('.xterm-selection div').first().waitFor();
  const selected = await pane.locator('.xterm').evaluate(node => {
    const data = new DataTransfer();
    node.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true }));
    return data.getData('text/plain');
  });
  assert.ok(selected.startsWith('older'), 'Browsing history preserves ordinary text selection');
  await page.mouse.wheel(0, 180);
  await pane.locator('.xterm-rows').getByText('latest shell prompt').waitFor();
  assert.ok(requests.some(r => r.path.endsWith('/scroll') && r.body.lines > 0));
  const scrollRequests = requests.filter(r => r.path.endsWith('/scroll')).length;
  // Programs that request mouse tracking must continue receiving wheel events.
  screen = '\x1b[?1000h\x1b[2J\x1b[Hmouse-aware application';
  await pane.locator('.xterm-rows').getByText('mouse-aware application').waitFor();
  await pane.locator('.xterm-screen').hover();
  const app = await pane.locator('.xterm-rows').getByText('mouse-aware application').boundingBox();
  await page.mouse.move(app.x + 5, app.y + app.height / 2);
  await page.mouse.click(app.x + 5, app.y + app.height / 2);
  await page.mouse.wheel(0, -180);
  await page.waitForTimeout(150);
  assert.equal(requests.filter(r => r.path.endsWith('/scroll')).length, scrollRequests);
  assert.ok(requests.some(r => r.path.endsWith('/input') && r.body.binary && r.body.data.startsWith('\x1b[')), `Mouse-aware applications retain wheel input: ${JSON.stringify(requests)}`);
  // Outside tmux's alternate screen, xterm still scrolls its own normal buffer.
  screen = '\x1b[?1000l\x1b[?1049l' + Array.from({ length: 100 }, (_, i) => `normal history ${i}\r\n`).join('');
  await pane.locator('.xterm-rows').getByText('normal history 99').waitFor();
  const normal = await pane.locator('.xterm-rows').getByText('normal history 99').boundingBox();
  await page.mouse.move(normal.x + 5, normal.y + normal.height / 2);
  await page.mouse.wheel(0, -180);
  await page.waitForTimeout(150);
  assert.equal(requests.filter(r => r.path.endsWith('/scroll')).length, scrollRequests);
  assert.ok(!(await pane.locator('.xterm-rows').innerText()).includes('normal history 99'), 'Normal xterm scrollback remains usable');
  assert.deepEqual(errors, []);
  console.log('Wheel scrolling reaches older tmux history and returns to live output without typing shell commands.');
} finally { await browser.close(); }
