import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const agent = { id: 'syntax-test', name: 'Syntax test', cwd: '/workspace', backend: 'codex', model: 'test', status: 'complete', updatedAt: 1 };
const cases = [
  { path: 'settings.ts', before: 'const label = "before"; const limit = 20;', after: 'const label = "after"; const limit = 40;', changes: ['after', '40'] },
  { path: 'worker.py', before: 'return load("旧")', after: 'return load("新")', changes: ['新'] },
  { path: 'options.json', before: '{"enabled": false, "limit": 20}', after: '{"enabled": true, "limit": 20}', changes: ['true'] },
  { path: 'notes.txt', before: '<b>read & keep</b>', after: '<b>read & save</b>', changes: ['save'] },
  { path: 'block.js', before: '/* opening\nold comment\n*/\nconst count = 20;', after: '/* opening\nnew comment\n*/\nconst extra = true;\nconst count = 40;', changes: ['new', 'extra', '40'] },
];
const files = cases.map(item => ({ path: item.path, patch: '@@ -1 +1 @@\n' + item.before.split('\n').map(line => '-' + line).join('\n') + '\n' + item.after.split('\n').map(line => '+' + line).join('\n') }));
const review = { id: 'syntax-review', title: 'Syntax and changed words', description: '', status: 'pending', snapshot: { repository: '/workspace', branch: 'change', baseRef: 'main', remote: 'origin', remoteUrl: '', baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), files } };
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  await page.route('**/api/state', r => r.fulfill({ json: { mode: 'ask', agents: [agent], archived: [], messages: {}, tasks: [], taskNotes: [], inbox: [], paneLinks: {}, tags: {}, boards: [], sources: [], models: [], backends: [] } }));
  await page.route('**/api/events', r => r.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' }));
  await page.route('**/api/agents/*', r => r.fulfill({ json: { agent, timeline: [{ id: 1, agentId: agent.id, at: 1, kind: 'review', text: review.title, detail: review.id }], delivery: 'start' } }));
  await page.route('**/reviews/syntax-review', r => r.fulfill({ json: review }));
  const writes = [];
  page.on('request', r => { if (r.method() !== 'GET') writes.push(r.url()); });
  await page.goto((process.env.TEST_URL ?? 'http://localhost:3941') + '/?agent=' + agent.id);
  await page.getByRole('button', { name: 'Review ' + review.title, exact: true }).click();
  for (const item of cases) {
    const section = page.getByRole('region', { name: 'Diff ' + item.path, exact: true });
    await section.waitFor();
    const rows = section.locator('[data-diff-line]');
    assert.deepEqual(await rows.evaluateAll(nodes => nodes.slice(1).map(node => node.lastElementChild.textContent)), [
      ...item.before.split('\n').map(line => '-' + line), ...item.after.split('\n').map(line => '+' + line),
    ], 'Source characters survive syntax tokenization, escaping and Unicode');
    const added = rows.filter({ hasText: /^\s*\d*\s*\+/ });
    const changes = (await added.locator('[data-diff-change]').allTextContents()).join('');
    for (const changed of item.changes) assert.ok(changes.includes(changed), changed + ' is emphasized');
    assert.ok(changes.length < item.after.length, 'Common portions are not strongly highlighted');
  }
  const ts = page.getByRole('region', { name: 'Diff settings.ts', exact: true });
  assert.ok(await ts.locator('.hljs-keyword').count(), 'TypeScript syntax has keyword colors');
  const block = page.getByRole('region', { name: 'Diff block.js', exact: true });
  assert.ok((await block.locator('.hljs-comment').allTextContents()).join('').includes('new comment'), 'Multiline syntax carries over lines');
  assert.deepEqual(writes, [], 'Rendering a diff never mutates data');
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  if (process.env.DARK_SCREENSHOT) await page.screenshot({ path: process.env.DARK_SCREENSHOT });
  console.log('Syntax colors, multiple changed words, inserted lines, multiline comments, Unicode and literal source text pass.');
} finally { await browser.close(); }
