import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const agent = { id: 'review-test', name: 'Review test', cwd: '/workspace/review', backend: 'codex', model: 'test', status: 'complete', updatedAt: Date.now()/1000 };
const patch = 'diff --git a/config.yaml b/config.yaml\nindex 1234567..abcdef0 100644\n--- a/config.yaml\n+++ b/config.yaml\n@@ -2,2 +2,2 @@\n setting: true\n-value: before\n+value: after\n@@ -20 +30 @@\n-later: before\n+later: after\n';
const review = { id: 'review-local', title: 'Adjust request settings', description: 'Proposed PR description', status: 'pending',
  snapshot: { repository: agent.cwd, branch: 'proposal', baseRef: 'main', remote: 'origin', remoteUrl: 'https://example.invalid/repo.git',
    baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), files: [{ path: 'config.yaml', patch }] } };
const timeline = [{ id: 1, agentId: agent.id, at: Date.now()/1000, kind: 'review', text: review.title, detail: review.id }];
const demo = process.env.DEMO_DIR;
if (demo) await mkdir(demo, { recursive: true });
const browser = await chromium.launch({ slowMo: demo ? 250 : 0 });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, ...(demo ? { recordVideo: { dir: demo, size: { width: 1280, height: 800 } } } : {}) });
  const stage = async text => {
    if (!demo) return;
    await page.evaluate(text => {
      let caption = document.getElementById('demo-caption');
      if (!caption) {
        caption = document.createElement('div'); caption.id = 'demo-caption';
        caption.style.cssText = 'position:fixed;right:24px;bottom:220px;background:#211d19;color:white;padding:14px 18px;font:18px sans-serif;z-index:100;pointer-events:none;max-width:460px';
        document.body.append(caption);
      }
      caption.textContent = text;
    }, text);
    await page.waitForTimeout(2200);
  };
  await page.route('**/api/state', r => r.fulfill({ json: { mode: 'ask', agents: [agent], archived: [], messages: {}, tasks: [], taskNotes: [], inbox: [], paneLinks: {}, tags: {}, boards: [], sources: [], models: [], backends: [] } }));
  await page.route('**/api/events', r => r.fulfill({ contentType: 'text/event-stream', body: ': test\n\n' }));
  await page.route('**/api/agents/*', r => r.fulfill({ json: { agent, timeline, delivery: 'start' } }));
  await page.route('**/reviews/review-local', r => r.fulfill({ json: review }));
  await page.route('**/reviews/review-local/approve', r => r.fulfill({ json: { ...review, status: 'approved' } }));
  const writes = [];
  page.on('request', r => { if (r.method() !== 'GET') writes.push(r.url()); });
  await page.goto(`${process.env.TEST_URL ?? 'http://localhost:3941'}/?agent=${agent.id}`);
  await stage('The agent presents a local proposed PR in chat. Demo data; nothing is pushed.');
  if (demo) await page.screenshot({ path: `${demo}/review-card.png` });
  await page.getByRole('button', { name: `Review ${review.title}`, exact: true }).click();
  await stage('Open this specific change. Green additions, red deletions.');
  assert.equal(await page.getByRole('region', { name: 'Change review' }).getByRole('combobox').count(), 0, 'Review has no repository discovery picker');
  const added = page.locator('[data-diff-line]').filter({ hasText: '+value: after' });
  await added.waitFor();
  const rendered = await page.locator('[data-diff]').innerText();
  for (const metadata of ['diff --git', 'index 1234567', '--- a/', '+++ b/', '@@']) {
    assert.ok(!rendered.includes(metadata), 'Patch metadata is hidden');
  }
  assert.equal(await page.getByText('Select lines and right-click to discuss them.', { exact: false }).count(), 0);
  const later = page.locator('[data-diff-line]').filter({ hasText: '+later: after' });
  assert.equal(await later.locator('span').nth(1).innerText(), '30', 'Hidden hunk headers still set correct line numbers');
  const removed = page.locator('[data-diff-line]').filter({ hasText: '-value: before' });
  const color = async row => row.evaluate(element => {
    const rgb = getComputedStyle(element).color;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    context.fillStyle = rgb; context.fillRect(0, 0, 1, 1);
    return Array.from(context.getImageData(0, 0, 1, 1).data);
  });
  const [addedRed, addedGreen] = await color(added);
  const [removedRed, removedGreen] = await color(removed);
  assert.ok(addedGreen > addedRed, 'Additions use green');
  assert.ok(removedRed > removedGreen, 'Deletions use red');
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  const [darkAddedRed, darkAddedGreen] = await color(added);
  const [darkRemovedRed, darkRemovedGreen] = await color(removed);
  assert.ok(darkAddedGreen > darkAddedRed && darkRemovedRed > darkRemovedGreen);
  await page.evaluate(() => document.documentElement.dataset.theme = 'light');
  assert.ok((await added.innerText()).includes('3'));
  await added.click({ button: 'right' });
  await stage('Right-click a changed line to quote it into a question.');
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  await page.getByRole('button', { name: 'Quote diff into chat' }).click();
  const draft = await page.locator('[data-composer]').inputValue();
  assert.ok(draft.includes('File: config.yaml'));
  assert.ok(draft.includes(`${review.snapshot.baseCommit}...${review.snapshot.headCommit}`));
  assert.ok(draft.includes(review.id));
  assert.ok(draft.includes('> +value: after'));
  assert.ok(draft.includes('old none, new 3–3'), 'Quotes retain source line numbers without metadata rows');
  assert.equal(await page.locator('section[aria-label="Change review"]').isVisible(), false);
  if (demo) {
    await page.locator('[data-composer]').press('ControlOrMeta+End');
    await page.locator('[data-composer]').type('Can you explain this change before I approve it?', { delay: 35 });
  }
  await stage('The draft includes the review ID, exact commits, file, and line numbers.');
  if (demo) await page.screenshot({ path: `${demo}/review-quote.png` });
  if (!demo) await page.setViewportSize({ width: 500, height: 800 });
  await page.getByRole('button', { name: 'Open change review', exact: true }).click();
  await added.waitFor();
  await page.locator('[data-diff]').evaluate(element => {
    const nodes = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const before = nodes.find(node => node.textContent === '-value: before');
    const after = nodes.find(node => node.textContent === '+value: after');
    const range = document.createRange();
    range.setStart(before, 0); range.setEnd(after, after.textContent.length);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  });
  await added.click({ button: 'right' });
  await page.getByRole('button', { name: 'Quote diff into chat' }).click();
  const multiple = await page.locator('[data-composer]').inputValue();
  assert.ok(multiple.includes('> -value: before\n> +value: after'));
  assert.deepEqual(writes, [], 'Review and quote never send a message or change Git');
  await page.getByRole('button', { name: 'Open change review', exact: true }).click();
  await stage('When satisfied, approve this revision for publication.');
  await page.getByRole('button', { name: 'Approve publication' }).click();
  await page.getByText('Approved for publication', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Approve publication' }).isDisabled(), true);
  assert.equal(writes.length, 1, 'Only explicit approval mutates review state');
  assert.ok(writes[0].endsWith('/reviews/review-local/approve'));
  await stage('Approval authorizes this revision only. Merge and deployment remain separate.');
  // A stale snapshot stays inspectable but cannot authorize publication.
  await page.route('**/reviews/review-local', r => r.fulfill({ json: { ...review, status: 'stale' } }));
  await page.getByRole('button', { name: 'Back to conversation' }).click();
  await page.getByRole('button', { name: `Review ${review.title}`, exact: true }).click();
  await added.waitFor();
  await page.getByText('Revision changed', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Approve publication' }).isDisabled(), true);
  await stage('Further edits require a new review. The previous diff stays readable.');
  if (demo) {
    await page.screenshot({ path: `${demo}/review-stale.png` });
    const video = page.video();
    await page.context().close();
    await video.saveAs(`${demo}/pre-publication-review.webm`);
  }
  console.log('Local review card, colors, revision-specific quotes, explicit approval, and stale review behavior pass.');
} finally { await browser.close(); }
