import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
const agent = { id: 'selection-fixture', name: 'Selection fixture', backend: 'codex', model: 'fixture', status: 'complete', updatedAt: Date.now()/1000 };
const taskId = 'task_' + 'a'.repeat(32);
const text = `Opening paragraph.\n\n\`\`\`js\nconst limit = 17;\nconst label = "steady";\n\`\`\`\n\nClosing paragraph. Related work: ${taskId}.`;
const timeline = [{ id: 1, agentId: agent.id, kind: 'said', text, at: Date.now()/1000, detail: '' }];
let tasks = [], threads = [], child = null;
const threadRequests = [];
const base = process.env.TEST_URL ?? 'http://127.0.0.1:3939';
const browser = await (process.env.TEST_BROWSER === 'webkit' ? webkit : chromium).launch(process.env.WEBKIT_EXECUTABLE ? { executablePath: process.env.WEBKIT_EXECUTABLE } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  await page.addInitScript(() => { window.SharedWorker = undefined; window.EventSource = class extends EventTarget { constructor() { super(); window.fixtureEvents = this; } close() {} }; });
  await page.route('**/api/state', r => r.fulfill({ json: { mode: 'ask', agents: child ? [agent, child] : [agent], archived: [], messages: {}, tasks, taskNotes: [], inbox: [], paneLinks: {}, quoteThreads: threads, tags: {}, boards: [], sources: [], models: [], backends: [{backend:'codex',fork:true,merge:true}] } }));
  await page.route('**/api/terminals', r => r.fulfill({ json: [] }));
  await page.route('**/api/agents/*', r => r.fulfill({ json: r.request().url().endsWith(agent.id) ? { agent, timeline, delivery: 'start' } : { agent: child, timeline: [], delivery: 'start' } }));
  await page.route('**/api/fork-in-chat', r => {
    const body = r.request().postDataJSON(); threadRequests.push(body);
    child = { ...agent, id: 'selection-thread', name: 'Selected passage' };
    threads = [{ ...body.quote, agentId: child.id, parentId: agent.id }];
    return r.fulfill({ json: { agent: child } });
  });
  const writes = [];
  page.on('request', r => { if (r.method() !== 'GET') writes.push(r.url()); });
  await page.goto(`${base}/?agent=${agent.id}`);
  const message = page.locator('[data-entry="1"] .message-markdown');
  await message.locator('pre').waitFor();
  const select = async excerpt => message.evaluate((element, excerpt) => {
    const start = element.textContent.indexOf(excerpt);
    if (start < 0) throw new Error('Excerpt missing');
    const nodes = [], walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const point = offset => {
      for (const node of nodes) { if (offset <= node.length) return [node, offset]; offset -= node.length; }
      throw new Error('Selection endpoint missing');
    };
    const range = document.createRange(); range.setStart(...point(start)); range.setEnd(...point(start + excerpt.length));
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const box = [...range.getClientRects()].find(box => box.width && box.height);
    return { x: box.x + Math.min(box.width / 2, 10), y: box.y + box.height / 2 };
  }, excerpt);
  const composer = page.locator('[data-composer]');
  const excerpts = ['limit = 17', '17;\nconst label', await message.evaluate(el => {
    const text = el.textContent;
    return text.slice(text.indexOf('paragraph.'), text.indexOf('limit') + 'limit'.length);
  })];
  for (const [index, excerpt] of excerpts.entries()) {
    const position = await select(excerpt);
    // A background update refreshes reference metadata without changing the selected words.
    tasks = [{ id: taskId, text: `Check metadata ${index}`, status: 'incomplete', parentTaskId: '', blockedByTaskId: '', agentId: agent.id, images: [], createdAt: 1, updatedAt: index }];
    await page.evaluate(() => window.fixtureEvents.onmessage({ data: JSON.stringify({ type: 'sync' }) }));
    await message.getByRole('button', { name: `Task Check metadata ${index}`, exact: true }).waitFor();
    await page.mouse.click(position.x, position.y, { button: 'right' });
    await page.getByRole('button', { name: 'quote reply', exact: true }).click();
    assert.equal(await composer.inputValue(), excerpt.trim().split('\n').map(line => `> ${line}`).join('\n') + '\n\n', 'Quote only the selected text, including selections across code and prose');
    if (index === 0 && process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
    await composer.fill('');
  }
  // Streaming more prose must preserve a selection in an unchanged code block.
  const streamedExcerpt = 'const label = "steady";';
  const streamedPosition = await select(streamedExcerpt);
  timeline[0].text += '\n\nFollow-up detail.';
  await page.evaluate(entry => window.fixtureEvents.onmessage({ data: JSON.stringify({ type: 'timeline', entry }) }), timeline[0]);
  await message.getByText('Follow-up detail.', { exact: true }).waitFor();
  await page.mouse.click(streamedPosition.x, streamedPosition.y, { button: 'right' });
  await page.getByRole('button', { name: 'quote reply', exact: true }).click();
  assert.equal(await composer.inputValue(), `> ${streamedExcerpt}\n\n`);
  await composer.fill('');
  // A selection in highlighted code can also create an anchored discussion.
  const excerpt = 'label = "steady"';
  const position = await select(excerpt);
  tasks[0].text = 'Check metadata for discussion';
  await page.evaluate(() => window.fixtureEvents.onmessage({ data: JSON.stringify({ type: 'sync' }) }));
  await message.getByRole('button', { name: 'Task Check metadata for discussion', exact: true }).waitFor();
  await page.mouse.click(position.x, position.y, { button: 'right' });
  await page.getByRole('button', { name: 'quote into thread', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Quoted thread', exact: true });
  await dialog.waitFor();
  await page.waitForFunction(() => document.querySelector('[data-quote-thread]'));
  assert.equal(threadRequests[0].quote.text, excerpt);
  await dialog.getByRole('button', { name: 'Close thread', exact: true }).click();
  // With no selection, quoting the entire message remains intentional.
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await message.locator('p').first().click({ button: 'right' });
  await page.getByRole('button', { name: 'quote reply', exact: true }).click();
  assert.equal(await composer.inputValue(), timeline[0].text.split('\n').map(line => `> ${line}`).join('\n') + '\n\n');
  assert.equal(writes.length, 1);
  assert.ok(writes[0].endsWith('/api/fork-in-chat'), 'Only the explicitly requested thread is created, entirely through the fixture');
  console.log('Selections inside and across code blocks survive background updates; replies and anchored discussions use the snippet, and full-message quoting remains available without selection.');
} finally { await browser.close(); }
