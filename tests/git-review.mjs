import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const agent = { id: 'review-test', name: 'Review test', cwd: '/workspace/review', backend: 'codex', model: 'test', status: 'complete', updatedAt: Date.now()/1000 };
const patch = 'diff --git a/config.yaml b/config.yaml\nindex 1234567..abcdef0 100644\n--- a/config.yaml\n+++ b/config.yaml\n@@ -2,2 +2,2 @@\n setting: true\n-value: before\n+value: after\n@@ -20 +30 @@\n-later: before\n+later: after\n';
const otherPatch = 'diff --git a/notes.txt b/notes.txt\n--- a/notes.txt\n+++ b/notes.txt\n@@ -7,51 +7,51 @@\n-old note\n+new note\n' + Array.from({ length: 50 }, (_, index) => ` context ${index}`).join('\n');
const review = { id: 'review-local', title: 'Adjust request settings', description: 'Proposed PR description', status: 'pending',
  snapshot: { repository: agent.cwd, branch: 'proposal', baseRef: 'main', remote: 'origin', remoteUrl: 'https://example.invalid/repo.git',
    baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), files: [{ path: 'config.yaml', patch }, { path: 'notes.txt', patch: otherPatch }] } };
const authorization = `Authorize publishing revision ${review.snapshot.headCommit} from ${agent.cwd}; merge and deployment require separate approval.`;
const approvalDetail = 'review-approval:' + JSON.stringify({ id: review.id, title: review.title, commit: review.snapshot.headCommit, branch: review.snapshot.branch, base: review.snapshot.baseRef });
const timeline = [{ id: 1, agentId: agent.id, at: Date.now()/1000, kind: 'review', text: review.title, detail: review.id },
  { id: 2, agentId: agent.id, at: Date.now()/1000, kind: 'you', text: authorization, detail: approvalDetail }];
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
  const approvalCard = page.getByRole('region', { name: 'Publication approval', exact: true });
  await approvalCard.waitFor();
  assert.equal(await approvalCard.innerText(), `PR approved: ${review.title}`);
  assert.equal(await approvalCard.getByText(authorization, { exact: true }).count(), 0, 'Authorization remains in message data, not the card');
  if (process.env.APPROVAL_SCREENSHOT) await page.screenshot({ path: process.env.APPROVAL_SCREENSHOT });
  await stage('The agent presents a local proposed PR in chat. Demo data; nothing is pushed.');
  if (demo) await page.screenshot({ path: `${demo}/review-card.png` });
  await page.getByRole('button', { name: `Review ${review.title}`, exact: true }).click();
  await stage('Open this specific change. Green additions, red deletions.');
  assert.equal(await page.getByRole('region', { name: 'Change review' }).getByRole('combobox').count(), 0, 'Review has no repository discovery picker');
  const added = page.locator('[data-diff-line]').filter({ hasText: '+value: after' });
  await added.waitFor();
  const rendered = await page.locator('[data-diff]').first().innerText();
  for (const metadata of ['diff --git', 'index 1234567', '--- a/', '+++ b/']) {
    assert.ok(!rendered.includes(metadata), 'Patch metadata is hidden');
  }
  assert.equal(await page.getByText('Select lines and right-click to discuss them.', { exact: false }).count(), 0);
  const later = page.locator('[data-diff-line]').filter({ hasText: '+later: after' });
  assert.equal(await later.locator('span').nth(1).innerText(), '30', 'Hunk headers set correct line numbers');
  const hunk = page.locator('[data-diff-line]').filter({ hasText: '@@ -2,2 +2,2 @@' });
  const context = page.locator('[data-diff-line]').filter({ hasText: 'setting: true' });
  const textColor = row => row.evaluate(element => getComputedStyle(element).color);
  assert.notEqual(await textColor(hunk), await textColor(context), 'Hunk headers are visually muted');
  const summary = page.locator('section[aria-label="Change review"] summary');
  assert.equal(await summary.innerText(), 'proposal into main', 'Summary shows only the branch relationship');
  await summary.click();
  const details = await page.locator('section[aria-label="Change review"] details').innerText();
  assert.ok(details.includes('Base aaaaaaaa · Head bbbbbbbb'));
  assert.ok(!details.includes(review.snapshot.headCommit) && !details.includes(review.snapshot.baseCommit), 'Displayed commits are abbreviated');
  assert.ok(!details.includes('branch proposal'), 'Branch is not repeated');
  await summary.click();
  const removed = page.locator('[data-diff-line]').filter({ hasText: '-value: before' });
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-diff-line]')];
    const before = rows.find(row => row.textContent.includes('-value: before')).lastElementChild.firstChild;
    const after = rows.find(row => row.textContent.includes('+value: after')).lastElementChild.firstChild;
    const range = document.createRange();
    range.setStart(before, 0); range.setEnd(after, 0);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  });
  await removed.click({ button: 'right' });
  await page.getByRole('button', { name: 'Quote diff into chat' }).click();
  const boundaryQuote = page.getByRole('region', { name: 'Attached diff config.yaml', exact: true });
  await boundaryQuote.waitFor();
  assert.equal(await boundaryQuote.locator('[data-quoted-diff-line]').count(), 1, 'A selection ending at the next line start excludes that line');
  await page.getByRole('button', { name: 'Remove diff config.yaml', exact: true }).click();
  await page.getByRole('button', { name: 'Open change review', exact: true }).click();
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
  assert.equal(await page.locator('[data-diff]').count(), 2, 'All files render together');
  const sidebar = page.getByRole('navigation', { name: 'Changed files' });
  const reviewPanel = page.getByRole('region', { name: 'Change review', exact: true });
  await reviewPanel.evaluate(element => element.style.width = '380px');
  assert.equal(await sidebar.isVisible(), false, 'Narrow columns hide the sidebar even in a wide browser');
  assert.equal(await page.getByRole('heading', { name: 'config.yaml', exact: true }).isVisible(), true, 'Diff headers retain the filename');
  assert.equal(await page.locator('[data-diff]').count(), 2, 'All file diffs remain available');
  if (process.env.NARROW_SCREENSHOT) await page.screenshot({ path: process.env.NARROW_SCREENSHOT });
  await reviewPanel.evaluate(element => element.style.width = '');
  assert.equal(await sidebar.isVisible(), true, 'Wider columns retain filename navigation');
  for (const filename of [sidebar.getByRole('button', { name: 'config.yaml', exact: true }), page.getByRole('heading', { name: 'config.yaml', exact: true })]) {
    await filename.click({ button: 'right' });
    await page.getByRole('button', { name: 'Quote file into chat', exact: true }).click();
    const fullFile = page.getByRole('region', { name: 'Attached diff config.yaml', exact: true });
    await fullFile.waitFor();
    assert.ok((await fullFile.innerText()).includes('-value: before') && (await fullFile.innerText()).includes('+later: after'), 'Filename quotes include every hunk');
    if (process.env.FILE_SCREENSHOT) await page.screenshot({ path: process.env.FILE_SCREENSHOT });
    await page.getByRole('button', { name: 'Remove diff config.yaml', exact: true }).click();
    await page.getByRole('button', { name: 'Open change review', exact: true }).click();
  }
  const codeSize = await added.evaluate(element => parseFloat(getComputedStyle(element).fontSize));
  const fileSize = await sidebar.getByRole('button').first().evaluate(element => parseFloat(getComputedStyle(element).fontSize));
  assert.ok(fileSize < codeSize, 'File labels are smaller than code');
  if (process.env.REVIEW_SCREENSHOT) await page.screenshot({ path: process.env.REVIEW_SCREENSHOT });
  await sidebar.getByRole('button', { name: 'notes.txt', exact: true }).click();
  assert.ok(await page.getByRole('region', { name: 'Diff notes.txt', exact: true }).evaluate(element => element.parentElement.scrollTop > 0), 'Sidebar scrolls the shared diff view');
  const otherAdded = page.getByRole('region', { name: 'Diff notes.txt', exact: true }).locator('[data-diff-line]').filter({ hasText: '+new note' });
  assert.ok(await otherAdded.isVisible());
  assert.equal(await page.locator('[data-diff]').count(), 2, 'Sidebar navigation does not replace other files');
  await otherAdded.click({ button: 'right' });
  await page.getByRole('button', { name: 'Quote diff into chat' }).click();
  await page.getByRole('region', { name: 'Attached diff notes.txt', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Remove diff notes.txt', exact: true }).click();
  await page.getByRole('button', { name: 'Open change review', exact: true }).click();
  await sidebar.getByRole('button', { name: 'config.yaml', exact: true }).click();
  assert.ok((await added.innerText()).includes('3'));
  await added.click({ button: 'right' });
  await stage('Right-click a changed line to quote it into a question.');
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  await page.getByRole('button', { name: 'Quote diff into chat' }).click();
  const attachment = page.getByRole('region', { name: 'Attached diff config.yaml' }).filter({ has: page.getByRole('button', { name: 'Remove diff config.yaml', exact: true }) });
  await attachment.waitFor();
  assert.equal(await page.locator('[data-composer]').inputValue(), '', 'Diff content is separate from editable question');
  const attachedAdded = attachment.locator('[data-quoted-diff-line]').filter({ hasText: '+value: after' });
  const [quoteRed, quoteGreen] = await color(attachedAdded);
  assert.ok(quoteGreen > quoteRed, 'Attachment additions are green');
  assert.equal(await page.locator('section[aria-label="Change review"]').isVisible(), false);
  await page.locator('[data-composer]').fill('Explain this change.');
  if (demo) {
    await page.locator('[data-composer]').press('ControlOrMeta+End');
    await page.locator('[data-composer]').type('Can you explain this change before I approve it?', { delay: 35 });
  }
  await stage('The draft includes the review ID, exact commits, file, and line numbers.');
  if (demo) await page.screenshot({ path: `${demo}/review-quote.png` });
  await page.getByRole('button', { name: 'Remove diff config.yaml', exact: true }).click();
  assert.equal(await attachment.count(), 0);
  assert.ok((await page.locator('[data-composer]').inputValue()).includes('Explain this change.'), 'Removing a diff preserves the question');
  if (!demo) await page.setViewportSize({ width: 500, height: 800 });
  await page.getByRole('button', { name: 'Open change review', exact: true }).click();
  await added.waitFor();
  await page.locator('[data-diff]').first().evaluate(element => {
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
  await attachment.waitFor();
  assert.ok((await attachment.innerText()).includes('-value: before'));
  const attachedRemoved = attachment.locator('[data-quoted-diff-line]').filter({ hasText: '-value: before' });
  const [quoteRemovedRed, quoteRemovedGreen] = await color(attachedRemoved);
  assert.ok(quoteRemovedRed > quoteRemovedGreen, 'Attachment deletions are red');
  await page.getByRole('button', { name: 'back to the fleet', exact: true }).click();
  await page.getByText('Review test', { exact: true }).click();
  await attachment.waitFor();
  assert.ok((await page.locator('[data-composer]').inputValue()).includes('Explain this change.'), 'Question and attached diff survive navigation');
  await page.setViewportSize({ width: 1280, height: 800 });
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  assert.deepEqual(writes, [], 'Review and quote never send a message or change Git');
  await page.getByRole('button', { name: `Review ${review.title}`, exact: true }).click();
  await stage('When satisfied, approve this revision for publication.');
  await page.route('**/reviews/review-local/approve', r => r.fulfill({ status: 409, json: { error: 'Revision changed before approval' } }));
  await page.getByRole('button', { name: 'Approve publication' }).click();
  await page.getByRole('alert').filter({ hasText: 'Revision changed before approval' }).waitFor();
  assert.equal(await page.getByRole('region', { name: 'Change review' }).isVisible(), true, 'Failed approval keeps the review open');
  await page.route('**/reviews/review-local/approve', r => r.fulfill({ json: { ...review, status: 'approved' } }));
  await page.getByRole('button', { name: 'Approve publication' }).click();
  await page.getByRole('region', { name: 'Change review' }).waitFor({ state: 'hidden' });
  assert.equal(await page.locator('[data-composer]').inputValue(), 'Explain this change.', 'Approval returns to chat without losing the draft');
  if (process.env.APPROVED_SCREENSHOT) await page.screenshot({ path: process.env.APPROVED_SCREENSHOT });
  assert.equal(writes.length, 2, 'Only explicit approval attempts mutate review state');
  assert.ok(writes[0].endsWith('/reviews/review-local/approve'));
  await stage('Approval authorizes this revision only. Merge and deployment remain separate.');
  // A stale snapshot stays inspectable but cannot authorize publication.
  await page.route('**/reviews/review-local', r => r.fulfill({ json: { ...review, status: 'stale' } }));
  await page.getByRole('button', { name: `Review ${review.title}`, exact: true }).click();
  await added.waitFor();
  await page.getByText('Revision changed', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Approve publication' }).isDisabled(), true);
  await stage('Further edits require a new review. The previous diff stays readable.');
  if (!demo) {
    await page.getByRole('button', { name: 'Back to conversation' }).click();
    let sent;
    await page.route('**/api/say', route => { sent = route.request().postDataJSON(); return route.fulfill({ status: 500, json: { error: 'Test rejection' } }); });
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await attachment.waitFor();
    assert.equal(await page.locator('[data-composer]').inputValue(), 'Explain this change.', 'Rejected sends restore question and attachment');
    assert.ok(sent.text.includes(review.id) && sent.text.includes(`${review.snapshot.baseCommit}...${review.snapshot.headCommit}`));
    assert.ok(sent.text.includes('File: config.yaml (old 3–3, new 3–3)'));
    assert.ok(sent.text.includes('> -value: before\n> +value: after'));
    assert.ok(sent.text.endsWith('Explain this change.'));
    await page.route('**/api/say', route => {
      sent = route.request().postDataJSON();
      timeline.push({ id: 3, agentId: agent.id, at: Date.now()/1000, kind: 'you', text: sent.text, detail: 'diff-attachments:' + JSON.stringify(sent.diffs) });
      return route.fulfill({ json: {} });
    });
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await attachment.waitFor({ state: 'detached' });
    assert.equal(await page.locator('[data-composer]').inputValue(), '', 'Successful sends clear composer attachments');
    const sentDiff = page.locator('[data-entry="3"]').getByRole('region', { name: 'Attached diff config.yaml', exact: true });
    await sentDiff.waitFor();
    assert.equal(await sentDiff.getByRole('button', { name: 'Remove diff config.yaml' }).count(), 0);
    assert.equal(await page.locator('[data-entry="3"] blockquote').count(), 0, 'Sent diff does not become Markdown');
    assert.ok((await page.locator('[data-entry="3"]').innerText()).includes('Explain this change.'));
    const [sentRed, sentGreen] = await color(sentDiff.locator('[data-quoted-diff-line]').filter({ hasText: '-value: before' }));
    assert.ok(sentRed > sentGreen, 'Sent deletions stay red');
    const [sentAddRed, sentAddGreen] = await color(sentDiff.locator('[data-quoted-diff-line]').filter({ hasText: '+value: after' }));
    assert.ok(sentAddGreen > sentAddRed, 'Sent additions stay green');
    await page.reload();
    await sentDiff.waitFor();
    assert.ok((await sentDiff.innerText()).includes('-value: before'), 'Sent attachment survives reload');
    assert.ok(!(await page.locator('[data-entry="3"]').innerText()).includes('diff-attachments:'), 'Presentation metadata stays hidden');
    if (process.env.SENT_SCREENSHOT) await page.screenshot({ path: process.env.SENT_SCREENSHOT });
  }
  if (demo) {
    await page.screenshot({ path: `${demo}/review-stale.png` });
    const video = page.video();
    await page.context().close();
    await video.saveAs(`${demo}/pre-publication-review.webm`);
  }
  await page.route('**/reviews/review-local', r => r.fulfill({ status: 400, json: { error: 'Review worktree was removed; its diff is no longer available' } }));
  await page.reload();
  await page.getByRole('button', { name: `Review ${review.title}`, exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'worktree was removed' }).waitFor();
  assert.equal(await page.getByText('Reading review…', { exact: true }).count(), 0);
  await page.getByText('Review unavailable', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Approve publication', exact: true }).count(), 0);
  if (process.env.UNAVAILABLE_SCREENSHOT) await page.screenshot({ path: process.env.UNAVAILABLE_SCREENSHOT });
  console.log('Local review card, colors, quotes, explicit approval, stale revisions, and removed worktrees pass.');
} finally { await browser.close(); }
