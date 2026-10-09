import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const agents = ['North', 'South', 'Archive'].map(name => ({ id: name.toLowerCase(), name, cwd: '/workspace', backend: 'codex', model: 'test', status: 'complete', updatedAt: 1 }));
const tasks = [
  ['Tune storage latency', 'incomplete', 'north'],
  ['Review storage alerts', 'complete', 'south'],
  ['Audit network paths', 'waiting_for_human', 'south'],
  ['Inspect GPU health', 'incomplete', 'archive'],
].map(([text, status, agentId], index) => ({ id: `task-${index}`, text, status, agentId, blockedByTaskId: '', images: [], createdAt: 1, updatedAt: 1, position: index }));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const writes = [];
  page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
  await page.route('**/api/state', route => route.fulfill({ json: { mode: 'ask', agents: agents.slice(0, 2), archived: agents.slice(2), messages: {}, tasks, taskNotes: [], inbox: [], paneLinks: {}, tags: {}, boards: [], sources: [], models: [], backends: [] } }));
  await page.route('**/api/events', route => route.fulfill({ contentType: 'text/event-stream', body: ': test\n\n' }));
  await page.route('**/api/agents/*', route => route.fulfill({ json: { agent: agents.find(agent => route.request().url().endsWith('/' + agent.id)), timeline: [], delivery: 'start' } }));
  await page.goto(process.env.TEST_URL ?? 'http://localhost:3941');
  await page.getByRole('button', { name: 'Show or hide tasks', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Tasks', exact: true });
  const search = panel.getByRole('searchbox', { name: 'Search tasks' });
  const shown = () => panel.locator('[data-task-open]').allTextContents();
  assert.deepEqual(await shown(), [tasks[0].text, tasks[2].text, tasks[3].text]);
  await search.fill('  STORAGE  ');
  assert.deepEqual(await shown(), [tasks[0].text, tasks[1].text], 'Search ignores case/outer spaces and includes completed matches');
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  await search.fill('North');
  assert.deepEqual(await shown(), [tasks[0].text], 'Search matches assigned agent names');
  await search.fill('Archive');
  assert.deepEqual(await shown(), [tasks[3].text], 'Archived assignment names remain searchable');
  await search.fill('No such task');
  assert.deepEqual(await shown(), []);
  assert.ok(await panel.getByText('No matching tasks.', { exact: true }).isVisible());
  await search.fill('');
  assert.deepEqual(await shown(), [tasks[0].text, tasks[2].text, tasks[3].text], 'Clearing restores the previous completed-task visibility');
  await search.fill('network');
  await search.press('Escape');
  await page.keyboard.press('Enter');
  await page.locator('[data-agent-pane="south"]').waitFor();
  assert.equal(new URL(page.url()).searchParams.get('agent'), 'south', 'Keyboard actions target the filtered task');
  await page.getByRole('button', { name: 'Show or hide tasks', exact: true }).click();
  await page.getByRole('button', { name: 'Show or hide tasks', exact: true }).click();
  assert.equal(await search.inputValue(), 'network', 'Search remains while toggling the Tasks tab');
  assert.deepEqual(writes, [], 'Searching never mutates tasks or agents');
  console.log('Task text/name search, completed matches, clearing, keyboard targeting and view toggling pass.');
} finally { await browser.close(); }
