import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';

const now = Date.now() / 1000;
const parent = { id: 'quote-parent', name: 'Interface design', cwd: '/workspace', backend: 'codex', model: 'Astra', status: 'complete', updatedAt: now };
const text = 'Keep **the small interface** simple. Revisit the small interface when needed.\n\nA compass 🧭 and `code()` can guide the design. Preserve [the documentation](https://example.invalid).';
const timeline = [{ id: 1, agentId: parent.id, kind: 'said', text, at: now, detail: '', reaction: '' }];
const children = new Map();
const childReads = new Map();
let threads = [];
const base = process.env.TEST_URL ?? 'http://127.0.0.1:3941';
const { version } = await fetch(`${base}/api/version`).then(response => response.json());
const browser = await (process.env.TEST_BROWSER === 'webkit' ? webkit : chromium).launch(process.env.WEBKIT_EXECUTABLE ? { executablePath: process.env.WEBKIT_EXECUTABLE } : {});
let releaseFork, releaseReply, replyStarted;
const forkGate = new Promise(resolve => { releaseFork = resolve; });
const replyGate = new Promise(resolve => { releaseReply = resolve; });
const firstReply = new Promise(resolve => { replyStarted = resolve; });
let latencyProbe = true, sayCalls = 0, failNextFork = false, retryProbe = false;
let closeForkGate, releaseClosedFork;
let releaseAccepted;
const acceptedGate = new Promise(resolve => { releaseAccepted = resolve; });
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
      if (!children.size) await forkGate;
      if (closeForkGate) { const gate = closeForkGate; closeForkGate = null; await gate; }
      if (failNextFork) { failNextFork = false; return route.fulfill({ status: 503, json: { error: 'The session could not be created' } }); }
      const agent = { ...parent, id: `quote-child-${children.size}`, name: 'Design discussion' };
      children.set(agent.id, { agent, timeline: [{ id: 2, agentId: agent.id, kind: 'forkedFrom', text: 'Forked from session', detail: parent.id }], delivery: 'start' });
      threads.push({ ...body.quote, agentId: agent.id, parentId: parent.id });
      return json({ agent });
    }
    if (path === '/api/say') {
      sayCalls++;
      if (sayCalls === 1) { replyStarted(); await replyGate; return route.fulfill({ status: 503, json: { error: 'The request could not be accepted' } }); }
      const child = children.get(body.agent);
      assert.ok(body.text.trim());
      child.timeline.push({ id: 3, agentId: body.agent, kind: 'you', text: body.text, requestId: body.requestId, at: now, detail: '' }, { id: 4, agentId: body.agent, kind: 'said', text: 'Keep the smaller interface and document the tradeoff.', at: now, detail: '' });
      if (sayCalls === 2) {
        await page.evaluate(entry => window.fixtureEvents.onmessage({ data: JSON.stringify({ type: 'timeline', entry }) }), child.timeline.at(-2));
        await acceptedGate;
      }
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
  const select = async (excerpt, occurrence = 0, closeEarly = false) => {
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
    const opened = page.getByRole('dialog', { name: 'Quoted thread', exact: true });
    await opened.waitFor({ timeout: 2000 });
    if (latencyProbe) {
      latencyProbe = false;
      assert.equal(threads.length, 0, 'Discussion is visible before the native fork completes');
      const composer = opened.getByRole('textbox', { name: 'Reply to quoted thread' });
      await composer.fill('Could this design be simpler?');
      await opened.getByRole('button', { name: 'Send thread reply' }).click();
      assert.equal(await composer.inputValue(), '', 'Send clears the composer immediately');
      assert.equal(await opened.locator('[data-pending-reply]').textContent(), 'Could this design be simpler?Sending…');
      await composer.fill('Keep this additional thought');
      assert.equal(sayCalls, 0, 'Reply waits for its actual session without blocking the UI');
      if (process.env.PENDING_SCREENSHOT) await page.screenshot({ path: process.env.PENDING_SCREENSHOT });
      releaseFork(); await firstReply;
      assert.ok(await opened.locator('[data-pending-reply]').isVisible(), 'Reply remains visible before request acceptance');
      releaseReply(); await opened.getByRole('alert').waitFor();
      await page.waitForFunction(() => document.querySelector('[aria-label="Reply to quoted thread"]').value.startsWith('Could this design'));
      assert.equal(await composer.inputValue(), 'Could this design be simpler? Keep this additional thought', 'Failure restores the message without losing newer typing');
    }
    if (retryProbe) {
      retryProbe = false;
      const composer = opened.getByRole('textbox', { name: 'Reply to quoted thread' });
      await composer.fill('Preserve this draft through retry');
      await opened.getByRole('alert').waitFor();
      await opened.getByRole('button', { name: 'Retry opening thread' }).click();
      await opened.getByRole('button', { name: 'Open full thread' }).waitFor();
      await page.waitForFunction(() => !document.querySelector('[aria-label="Open full thread"]').disabled);
      assert.equal(await composer.inputValue(), 'Preserve this draft through retry');
    }
    if (!closeEarly) await message.locator('[data-quote-thread]').first().waitFor();
    if (closeEarly) {
      await opened.getByRole('textbox', { name: 'Reply to quoted thread' }).fill('Draft while opening');
      await opened.getByRole('button', { name: 'Close thread', exact: true }).click();
      releaseClosedFork();
      await message.locator('[data-quote-thread]').first().waitFor();
      assert.equal(await opened.count(), 0, 'Finishing creation does not reopen a dismissed popup');
      await message.locator('[data-quote-thread]').first().click();
      assert.equal(await opened.getByRole('textbox', { name: 'Reply to quoted thread' }).inputValue(), 'Draft while opening', 'Draft follows the actual session even when creation finished after closing');
    }
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
  await dialog.getByText('Could we simplify this further?', { exact: true }).waitFor();
  assert.equal(await dialog.getByText('Could we simplify this further?', { exact: true }).count(), 1, 'Persisted replies reconcile with their optimistic copy before acceptance');
  releaseAccepted();
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
  failNextFork = true; retryProbe = true;
  dialog = await select('code()');
  await dialog.getByRole('button', { name: 'Archive thread', exact: true }).click();
  await message.locator('[data-quote-thread]').first().waitFor({ state: 'detached' });
  closeForkGate = new Promise(resolve => { releaseClosedFork = resolve; });
  dialog = await select('code()', 0, true);
  await dialog.getByRole('button', { name: 'Archive thread', exact: true }).click();
  await message.locator('[data-quote-thread]').first().waitFor({ state: 'detached' });
  console.log('Quoted threads preserve selection, Unicode, formatting, replies and reloads; archive/merge remove only the underline.');
} finally { await browser.close(); }
