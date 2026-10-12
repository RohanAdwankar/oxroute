import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const agent = { id: 'review-loading', name: 'Review loading', cwd: '/workspace', backend: 'codex', model: 'fixture', status: 'complete', updatedAt: 1 };
const review = { id: 'loading-review', title: 'Prepared change', description: '', status: 'pending', snapshot: { repository: '/workspace', remote: 'origin', remoteUrl: '', branch: 'proposal', baseRef: 'main', baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), files: [{ path: 'value.ts', patch: '@@ -1 +1 @@\n-const value = 10;\n+const value = 20;\n' }] } };
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 750 } });
  let warming = 0, maxWarming = 0;
  const others = Array.from({ length: 12 }, (_, i) => ({ ...agent, id: "background-" + i, name: "Background " + i }));
  let requests = 0, completed = 0, status = 'pending';
  await page.route('**/api/state', r => r.fulfill({ json: { mode: 'ask', agents: [agent, ...others], archived: [], messages: {}, tasks: [], taskNotes: [], inbox: [], paneLinks: {}, tags: {}, boards: [], sources: [], models: [], backends: [] } }));
  await page.route('**/api/events', r => r.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' }));
  await page.route('**/api/agents/*', async r => {
    const id = new URL(r.request().url()).pathname.split('/').at(-1);
    if (id !== agent.id) {
      maxWarming = Math.max(maxWarming, ++warming);
      await new Promise(resolve => setTimeout(resolve, 250));
      warming--;
      return r.fulfill({ json: { agent: others.find(item => item.id === id), timeline: [], delivery: 'start' } }).catch(() => {});
    }
    return r.fulfill({ json: { agent, timeline: [{ id: 1, agentId: agent.id, kind: 'review', text: review.title, detail: review.id, at: 1 }], delivery: 'start' } });
  });
  await page.route('**/reviews/loading-review', async r => {
    requests++;
    await new Promise(resolve => setTimeout(resolve, 1000));
    await r.fulfill({ json: { ...review, status } });
    completed++;
  });
  await page.goto((process.env.TEST_URL ?? 'http://localhost:3941') + '/?agent=' + agent.id);
  await page.getByRole('button', { name: 'Review Prepared change', exact: true }).waitFor();
  await assertEventually(() => requests === 1, 'Review is requested before it is clicked');
  await assertEventually(() => completed === 1, 'Background preload completes');
  assert.ok(maxWarming <= 2, 'Background history warming reserves capacity for foreground requests');
  const start = Date.now();
  await page.getByRole('button', { name: 'Review Prepared change', exact: true }).click();
  await page.locator('[data-diff-line]').filter({ hasText: '+const value = 20;' }).waitFor();
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 500, 'Opening a prepared review does not wait for the one-second API round trip');
  assert.equal(await page.getByText('Reading review…', { exact: true }).count(), 0);
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  await assertEventually(() => completed === 2, 'Opening refreshes current revision status');
  status = 'stale';
  await page.getByRole('button', { name: 'Back to conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Open change review', exact: true }).click();
  await page.getByText('Revision changed', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Approve publication', exact: true }).isDisabled(), true, 'Preloading retains live approval eligibility checks');
  console.log('Prepared review opened in ' + elapsed + ' ms despite 1000 ms API latency; live staleness checks remain.');
} finally { await browser.close(); }

async function assertEventually(condition, message) {
  const deadline = Date.now() + 5000;
  while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(condition(), message);
}
