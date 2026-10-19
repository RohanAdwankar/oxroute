import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const agent = { id: 'reference-fixture', name: 'References', status: 'complete', backend: 'codex', model: 'fixture', updatedAt: Date.now()/1000 };
const tasks = ['a', 'b', 'c'].map((letter, index) => ({ id: `task_${letter.repeat(32)}`, text: ['Inspect a change', 'Validate a release', 'Review a deployment'][index], status: ['incomplete', 'complete', 'done'][index], agentId: agent.id, blockedByTaskId: '', images: [], createdAt: index, updatedAt: index }));
const archived = { ...agent, id: 'archived-thread', name: 'Earlier release review and compatibility checks' };
tasks[1].agentId = archived.id;
const unknown = `task_${'e'.repeat(32)}`;
const text = `Review ${tasks[2].id}. See ${tasks[0].id} and \`${tasks[1].id}\`. Unknown ${unknown}. Lookalike ${tasks[0].id}extra.\n\n\`\`\`text\n${tasks[0].id}\n\`\`\`\n\n[Existing link](https://example.invalid/${tasks[0].id})`;
const timeline = [{ id: 1, agentId: agent.id, kind: 'said', text, at: Date.now()/1000, detail: '' },
  { id: 2, agentId: agent.id, kind: 'notice', text: `Resuming open work:\n- ${tasks[0].id}\n- ${tasks[1].id}\n- ${tasks[2].id}`, at: Date.now()/1000, detail: '' }];
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  await page.route('**/api/state', r => r.fulfill({ json: { mode: 'ask', agents: [agent], archived: [archived], messages: {}, tasks, taskNotes: [], inbox: [], paneLinks: {}, tags: {}, boards: [], sources: [], models: [], backends: [] } }));
  await page.route('**/api/events', r => r.fulfill({ contentType: 'text/event-stream', body: ': test\n\n' }));
  await page.route('**/api/agents/*', r => r.fulfill({ json: { agent: r.request().url().endsWith(archived.id) ? archived : agent, timeline, delivery: 'start' } }));
  await page.route('**/api/terminals', r => r.fulfill({ json: [] }));
  let fail = false;
  await page.route('**/api/tasks/*', async r => {
    const body = r.request().postDataJSON();
    if (fail) return r.fulfill({ status: 500, json: { error: 'Could not save approval' } });
    assert.equal(body.status, 'complete');
    assert.equal(body.approved, true);
    assert.equal(body.note, 'approved');
    tasks[2] = { ...tasks[2], ...body };
    await r.fulfill({ json: tasks[2] });
  });
  const writes = [];
  page.on('request', r => { if (r.method() !== 'GET') writes.push(r.url()); });
  await page.goto(`${process.env.TEST_URL ?? 'http://127.0.0.1:3946'}/?agent=${agent.id}`);
  const message = page.locator('[data-entry="1"]');
  await message.getByRole('button', { name: `Task ${tasks[0].text}`, exact: true }).waitFor();
  assert.equal(await message.getByRole('button', { name: /^Task / }).count(), 3);
  assert.ok((await message.innerText()).includes(unknown));
  assert.ok((await message.innerText()).includes(`${tasks[0].id}extra`));
  assert.equal((await message.locator('pre').innerText()).trim(), tasks[0].id);
  assert.equal(await message.getByRole('link', { name: 'Existing link' }).getAttribute('href'), `https://example.invalid/${tasks[0].id}`);
  for (const task of tasks) {
    const label = message.locator(`[data-task-reference="${task.id}"] [data-task-thread]`);
    assert.equal(await label.innerText(), task.agentId === archived.id ? archived.name : agent.name);
  }
  const longLabel = message.locator(`[data-task-reference="${tasks[1].id}"] [data-task-thread]`);
  assert.equal(await longLabel.getAttribute('title'), archived.name);
  assert.ok(await longLabel.evaluate(el => el.scrollWidth > el.clientWidth), 'Long thread names truncate with their full title retained');
  const notice = page.locator('[data-entry="2"]');
  assert.equal(await notice.getByRole('button', { name: /^Task / }).count(), tasks.length, 'Resume notices show task previews');
  for (const task of tasks) assert.equal((await notice.innerText()).split(task.text).length - 1, 1, 'Notice titles appear once');
  for (const task of tasks) {
    await message.getByRole('button', { name: `Task ${task.text}`, exact: true }).click();
    await page.locator('[data-task-row]').filter({ hasText: task.text }).waitFor();
    await page.locator('[data-task-row][aria-current="true"]').filter({ hasText: task.text }).waitFor();
  }
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  assert.deepEqual(writes, []);
  const reference = message.locator(`[data-task-reference="${tasks[2].id}"]`);
  await reference.getByRole('button', { name: 'Not yet', exact: true }).click();
  await page.getByText(`Not yet: ${tasks[2].text}`, { exact: true }).waitFor();
  assert.deepEqual(writes, [], 'Correction opens the existing composer without changing a task');
  // Failed approval must leave the same controls available to retry.
  fail = true;
  await reference.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByText('Could not save approval', { exact: true }).waitFor();
  await reference.getByRole('button', { name: 'Approve', exact: true }).waitFor();
  fail = false;

  await reference.getByRole('button', { name: 'Approve', exact: true }).click();
  await reference.getByText('Approved', { exact: true }).waitFor();
  assert.equal(await reference.getByRole('button', { name: 'Approve', exact: true }).count(), 0);
  assert.equal(await page.locator('[data-task-row]').filter({ hasText: tasks[2].text }).locator('select').first().inputValue(), 'complete');
  assert.equal(writes.length, 2, 'One failed request and one explicit retry');
  const archivedLink = message.locator(`[data-task-reference="${tasks[1].id}"]`).getByRole('button', { name: `Open thread ${archived.name}`, exact: true });
  await archivedLink.click();
  await page.waitForURL(url => url.searchParams.get('agent') === archived.id);
  console.log('Task references support navigation, inline approval, correction, failure recovery and synchronized task status.');
} finally { await browser.close(); }
