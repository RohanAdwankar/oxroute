import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import ts from 'typescript';
import { chromium } from 'playwright';
const module = ts.transpileModule(fs.readFileSync(new URL('../app/lib/reviews.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const held = [];
let requested = 0;
const server = http.createServer((req, res) => {
  if (req.url === '/') { res.end('<!doctype html><title>Review request scheduling</title>'); return; }
  if (req.url === '/reviews.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(module); return; }
  res.setHeader('Content-Type', 'application/json');
  const send = () => res.end(JSON.stringify({ id: req.url, status: 'pending', snapshot: { files: [] } }));
  if (req.url.startsWith('/background/')) { requested++; held.push(send); } else send();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(async () => {
    const reviews = await import('/reviews.js');
    window.reviews = reviews;
    for (let i = 0; i < 10; i++) reviews.preloadReview(`/background/${i}`);
  });
  const deadline = Date.now() + 2000;
  while (!requested && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  let released = false;
  const release = setTimeout(() => { released = true; held.splice(0).forEach(send => send()); }, 1500);
  try {
    const elapsed = await page.evaluate(async () => {
      const start = performance.now();
      await window.reviews.loadReview('/foreground');
      return performance.now() - start;
    });
    console.log(`Foreground review: ${Math.round(elapsed)} ms; background released: ${released}`);
    assert.equal(released, false, 'A foreground review must complete while background review responses remain held');
  } finally { clearTimeout(release); }
} finally {
  held.splice(0).forEach(send => send());
  await browser.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
