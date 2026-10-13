import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const terminal = { id: 'terminal_scroll', name: 'Shell history', pending: [], granted: [] };
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 750 } });
  const requests = [], errors = [];
  let screen = '\x1b[?1049hcurrent shell prompt', offset = 0, alternate = false;
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript(id => localStorage.setItem(`oxroute.terminal.${id}`, 'fixture-controller'), terminal.id);
  await page.route('**/api/state', r => r.fulfill({ json: { mode: 'ask', agents: [], archived: [], messages: {}, tasks: [], taskNotes: [], inbox: [], paneLinks: {}, tags: {}, boards: [], sources: [], models: [], backends: [] } }));
  await page.route('**/api/events', r => r.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' }));
  await page.route('**/api/terminals', r => r.fulfill({ json: [terminal] }));
  await page.route(`**/api/terminals/${terminal.id}/**`, async r => {
    requests.push({ path: new URL(r.request().url()).pathname, body: r.request().postDataJSON() });
    if (r.request().url().endsWith('/history')) {
      await new Promise(resolve => setTimeout(resolve, 200));
      return r.fulfill({ json: { text: Array.from({ length: 1000 }, (_, i) => `earlier command ${i}`).join('\n'), alternate } });
    }
    await r.fulfill({ json: { ok: true } });
  });
  await page.route(`**/api/terminals/${terminal.id}?*`, async r => {
    if (!screen) await new Promise(resolve => setTimeout(resolve, 50));
    const bytes = [...Buffer.from(screen)]; screen = ''; offset += bytes.length;
    await r.fulfill({ json: { terminal, bytes, end: offset, reset: false } }).catch(() => {});
  });
  await page.goto(`${process.env.TEST_URL ?? 'http://127.0.0.1:3941'}/?agent=${terminal.id}`);
  const pane = page.locator('[data-terminal-pane]');
  const visibleRows = pane.locator('.xterm:visible .xterm-rows');
  await visibleRows.getByText('current shell prompt').waitFor();
  await pane.locator('.xterm:visible .xterm-screen').hover();
  await page.mouse.wheel(0, -180);
  await visibleRows.getByText('earlier command 980', { exact: true }).waitFor();
  const before = await visibleRows.innerText();
  const start = performance.now();
  for (let i = 0; i < 8; i++) await page.mouse.wheel(0, -80);
  await page.waitForTimeout(100);
  assert.notEqual(await visibleRows.innerText(), before, 'Continuous scrolling changes the viewport locally');
  assert.equal(requests.filter(r => r.path.endsWith('/history')).length, 1, 'A history visit fetches once, despite repeated wheel events');
  assert.equal(requests.filter(r => r.path.endsWith('/scroll')).length, 0, 'Wheel movement does not await server redraws');
  assert.equal(requests.filter(r => r.path.endsWith('/input')).length, 0, 'Scrolling does not type into the shell');
  console.log(`Repeated scrolling used one initial history read with 200 ms latency; local movements took ${Math.round(performance.now() - start)} ms.`);
  const text = visibleRows.locator('div > span').first(), cell = await text.boundingBox();
  await page.mouse.move(cell.x + .1, cell.y + cell.height / 2);
  await page.mouse.down(); await page.mouse.move(cell.x + cell.width / 2, cell.y + cell.height / 2); await page.mouse.up();
  await pane.locator('.xterm:visible .xterm-selection div').first().waitFor();
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/terminal-local-history.png` });
  screen = '\x1b[2J\x1b[Hnew live output';
  await page.waitForTimeout(150);
  assert.ok(!(await visibleRows.innerText()).includes('new live output'), 'Live output does not pull the history view to the bottom');
  await pane.locator('.xterm:visible .xterm-screen').click();
  await page.keyboard.type('ls');
  await visibleRows.getByText('new live output').waitFor();
  await page.waitForTimeout(50);
  assert.ok(requests.some(r => r.path.endsWith('/input') && r.body.data.includes('l')), 'Typing returns to the running shell');
  screen = '\x1b[?2004h';
  await page.waitForTimeout(150);
  await pane.locator('.xterm:visible .xterm-screen').hover();
  await page.mouse.wheel(0, -180);
  await visibleRows.getByText('earlier command 980', { exact: true }).waitFor();
  await pane.locator('.xterm:visible .xterm-helper-textarea').evaluate(node => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', 'ls\npwd');
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  });
  await visibleRows.getByText('new live output').waitFor();
  await page.waitForTimeout(50);
  assert.ok(requests.some(r => r.body?.data === '\x1b[200~ls\rpwd\x1b[201~'), 'History paste preserves the live terminal bracketed-paste protocol');
  // History scrolling must not replace application mouse input.
  screen = '\x1b[?1000h\x1b[2J\x1b[Hmouse-aware application';
  await visibleRows.getByText('mouse-aware application').waitFor();
  const app = await visibleRows.getByText('mouse-aware application').boundingBox();
  await page.mouse.click(app.x + 5, app.y + app.height / 2);
  await page.mouse.wheel(0, -180);
  await page.waitForTimeout(100);
  assert.equal(requests.filter(r => r.path.endsWith('/history')).length, 2);
  assert.ok(requests.some(r => r.body?.binary), 'Application mouse reports still reach the terminal');
  alternate = true;
  screen = '\x1b[?1000l\x1b[2J\x1b[Hfull-screen program';
  await visibleRows.getByText('full-screen program').waitFor();
  await page.mouse.wheel(0, -180);
  await page.waitForTimeout(300);
  assert.ok((await visibleRows.innerText()).includes('full-screen program'), 'Full-screen programs retain their screen');
  assert.ok(requests.some(r => r.body?.data?.includes('\x1b[A')), 'Programs without mouse tracking retain arrow-key scrolling');
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
