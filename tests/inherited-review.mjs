import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const source = { id: 'source-review-thread', name: 'Original discussion', cwd: '/workspace', backend: 'codex', model: 'fixture', status: 'complete', updatedAt: 1 };
const fork = { ...source, id: 'fork-review-thread', name: 'Continued discussion' };
const review = { id: 'inherited-review', agentId: source.id, title: 'Adjust cache duration', description: '', status: 'pending', snapshot: { repository: '/workspace', remote: 'origin', remoteUrl: 'https://example.invalid/project', branch: 'change', baseRef: 'main', baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), files: [{ path: 'settings.ts', patch: '@@ -1 +1 @@\n-const ttl = 20;\n+const ttl = 30;' }] } };
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
  await page.route('**/api/state', r => r.fulfill({ json: { mode: 'ask', agents: [fork, source], archived: [], messages: {}, tasks: [], taskNotes: [], inbox: [], paneLinks: {}, tags: {}, boards: [], sources: [], models: [], backends: [] } }));
  await page.route('**/api/events', r => r.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' }));
  await page.route('**/api/terminals', r => r.fulfill({ json: [] }));
  await page.route('**/api/agents/*', r => {
    const agent = r.request().url().endsWith(fork.id) ? fork : source;
    return r.fulfill({ json: { agent, timeline: [{ id: 1, agentId: agent.id, kind: 'review', text: review.title, detail: review.id, at: 1 }], delivery: 'start' } });
  });
  await page.route('**/reviews/inherited-review', r => r.fulfill({ json: review }));
  const approvals = [];
  await page.route('**/reviews/inherited-review/approve', r => {
    approvals.push(new URL(r.request().url()).pathname);
    return r.fulfill({ json: { ...review, status: 'approved' } });
  });
  await page.goto(`${process.env.TEST_URL ?? 'http://127.0.0.1:3942'}/?agent=${fork.id}`);
  await page.getByRole('button', { name: 'Review ' + review.title, exact: true }).click();
  await page.locator('[data-diff-line]').filter({ hasText: '+const ttl = 30;' }).waitFor();
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  await page.getByRole('button', { name: 'Approve publication', exact: true }).click();
  await page.getByRole('button', { name: 'Review ' + review.title, exact: true }).waitFor();
  assert.deepEqual(approvals, [`/api/agents/${source.id}/reviews/${review.id}/approve`]);
  console.log('Inherited reviews render in forks; explicit approval targets the original review and publishing conversation.');
} finally { await browser.close(); }
