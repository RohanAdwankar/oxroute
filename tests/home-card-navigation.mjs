import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';

const agents = ['Map work', 'Plan work'].map((name, index) => ({
  id: `home-card-${index}`, name, cwd: '/workspace/project', backend: 'codex',
  model: 'fixture', status: 'complete', updatedAt: Date.now() / 1000,
}));
const reviews = agents.map((agent, index) => ({
  id: `proposal-${index}`, agentId: agent.id, title: `Change ${index}`, status: 'pending', description: 'Review this change', full: true,
  snapshot: { repository: agent.cwd, branch: 'proposal', baseRef: 'main', remote: 'origin', remoteUrl: 'https://example.invalid/repo.git',
    baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), files: [{ path: 'settings.txt',
      patch: 'diff --git a/settings.txt b/settings.txt\n--- a/settings.txt\n+++ b/settings.txt\n@@ -1 +1 @@\n-before\n+after\n' }] },
}));
const timeline = index => [
  { id: 1, agentId: agents[index].id, at: 1, kind: 'said', text: `Conversation for ${agents[index].name}`, detail: '' },
  { id: 2, agentId: agents[index].id, at: 2, kind: 'review', text: reviews[index].title, detail: reviews[index].id },
];
const snapshot = { mode: 'ask', agents, archived: [], messages: {}, tasks: [], taskNotes: [], inbox: [], paneLinks: {}, tags: {}, boards: [], sources: [], models: [], backends: [] };
const browser = await (process.env.BROWSER === 'webkit' ? webkit : chromium).launch(
  process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {});
const failures = [];
try {
  // A card always opens its conversation, even if an unrelated review remains in the home URL.
  for (const stale of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const errors = [], writes = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.addInitScript(() => {
      window.SharedWorker = undefined;
      window.EventSource = class extends EventTarget { close() {} };
    });
    await page.route('**/api/**', route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path === '/api/version') return route.continue();
      if (request.method() !== 'GET') {
        writes.push(path);
        return route.fulfill({ status: 400, json: { error: 'Navigation must be read-only' } });
      }
      if (path === '/api/state') return route.fulfill({ json: snapshot });
      if (path === '/api/terminals') return route.fulfill({ json: [] });
      for (const [index, agent] of agents.entries()) {
        if (path === `/api/agents/${agent.id}`) return route.fulfill({ json: { agent, timeline: timeline(index), delivery: 'start' } });
        if (path === `/api/agents/${agent.id}/reviews/${reviews[index].id}`) return route.fulfill({ json: reviews[index] });
      }
      return route.fulfill({ status: 404, json: { error: 'Not found' } });
    });
    try {
      await page.goto(`${process.env.TEST_URL}${stale ? `/?review=${reviews[0].id}` : '/'}`);
      await page.getByRole('button', { name: agents[1].name, exact: true }).click();
      await page.locator('[data-agent-pane]').waitFor();
      // Poll rather than sampling during the agent panel's initial render.
      await page.getByText(`Conversation for ${agents[1].name}`, { exact: true }).waitFor({ timeout: 5000 });
      assert.equal(new URL(page.url()).searchParams.get('agent'), agents[1].id);
      assert.equal(new URL(page.url()).searchParams.get('review'), null, 'Card navigation clears unrelated review state');
      assert.equal(await page.getByRole('region', { name: 'Change review', exact: true }).count(), 0);
      if (process.env.SCREENSHOT && stale) await page.screenshot({ path: process.env.SCREENSHOT });
      await page.getByRole('button', { name: `Review ${reviews[1].title}`, exact: true }).click();
      const review = page.getByRole('region', { name: 'Change review', exact: true });
      await review.getByRole('heading', { name: 'settings.txt', exact: true }).waitFor();
      assert.ok((await review.innerText()).includes('+after'), 'Explicit review still opens the selected card’s diff');
      assert.deepEqual(writes, [], 'Opening conversations and reviews never approves or edits anything');
      assert.deepEqual(errors, []);
      console.log(`${stale ? 'Stale review URL' : 'Clean home'}: conversation opens; explicit review works`);
    } catch (error) {
      failures.push(`${stale ? 'Stale review URL' : 'Clean home'}: ${error.message}`);
      if (process.env.FAILURE_SCREENSHOT) await page.screenshot({ path: process.env.FAILURE_SCREENSHOT });
    } finally { await context.close(); }
  }
  assert.deepEqual(failures, []);
} finally { await browser.close(); }
