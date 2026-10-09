import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const terminal = { id: 'terminal_flow', name: 'Shared terminal', pending: [], granted: [] };
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  await page.addInitScript(id => localStorage.setItem(`oxroute.terminal.${id}`, 'fixture-owner'), terminal.id);
  await page.route('**/api/state', r => r.fulfill({ json: { mode: 'ask', agents: [], archived: [], messages: {}, tasks: [], taskNotes: [], inbox: [], paneLinks: {}, tags: {}, boards: [], sources: [], models: [], backends: [] } }));
  await page.route('**/api/events', r => r.fulfill({ contentType: 'text/event-stream', body: ': test\n\n' }));
  const received = [], bytes = [...Buffer.from('Ready for input.\r\n')];
  let reads = 0;
  // Every terminal request stays inside this fixture, including owner input.
  await page.route('**/api/terminals{,/**}', async r => {
    const path = new URL(r.request().url()).pathname;
    if (path === '/api/terminals') return r.fulfill({ json: [terminal] });
    if (path.endsWith('/input')) {
      const body = r.request().postDataJSON();
      assert.equal(body.controller, 'fixture-owner');
      await new Promise(resolve => setTimeout(resolve, 120));
      received.push(body.data);
      return r.fulfill({ json: { ok: true } });
    }
    if (path.endsWith('/resize')) return r.fulfill({ json: { ok: true } });
    const initial = reads++ === 0;
    if (!initial) await new Promise(resolve => setTimeout(resolve, 2000));
    await r.fulfill({ json: { terminal, bytes: initial ? bytes : [], end: bytes.length, reset: false } }).catch(() => {});
  });
  await page.goto(`${process.env.TEST_URL ?? 'http://127.0.0.1:3942'}/?agent=${terminal.id}`);
  const pane = page.locator('[data-terminal-pane]');
  await pane.locator('.xterm-rows').getByText('Ready for input.').waitFor();
  await pane.locator('.xterm-helper-textarea').focus();
  const expected = Array.from({ length: 40 }, (_, i) => String.fromCharCode(97 + i % 26)).join('');
  await page.keyboard.type(expected, { delay: 10 });
  const released = Date.now();
  while (received.join('').length < expected.length && Date.now() - released < 6000) await page.waitForTimeout(20);
  assert.equal(received.join(''), expected, 'Every key arrives once in order');
  const tail = Date.now() - released;
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  assert.ok(tail < 600, `Input backlog must drain promptly after release, took ${tail} ms`);
  console.log(`Ordered terminal input drained ${tail} ms after release over ${received.length} requests at 120 ms latency.`);
} finally { await browser.close(); }
