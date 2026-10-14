import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { chromium } from 'playwright';

const source = ts.transpileModule(await readFile(new URL('../app/lib/api.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const worker = await readFile(new URL('../public/events-worker.js', import.meta.url));
const streams = new Set();
let connections = 0;
const server = createServer((request, response) => {
  if (request.url === '/api/events') {
    connections++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"type":"sync"}\n\n');
    streams.add(response);
    request.on('close', () => streams.delete(response));
  } else if (request.url === '/events-worker.js' || request.url === '/client.js') {
    response.writeHead(200, { 'content-type': 'text/javascript' });
    response.end(request.url === '/client.js' ? source : worker);
  } else if (request.url === '/download') {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="report.bin"', 'content-length': '131072' });
    response.write(Buffer.alloc(65536));
    setTimeout(() => response.end(Buffer.alloc(65536)), 1500);
  } else {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<a href="/download" download>Download</a><script type="module">import {follow} from "/client.js"; window.events=[]; window.stopFollowing=follow(event=>events.push(event));</script>');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ acceptDownloads: true });
  const pages = [];
  for (let i = 0; i < 7; i++) {
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.events?.some(event => event.type === 'sync'));
    pages.push(page);
  }
  assert.equal(connections, 1, 'Tabs share one event connection');
  for (const stream of streams) stream.write('data: {"type":"notice","text":"Updated"}\n\n');
  for (const page of pages) await page.waitForFunction(() => window.events.some(event => event.text === 'Updated'));
  const started = performance.now();
  const [download] = await Promise.all([pages[0].waitForEvent('download', { timeout: 1000 }), pages[0].getByText('Download').click()]);
  console.log(`Seven tabs: download started in ${Math.round(performance.now() - started)} ms, before the 1500 ms body finished.`);
  assert.equal(await download.failure(), null);
  await pages[0].close();
  for (const stream of streams) stream.write('data: {"type":"notice","text":"Still connected"}\n\n');
  for (const page of pages.slice(1)) await page.waitForFunction(() => window.events.some(event => event.text === 'Still connected'));
  assert.equal(connections, 1, 'Closing the first tab preserves the shared connection');
  for (const page of pages.slice(1)) await page.evaluate(() => window.stopFollowing());
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(streams.size, 0, 'Last subscriber releases the connection');
  await pages[1].evaluate(async () => {
    const { follow } = await import('/client.js');
    window.stopFollowing = follow(event => events.push(event));
  });
  await pages[1].waitForFunction(() => window.events.filter(event => event.type === 'sync').length > 2);
  assert.equal(connections, 2, 'A new subscriber reconnects after everyone left');
  console.log('Every tab receives updates; closing tabs and resubscribing preserve live updates.');
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
