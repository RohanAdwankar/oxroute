import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { chromium } from 'playwright';

const native = process.env.TEST_NATIVE_URL, web = process.env.TEST_URL;
assert.ok(native && web, 'Use a disposable daemon and production frontend');
const api = async (path, body) => {
  const result = await fetch(native + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.ok(result.ok, await result.clone().text());
  return result.json();
};
assert.ok((await api('/api/state')).artifactRoot.includes('/.tmp/'));
const named = await api('/api/agents', {}), mentioned = await api('/api/agents', {});
await api('/api/rename', { agent: named.id, name: 'Harbor rollout' });
await api('/api/rename', { agent: mentioned.id, name: 'Capacity planning' });
await api('/api/say', { agent: named.id, text: 'A launch review is ready.', queued: true });
await api('/api/say', { agent: mentioned.id, text: 'Harbor capacity needs another review.', queued: true });
await api('/api/archive', { agent: named.id, archived: true });
const hits = await api('/api/search?q=HARBOR');
assert.ok(hits.some(hit => hit.destinations.some(item => item.agentId === mentioned.id)));
assert.ok(!hits.some(hit => hit.destinations.some(item => item.agentId === named.id)), 'Content search does not substitute card titles for work context');
assert.equal((await fetch(`${native}/api/agents/${named.id}/files/search?q=harbor&mode=names`)).status, 404);

const proxy = createServer((req, res) => {
  const target = new URL(req.url, req.url.startsWith('/api/') && !req.url.startsWith('/api/version') ? native : web);
  const upstream = request(target, { method: req.method, headers: req.headers }, reply => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(upstream); res.on('close', () => upstream.destroy());
});
await new Promise(done => proxy.listen(0, '127.0.0.1', done));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } }), requests = [];
  page.on('request', r => requests.push(new URL(r.url()).pathname));
  await page.goto(`http://127.0.0.1:${proxy.address().port}/?agent=${mentioned.id}`);
  const trigger = page.getByRole('button', { name: 'Search sessions', exact: true });
  await trigger.click({ button: 'right' });
  const dialog = page.getByRole('dialog', { name: 'Session search' });
  assert.equal(await dialog.getByRole('group', { name: 'Search mode' }).getByRole('button').count(), 2);
  assert.equal(await dialog.getByRole('button', { name: 'Card titles', exact: true }).getAttribute('aria-pressed'), 'true');
  const titles = dialog.getByRole('searchbox', { name: 'search card titles' });
  requests.length = 0;
  await titles.fill('No such card');
  await dialog.getByText('No card titles match.', { exact: true }).waitFor();
  await titles.fill('HARBOR');
  await dialog.getByText('Harbor rollout', { exact: true }).first().waitFor();
  await dialog.getByText('A launch review is ready.', { exact: true }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Open', exact: true }).count(), 1);
  assert.ok(!requests.includes('/api/search') && !requests.includes('/api/search/native'), 'Title search only uses card names and recent context previews');
  if (process.env.CARD_SEARCH_SCREENSHOT) await page.screenshot({ path: process.env.CARD_SEARCH_SCREENSHOT.replace('.png', '-titles.png') });
  await titles.press('Enter');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(new URL(page.url()).searchParams.get('agent'), named.id);
  await trigger.click();
  assert.equal(await dialog.getByRole('button', { name: 'Conversation content', exact: true }).getAttribute('aria-pressed'), 'true');
  const contents = dialog.getByRole('searchbox', { name: 'search all sessions' });
  await contents.fill('Harbor');
  await dialog.getByText('Harbor capacity needs another review.', { exact: true }).first().waitFor();
  assert.ok(!await dialog.getByText('Harbor rollout', { exact: true }).count(), 'Content results identify the card containing the matching work');
  if (process.env.CARD_SEARCH_SCREENSHOT) await page.screenshot({ path: process.env.CARD_SEARCH_SCREENSHOT });
  await contents.press('Enter');
  await page.waitForURL(url => url.searchParams.get('agent') === mentioned.id);
  assert.ok(!requests.some(path => path.includes('/files/')), 'Neither mode scans physical files');
  console.log('Real card-title and conversation-content searches stay distinct, preview context, open the correct card and preserve the right-click shortcut.');
} finally {
  await browser.close(); proxy.closeAllConnections(); await new Promise(done => proxy.close(done));
}
