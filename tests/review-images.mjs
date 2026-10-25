import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const agent = { id: 'image-fixture', name: 'Image review', cwd: '/workspace/images', backend: 'codex', model: 'fixture', status: 'complete', updatedAt: Date.now()/1000 };
const binary = 'Binary files differ';
const files = [
  { path: 'diagram # λ.png', patch: binary, image: { before: true, after: true } },
  { path: 'added.png', patch: binary, image: { before: false, after: true } },
  { path: 'removed.png', patch: binary, image: { before: true, after: false } },
  { path: 'vector.svg', patch: '@@ -1 +1 @@\n-<svg width="10"/>\n+<svg width="20"/>', image: { before: true, after: true } },
  { path: 'broken.png', patch: binary, image: { before: false, after: true } },
];
const review = { id: 'image-review', agentId: agent.id, title: 'Update visual assets', description: 'Review image revisions alongside their source changes.', status: 'pending', snapshot: { repository: agent.cwd, branch: 'images', baseRef: 'main', remote: 'origin', remoteUrl: 'https://example.invalid/images.git', baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), files } };
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const pngs = await page.evaluate(() => ['Earlier', 'Revised'].map((label, index) => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 140;
    const context = canvas.getContext('2d'); context.fillStyle = '#eeeae4'; context.fillRect(0, 0, 320, 140);
    context.fillStyle = index ? '#37302a' : '#958a80'; context.fillRect(20 + index*130, 22, 118, 78);
    context.fillStyle = '#37302a'; context.font = '14px monospace'; context.fillText(label, 20, 124);
    return canvas.toDataURL('image/png').split(',')[1];
  }));
  await page.route('**/api/state', route => route.fulfill({ json: { mode: 'ask', agents: [agent], archived: [], messages: {}, tasks: [], taskNotes: [], inbox: [], paneLinks: {}, tags: {}, boards: [], sources: [], models: [], backends: [] } }));
  await page.route('**/api/terminals', route => route.fulfill({ json: [] }));
  await page.route('**/api/events', route => route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' }));
  await page.route('**/api/agents/*', route => route.fulfill({ json: { agent, timeline: [{ id: 1, agentId: agent.id, at: Date.now()/1000, kind: 'review', text: review.title, detail: review.id }], delivery: 'start' } }));
  await page.route('**/reviews/image-review', route => route.fulfill({ json: review }));
  const requests = [];
  await page.route('**/reviews/image-review/image?*', route => {
    const url = new URL(route.request().url()); const path = url.searchParams.get('path'), side = url.searchParams.get('side');
    requests.push({ path, side });
    if (path === 'broken.png') return route.fulfill({ status: 404, body: 'Unavailable' });
    if (path === 'vector.svg') return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#777"/></svg>' });
    return route.fulfill({ contentType: 'image/png', body: Buffer.from(pngs[side === 'before' ? 0 : 1], 'base64') });
  });
  await page.goto(`${process.env.TEST_URL ?? 'http://127.0.0.1:3942'}/?agent=${agent.id}`);
  await page.getByRole('button', { name: `Review ${review.title}`, exact: true }).click();
  const comparison = page.getByLabel(`Image comparison ${files[0].path}`, { exact: true });
  await comparison.waitFor({ timeout: 2000 });
  for (const side of ['Before', 'After']) {
    const image = page.getByRole('img', { name: `${side} ${files[0].path}`, exact: true });
    await image.waitFor();
    await image.evaluate(image => image.decode());
    assert.equal(await image.evaluate(image => image.naturalWidth), 320);
    assert.equal(await image.locator('..').getAttribute('target'), '_blank', 'Images open at their original size');
  }
  assert.equal(new Set((await comparison.locator('img').evaluateAll(images => images.map(image => image.src)))).size, 2, 'Before and after load separate revisions');
  const nav = page.getByRole('navigation', { name: 'Changed files' });
  for (const file of files.slice(1)) {
    await nav.getByRole('button', { name: file.path, exact: true }).click();
    const section = page.getByRole('region', { name: `Diff ${file.path}`, exact: true });
    if (file.path === 'broken.png') { await section.getByRole('alert').waitFor(); continue; }
    for (const image of await section.locator('img').all()) await image.evaluate(image => image.decode());
    if (!file.image.before) await section.getByText('Added image', { exact: true }).waitFor();
    if (!file.image.after) await section.getByText('Deleted image', { exact: true }).waitFor();
    if (file.path === 'vector.svg') assert.ok((await section.locator('[data-diff]').innerText()).includes('+<svg width="20"/>'), 'SVG source remains reviewable alongside its preview');
  }
  assert.ok(!requests.some(request => (request.path === 'added.png' && request.side === 'before') || (request.path === 'removed.png' && request.side === 'after')), 'Absent versions never request image bytes');
  await nav.getByRole('button', { name: files[0].path, exact: true }).click();
  await comparison.getByText('Before', { exact: true }).waitFor();
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  const panel = page.getByRole('region', { name: 'Change review', exact: true });
  await panel.evaluate(element => element.style.width = '380px');
  for (const image of await comparison.locator('img').all()) {
    assert.ok(await image.evaluate(image => image.getBoundingClientRect().width <= image.parentElement.parentElement.getBoundingClientRect().width), 'Images fit narrow review panes');
  }
  await panel.evaluate(element => element.style.width = '');
  await page.getByRole('heading', { name: files[0].path, exact: true }).click({ button: 'right' });
  await page.getByRole('button', { name: 'Quote file into chat', exact: true }).click();
  await page.getByRole('region', { name: `Attached diff ${files[0].path}`, exact: true }).waitFor();
  console.log('Changed, added and deleted images render from separate Git revision URLs; SVG source, original-size links, navigation and load errors remain available.');
} finally { await browser.close(); }
