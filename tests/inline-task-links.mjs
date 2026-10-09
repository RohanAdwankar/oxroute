import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const agent = { id: 'reference-fixture', name: 'References', status: 'complete', backend: 'codex', model: 'fixture', updatedAt: Date.now()/1000 };
const tasks = ['a', 'b'].map((letter, index) => ({ id: `task_${letter.repeat(32)}`, text: ['Inspect a change', 'Validate a release'][index], status: index ? 'complete' : 'incomplete', agentId: agent.id, blockedByTaskId: '', images: [], createdAt: index, updatedAt: index }));
const unknown = `task_${'e'.repeat(32)}`;
const text = `See ${tasks[0].id} and \`${tasks[1].id}\`. Unknown ${unknown}. Lookalike ${tasks[0].id}extra.\n\n\`\`\`text\n${tasks[0].id}\n\`\`\`\n\n[Existing link](https://example.invalid/${tasks[0].id})`;
const timeline = [{ id: 1, agentId: agent.id, kind: 'said', text, at: Date.now()/1000, detail: '' },
  { id: 2, agentId: agent.id, kind: 'notice', text: `Resuming open work:\n- ${tasks[0].id}\n- ${tasks[1].id}`, at: Date.now()/1000, detail: '' }];
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  await page.route('**/api/state', r => r.fulfill({ json: { mode: 'ask', agents: [agent], archived: [], messages: {}, tasks, taskNotes: [], inbox: [], paneLinks: {}, tags: {}, boards: [], sources: [], models: [], backends: [] } }));
  await page.route('**/api/events', r => r.fulfill({ contentType: 'text/event-stream', body: ': test\n\n' }));
  await page.route('**/api/agents/*', r => r.fulfill({ json: { agent, timeline, delivery: 'start' } }));
  await page.route('**/api/terminals', r => r.fulfill({ json: [] }));
  const writes = [];
  page.on('request', r => { if (r.method() !== 'GET') writes.push(r.url()); });
  await page.goto(`${process.env.TEST_URL ?? 'http://127.0.0.1:3946'}/?agent=${agent.id}`);
  const message = page.locator('[data-entry="1"]');
  await message.getByRole('button', { name: `Task ${tasks[0].text}`, exact: true }).waitFor();
  assert.equal(await message.getByRole('button', { name: /^Task / }).count(), 2);
  assert.ok((await message.innerText()).includes(unknown));
  assert.ok((await message.innerText()).includes(`${tasks[0].id}extra`));
  assert.equal((await message.locator('pre').innerText()).trim(), tasks[0].id);
  assert.equal(await message.getByRole('link', { name: 'Existing link' }).getAttribute('href'), `https://example.invalid/${tasks[0].id}`);
  const notice = page.locator('[data-entry="2"]');
  assert.equal(await notice.getByRole('button', { name: /^Task / }).count(), tasks.length, 'Resume notices show task previews');
  for (const task of tasks) assert.equal((await notice.innerText()).split(task.text).length - 1, 1, 'Notice titles appear once');
  for (const task of tasks) {
    await message.getByRole('button', { name: `Task ${task.text}`, exact: true }).click();
    await page.locator('[data-task-row]').filter({ hasText: task.text }).waitFor();
    assert.equal(await page.locator('[data-task-row]').filter({ hasText: task.text }).getAttribute('aria-current'), 'true');
  }
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  assert.deepEqual(writes, []);
  console.log('Inline task references reveal matching open and completed tasks without mutations.');
} finally { await browser.close(); }
