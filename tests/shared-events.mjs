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
const workers = new Set();
let paused = false;
const heartbeat = setInterval(() => {
  if (!paused) for (const stream of streams) stream.write('event: heartbeat\ndata: {}\n\n');
}, 1000);
let connections = 0;
const server = createServer((request, response) => {
  if (request.url === '/api/events') {
    connections++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"type":"sync"}\n\n');
    streams.add(response);
    request.on('close', () => streams.delete(response));
  } else if (request.url.startsWith('/events-worker.js') || request.url === '/client.js') {
    response.writeHead(200, { 'content-type': 'text/javascript' });
    if (request.url !== '/client.js') workers.add(request.url);
    response.end(request.url === '/client.js' ? source : worker);
  } else if (request.url === '/older-client') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<script>window.events=[]; const worker=new SharedWorker("/events-worker.js"); worker.port.onmessage=event=>events.push(JSON.parse(event.data)); onpagehide=()=>worker.port.postMessage("close");</script>');
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
  // A broken tunnel can leave an apparently open response without any frames.
  const beforeStall = connections;
  const syncCounts = await Promise.all(pages.map(page => page.evaluate(() => window.events.filter(event => event.type === 'sync').length)));
  paused = true;
  const stalledAt = performance.now();
  await pages[0].waitForFunction(count => window.events.filter(event => event.type === 'sync').length > count, syncCounts[0], { timeout: 22000 });
  console.log(`Silent shared stream recovered in ${Math.round(performance.now() - stalledAt)} ms.`);
  assert.ok(connections > beforeStall, 'A silent connection is replaced and every tab resynchronizes');
  paused = false;
  for (const [index, page] of pages.entries()) await page.waitForFunction(count => window.events.filter(event => event.type === 'sync').length > count, syncCounts[index]);
  const started = performance.now();
  const [download] = await Promise.all([pages[0].waitForEvent('download', { timeout: 1000 }), pages[0].getByText('Download').click()]);
  console.log(`Seven tabs: download started in ${Math.round(performance.now() - started)} ms, before the 1500 ms body finished.`);
  assert.equal(await download.failure(), null);
  await pages[0].close();
  for (const stream of streams) stream.write('data: {"type":"notice","text":"Still connected"}\n\n');
  for (const page of pages.slice(1)) await page.waitForFunction(() => window.events.some(event => event.text === 'Still connected'));
  const afterRecovery = connections;
  assert.equal(streams.size, 1, 'Closing the first tab preserves the shared connection');
  for (const page of pages.slice(1)) await page.evaluate(() => window.stopFollowing());
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(streams.size, 0, 'Last subscriber releases the connection');
  const beforeRenew = await pages[1].evaluate(() => window.events.filter(event => event.type === 'sync').length);
  await pages[1].evaluate(async () => {
    const { follow } = await import('/client.js');
    window.stopFollowing = follow(event => events.push(event));
  });
  await pages[1].waitForFunction(count => window.events.filter(event => event.type === 'sync').length >= count + 2, beforeRenew);
  assert.equal(connections, afterRecovery + 1, 'A new subscriber reconnects after everyone left');
  const older = await context.newPage();
  await older.goto(`${url}/older-client`);
  await older.waitForFunction(() => window.events.filter(event => event.type === 'sync').length >= 2);
  assert.equal(workers.size, 2, 'The repaired worker is isolated from the runtime kept alive by older tabs');
  assert.equal(streams.size, 2, 'Older tabs keep their connection during the worker upgrade');
  await older.close();
  console.log('Every tab receives updates; closing tabs and resubscribing preserve live updates.');
  await context.close();
  const direct = await browser.newContext();
  await direct.addInitScript(() => { window.SharedWorker = undefined; });
  const page = await direct.newPage();
  await page.goto(url);
  await page.waitForFunction(() => window.events?.some(event => event.type === 'sync'));
  const healthyConnections = connections;
  await page.waitForTimeout(17000);
  assert.equal(connections, healthyConnections, 'A quiet but healthy stream stays connected');
  paused = true;
  const directStall = performance.now();
  await page.waitForFunction(() => window.events.filter(event => event.type === 'sync').length > 1, null, { timeout: 22000 });
  console.log(`Silent stream without SharedWorker recovered in ${Math.round(performance.now() - directStall)} ms.`);
  paused = false;
  for (const stream of streams) stream.write('data: {"type":"notice","text":"Recovered"}\n\n');
  await page.waitForFunction(() => window.events.some(event => event.text === 'Recovered'));
  await page.evaluate(() => window.stopFollowing());
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(streams.size, 0, 'Unsubscribing closes the direct connection and its watchdog');
} finally {
  clearInterval(heartbeat);
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
