import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
const agent = {
  id: 'test-chat', name: 'Test chat', backend: 'codex', model: 'test-model',
  sessionId: '', cwd: '', status: 'complete', activity: '',
  permalink: 'https://example.invalid/session', lastActivity: 0,
  updatedAt: Date.now()/1000, stallReason: null, stallAlerted: false, pinned: false,
};
const url = 'https://example.invalid/exact-message';
const entries = [url, ''].map((slackUrl, at) => ({
  id: at+1, agentId: agent.id, at: Date.now()/1000, kind: 'received',
  text: slackUrl ? 'A message with a Slack counterpart' : 'A message without a Slack counterpart',
  detail: '', output: '', origin: '', reaction: '', slackUrl,
}));
await page.route('**/api/state', r => r.fulfill({ json: {
  mode: 'ask', defaultModel: agent.model, agents: [agent], archived: [],
  tasks: [], taskNotes: [], inbox: [], paneLinks: {}, tags: {}, boards: [],
  messages: {}, sources: [], models: [], backends: [],
} }));
await page.route('**/api/events', r => r.fulfill({ contentType: 'text/event-stream', body: ': test\n\n' }));
await page.route('**/api/agents/*', r => r.fulfill({ json: { agent, timeline: entries, delivery: 'start' } }));
await page.context().route('https://example.invalid/**', r => r.fulfill({ body: 'Test destination' }));
await page.goto(`${process.env.TEST_URL ?? 'http://localhost:3941'}/?agent=${agent.id}`);
await page.locator('[data-entry="1"]').click({ button: 'right' });
const actions = page.getByRole('group', { name: 'message actions' });
const link = actions.getByRole('link', { name: 'open in Slack' });
assert.equal(await link.getAttribute('href'), url);
assert.equal(await link.getAttribute('title'), 'Open in Slack');
await page.getByRole('button', { name: 'quote reply', exact: true }).waitFor();
if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
const popupPromise = page.waitForEvent('popup');
await link.click();
const popup = await popupPromise;
await popup.waitForLoadState();
assert.equal(popup.url(), url);
await popup.close();
await page.locator('[data-entry="2"]').click({ button: 'right' });
assert.equal(await actions.getByRole('link', { name: 'open in Slack' }).count(), 0);
await page.getByRole('button', { name: 'quote reply', exact: true }).click();
assert.ok((await page.locator('[data-composer]').inputValue()).includes(entries[1].text));
await browser.close();
console.log('Passed exact-message link, hidden action without a link, popup navigation, and quote reply. No Slack requests sent.');
