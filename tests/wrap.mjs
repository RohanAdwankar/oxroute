import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const agent = { id: 'wrap-fixture', name: 'Wrap fixture', cwd: '/workspace', backend: 'codex', model: 'fixture', status: 'complete', updatedAt: Date.now()/1000 };
const line = '+    ' + 'long_token'.repeat(60);
const review = { id: 'wrap-review', title: 'Long lines', description: '', status: 'pending', snapshot: {
  repository: agent.cwd, branch: 'proposal', baseRef: 'main', remote: 'origin', remoteUrl: 'https://example.invalid/repo', baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40),
  files: [{ path: 'settings.txt', patch: `@@ -1 +1 @@\n-old\n${line}\n` }],
} };
const timeline = [{ id: 1, agentId: agent.id, kind: 'review', text: review.title, detail: review.id, at: 1 },
  { id: 2, agentId: agent.id, kind: 'said', text: '```text\n' + line.slice(1) + '\n```', detail: '', at: 1 }];
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 700, height: 900 } });
  await page.route('**/api/state', r => r.fulfill({ json: { mode: 'ask', agents: [agent], archived: [], messages: {}, tasks: [], taskNotes: [], inbox: [], paneLinks: {}, tags: {}, boards: [], sources: [], models: [], backends: [] } }));
  await page.route('**/api/events', r => r.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' }));
  await page.route('**/api/agents/*', r => r.fulfill({ json: { agent, timeline, delivery: 'start' } }));
  await page.route('**/reviews/wrap-review', r => r.fulfill({ json: review }));
  const open = async () => {
    await page.goto(`${process.env.TEST_URL ?? 'http://127.0.0.1:3941'}/?agent=${agent.id}`);
    await page.getByRole('button', { name: 'Review Long lines', exact: true }).click();
  };
  const added = page.locator('[data-diff-line]').filter({ hasText: line });
  const height = async () => (await added.boundingBox()).height;
  const settings = async (on) => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const choice = page.getByRole('dialog').locator('section').filter({ has: page.getByText('Wrap code and diffs', { exact: true }) });
    await choice.getByRole('button').nth(on ? 1 : 0).click();
    if (on && process.env.SETTINGS_SCREENSHOT) await page.screenshot({ path: process.env.SETTINGS_SCREENSHOT });
    await page.keyboard.press('Escape');
  };
  await open();
  const unwrapped = await height();
  await settings(true);
  assert.ok(await height() > unwrapped * 2, 'Long diff lines wrap');
  assert.equal(await added.locator('span').last().textContent(), line, 'Wrapping preserves code and indentation');
  assert.ok(await added.evaluate(el => el.closest('[data-diff]').parentElement.scrollWidth <= el.closest('[data-diff]').parentElement.clientWidth), 'Wrapped diff fits horizontally');
  await page.getByRole('button', { name: 'Back to conversation', exact: true }).click();
  const code = page.locator('.message-markdown pre');
  assert.equal(await code.evaluate(el => getComputedStyle(el).whiteSpace), 'pre-wrap', 'Message code follows the same setting');
  await open();
  assert.ok(await height() > unwrapped * 2, 'Wrap preference survives reload');
  if (process.env.WRAP_SCREENSHOT) await page.screenshot({ path: process.env.WRAP_SCREENSHOT });
  await settings(false);
  assert.equal(await height(), unwrapped, 'Turning wrap off restores single-line diffs');
  await open();
  assert.equal(await height(), unwrapped, 'Off preference survives reload');
  await page.setViewportSize({ width: 500, height: 600 });
  await settings(true);
  assert.ok(await height() > unwrapped * 2, 'Wrap remains selectable on small screens');
  console.log('Wrap setting, code fidelity, horizontal fit and reload persistence pass.');
} finally { await browser.close(); }
