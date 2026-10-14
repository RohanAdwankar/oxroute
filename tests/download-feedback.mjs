import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer, request as proxyRequest } from 'node:http';

const browser = await chromium.launch();
let closeServer;
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 }, acceptDownloads: true });
  const agent = { id: 'download-fixture', name: 'Download fixture', backend: 'codex', model: 'fixture', status: 'complete', updatedAt: Date.now()/1000 };
  await page.addInitScript(() => { window.SharedWorker = undefined; window.EventSource = class { close() {} }; });
  await page.route('**/api/state', r => r.fulfill({ json: { mode: 'ask', agents: [agent], archived: [], messages: {}, tasks: [], taskNotes: [], inbox: [], paneLinks: {}, tags: {}, boards: [], sources: [], models: [], backends: [] } }));
  await page.route('**/api/terminals', r => r.fulfill({ json: [] }));
  await page.route('**/api/agents/*', r => r.fulfill({ json: { agent, timeline: [{ id: 1, agentId: agent.id, kind: 'said', at: Date.now()/1000, text: 'Here is the report.\n\nAttached: art_fixture-report.csv', detail: '', output: '' }], delivery: 'start' } }));
  let release;
  const waiting = new Promise(resolve => release = resolve);
  const server = createServer((request, response) => {
    if (request.url.startsWith('/api/attachments/')) {
      void waiting.then(() => {
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="report.csv"' });
        response.end('name,value\nexample,42\n');
      });
    } else {
      const upstream = proxyRequest(new URL(request.url, process.env.TEST_URL ?? 'http://127.0.0.1:3942'), { headers: request.headers }, reply => {
        response.writeHead(reply.statusCode, reply.headers);
        reply.pipe(response);
      });
      upstream.on('error', error => response.destroy(error));
      request.pipe(upstream);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  closeServer = () => { server.closeAllConnections(); server.close(); };
  await page.goto(`http://127.0.0.1:${server.address().port}/?agent=${agent.id}`);
  const link = page.getByRole('link', { name: 'report.csv', exact: true });
  let started = false;
  const download = page.waitForEvent('download').then(file => { started = true; return file; });
  const click = link.click();
  await page.getByRole('status').filter({ hasText: 'Download requested' }).waitFor({ timeout: 1000 });
  assert.equal(await link.getAttribute('download'), 'report.csv', 'Native download and filename stay available');
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  assert.equal(started, false, 'Feedback appears before download headers arrive');
  release();
  await click;
  assert.equal((await download).suggestedFilename(), 'report.csv');
  console.log('Download click shows immediate feedback while the response is pending, then starts a native download.');
} finally { await browser.close(); closeServer?.(); }
