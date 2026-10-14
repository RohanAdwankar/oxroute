import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const agent = { id: 'review-jump', name: 'Review jump', cwd: '/workspace', backend: 'codex', model: 'test', status: 'complete', updatedAt: Date.now()/1000 };
const files = ['first.js', 'second.js', 'third.js'].map(path => ({ path, patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,200 +1,200 @@\n` + Array.from({ length: 200 }, (_, i) => ` const value${i} = ${i};`).join('\n') }));
const review = { id: 'jump', title: 'Review navigation', description: '', status: 'pending', snapshot: { repository: '/workspace', branch: 'change', baseRef: 'main', remote: 'origin', remoteUrl: 'https://example.invalid/repo', baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), files } };
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.route('**/api/state', r => r.fulfill({ json: { mode: 'ask', agents: [agent], archived: [], messages: {}, tasks: [], taskNotes: [], inbox: [], paneLinks: {}, tags: {}, boards: [], sources: [], models: [], backends: [] } }));
  await page.route('**/api/events', r => r.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' }));
  await page.route('**/api/agents/*', r => r.fulfill({ json: { agent, timeline: [{ id: 1, agentId: agent.id, at: Date.now()/1000, kind: 'review', text: review.title, detail: review.id }], delivery: 'start' } }));
  await page.route('**/reviews/jump', r => r.fulfill({ json: review }));
  await page.goto(`${process.env.TEST_URL ?? 'http://127.0.0.1:3939'}/?agent=${agent.id}`);
  await page.getByRole('button', { name: `Review ${review.title}`, exact: true }).click();
  const pane = page.getByRole('region', { name: 'Change review', exact: true });
  const nav = pane.getByRole('navigation', { name: 'Changed files' });
  for (const zoom of [0.5, 0.7, 1, 1.25]) {
    await pane.evaluate((node, zoom) => { node.style.zoom = String(zoom); }, zoom);
    await pane.getByRole('region', { name: 'Diff third.js', exact: true }).evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
    for (const path of ['second.js', 'first.js', 'third.js', 'second.js']) {
      await nav.getByRole('button', { name: path, exact: true }).click();
      const distance = await pane.getByRole('region', { name: `Diff ${path}`, exact: true }).evaluate(node => node.getBoundingClientRect().top - node.parentElement.getBoundingClientRect().top);
      assert.ok(Math.abs(distance) < 1, `One click reaches ${path}'s top at ${zoom} zoom; offset ${distance}px`);
    }
  }
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  console.log('File buttons jump to the top in one click in both directions at multiple pane scales.');
} finally { await browser.close(); }
