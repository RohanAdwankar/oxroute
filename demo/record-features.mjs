// Record the real UI against isolated fixtures. No requests reach a daemon.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const out = process.env.OXROUTE_DEMO_OUT ?? 'demo/out';
await mkdir(out, { recursive: true });
const now = Date.now() / 1000;
const version = process.env.OXROUTE_WEB_VERSION ?? execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
const agents = ['Health endpoint', 'Parcel ordering'].map((name, i) => ({
  id: `demo-${i}`, name, cwd: '/workspace/parcels', backend: 'codex', model: 'Astra', status: 'complete', updatedAt: now,
}));
const tasks = ['Report version and commit', 'Sort parcels by id', 'Add response tests'].map((text, i) => ({
  id: `task-demo-${i}`, text, status: i === 0 ? 'done' : 'incomplete', agentId: agents[i % 2].id,
  blockedByTaskId: '', images: [], position: i, createdAt: now, updatedAt: now,
}));
const review = { id: 'demo-review', title: 'Include version in the health response', description: '', status: 'pending',
  snapshot: { repository: '/workspace/parcels', branch: 'health-response', baseRef: 'main', remote: 'origin', remoteUrl: '',
    baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), files: [{ path: 'src/routes.js', patch:
      '@@ -1,7 +1,8 @@\n function health(answer) {\n-  const version = "0.1.0";\n+  const version = "0.2.0";\n+  const commit = process.env.COMMIT;\n   answer.writeHead(200, { "content-type": "application/json" });\n-  answer.end(JSON.stringify({ version }));\n+  answer.end(JSON.stringify({ version, commit }));\n }\n\n module.exports = { health };\n' }] } };
const timelines = agents.map((agent, i) => [
  { id: i * 10 + 1, agentId: agent.id, at: now, kind: 'you', text: i ? 'Sort the parcels by id and keep the response format.' : 'Make /health report the version and commit.', detail: '' },
  { id: i * 10 + 2, agentId: agent.id, at: now, kind: 'said', text: i ? 'The response is now sorted by id. Existing fields are preserved.\n\nThe ordering tests pass for empty lists, single parcels, and multiple parcels.' : 'The health response now includes the version and commit.\n\nI added response tests and prepared the change for review.', detail: '' },
  ...(i ? [] : [{ id: 3, agentId: agent.id, at: now, kind: 'review', text: review.title, detail: review.id }]),
]);
let terminals = [];
const output = '$ npm test\r\n\r\n✓ health response\r\n✓ parcel ordering\r\n✓ empty response shape\r\n\r\n3 tests passed\r\n$ ';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 960, height: 600 }, recordVideo: { dir: out, size: { width: 960, height: 600 } } });
const video = page.video();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => {
  window.EventSource = class { constructor() { window.demoEvents = this; } close() {} };
  // Chromium's video omits the native pointer. Make drag gestures visible.
  document.addEventListener('DOMContentLoaded', () => {
    const cursor = document.createElement('div');
    cursor.style.cssText = 'position:fixed;left:0;top:0;display:none;pointer-events:none;z-index:1000';
    cursor.innerHTML = '<svg width="22" height="28" viewBox="0 0 22 28"><path d="M2 2v21l5-6 4 9 4-2-4-8h9z" fill="#211d19" stroke="white" stroke-width="1.5"/></svg>';
    document.body.append(cursor);
    document.addEventListener('mousemove', event => {
      cursor.style.display = 'block';
      cursor.style.transform = `translate(${event.clientX}px,${event.clientY}px)`;
    });
  });
});
await page.route('**/api/**', async route => {
  const request = route.request(), url = new URL(request.url()), path = url.pathname;
  const json = value => route.fulfill({ json: value });
  if (path === '/api/say' && request.method() === 'POST') {
    const sent = request.postDataJSON();
    timelines[0].push({ id: 4, agentId: agents[0].id, at: now, kind: 'you', text: sent.text, requestId: sent.requestId, detail: 'diff-attachments:' + JSON.stringify(sent.diffs) });
    return json({});
  }
  if (path === '/api/version') return json({ version });
  if (path === '/api/state') return json({ mode: 'ask', agents, archived: [], tasks, taskNotes: [], messages: {}, inbox: [], paneLinks: {}, tags: {}, boards: [], sources: [], models: [], backends: [] });
  if (path === '/api/terminals') return json(terminals);
  if (path.startsWith('/api/terminals/')) {
    const terminal = terminals[0];
    if (path.endsWith('/claim')) return json({ controller: 'demo-controller' });
    if (request.method() !== 'GET') return json({ ok: true });
    await new Promise(resolve => setTimeout(resolve, 150));
    const after = Number(url.searchParams.get('after'));
    return json({ terminal, bytes: [...Buffer.from(output).subarray(after)], end: Buffer.byteLength(output), reset: false });
  }
  if (path.endsWith('/reviews/demo-review')) return json(review);
  if (path.startsWith('/api/agents/')) {
    const i = agents.findIndex(agent => path === '/api/agents/' + agent.id);
    if (i !== -1) return json({ agent: agents[i], timeline: timelines[i], delivery: 'start' });
  }
  throw new Error(`Unhandled demo request: ${request.method()} ${path}`);
});
const caption = async (text, bottom = 110) => {
  await page.evaluate(({ text, bottom }) => {
    let node = document.getElementById('demo-caption');
    if (!node) {
      node = document.createElement('div'); node.id = 'demo-caption';
      node.style.cssText = 'position:fixed;bottom:110px;left:50%;transform:translateX(-50%);background:#211d19;color:#fff;padding:8px 14px;font:16px system-ui;white-space:nowrap;z-index:999;pointer-events:none';
      document.body.append(node);
    }
    node.textContent = text;
    node.style.bottom = `${bottom}px`;
  }, { text, bottom });
};
const hold = async name => { await page.waitForTimeout(2300); await page.screenshot({ path: `${out}/${name}.png` }); };
const pane = i => page.locator(`[data-agent-pane="${agents[i].id}"]`);
const drag = async (separator, x, y) => {
  const box = await separator.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(x, y ?? box.y + box.height / 2, { steps: 30 }); await page.mouse.up();
};
try {
  await page.goto(`${process.env.OXROUTE_DEMO_URL ?? 'http://127.0.0.1:3941'}/?agent=demo-0`);
  await pane(0).waitFor();
  await caption('Review code with syntax colors and precise changed words');
  await page.getByRole('button', { name: 'Review ' + review.title, exact: true }).click();
  const diff = page.getByRole('region', { name: 'Diff src/routes.js', exact: true });
  await diff.waitFor();
  assert.ok(await diff.locator('.hljs-keyword').count());
  await hold('review');
  await caption('Select the lines you want to discuss');
  const endpoints = await diff.evaluate(element => {
    const rows = [...element.querySelectorAll('[data-diff-line]')];
    const point = (row, end) => {
      const walker = document.createTreeWalker(row.lastElementChild, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      const node = end ? nodes.at(-1) : nodes[0];
      const range = document.createRange();
      range.setStart(node, end ? node.length : 0); range.collapse(true);
      const box = range.getBoundingClientRect();
      return { x: box.x, y: box.y + box.height / 2 };
    };
    return { start: point(rows.find(row => row.textContent.includes('-  const version')), false), end: point(rows.find(row => row.textContent.includes('+  const commit')), true) };
  });
  await page.mouse.move(endpoints.start.x, endpoints.start.y);
  await page.mouse.down();
  await page.mouse.move(endpoints.end.x + 1, endpoints.end.y, { steps: 40 });
  await page.mouse.up();
  const selected = await page.evaluate(() => window.getSelection().toString());
  assert.ok(selected.includes('0.1.0') && selected.includes('0.2.0') && selected.includes('const commit'));
  await hold('selection');
  await caption('Right-click the selection and quote it into chat');
  await page.mouse.click(endpoints.start.x + 50, endpoints.start.y, { button: 'right' });
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Quote diff into chat', exact: true }).click();
  const attachment = pane(0).getByRole('region', { name: 'Attached diff src/routes.js', exact: true });
  await attachment.waitFor();
  assert.equal(await attachment.locator('[data-quoted-diff-line]').count(), 3);
  await caption('The selected diff sits beside your question', 160);
  await pane(0).locator('[data-composer]').pressSequentially('Should we report an unknown commit explicitly?', { delay: 45 });
  await hold('quote');
  await caption('Send the question. The selected diff stays in the conversation', 160);
  await pane(0).getByRole('button', { name: 'Send message', exact: true }).click();
  const sentDiff = pane(0).locator('[data-entry="4"]').getByRole('region', { name: 'Attached diff src/routes.js', exact: true });
  await sentDiff.waitFor();
  assert.equal(await sentDiff.locator('[data-quoted-diff-line]').count(), 3);
  assert.equal(await pane(0).locator('[data-transcript] [data-entry]').filter({ hasText: 'Should we report an unknown commit explicitly?' }).count(), 1);
  await hold('sent-diff');
  await caption('Keep several conversations in view');
  await page.getByLabel('Choose visible agents').click();
  await page.getByRole('checkbox', { name: agents[1].name, exact: true }).check();
  await page.getByLabel('Choose visible agents').click();
  await pane(1).waitFor();
  await hold('panes');
  await caption('Choose the minimum pane scale in Settings');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'settings' });
  await dialog.locator('section').filter({ hasText: 'Scale panes with width' }).getByRole('button').nth(1).click();
  const minimum = dialog.getByRole('spinbutton', { name: 'Minimum pane scale' });
  await minimum.fill('80');
  await minimum.press('Tab');
  await hold('settings');
  await page.keyboard.press('Escape');
  await caption('Drag the divider. Text and controls scale together');
  const divider = page.getByRole('separator', { name: 'resize chat panes', exact: true });
  await drag(divider, 260);
  await hold('scaled');
  await caption('Collapse a pane to its handle, then pull it back');
  await drag(divider, 1);
  assert.ok((await pane(0).boundingBox()).width < 48);
  await hold('rail');
  await drag(divider, 480);
  await caption('Search tasks across conversations');
  await page.getByRole('button', { name: 'Show or hide tasks', exact: true }).click();
  const search = page.getByRole('searchbox', { name: 'Search tasks' });
  await search.pressSequentially('parcels', { delay: 110 });
  await hold('tasks');
  await search.fill('');
  await page.getByRole('button', { name: 'Show or hide tasks', exact: true }).click();
  await caption('An agent can open its own terminal beside the conversation');
  terminals = [{ id: 'terminal_demo', name: 'Response tests', agentId: agents[0].id, granted: [agents[0].id], pending: [] }];
  await page.evaluate(() => window.demoEvents.onmessage({ data: JSON.stringify({ type: 'sync' }) }));
  const terminal = page.locator('[data-terminal-pane="terminal_demo"]');
  await terminal.getByText('3 tests passed', { exact: false }).waitFor();
  await hold('terminal');
  await caption('Other agents need your consent to write here');
  terminals[0].pending = [agents[1].id];
  await terminal.getByRole('alertdialog').waitFor();
  await hold('consent');
  terminals[0].pending = [];
  await page.getByLabel('Choose visible agents').click();
  await page.getByRole('checkbox', { name: 'Response tests', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: agents[1].name, exact: true }).uncheck();
  await page.getByLabel('Choose visible agents').click();
  await caption('Route work. Watch it happen. Steer the result.');
  await page.waitForTimeout(2300);
  assert.deepEqual(errors, []);
} finally {
  await page.close();
  await video.saveAs(`${out}/features.webm`);
  await browser.close();
}
