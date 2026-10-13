import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const agent = { id: 'terminal-owner', name: 'Terminal owner', cwd: '/workspace', backend: 'codex', model: 'test', status: 'complete', updatedAt: 1 };
let terminals = [
  { id: 'terminal_other', name: 'Other conversation', agentId: 'other', granted: ['other'], pending: [] },
  { id: 'terminal_user', name: 'User shell', agentId: '', granted: [], pending: [] },
];
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript(() => {
    window.EventSource = class {
      constructor() { window.fixtureEvents = this; }
      close() {}
    };
  });
  await page.route('**/api/state', r => r.fulfill({ json: { mode: 'ask', agents: [agent], archived: [], messages: {}, tasks: [], taskNotes: [], inbox: [], paneLinks: {}, tags: {}, boards: [], sources: [], models: [], backends: [] } }));
  await page.route('**/api/agents/*', r => r.fulfill({ json: { agent, timeline: [], delivery: 'start' } }));
  const writes = [], reads = new Map();
  // All terminal interactions, including human controls, are fixture requests.
  await page.route('**/api/terminals{,/**}', async r => {
    const request = r.request(), path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') writes.push({ path, body: request.postDataJSON() });
    if (path === '/api/terminals') return r.fulfill({ json: terminals });
    const id = path.split('/')[3], terminal = terminals.find(t => t.id === id);
    if (path.endsWith('/claim')) return r.fulfill({ json: { controller: 'fixture-owner' } });
    if (path.endsWith('/consent')) {
      terminal.granted = [];
      return r.fulfill({ json: terminal });
    }
    if (request.method() !== 'GET') return r.fulfill({ json: { ok: true } });
    const count = reads.get(id) ?? 0;
    reads.set(id, count + 1);
    if (count) await new Promise(resolve => setTimeout(resolve, 200));
    const bytes = new URL(request.url()).searchParams.get('after') === '0' ? [...Buffer.from('Agent workspace ready.\r\n')] : [];
    return r.fulfill({ json: { terminal, bytes, end: 23, reset: false } }).catch(() => {});
  });
  await page.goto((process.env.TEST_URL ?? 'http://localhost:3941') + '/?agent=' + agent.id);
  await page.locator('[data-agent-pane]').waitFor();
  assert.equal(await page.locator('[data-terminal-pane]').count(), 0, 'Other conversations and user terminals do not pop open');
  for (let index = 1; index <= 2; index++) {
    terminals.push({ id: 'terminal_owned' + index, name: 'Agent shell ' + index, agentId: agent.id, granted: [agent.id], pending: [] });
    await page.evaluate(() => window.fixtureEvents.onmessage({ data: JSON.stringify({ type: 'sync' }) }));
    await page.locator('[data-terminal-pane="terminal_owned' + index + '"]').waitFor();
  }
  assert.equal(await page.locator('[data-terminal-pane]').count(), 2, 'Both new terminals appear beside their conversation');
  const pane = page.locator('[data-terminal-pane="terminal_owned1"]');
  await pane.getByText('Agent workspace ready.', { exact: false }).waitFor();
  await pane.getByText(agent.name + ' can write', { exact: true }).waitFor();
  assert.equal(await pane.getByRole('alertdialog').count(), 0, 'Creator already has access without a consent dialog');
  await pane.locator('.xterm:visible .xterm-helper-textarea').focus();
  await page.keyboard.type('user input');
  await page.waitForTimeout(100);
  assert.ok(writes.some(w => w.path.endsWith('/input') && w.body.controller === 'fixture-owner'), 'The human can type in the agent-created pane');
  await pane.getByRole('button', { name: 'Revoke', exact: true }).click();
  assert.ok(writes.some(w => w.path.endsWith('/consent') && w.body.allow === false), 'The human retains revocation controls');
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  await page.reload();
  await page.locator('[data-terminal-pane="terminal_owned1"]').waitFor();
  assert.equal(await page.locator('[data-terminal-pane]').count(), 2, 'Attached terminals survive reloading their conversation');
  assert.ok(!writes.some(w => w.path.endsWith('/access')), 'UI never asks the agent for consent to its own terminal');
  console.log('Agent-created panes appear automatically, stay attached, and retain human input/revocation controls.');
} finally { await browser.close(); }
