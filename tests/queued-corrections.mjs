import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const agent = { id: 'correction-session', name: 'Current work', backend: 'codex', model: 'test', cwd: '', status: 'working', updatedAt: Date.now()/1000 };
const task = { id: 'finished-task', text: 'Previous work', agentId: agent.id, status: 'done', images: [], blockedByTaskId: '', createdAt: 1, updatedAt: 1, position: 0 };
const notes = [];
const timeline = [];
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(5000);
  await page.route('**/api/events', r => r.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' }));
  await page.route('**/api/state', r => r.fulfill({ json: { mode: 'ask', agents: [agent], archived: [], messages: {}, tasks: [task], taskNotes: notes, inbox: [], paneLinks: {}, tags: {}, boards: [], sources: [], models: [], backends: [] } }));
  await page.route('**/api/agents/*', r => r.fulfill({ json: { agent, timeline, delivery: 'steer' } }));
  const requests = [];
  await page.route('**/api/tasks', r => r.fulfill({ status: 400, json: { error: 'Correction must target the existing task' } }));
  await page.route('**/api/tasks/finished-task/correction', async r => {
    const body = r.request().postData();
    requests.push(body);
    const queued = body.includes('name="queued"\r\n\r\ntrue');
    const form = await new Response(body, { headers: { 'content-type': r.request().headers()['content-type'] } }).formData();
    const text = form.get('text').trim() || 'Not yet';
    task.status = 'incomplete';
    notes.push({ id: `note-${notes.length}`, taskId: task.id, text, agentId: '', at: Date.now()/1000 });
    if (!queued) timeline.push({ id: timeline.length + 1, agentId: agent.id, kind: 'you', text, detail: '', at: Date.now()/1000 });
    await r.fulfill({ json: task });
  });
  await page.goto(`${process.env.TEST_URL ?? 'http://localhost:3941'}/?agent=${agent.id}`);
  await page.getByRole('button', { name: 'Show or hide tasks', exact: true }).click();
  const composer = page.locator('[data-composer]');
  for (const [key, queued, feedback] of [['Tab', 'true', 'Another pass via Tab'], ['Enter', 'false', 'Another pass via Enter'], ['Enter', 'false', ''], ['Tab', 'true', '   ']]) {
    task.status = 'done';
    await page.goto(`${process.env.TEST_URL ?? 'http://localhost:3941'}/?agent=${agent.id}`);
    await page.getByRole('button', { name: 'Not yet', exact: true }).click();
    await composer.fill(feedback);
    assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isEnabled(), true);
    const previousMessages = timeline.length;
    const request = page.waitForRequest('**/api/tasks/finished-task/correction');
    await composer.press(key);
    const body = (await request).postData();
    assert.ok(body.includes(`name="queued"\r\n\r\n${queued}`));
    assert.ok(body.includes(`name="text"\r\n\r\n${feedback.trim()}\r\n`));
    await page.waitForTimeout(100);
    assert.equal(await composer.inputValue(), '');
    await page.locator('[data-task-row] li').filter({ hasText: feedback.trim() || 'Not yet' }).first().waitFor();
    assert.equal(await page.getByRole('button', { name: 'Not yet', exact: true }).count(), 0);
    if (key === 'Tab') {
      assert.equal(timeline.length, previousMessages);
      if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
    }
  }
  await composer.press('Enter');
  assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isEnabled(), false);
  assert.equal(requests.length, 4, 'Empty correction is allowed; an ordinary empty message is still ignored');
  console.log('Passed: Enter and Tab reopen tasks with optional feedback; Tab stays off chat.');
} finally { await browser.close(); }
