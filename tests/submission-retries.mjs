import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { chromium, webkit } from 'playwright';
const base = process.env.TEST_URL;
const agent = process.env.TEST_AGENT;
assert.ok(base && agent, 'Use an isolated runtime and a disposable conversation');
const attempts = new Map();
let drops = 1;
let droppedRead = false;
const proxy = createServer(async (req, res) => {
  if (req.url === '/api/state' && !droppedRead) {
    droppedRead = true;
    const body = await fetch(new URL(req.url, base)).then(response => response.text());
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) + 100 });
    res.write(body.slice(0, 1));
    setTimeout(() => res.destroy(), 30);
    return;
  }
  if (['/api/say', '/api/say-attachments'].includes(req.url)) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const payload = req.url === '/api/say' ? JSON.parse(body) : Object.fromEntries(await new Request(new URL(req.url, base), { method: 'POST', headers: req.headers, body }).formData());
    const id = payload.requestId;
    attempts.set(id, (attempts.get(id) ?? 0) + 1);
    const upstream = await fetch(new URL(req.url, base), { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body });
    const accepted = await upstream.text();
    assert.equal(upstream.status, 200, accepted);
    if (attempts.get(id) <= drops) {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': accepted.length + 100 });
      res.write(accepted.slice(0, 1));
      setTimeout(() => res.destroy(), 30);
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(accepted);
    }
    return;
  }
  const upstream = request(new URL(req.url, base), { method: req.method, headers: req.headers }, response => {
    res.writeHead(response.statusCode, response.headers);
    response.pipe(res);
  });
  upstream.on('error', () => res.destroy());
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${proxy.address().port}`;
const browser = await (process.env.TEST_BROWSER === 'webkit' ? webkit : chromium).launch(process.env.WEBKIT_EXECUTABLE ? { executablePath: process.env.WEBKIT_EXECUTABLE } : {});
try {
  const page = await browser.newPage();
  await page.addInitScript(() => { window.SharedWorker = undefined; window.EventSource = class extends EventTarget { close() {} }; });
  await page.goto(`${url}/?agent=${agent}`);
  const composer = page.locator('[data-composer]');
  for (const [index, attachment] of [false, true, false].entries()) {
    drops = index === 2 ? 3 : 1;
    const text = `Delivery ${crypto.randomUUID()}`;
    await composer.fill(text);
    if (attachment) await page.locator('input[type=file]').first().setInputFiles({ name: 'drawing.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>') });
    await composer.press('Enter');
    await page.waitForFunction(text => [...document.querySelectorAll('[data-entry]')].filter(entry => entry.textContent.includes(text)).length === 1, text);
    if (index === 2) {
      await page.waitForFunction(text => document.querySelector('[data-composer]').value === text, text);
      await composer.press('Enter');
    }
    const expected = index + 1;
    const expectedCounts = [2, 2, 4].slice(0, expected);
    for (let tries = 0; tries < 200 && (attempts.size !== expected || JSON.stringify([...attempts.values()]) !== JSON.stringify(expectedCounts)); tries++) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(attempts.size, expected);
    assert.deepEqual([...attempts.values()], expectedCounts, 'Automatic and manual retries retain the original submission ID');
    const view = await fetch(`${base}/api/agents/${agent}`).then(response => response.json());
    assert.equal(view.timeline.filter(entry => entry.kind === 'you' && entry.text.includes(text)).length, 1, 'Lost acknowledgements must not duplicate accepted messages');
    assert.equal(await composer.inputValue(), '', 'Recovered sends must not return to the draft');
    assert.equal(await page.locator('[data-entry]').filter({ hasText: text }).count(), 1);
  }
  assert.equal(attempts.size, 3);
  assert.ok(droppedRead, 'Initial conversation loading recovers from a truncated HTTP 200 response');
  assert.deepEqual([...attempts.values()], [2, 2, 4]);
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  console.log('Real truncated HTTP acknowledgements recover automatically; text and file submissions persist once with stable request IDs.');
} finally {
  await browser.close();
  proxy.closeAllConnections();
  await new Promise(resolve => proxy.close(resolve));
}
