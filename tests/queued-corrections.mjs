import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const agent = { id: 'correction-session', name: 'Current work', backend: 'codex', model: 'test', cwd: '', status: 'working', updatedAt: Date.now()/1000 };
const task = { id: 'finished-task', text: 'Previous work', agentId: agent.id, status: 'done', images: [], blockedByTaskId: '', createdAt: 1, updatedAt: 1, position: 0 };
const notes = [];
const timeline = [];
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.route('**/api/events', r => r.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' }));
  await page.route('**/api/state', r => r.fulfill({ json: { mode: 'ask', agents: [agent], archived: [], messages: {}, tasks: [task], taskNotes: notes, inbox: [], paneLinks: {}, tags: {}, boards: [], sources: [], models: [], backends: [] } }));
  await page.route('**/api/agents/*', r => r.fulfill({ json: { agent, timeline, delivery: 'steer' } }));
  const requests = [];
  await page.route('**/api/tasks', r => r.fulfill({ status: 400, json: { error: 'Correction must target the existing task' } }));
  await page.route('**/api/tasks/finished-task/correction', async r => {
    const body = r.request().postData();
    requests.push(body);
    const queued = body.includes('name="queued"\r\n\r\ntrue');
    const text = `Another pass via ${queued ? 'Tab' : 'Enter'}`;
    task.status = 'incomplete';
    notes.push({ id: `note-${notes.length}`, taskId: task.id, text, agentId: '', at: Date.now()/1000 });
    if (!queued) timeline.push({ id: 1, agentId: agent.id, kind: 'you', text, detail: '', at: Date.now()/1000 });
    await r.fulfill({ json: task });
  });
  await page.goto(`${process.env.TEST_URL ?? 'http://localhost:3941'}/?agent=${agent.id}`);
  await page.getByRole('button', { name: 'Show or hide tasks', exact: true }).click();
  const composer = page.locator('[data-composer]');
  for (const [key, queued] of [['Tab', 'true'], ['Enter', 'false']]) {
    task.status = 'done';
    if (key === 'Enter') await page.goto(`${process.env.TEST_URL ?? 'http://localhost:3941'}/?agent=${agent.id}`);
    await page.getByRole('button', { name: 'Not yet', exact: true }).click();
    await composer.fill(`Another pass via ${key}`);
    const request = page.waitForRequest('**/api/tasks/finished-task/correction');
    await composer.press(key);
    const body = (await request).postData();
    assert.ok(body.includes(`name="queued"\r\n\r\n${queued}`));
    assert.ok(body.includes(`Another pass via ${key}`));
    await page.waitForTimeout(100);
    assert.equal(await composer.inputValue(), '');
    await page.locator('[data-task-row] li').filter({ hasText: `Another pass via ${key}` }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Not yet', exact: true }).count(), 0);
    if (key === 'Tab') {
      assert.equal(timeline.length, 0);
      if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
    }
  }
  assert.equal(requests.length, 2, 'Both actions correct the existing task');
  console.log('Passed: Tab saves feedback on the reopened task without chat; Enter sends immediately.');
} finally { await browser.close(); }
