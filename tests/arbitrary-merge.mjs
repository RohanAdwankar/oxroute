import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const now = Date.now()/1000;
const source = { id: 'research', name: 'Investigation', backend: 'codex', model: 'fixture', status: 'complete', updatedAt: now };
const target = { ...source, id: 'implementation', name: 'Implementation', backend: 'claude-code' };
const archived = { ...target, id: 'notes', name: 'Archived notes' };
const fork = { ...source, id: 'experiment', name: 'Experiment' };
const entries = {
  [source.id]: [{ id: 1, agentId: source.id, kind: 'said', at: now, text: 'The investigation found a simpler approach.', detail: '' }],
  [fork.id]: [{ id: 2, agentId: fork.id, kind: 'forkedFrom', at: now, text: 'Forked from Investigation', detail: source.id }],
};
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
  await page.addInitScript(() => { window.SharedWorker = undefined; window.EventSource = class extends EventTarget { close() {} }; });
  let retired = false, failNext = false;
  const requests = [];
  await page.route('**/api/state', r => r.fulfill({ json: {
    mode: 'ask', agents: [source, target, fork].filter(agent => !retired || agent.id !== source.id), archived: [archived, ...(retired ? [source] : [])], messages: {}, tasks: [], taskNotes: [], inbox: [], paneLinks: {}, tags: {}, boards: [], sources: [], models: [],
    backends: [{ backend: 'codex', fork: true, merge: true }, { backend: 'claude-code', fork: true, merge: false }],
  } }));
  await page.route('**/api/terminals', r => r.fulfill({ json: [] }));
  await page.route('**/api/agents/*', r => {
    const id = r.request().url().split('/').pop();
    return r.fulfill({ json: { agent: [source, target, archived, fork].find(agent => agent.id === id), timeline: entries[id] ?? [], delivery: 'start' } });
  });
  await page.route('**/api/merge', r => {
    const body = r.request().postDataJSON(); requests.push(body);
    if (failNext) { failNext = false; return r.fulfill({ status: 500, body: 'Merge unavailable' }); }
    if (body.archive) retired = true;
    return r.fulfill({ json: { agent: body.into ? target : source } });
  });
  await page.goto(`${process.env.TEST_URL ?? 'http://127.0.0.1:3942'}/?agent=${source.id}`);
  const sourcePane = page.locator(`[data-agent-pane="${source.id}"]`);
  const choose = async () => {
    await sourcePane.getByRole('button', { name: `Move pane ${source.id}`, exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Merge into…', exact: true }).click();
  };
  await choose();
  const picker = page.getByRole('dialog', { name: 'Merge into thread' });
  await picker.getByRole('button', { name: archived.name, exact: true }).waitFor();
  assert.equal(await picker.getByRole('button', { name: source.name, exact: true }).count(), 0);
  assert.equal(await picker.getByRole('checkbox', { name: 'Archive source' }).isChecked(), false);
  await picker.getByRole('textbox', { name: 'Find destination thread' }).fill('no matching destination');
  await picker.getByText('No matching threads', { exact: true }).waitFor();
  assert.equal(requests.length, 0);
  await picker.getByRole('textbox', { name: 'Find destination thread' }).fill('implement');
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  await picker.getByRole('button', { name: target.name, exact: true }).click();
  await page.locator(`[data-agent-pane="${target.id}"]`).waitFor();
  assert.deepEqual(requests[0], { agent: source.id, into: target.id, archive: false });
  assert.equal(await sourcePane.count(), 1, 'Passing context keeps the source pane');

  await choose();
  await picker.getByRole('checkbox', { name: 'Archive source' }).check();
  failNext = true;
  await picker.getByRole('button', { name: target.name, exact: true }).click();
  await page.getByText('Merge unavailable', { exact: true }).waitFor();
  assert.equal(await sourcePane.count(), 1, 'A failed merge keeps the source available');
  await choose();
  await picker.getByRole('checkbox', { name: 'Archive source' }).check();
  await picker.getByRole('button', { name: target.name, exact: true }).click();
  await sourcePane.waitFor({ state: 'detached' });
  assert.equal(requests.at(-1).archive, true);

  await page.goto(`${process.env.TEST_URL ?? 'http://127.0.0.1:3942'}/?agent=${fork.id}`);
  await page.getByRole('button', { name: 'merge into parent', exact: true }).click();
  await page.locator(`[data-agent-pane="${source.id}"]`).waitFor();
  assert.equal(requests.at(-1).agent, fork.id);
  assert.equal(requests.at(-1).into, undefined, 'Existing fork merge keeps its direct-parent request');
  console.log('Unrelated threads merge across backends; filtering, archived destinations, optional retirement, failure recovery, and the existing parent merge work.');
} finally { await browser.close(); }
