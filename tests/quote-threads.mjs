import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const now = Date.now() / 1000;
const parent = { id: 'quote-parent', name: 'Interface design', cwd: '/workspace', backend: 'codex', model: 'Astra', status: 'complete', updatedAt: now };
const text = 'Keep **the small interface** simple. Revisit the small interface when needed.\n\nA compass 🧭 and `code()` can guide the design. Preserve [the documentation](https://example.invalid).';
const timeline = [{ id: 1, agentId: parent.id, kind: 'said', text, at: now, detail: '', reaction: '' }];
const children = new Map();
const childReads = new Map();
let threads = [];
const base = process.env.TEST_URL ?? 'http://127.0.0.1:3941';
const { version } = await fetch(`${base}/api/version`).then(response => response.json());
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  await page.addInitScript(() => { window.EventSource = class { constructor() { window.fixtureEvents = this; } close() {} }; });
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const json = value => route.fulfill({ json: value });
    if (path === '/api/version') return json({ version });
    if (path === '/api/state') return json({ mode: 'ask', agents: [parent, ...[...children.values()].filter(child => !child.archived).map(child => child.agent)], archived: [...children.values()].filter(child => child.archived).map(child => child.agent), messages: {}, tasks: [], taskNotes: [], inbox: [], paneLinks: {}, quoteThreads: threads, tags: {}, boards: [], sources: [], models: [], backends: [{ backend: 'codex', fork: true, merge: true }] });
    if (path === '/api/terminals') return json([]);
    if (path.startsWith('/api/agents/')) {
      const id = path.split('/')[3];
      const child = children.get(id);
      if (child) childReads.set(id, (childReads.get(id) ?? 0) + 1);
      return json(child ?? { agent: parent, timeline, delivery: 'start' });
    }
    const body = request.postDataJSON();
    if (path === '/api/fork-in-chat') {
      const agent = { ...parent, id: `quote-child-${children.size}`, name: 'Design discussion' };
      children.set(agent.id, { agent, timeline: [{ id: 2, agentId: agent.id, kind: 'forkedFrom', text: 'Forked from session', detail: parent.id }], delivery: 'start' });
      threads.push({ ...body.quote, agentId: agent.id, parentId: parent.id });
      return json({ agent });
    }
    if (path === '/api/say') {
      const child = children.get(body.agent);
      assert.ok(body.text.trim());
      child.timeline.push({ id: 3, agentId: body.agent, kind: 'you', text: body.text, at: now, detail: '' }, { id: 4, agentId: body.agent, kind: 'said', text: 'Keep the smaller interface and document the tradeoff.', at: now, detail: '' });
      return json({ ok: true });
    }
    if (path === '/api/archive' || path === '/api/merge') {
      children.get(body.agent).archived = true;
      threads = threads.filter(thread => thread.agentId !== body.agent);
      return json(path === '/api/merge' ? { agent: parent } : {});
    }
    throw new Error(`Unexpected fixture request ${path}`);
  });
  const url = `${base}/?agent=${parent.id}`;
  await page.goto(url);
  const message = page.locator('[data-entry="1"] .message-markdown');
  const select = async (excerpt, occurrence = 0) => {
    const selected = await message.evaluate((element, { excerpt, occurrence }) => {
      const text = element.textContent;
      let start = -1;
      for (let i = 0; i <= occurrence; i++) start = text.indexOf(excerpt, start + 1);
      if (start < 0) throw new Error('Excerpt missing');
      const nodes = [], walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) nodes.push(walker.currentNode);
      const point = offset => {
        for (const node of nodes) { if (offset <= node.length) return [node, offset]; offset -= node.length; }
      };
      const range = document.createRange();
      range.setStart(...point(start)); range.setEnd(...point(start + excerpt.length));
      window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
      const box = range.getBoundingClientRect();
      return { start, end: start + excerpt.length, x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }, { excerpt, occurrence });
    await page.mouse.click(selected.x, selected.y, { button: 'right' });
    assert.ok(await page.getByRole('button', { name: 'quote reply', exact: true }).isVisible(), 'Existing quote reply remains available');
    await page.getByRole('button', { name: 'quote into thread', exact: true }).click();
    await page.getByRole('dialog', { name: 'Quoted thread', exact: true }).waitFor();
    assert.equal(threads.at(-1).start, selected.start, 'The selected occurrence is anchored');
    await message.locator('[data-quote-thread]').first().waitFor();
    assert.equal((await message.locator('[data-quote-thread]').allTextContents()).join(''), excerpt);
    return page.getByRole('dialog', { name: 'Quoted thread', exact: true });
  };
  let dialog = await select('the small interface', 1);
  await dialog.getByRole('textbox', { name: 'Reply to quoted thread' }).fill('Keep this draft');
  await dialog.getByRole('button', { name: 'Close thread', exact: true }).click();
  await message.locator('[data-quote-thread]').first().click();
  dialog = page.getByRole('dialog', { name: 'Quoted thread', exact: true });
  assert.equal(await dialog.getByRole('textbox', { name: 'Reply to quoted thread' }).inputValue(), 'Keep this draft');
  await dialog.getByRole('textbox', { name: 'Reply to quoted thread' }).fill('Could we simplify this further?');
  await dialog.getByRole('button', { name: 'Send thread reply', exact: true }).click();
  await dialog.getByText('Keep the smaller interface and document the tradeoff.', { exact: true }).waitFor();
  const threadId = threads[0].agentId;
  const reads = childReads.get(threadId);
  await page.evaluate(agentId => window.fixtureEvents.onmessage({ data: JSON.stringify({ type: 'timeline', entry: { id: 5, agentId, kind: 'said', text: 'An additional detail arrived.', at: Date.now() / 1000, detail: '' } }) }), threadId);
  await dialog.getByText('An additional detail arrived.', { exact: true }).waitFor();
  await page.waitForTimeout(1100);
  assert.equal(childReads.get(threadId), reads, 'Live replies arrive without repeatedly fetching the copied history');
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  await dialog.getByRole('button', { name: 'Close thread', exact: true }).click();
  await page.reload();
  await message.locator('[data-quote-thread]').first().click();
  dialog = page.getByRole('dialog', { name: 'Quoted thread', exact: true });
  await dialog.getByText('Keep the smaller interface and document the tradeoff.', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Archive thread', exact: true }).click();
  await message.locator('[data-quote-thread]').first().waitFor({ state: 'detached' });
  assert.ok(await message.getByRole('link', { name: 'the documentation' }).isVisible());
  dialog = await select('compass 🧭 and code()');
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  if (process.env.DARK_SCREENSHOT) await page.screenshot({ path: process.env.DARK_SCREENSHOT });
  await dialog.getByRole('textbox', { name: 'Reply to quoted thread' }).fill('Older thread draft');
  await dialog.getByRole('button', { name: 'Close thread', exact: true }).click();
  dialog = await select('compass 🧭 and code()');
  await dialog.getByRole('button', { name: 'Next quoted discussion', exact: true }).click();
  assert.equal(await dialog.getByRole('textbox', { name: 'Reply to quoted thread' }).inputValue(), 'Older thread draft');
  await dialog.getByRole('button', { name: 'Archive thread', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await message.locator('[data-quote-thread]').first().click();
  dialog = page.getByRole('dialog', { name: 'Quoted thread', exact: true });
  await dialog.getByRole('button', { name: 'Merge thread into parent', exact: true }).click();
  await message.locator('[data-quote-thread]').first().waitFor({ state: 'detached' });
  assert.equal(await message.locator('[data-quote-thread]').count(), 0);
  assert.equal(await page.locator('[data-agent-pane]').count(), 1, 'Inline threads never pop open chat panes');
  assert.equal((await message.innerText()).includes('compass 🧭'), true);
  console.log('Quoted threads preserve selection, Unicode, formatting, replies and reloads; archive/merge remove only the underline.');
} finally { await browser.close(); }
