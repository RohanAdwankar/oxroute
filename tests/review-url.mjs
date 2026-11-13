import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';

const agents = ['alpha', 'bravo'].map(id => ({ id, name: `${id} session`, cwd: '/workspace', backend: 'codex', model: 'fixture', status: 'complete', updatedAt: Date.now() / 1000 }));
const review = { id: 'proposed-change', agentId: 'alpha', title: 'Prepared change', description: '', status: 'pending', snapshot: { repository: '/workspace', remote: 'origin', branch: 'proposal', baseRef: 'main', baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), files: [{ path: 'value.ts', patch: '@@ -1 +1 @@\n-const value = 10;\n+const value = 20;\n' }] } };
const browser = await (process.env.BROWSER === 'webkit' ? webkit : chromium).launch({ ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 750 } });
  const invalid = [], writes = [];
  await page.addInitScript(() => { window.SharedWorker = undefined; window.EventSource = class extends EventTarget { close() {} }; });
  await page.route('**/api/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') { writes.push(path); return route.fulfill({ json: {} }); }
    if (path === '/api/version') return route.fulfill({ status: 404, json: {} });
    if (path === '/api/state') return route.fulfill({ json: { mode: 'ask', agents, archived: [], messages: {}, tasks: [], taskNotes: [], inbox: [], paneLinks: {}, tags: {}, boards: [], sources: [], models: [], backends: [] } });
    if (path === '/api/terminals') return route.fulfill({ json: [] });
    if (path.includes('/reviews/')) {
      if (path !== `/api/agents/alpha/reviews/${review.id}`) invalid.push(path);
      return route.fulfill({ json: review });
    }
    const agent = agents.find(item => path === `/api/agents/${item.id}`);
    if (agent) return route.fulfill({ json: { agent, timeline: [{ id: 1, agentId: agent.id, kind: 'said', text: `Conversation for ${agent.name}`, at: 1, detail: '' }], delivery: 'start' } });
    return route.fulfill({ json: {} });
  });
  const url = `${process.env.TEST_URL ?? 'http://127.0.0.1:3939'}/?agent=alpha&review=${review.id}&keep=value#retained`;
  const panel = page.getByRole('region', { name: 'Change review', exact: true });
  const tab = id => page.getByRole('tab', { name: `${id} session`, exact: true });
  const checkUrl = expected => {
    const current = new URL(page.url());
    assert.equal(current.searchParams.get('review'), expected);
    assert.equal(current.searchParams.get('keep'), 'value');
    assert.equal(current.hash, '#retained');
  };
  await page.goto(url);
  await panel.locator('[data-diff-line]').first().waitFor();
  await tab('alpha').click();
  await panel.waitFor();
  checkUrl(review.id);
  await page.getByRole('button', { name: 'Back to conversation', exact: true }).click();
  checkUrl(null);
  await panel.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Open change review', exact: true }).click();
  await panel.waitFor();
  await page.getByRole('button', { name: 'Open change review', exact: true }).click();
  await panel.waitFor({ state: 'hidden' });
  checkUrl(null);

  // Leaving an active deep link must not transfer its review to another conversation.
  await page.goto(url);
  await panel.waitFor();
  await page.getByRole('button', { name: 'Show the fleet', exact: true }).click();
  checkUrl(null);
  await page.getByRole('button', { name: 'bravo session', exact: true }).click();
  await tab('bravo').waitFor();
  checkUrl(null);
  await panel.waitFor({ state: 'hidden' });
  await page.goBack();
  await page.goBack();
  await panel.waitFor();
  checkUrl(review.id);
  await page.goForward();
  await panel.waitFor({ state: 'hidden' });
  checkUrl(null);

  // Existing session tabs use the same clean conversation navigation.
  await page.goto(url);
  await panel.waitFor();
  await tab('bravo').click();
  await page.getByText('Conversation for bravo session', { exact: true }).waitFor();
  checkUrl(null);
  await page.goBack();
  await panel.waitFor();
  await page.getByRole('button', { name: 'Close tab alpha session', exact: true }).click();
  await page.getByText('Conversation for bravo session', { exact: true }).waitFor();
  checkUrl(null);

  // Browser history must also hide a review when only the review parameter changes.
  await page.goto(url);
  await panel.waitFor();
  await page.evaluate(() => { const url = new URL(location.href); url.searchParams.delete('review'); history.pushState(null, '', url); dispatchEvent(new PopStateEvent('popstate')); });
  await panel.waitFor({ state: 'hidden' });
  await page.goBack();
  await panel.waitFor();
  await page.goForward();
  await panel.waitFor({ state: 'hidden' });
  // Returning a quoted file to the composer exits the deep-linked review too.
  await page.goto(url);
  await panel.getByRole('heading', { name: 'value.ts', exact: true }).click({ button: 'right' });
  await page.getByRole('button', { name: 'Quote file into chat', exact: true }).click();
  await page.getByRole('region', { name: 'Attached diff value.ts', exact: true }).waitFor();
  await panel.waitFor({ state: 'hidden' });
  checkUrl(null);
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  assert.deepEqual(invalid, [], 'Review IDs never leak to another agent');
  assert.deepEqual(writes, [], 'Review navigation never mutates daemon data');
  console.log('Review deep links, close/reopen, fleet/tabs, tab closure and browser history preserve conversation navigation and unrelated URL state.');
} finally { await browser.close(); }
