import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
const agent = { id: 'cached-owner', name: 'Cached reviews', backend: 'codex', status: 'complete', updatedAt: 1 };
const hidden = { ...agent, id: 'unopened-owner', name: 'Unopened conversation' };
const ids = Array.from({ length: 12 }, (_, i) => 'review_' + i.toString(16).padStart(32, '0'));
const liveId = 'review_' + 'f'.repeat(32);
const endpoint = (owner, id) => `/api/agents/${owner}/reviews/${id}`;
let offline = false;
const requests = [];
const browser = await (process.env.TEST_BROWSER === 'webkit' ? webkit : chromium).launch(process.env.WEBKIT_EXECUTABLE ? { executablePath: process.env.WEBKIT_EXECUTABLE } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  await page.addInitScript(() => { window.SharedWorker = undefined; window.EventSource = class extends EventTarget { constructor() { super(); window.fixtureEvents = this; } close() {} }; });
  await page.route('**/api/state', r => r.fulfill({ json: { mode: 'ask', agents: [agent, hidden], archived: [], reviews: { [agent.id]: ids }, messages: {}, tasks: [], taskNotes: [], inbox: [], paneLinks: {}, quoteThreads: [], tags: {}, boards: [], sources: [], models: [], backends: [] } }));
  await page.route('**/api/terminals', r => r.fulfill({ json: [] }));
  await page.route('**/api/agents/*', r => r.fulfill({ json: { agent, timeline: ids.map((id, i) => ({ id: i+1, agentId: agent.id, kind: 'review', detail: id, text: `Prepared ${i}`, at: i+1 })), delivery: 'start' } }));
  await page.route('**/reviews/*', r => {
    const url = new URL(r.request().url()), id = url.pathname.split('/').at(-1);
    requests.push(url.pathname);
    if (offline) return r.abort();
    const full = url.searchParams.has('full');
    return r.fulfill({ json: { id, agentId: id === liveId ? hidden.id : agent.id, title: `Prepared ${ids.indexOf(id)}`, description: '', status: 'pending', full,
      snapshot: { repository: '/workspace', remote: 'origin', remoteUrl: '', branch: 'proposal', baseRef: 'main', baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), ...(id === ids[0] ? { reviewBaseCommit: 'c'.repeat(40) } : {}),
        files: [{ path: 'change.ts', patch: '@@ -1 +1 @@\n-old value\n+cached value\n' }, ...(id === ids[0] ? [{ path: 'picture.svg', patch: 'Binary files differ', image: { before: false, after: true } }] : [])] } } });
  });
  await page.route('**/reviews/*/image?*', r => offline ? r.abort() : r.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12" fill="#888"/></svg>' }));
  await page.goto(`${process.env.TEST_URL ?? 'http://127.0.0.1:3953'}/?agent=${agent.id}`);
  const cached = async urls => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (!requests.length) { await page.waitForTimeout(20); continue; }
      if (await page.evaluate(async urls => {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open('oxroute.reviews.v1', 1);
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        });
        try {
          const keys = await new Promise((resolve, reject) => {
            const request = db.transaction('responses').objectStore('responses').getAllKeys();
            request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
          });
          return urls.every(url => keys.includes(url));
        } finally { db.close(); }
      }, urls)) return;
      await page.waitForTimeout(20);
    }
    assert.fail('Reviews and image bytes must finish downloading before they are opened');
  };
  await cached(ids.map(id => endpoint(agent.id, id)));
  await cached([endpoint(agent.id, ids[0]) + '?full=true', endpoint(agent.id, ids[0]) + '/image?path=picture.svg&side=after']);
  await page.evaluate(entry => window.fixtureEvents.onmessage({ data: JSON.stringify({ type: 'timeline', entry }) }), { id: 100, agentId: hidden.id, kind: 'review', detail: liveId, text: 'New unseen review', at: 100 });
  await cached([endpoint(hidden.id, liveId)]);
  assert.ok(requests.includes(endpoint(hidden.id, liveId)), 'Review creation warms an unopened conversation');
  offline = true;
  await page.reload();
  await page.getByRole('button', { name: 'Review Prepared 0', exact: true }).waitFor();
  const start = performance.now();
  await page.getByRole('button', { name: 'Review Prepared 0', exact: true }).click();
  await page.locator('[data-diff-line]').filter({ hasText: '+cached value' }).waitFor();
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 500, `Persistent cached review opens without its API (${Math.round(elapsed)} ms)`);
  const image = page.getByRole('img', { name: 'After picture.svg', exact: true });
  await image.waitFor(); await image.evaluate(image => image.decode());
  assert.equal(await image.evaluate(image => image.naturalWidth), 12, 'Image bytes survive reload with the review API unavailable');
  await page.waitForTimeout(100);
  assert.equal(await page.locator('[data-diff-line]').filter({ hasText: '+cached value' }).count(), 1, 'Failed background status refresh retains cached content');
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  console.log(`Twelve reviews, full comparisons, images and unseen live reviews persist locally; offline reopen ${Math.round(elapsed)} ms.`);
} finally { await browser.close(); }
