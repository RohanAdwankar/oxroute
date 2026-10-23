import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.TEST_URL ?? 'http://127.0.0.1:3941';
const { version } = await fetch(`${base}/api/version`).then(r => r.json());
const agents = ['alpha', 'beta'].map(id => ({ id, name: id, cwd: '/workspace', backend: 'codex', model: 'fixture', status: 'complete', updatedAt: 1 }));
const entryFields = { detail: '', output: '', origin: '', reaction: '' };
const entries = Array.from({ length: 50 }, (_, i) => ({ ...entryFields, id: i + 1, agentId: 'beta', kind: 'said', text: `Discussion ${i + 1}\n\nA detailed conversation passage with enough content to require scrolling through the history.`, at: 1 }));
let releaseHistory;
const historyReady = new Promise(resolve => { releaseHistory = resolve; });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  await page.addInitScript(() => {
    window.SharedWorker = undefined;
    window.EventSource = class extends EventTarget { constructor() { super(); window.stream = this; } close() {} };
    const scroll = Element.prototype.scrollIntoView;
    window.jumps = [];
    Element.prototype.scrollIntoView = function (...args) { if (this.dataset.entry) window.jumps.push(this.dataset.entry); return scroll.apply(this, args); };
  });
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const json = value => route.fulfill({ json: value });
    if (path === '/api/version') return json({ version });
    if (path === '/api/state') return json({ mode: 'ask', agents, archived: [], messages: {}, tasks: [], taskNotes: [], inbox: [], paneLinks: {}, quoteThreads: [], tags: {}, boards: [], sources: [], models: [], backends: [] });
    if (path === '/api/terminals') return json([]);
    if (path.startsWith('/api/agents/')) { const agent = agents.find(a => path.endsWith(a.id)); if (agent.id === 'beta') await historyReady; return json({ agent, timeline: agent.id === 'beta' ? entries : [], delivery: 'start' }); }
    if (path === '/api/say') {
      const body = route.request().postDataJSON();
      const entry = { ...entryFields, id: 100, agentId: 'beta', kind: 'you', text: body.text, requestId: body.requestId, at: 2 };
      entries.push(entry);
      await page.evaluate(entry => window.stream.onmessage({ data: JSON.stringify({ type: 'timeline', entry }) }), entry);
      return json({ ok: true });
    }
    throw new Error(`Unexpected request ${path}`);
  });
  await page.goto(`${base}/?agent=alpha`);
  await page.locator('[data-agent-pane="alpha"]').waitFor();
  const navigate = () => page.evaluate(() => { history.pushState(null, '', '/?agent=beta&entry=10&keep=present'); dispatchEvent(new PopStateEvent('popstate')); });
  await navigate();
  await page.locator('[data-agent-pane="beta"]').waitFor();
  assert.equal(new URL(page.url()).searchParams.get('entry'), '10', 'The target survives until its history arrives');
  releaseHistory();
  await page.waitForFunction(() => !new URL(location.href).searchParams.has('entry'), null, { timeout: 2000 });
  assert.equal(new URL(page.url()).searchParams.get('keep'), 'present', 'Consuming the jump preserves other URL parameters');
  const transcript = page.locator('[data-transcript]');
  const visible = id => page.locator(`[data-entry="${id}"]`).evaluate(el => { const r = el.getBoundingClientRect(), box = el.closest('[data-transcript]').getBoundingClientRect(); return r.top >= box.top && r.bottom <= box.bottom; });
  assert.ok(await visible(10), 'The requested message is revealed');
  const emit = async value => { const entry = { ...entryFields, ...value }; entries.push(entry); await page.evaluate(entry => window.stream.onmessage({ data: JSON.stringify({ type: 'timeline', entry }) }), entry); await page.locator(`[data-entry="${entry.id}"]`).waitFor(); };
  const before = await transcript.evaluate(el => el.scrollTop);
  await emit({ id: 80, agentId: 'beta', kind: 'said', text: 'A later update while reading older history.', at: 2 });
  assert.equal(await transcript.evaluate(el => el.scrollTop), before, 'Reading older history still opts out of following');
  await transcript.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.locator('[data-composer]').fill('A new question after following the deep link');
  await page.locator('[data-composer]').press('Enter');
  await page.locator('[data-entry="100"]').waitFor();
  await page.waitForFunction(() => { const el = document.querySelector('[data-transcript]'); return el.scrollHeight - el.scrollTop - el.clientHeight < 48; });
  await emit({ id: 101, agentId: 'beta', kind: 'said', text: 'The new answer stays at the conversation tail.', at: 3 });
  await page.waitForFunction(() => { const el = document.querySelector('[data-transcript]'); return el.scrollHeight - el.scrollTop - el.clientHeight < 48; });
  assert.equal(await page.evaluate(() => window.jumps.filter(id => id === '10').length), 1, 'Sending and receiving never replay the consumed jump');
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  await navigate();
  await page.waitForFunction(() => window.jumps.filter(id => id === '10').length === 2);
  assert.ok(await visible(10), 'An explicit second navigation can jump to the same message again');
  console.log('Entry links jump once after history loads, preserve reading position, and allow later messages to follow normally.');
} finally { await browser.close(); }
