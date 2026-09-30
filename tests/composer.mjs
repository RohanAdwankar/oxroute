import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.TEST_URL ?? 'http://localhost:3941';
const agent = {
  id: 'test-session', name: 'Test chat', backend: 'codex', model: 'test-model',
  sessionId: '', cwd: '', status: 'complete', activity: '', permalink: '',
  lastActivity: 0, updatedAt: Date.now()/1000, stallReason: null,
  stallAlerted: false, pinned: false,
};
const state = {
  mode: 'ask', defaultModel: agent.model, agents: [agent], archived: [],
  tasks: [], taskNotes: [], inbox: [], paneLinks: {}, tags: {}, boards: [],
  messages: {}, sources: [], models: [], backends: [],
};
let entries = [];
let failTask = false, failMessage = false;
const submitted = new Map();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.addInitScript(() => {
  window.EventSource = class {
    constructor() { window.testStream = this; }
    close() {}
  };
});
const emit = event => page.evaluate(event => window.testStream.onmessage({ data: JSON.stringify(event) }), event);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
await page.route('**/api/state', r => r.fulfill({ json: state }));
await page.route('**/api/agents/*', r => r.fulfill({ json: { agent, timeline: entries, delivery: 'start' } }));
await page.route('**/api/tasks', async r => {
  const body = r.request().postDataJSON();
  assert.equal(body.agentId, agent.id);
  await delay(1000);
  if (failTask) return r.fulfill({ status: 500, json: { error: 'Save rejected' } });
  const at = Date.now() / 1000;
  const task = { ...body, id: crypto.randomUUID(), status: 'incomplete', blockedByTaskId: '', images: [], createdAt: at, updatedAt: at };
  state.tasks.push(task);
  await emit({ type: 'sync' });
  // The saved row must replace the optimistic row even before acknowledgement.
  await delay(700);
  assert.equal(await page.locator('[data-task-open]').filter({ hasText: body.text }).count(), 1);
  await r.fulfill({ json: task });
});
await page.route('**/api/say', async r => {
  const body = r.request().postDataJSON();
  assert.equal(body.agent, agent.id);
  submitted.set(body.text, (submitted.get(body.text) ?? 0) + 1);
  await delay(submitted.get(body.text) > 1 ? 2100 : 1000);
  if (failMessage) return r.fulfill({ status: 500, json: { error: 'Message rejected' } });
  const entry = { id: entries.length + 1, agentId: agent.id, at: Date.now()/1000, kind: 'you', text: body.text, detail: '', output: '', origin: '', reaction: '' };
  entries.push(entry);
  await emit({ type: 'timeline', entry });
  await delay(500);
  assert.equal(await page.locator('[data-transcript]').getByText(body.text, { exact: true }).count(), submitted.get(body.text));
  await r.fulfill({ json: { ok: true } });
});
await page.goto(`${base}/?agent=${agent.id}`);
const composer = page.locator('[data-composer]');
await composer.waitFor();
const taskText = `task ${crypto.randomUUID()}`;
await composer.fill(taskText);
let start = performance.now();
await composer.press('Tab');
await page.locator('[data-task-open]').filter({ hasText: taskText }).waitFor();
console.log('Task visible:', Math.round(performance.now()-start), 'ms');
assert.ok(performance.now()-start < 700);
await delay(1900);
failTask = true;
const retryTask = `retry task ${crypto.randomUUID()}`;
await composer.fill(retryTask);
await composer.press('Tab');
await delay(1200);
assert.equal(await composer.inputValue(), retryTask);
assert.equal(await page.locator('[data-task-open]').filter({ hasText: retryTask }).count(), 0);
const text = `message ${crypto.randomUUID()}`;
await composer.fill(text);
start = performance.now();
await composer.press('Enter');
await page.locator('[data-transcript]').getByText(text, { exact: true }).waitFor();
console.log('Message visible:', Math.round(performance.now()-start), 'ms');
assert.ok(performance.now()-start < 700);
await delay(1700);
assert.equal(await page.locator('[data-transcript]').getByText(text, { exact: true }).count(), 1);
// Identical successive messages reconcile one-for-one, not as a single message.
const twice = `repeat ${crypto.randomUUID()}`;
for (let i=0; i<2; i++) { await composer.fill(twice); await composer.press('Enter'); }
await delay(2900);
assert.equal(await page.locator('[data-transcript]').getByText(twice, { exact: true }).count(), 2);
failMessage = true;
const retry = `retry message ${crypto.randomUUID()}`;
await composer.fill(retry); await composer.press('Enter'); await delay(1200);
assert.equal(await composer.inputValue(), retry);
assert.equal(await page.locator('[data-transcript]').getByText(retry, { exact: true }).count(), 0);
if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
await browser.close();
console.log('Passed assignment, immediate updates, early-event deduplication, successive sends, and failure recovery; no real submissions sent.');

