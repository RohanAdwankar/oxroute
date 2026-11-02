import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Run against an isolated daemon with a long conversation, never the shared service.
const base = process.env.TEST_URL;
const api = process.env.TEST_API;
const agentId = process.env.TEST_AGENT;
assert.ok(base && api && agentId);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.addInitScript(() => {
  window.SharedWorker = class {
    port = { postMessage() {}, close() {} };
    constructor() { window.testStream = this.port; }
  };
});
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/version') return route.continue();
  await route.fulfill({ response: await page.request.fetch(`${api}${url.pathname}${url.search}`, {
    method: route.request().method(), data: route.request().postDataBuffer() ?? undefined,
    headers: { 'content-type': 'application/json' },
  }) });
});
const boards = [];
const suffix = crypto.randomUUID().slice(0, 8);
try {
  for (const name of ['Workflow', 'Research']) {
    const response = await page.request.post(`${api}/api/boards`, { data: { name: `${name} ${suffix}` } });
    assert.equal(response.status(), 200);
    boards.push(await response.json());
  }
  await page.goto(base);
  await page.getByRole('button', { name: 'Show boards', exact: true }).click();
  const choose = page.getByRole('combobox', { name: 'Choose board', exact: true });
  await choose.waitFor();
  assert.equal(await page.locator('header nav button').count(), 3);
  await choose.selectOption(boards[1].id);
  await page.getByRole('button', { name: boards[1].name, exact: true }).waitFor();
  await page.getByRole('button', { name: 'Create board', exact: true }).click();
  await page.waitForFunction(previous => !previous.includes(document.querySelector('[aria-label="Choose board"]')?.value), boards.map(b => b.id));
  const createdBoardId = await choose.inputValue();
  boards.push({ id: createdBoardId });
  if (process.env.ARTIFACT_DIR) await page.screenshot({ path: `${process.env.ARTIFACT_DIR}/boards.png` });
  await page.getByRole('button', { name: 'New agent', exact: true }).click();
  await page.locator('[data-composer]').waitFor();
  const createdId = new URL(page.url()).searchParams.get('agent');
  assert.ok(createdId && createdId !== agentId);
  const created = await (await page.request.get(`${api}/api/agents/${createdId}`)).json();
  assert.equal(created.timeline.length, 0);
  assert.equal(created.agent.sessionId, '');
  assert.equal(created.agent.status, 'complete');
  if (process.env.ARTIFACT_DIR) await page.screenshot({ path: `${process.env.ARTIFACT_DIR}/new-agent.png` });
  await page.getByRole('button', { name: 'Show the fleet', exact: true }).click();
  await page.getByText('Fleet', { exact: true }).waitFor();

  await page.goto(`${base}/?agent=${agentId}`);
  const transcript = page.locator('[data-transcript]');
  await transcript.waitFor();
  await page.getByRole('button', { name: 'Load earlier messages', exact: true }).waitFor();
  let pages = 1;
  while (await page.getByRole('button', { name: 'Load earlier messages', exact: true }).count()) {
    const first = await transcript.locator('[data-entry]').first().getAttribute('data-entry');
    await transcript.evaluate(node => { node.scrollTop = 100; });
    await page.waitForTimeout(50);
    const anchorId = await transcript.evaluate(node => [...node.querySelectorAll('[data-entry]')].find(entry => entry.getBoundingClientRect().top >= node.getBoundingClientRect().top + 10)?.getAttribute('data-entry'));
    const anchor = transcript.locator(`[data-entry="${anchorId}"]`);
    const id = await anchor.getAttribute('data-entry');
    const top = (await anchor.boundingBox()).y;
    const zoom = await transcript.evaluate(node => node.getBoundingClientRect().height / node.offsetHeight);
    await transcript.evaluate(node => { node.scrollTop = 0; });
    await page.waitForFunction(first => document.querySelector('[data-transcript] [data-entry]')?.getAttribute('data-entry') !== first, first);
    await page.waitForTimeout(150);
    const position = await transcript.locator(`[data-entry="${id}"]`).boundingBox();
    // The reader moved 100px before loading; prepending keeps that position.
    assert.ok(Math.abs(position.y - (top + 100 * zoom)) < 8, `Scroll anchor moved: ${position.y - top}`);
    pages++;
    assert.ok(pages < 30);
  }

  await transcript.evaluate(node => { node.scrollTop = 0; });
  const firstId = Number(await transcript.locator('[data-entry]').first().getAttribute('data-entry'));
  let expectedFirst;
  let cursor;
  do {
    const response = await (await page.request.get(`${api}/api/agents/${agentId}${cursor ? `?before=${cursor}` : ''}`)).json();
    expectedFirst = response.timeline[0]?.id ?? expectedFirst;
    cursor = response.hasEarlier ? expectedFirst : undefined;
  } while (cursor);
  assert.equal(firstId, expectedFirst);
  await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === `/api/agents/${agentId}`),
    page.evaluate(() => window.testStream.onmessage({ data: JSON.stringify({ type: 'sync' }) })),
  ]);
  await page.waitForTimeout(100);
  assert.equal(Number(await transcript.locator('[data-entry]').first().getAttribute('data-entry')), firstId);
  assert.equal(await page.getByRole('button', { name: 'Load earlier messages', exact: true }).count(), 0);
  if (process.env.ARTIFACT_DIR) await page.screenshot({ path: `${process.env.ARTIFACT_DIR}/history-start.png` });
  console.log(JSON.stringify({ boards: 'switch/create passed', newAgent: 'empty card passed', historyPages: pages, earliestVisibleEntry: firstId }));
} finally {
  for (const board of boards) await page.request.delete(`${api}/api/boards/${board.id}`);
  await browser.close();
}
