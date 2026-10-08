import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const agent = { id: 'inline-review-test', name: 'Inline reviews', cwd: '/workspace', backend: 'codex', model: 'test', status: 'complete', updatedAt: Date.now()/1000 };
const reviews = ['a', 'b'].map((letter, index) => ({ id: `review_${letter.repeat(32)}`, title: ['Adjust cache settings', 'Update installation guide'][index], status: 'pending', description: '',
  snapshot: { repository: '/workspace', remote: 'origin', remoteUrl: 'https://example.invalid/repo', branch: 'proposal', baseRef: 'main', baseCommit: 'c'.repeat(40), headCommit: 'd'.repeat(40), files: [] } }));
const unknown = `review_${'e'.repeat(32)}`;
const text = `Please review ${reviews[0].id}, or compare \`${reviews[1].id}\`.\n\nUnknown: ${unknown}. Lookalike: ${reviews[0].id}extra.\n\n\`\`\`text\n${reviews[0].id}\n\`\`\`\n\n[Existing link](https://example.invalid/${reviews[0].id})`;
const timeline = [...reviews.map((review, index) => ({ id: index + 1, agentId: agent.id, at: Date.now()/1000, kind: 'review', text: review.title, detail: review.id })),
  { id: 3, agentId: agent.id, at: Date.now()/1000, kind: 'said', text, detail: '' }];
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  await page.route('**/api/state', r => r.fulfill({ json: { mode: 'ask', agents: [agent], archived: [], messages: {}, tasks: [], taskNotes: [], inbox: [], paneLinks: {}, tags: {}, boards: [], sources: [], models: [], backends: [] } }));
  await page.route('**/api/events', r => r.fulfill({ contentType: 'text/event-stream', body: ': test\n\n' }));
  await page.route('**/api/agents/*', r => r.fulfill({ json: { agent, timeline, delivery: 'start' } }));
  for (const review of reviews) await page.route(`**/reviews/${review.id}`, r => r.fulfill({ json: review }));
  const writes = [];
  page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
  await page.goto(`${process.env.TEST_URL ?? 'http://127.0.0.1:3941'}/?agent=${agent.id}`);
  const message = page.locator('[data-entry="3"]');
  await message.getByRole('button', { name: `Review ${reviews[0].title}`, exact: true }).waitFor();
  assert.equal(await message.getByRole('button').count(), 2, 'Plain and inline-code review references render as cards');
  assert.ok((await message.innerText()).includes(unknown), 'Unknown references stay literal');
  assert.ok((await message.innerText()).includes(`${reviews[0].id}extra`), 'ID prefixes do not match');
  assert.equal((await message.locator('pre').innerText()).trim(), reviews[0].id, 'Code blocks preserve literal IDs');
  assert.equal(await message.getByRole('link', { name: 'Existing link' }).getAttribute('href'), `https://example.invalid/${reviews[0].id}`);
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  for (const review of reviews) {
    await message.getByRole('button', { name: `Review ${review.title}`, exact: true }).click();
    await page.getByRole('region', { name: 'Change review' }).getByText(review.title, { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Back to conversation', exact: true }).click();
  }
  assert.deepEqual(writes, [], 'Opening references never approves or sends a message');
  console.log('Inline review references open the matching review; unknown IDs, code blocks and existing links remain literal.');
} finally { await browser.close(); }
