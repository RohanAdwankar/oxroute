import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const agent = { id: 'revision-session', name: 'Revision review', cwd: '/workspace', backend: 'codex', model: 'fixture', status: 'complete', updatedAt: Date.now()/1000 };
const review = { id: 'revision-review', agentId: agent.id, title: 'Refine request handling', description: '', status: 'pending', full: false,
  snapshot: { repository: '/workspace', remote: 'origin', remoteUrl: 'https://example.invalid/repo.git', branch: 'proposal', baseRef: 'main', baseCommit: 'a'.repeat(40), reviewBaseCommit: 'b'.repeat(40), headCommit: 'c'.repeat(40), files: [] } };
const patch = (before, after) => `@@ -1 +1 @@\n-${before}\n+${after}`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [], writes = [], images = [], quotes = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.addInitScript(() => { window.SharedWorker = undefined; window.EventSource = class extends EventTarget { close() {} }; });
  await page.route('**/api/state', route => route.fulfill({ json: { agents: [agent], archived: [], inbox: [], messages: {}, tasks: [], taskNotes: [], paneLinks: {}, quoteThreads: [], tags: {}, boards: [], sources: [], models: [], backends: [] } }));
  await page.route('**/api/agents/*', route => route.fulfill({ json: { agent, timeline: [{ id: 1, agentId: agent.id, kind: 'review', text: review.title, detail: review.id, at: 1 }], delivery: 'start' } }));
  await page.route('**/api/say', route => { quotes.push(route.request().postDataJSON().diffs[0]); return route.fulfill({ json: { ok: true } }); });
  await page.route('**/reviews/revision-review{,?*,/**}', route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/image')) {
      images.push(url.searchParams.get('full'));
      return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><path fill="gray" d="M0 0h80v40H0z"/></svg>' });
    }
    if (url.pathname.endsWith('/approve')) { writes.push(url.pathname); return route.fulfill({ json: { ...review, status: 'approved' } }); }
    const full = url.searchParams.get('full') === 'true';
    return route.fulfill({ json: { ...review, full, snapshot: { ...review.snapshot, files: [
      { path: 'settings.yaml', patch: patch(full ? 'original' : 'accepted', 'refined') },
      ...(full ? [{ path: 'earlier.txt', patch: patch('old', 'accepted') }, { path: 'diagram.svg', patch: '', image: { before: true, after: true } }] : []),
    ] } } });
  });
  await page.goto(`${process.env.TEST_URL ?? 'http://127.0.0.1:3942'}/?agent=${agent.id}`);
  await page.getByRole('button', { name: `Review ${review.title}`, exact: true }).click();
  const scope = page.getByRole('button', { name: 'Since approval', exact: true });
  await scope.waitFor();
  await page.getByRole('heading', { name: 'settings.yaml', exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'earlier.txt', exact: true }).count(), 0);
  assert.ok((await page.locator('[data-diff]').innerText()).includes('-accepted'));
  const quote = async expected => {
    await page.getByRole('heading', { name: 'settings.yaml', exact: true }).click({ button: 'right' });
    await page.getByRole('button', { name: 'Quote file into chat', exact: true }).click();
    const attached = page.locator('footer').getByRole('region', { name: 'Attached diff settings.yaml', exact: true });
    await attached.waitFor();
    await page.locator('[data-composer]').fill('Explain this change.');
    const sent = page.waitForResponse(response => response.url().endsWith('/api/say'));
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await sent;
    assert.ok(quotes.at(-1).text.includes(`${expected}...${review.snapshot.headCommit}`), 'Quotes name the actual comparison revisions');
    await page.getByRole('button', { name: 'Open change review', exact: true }).click();
  };
  await quote(review.snapshot.reviewBaseCommit);
  await scope.click();
  await page.getByRole('button', { name: 'Full PR', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'earlier.txt', exact: true }).waitFor();
  assert.ok((await page.locator('[data-diff]').first().innerText()).includes('-original'));
  await page.getByAltText('Before diagram.svg', { exact: true }).waitFor();
  await page.waitForFunction(() => [...document.images].filter(image => image.alt.includes('diagram.svg')).every(image => image.complete && image.naturalWidth));
  assert.deepEqual(images, ['true', 'true'], 'Full-PR image previews use the same scope as the text diff');
  await quote(review.snapshot.baseCommit);
  await page.getByRole('button', { name: 'Full PR', exact: true }).click();
  await scope.waitFor();
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  await page.getByRole('button', { name: 'Approve publication', exact: true }).click();
  assert.equal(writes.length, 1, 'Changing comparison scope never grants approval; the existing explicit approval remains available');
  assert.deepEqual(errors, []);
  console.log('Follow-up reviews show only new changes, retain the full PR view and its image previews, and quote the displayed baseline without changing publication approval.');
} finally { await browser.close(); }
