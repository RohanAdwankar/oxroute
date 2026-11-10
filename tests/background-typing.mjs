import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Exercise a loaded conversation while the remaining histories finish warming.
const agents = Array.from({ length: 100 }, (_, i) => ({ id: `typing-${i}`, name: `Conversation ${i}`, backend: 'codex', model: 'fixture', status: 'complete', updatedAt: 1 }));
const entry = (agentId, id, text) => ({ id, agentId, kind: 'said', text, at: 1, detail: '', output: '', origin: '' });
const histories = new Map(agents.map(agent => [agent.id, Array.from({ length: 80 }, (_, i) => entry(agent.id, i + 1, `Message ${i}: **context** with a [reference](https://example.com/) and \`code\`.\n\nA paragraph of conversation history.`))]));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 750 } });
  await page.addInitScript(() => {
    window.SharedWorker = undefined;
    window.EventSource = class extends EventTarget { constructor() { super(); window.testStream = this; } close() {} };
    window.typingDelays = [];
    document.addEventListener('keydown', event => {
      if (!event.target.matches('[data-composer]')) return;
      const start = performance.now();
      requestAnimationFrame(() => window.typingDelays.push(performance.now() - start));
    }, true);
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const loaded = new Set();
  await page.route('**/api/state', route => route.fulfill({ json: { mode: 'ask', agents, archived: [], messages: {}, tasks: [], taskNotes: [], inbox: [], paneLinks: {}, quoteThreads: [], tags: {}, boards: [], sources: [], models: [], backends: [] } }));
  await page.route('**/api/terminals', route => route.fulfill({ json: [] }));
  await page.route('**/api/agents/*', async route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    const agent = agents.find(agent => agent.id === id);
    await new Promise(resolve => setTimeout(resolve, 50));
    await route.fulfill({ json: { agent, timeline: histories.get(id), delivery: 'start' } });
    loaded.add(id);
  });
  await page.goto(`${process.env.TEST_URL ?? 'http://127.0.0.1:13991'}/?agent=${agents[0].id}`);
  await page.locator('[data-entry="80"]').waitFor();
  const composer = page.locator('[data-composer]').first();
  await composer.focus();
  const text = 'Typing should remain responsive while every conversation is preloaded. '.repeat(4);
  await page.keyboard.type(text, { delay: 15 });
  assert.equal(await composer.inputValue(), text, 'Background loading must preserve every keystroke');
  await assertEventually(() => loaded.size === agents.length);
  const late = agents.at(-1);
  const update = entry(late.id, 81, 'Live update retained in a warmed conversation.');
  await page.evaluate(entry => window.testStream.onmessage({ data: JSON.stringify({ type: 'timeline', entry }) }), update);
  await page.getByRole('button', { name: 'Show the fleet', exact: true }).click();
  await page.getByRole('button', { name: late.name, exact: true }).click();
  await page.locator('[data-entry="81"]').waitFor();
  assert.equal(await page.locator('[data-transcript] [data-entry]').count(), 81, 'Entire warmed history remains available with its live update');
  const delays = await page.evaluate(() => window.typingDelays.sort((a, b) => a - b));
  console.log(JSON.stringify({ loaded: loaded.size, keys: delays.length, median: delays[Math.floor(delays.length * .5)], p95: delays[Math.floor(delays.length * .95)], max: delays.at(-1) }));
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
} finally {
  for (const context of browser.contexts()) for (const page of context.pages()) await page.unrouteAll({ behavior: 'ignoreErrors' });
  await browser.close();
}

async function assertEventually(check) {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(check(), 'Every history must still preload');
}
