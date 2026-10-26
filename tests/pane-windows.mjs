import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.TEST_URL ?? 'http://127.0.0.1:3942';
const agents = ['alpha', 'bravo', 'charlie'].map(id => ({ id, name: `${id} session`, cwd: '/workspace', backend: 'codex', model: 'fixture', status: 'complete', updatedAt: Date.now()/1000 }));
const review = { id: 'transfer-review', agentId: 'alpha', title: 'A quoted change', status: 'pending', description: '', snapshot: { repository: '/workspace', remote: 'origin', remoteUrl: 'https://example.invalid/repo.git', branch: 'proposal', baseRef: 'main', baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), files: [{ path: 'example.txt', patch: '@@ -1 +1 @@\n-before\n+after' }] } };
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const errors = [], writes = [];
  context.on('page', page => page.on('pageerror', error => errors.push(String(error))));
  await context.addInitScript(() => {
    window.SharedWorker = undefined;
    window.EventSource = class extends EventTarget { close() {} };
  });
  let releasePopup;
  let popupGate = null;
  await context.route('**/api/state', async route => {
    if (popupGate && await route.request().frame().page().opener()) await popupGate;
    return route.fulfill({ json: { mode: 'ask', agents, archived: [], messages: {}, tasks: [], taskNotes: [], inbox: [], paneLinks: {}, quoteThreads: [], tags: {}, boards: [], sources: [], models: [], backends: [] } }).catch(() => {});
  });
  const terminal = { id: 'terminal_fixture', name: 'Fixture shell', granted: [], pending: [] };
  await context.route('**/api/terminals{,/**}', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/api/terminals') return route.fulfill({ json: [terminal] });
    if (url.pathname.endsWith('/claim')) return route.fulfill({ json: { controller: 'fixture-controller' } });
    if (request.method() !== 'GET') return route.fulfill({ json: { ok: true } });
    await new Promise(resolve => setTimeout(resolve, 50));
    return route.fulfill({ json: { terminal, bytes: url.searchParams.get('after') === '0' ? [...Buffer.from('Shared shell fixture.\r\n')] : [], end: 23, reset: false } }).catch(() => {});
  });
  await context.route('**/api/agents/*', route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1), agent = agents.find(agent => agent.id === id);
    return route.fulfill({ json: { agent, timeline: [{ id: 1, agentId: id, kind: 'said', text: `Conversation ${id}.`, at: 1, detail: '' }, ...(id === 'alpha' ? [{ id: 2, agentId: id, kind: 'review', text: review.title, detail: review.id, at: 2 }] : [])], delivery: 'start' } });
  });
  await context.route('**/reviews/transfer-review', route => route.fulfill({ json: review }));
  await context.route('**/api/say-attachments', route => {
    writes.push({ path: '/api/say-attachments', body: route.request().postDataBuffer() });
    return route.fulfill({ json: { ok: true } });
  });
  context.on('request', request => { if (request.method() !== 'GET' && !request.url().endsWith('/api/say-attachments')) writes.push({ path: request.url() }); });
  const page = await context.newPage();
  const pane = (page, id) => page.locator(`[data-agent-pane="${id}"]`);
  const draft = (page, id) => pane(page, id).locator('[data-composer]');
  const tab = (page, id) => page.getByRole('tab', { name: `${id} session`, exact: true });
  const relativeWidth = async page => {
    const [alpha, bravo] = await Promise.all([pane(page, 'alpha').boundingBox(), pane(page, 'bravo').boundingBox()]);
    return alpha.width / (alpha.width + bravo.width);
  };
  const select = async (page, id, checked) => {
    await page.getByLabel('Choose visible agents').click();
    await page.getByRole('checkbox', { name: `${id} session`, exact: true }).setChecked(checked);
    await page.getByLabel('Choose visible agents').click();
  };
  await page.goto(`${base}/?agent=alpha`);
  await pane(page, 'alpha').waitFor();
  await select(page, 'bravo', true);
  await draft(page, 'bravo').fill('Keep the other pane.');
  await page.getByRole('button', { name: `Review ${review.title}`, exact: true }).click();
  await page.getByRole('heading', { name: 'example.txt', exact: true }).click({ button: 'right' });
  await page.getByRole('button', { name: 'Quote file into chat', exact: true }).click();
  await draft(page, 'alpha').fill('Move this draft with its pane.');
  await pane(page, 'alpha').locator('input[type="file"]').first().setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('file-payload-kept-across-windows') });
  await pane(page, 'alpha').getByText('notes.txt', { exact: true }).waitFor();
  const moveMenu = async (page, id) => {
    await page.getByRole('button', { name: `Move pane ${id}`, exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Move to new window', exact: true }).click({ timeout: 2000 });
  };
  await page.evaluate(() => { window.realOpen = window.open; window.open = () => null; });
  await moveMenu(page, 'alpha');
  await page.getByText('The browser blocked the new window.', { exact: false }).waitFor();
  assert.equal(await draft(page, 'alpha').inputValue(), 'Move this draft with its pane.', 'A blocked popup preserves the original draft');
  await page.evaluate(() => { window.open = window.realOpen; });
  popupGate = new Promise(resolve => { releasePopup = resolve; });
  const cancelledOpening = page.waitForEvent('popup');
  await moveMenu(page, 'alpha');
  const cancelledPopup = await cancelledOpening;
  await cancelledPopup.close();
  releasePopup(); popupGate = null;
  assert.equal(await draft(page, 'alpha').inputValue(), 'Move this draft with its pane.', 'Closing a destination before it is ready preserves the original draft and pane');
  await pane(page, 'alpha').getByText('notes.txt', { exact: true }).waitFor();
  popupGate = new Promise(resolve => { releasePopup = resolve; });
  const opening = page.waitForEvent('popup');
  await moveMenu(page, 'alpha');
  const popup = await opening;
  assert.equal(await pane(page, 'alpha').count(), 1, 'The original remains while the destination is loading');
  releasePopup(); popupGate = null;
  await pane(popup, 'alpha').waitFor();
  await pane(page, 'alpha').waitFor({ state: 'detached' });
  assert.equal(await draft(popup, 'alpha').inputValue(), 'Move this draft with its pane.');
  await popup.getByRole('region', { name: 'Attached diff example.txt', exact: true }).waitFor();
  await pane(popup, 'alpha').getByText('notes.txt', { exact: true }).waitFor();
  assert.equal(await draft(page, 'bravo').inputValue(), 'Keep the other pane.');
  assert.equal(await tab(page, 'alpha').count(), 0, 'A moved primary pane leaves the remaining workspace under its own tab');
  await tab(page, 'bravo').waitFor();
  assert.equal(await popup.getByRole('tab').count(), 1, 'A detached window starts with its transferred tab only');
  await popup.goBack();
  await pane(popup, 'alpha').waitFor();
  assert.equal(new URL(popup.url()).searchParams.has('transfer'), false, 'A consumed handoff does not reappear through browser history');

  // Drag payloads cross real documents; the handoff uses the actual BroadcastChannel.
  const crossDrop = async (sourcePage, source, destinationPage, target, edge) => {
    const data = await source.evaluate(element => {
      const transfer = new DataTransfer();
      element.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
      return Object.fromEntries([...transfer.types].map(type => [type, transfer.getData(type)]));
    });
    assert.ok(data['application/x-oxroute-transfer']);
    const targetPane = pane(destinationPage, target);
    await targetPane.evaluate((element, { data, edge }) => {
      const transfer = new DataTransfer(); for (const [type, text] of Object.entries(data)) transfer.setData(type, text);
      const box = element.getBoundingClientRect();
      const x = edge === 'left' ? box.left + 5 : edge === 'right' ? box.right - 5 : box.left + box.width/2;
      const y = edge === 'top' ? box.top + 5 : edge === 'bottom' ? box.bottom - 5 : box.top + box.height/2;
      window.transferDrop = { transfer, x, y };
      element.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: transfer }));
    }, { data, edge });
    await destinationPage.getByLabel(`Place pane ${edge}`, { exact: true }).waitFor();
    await targetPane.evaluate(element => {
      const { transfer, x, y } = window.transferDrop;
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: transfer }));
    });
  };
  const closed = popup.waitForEvent('close');
  await crossDrop(popup, tab(popup, 'alpha'), page, 'bravo', 'left');
  await pane(page, 'alpha').waitFor();
  await closed;
  assert.ok(popup.isClosed(), 'An emptied detached window closes after its pane is received');
  assert.equal(await draft(page, 'alpha').inputValue(), 'Move this draft with its pane.');
  const alphaBox = await pane(page, 'alpha').boundingBox(), bravoBox = await pane(page, 'bravo').boundingBox();
  assert.ok(alphaBox.x < bravoBox.x && Math.abs(alphaBox.y - bravoBox.y) < 2, 'Cross-window docking respects the selected edge');
  await pane(page, 'alpha').getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-agent-pane="alpha"] [data-composer]').value === '');
  assert.equal(writes.length, 1);
  const sent = writes[0].body.toString();
  for (const expected of ['Move this draft with its pane.', 'file-payload-kept-across-windows', 'notes.txt', 'example.txt']) assert.ok(sent.includes(expected), `Moving preserves ${expected}`);

  const other = await context.newPage();
  await other.goto(`${base}/?agent=bravo`);
  await pane(other, 'alpha').waitFor();
  await select(other, 'alpha', false);
  await draft(page, 'bravo').fill('');
  await page.reload();
  await pane(page, 'alpha').waitFor();
  await other.reload();
  await pane(other, 'bravo').waitFor();
  assert.equal(await pane(other, 'alpha').count(), 0, 'Each window retains its own layout after reload');
  await page.getByRole('button', { name: 'Move pane alpha', exact: true }).dragTo(page.getByRole('navigation', { name: 'Session tabs', exact: true }));
  await tab(page, 'alpha').waitFor();
  assert.equal(await pane(page, 'bravo').count(), 0, 'Dragging a pane to the tab strip creates a separate workspace');
  await tab(page, 'bravo').click();
  await pane(page, 'bravo').waitFor();
  assert.equal(await pane(page, 'alpha').count(), 0);
  await tab(page, 'alpha').dragTo(pane(page, 'bravo'), { targetPosition: { x: 5, y: 120 } });
  await pane(page, 'alpha').waitFor();
  assert.equal(await tab(page, 'alpha').count(), 0, 'Docking a tab removes that tab and keeps its pane');
  const split = page.getByRole('separator', { name: 'resize chat panes', exact: true }).first();
  await split.focus(); await split.press('ArrowRight');
  const ratioBefore = await relativeWidth(page);
  const groupOpening = page.waitForEvent('popup');
  await tab(page, 'bravo').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to new window', exact: true }).click();
  const group = await groupOpening;
  await pane(group, 'alpha').waitFor(); await pane(group, 'bravo').waitFor();
  await pane(page, 'bravo').waitFor({ state: 'detached' });
  const ratioAfter = await relativeWidth(group);
  assert.ok(Math.abs(ratioBefore - ratioAfter) < 0.02, 'Moving a tab preserves the whole pane layout and split ratios');
  await other.getByRole('button', { name: 'Show the fleet', exact: true }).click();
  await other.getByRole('button', { name: 'charlie session', exact: true }).click();
  const groupClosed = group.waitForEvent('close');
  await crossDrop(group, tab(group, 'bravo'), other, 'charlie', 'right');
  await pane(other, 'alpha').waitFor(); await pane(other, 'bravo').waitFor(); await groupClosed;
  const nestedRatio = await relativeWidth(other);
  assert.ok(Math.abs(nestedRatio - ratioBefore) < 0.02, 'Docking a whole window retains nested split ratios');
  assert.equal(writes.length, 1, 'Moving views never archives, forks, merges or terminates sessions');

  await page.getByRole('button', { name: 'alpha session', exact: true }).click();
  assert.equal(await pane(page, 'bravo').count(), 0, 'Reopening a moved session does not resurrect its former companion panes');
  await draft(page, 'alpha').fill('An incoming draft.');
  await draft(other, 'alpha').fill('An existing draft.');
  await crossDrop(page, tab(page, 'alpha'), other, 'alpha', 'left');
  await pane(page, 'alpha').waitFor({ state: 'detached' });
  assert.equal(await pane(other, 'alpha').count(), 1, 'Docking an already visible session keeps a single pane');
  assert.equal(await draft(other, 'alpha').inputValue(), 'An existing draft.\n\nAn incoming draft.', 'Both windows’ unsent text is retained when the same session is docked');

  const dragOut = async (cancel) => {
    await other.getByRole('button', { name: 'Move pane alpha', exact: true }).evaluate((element, cancel) => {
      const transfer = new DataTransfer();
      element.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
      if (cancel) window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
      // The browser protects the drag data at dragend; the source retains its own ticket.
      element.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: new DataTransfer(), clientX: -20, clientY: 100, screenX: 200, screenY: 100 }));
    }, cancel);
  };
  const windowCount = context.pages().length;
  await dragOut(true);
  assert.equal(context.pages().length, windowCount, 'Escape cancels an outside drag without creating a window');
  const tearOpening = other.waitForEvent('popup');
  await dragOut(false);
  const torn = await tearOpening;
  await pane(torn, 'alpha').waitFor(); await pane(other, 'alpha').waitFor({ state: 'detached' });
  const tornClosed = torn.waitForEvent('close');
  await crossDrop(torn, tab(torn, 'alpha'), other, 'charlie', 'bottom');
  await pane(other, 'alpha').waitFor(); await tornClosed;
  assert.ok((await pane(other, 'alpha').boundingBox()).y > (await pane(other, 'charlie').boundingBox()).y, 'Dragging out and docking back respects the new destination edge');

  await page.getByRole('button', { name: 'alpha session', exact: true }).click();
  await page.getByLabel('Choose visible agents').click();
  await page.getByRole('checkbox', { name: terminal.name, exact: true }).check();
  await page.getByLabel('Choose visible agents').click();
  await page.locator(`[data-terminal-pane="${terminal.id}"]`).waitFor();
  const shellOpening = page.waitForEvent('popup');
  await moveMenu(page, terminal.id);
  const shell = await shellOpening;
  await shell.locator(`[data-terminal-pane="${terminal.id}"]`).waitFor();
  await pane(page, terminal.id).waitFor({ state: 'detached' });
  const shellClosed = shell.waitForEvent('close');
  await crossDrop(shell, shell.getByRole('tab', { name: terminal.name, exact: true }), page, 'alpha', 'right');
  await page.locator(`[data-terminal-pane="${terminal.id}"]`).waitFor(); await shellClosed;
  assert.ok(!writes.some(write => /\/(end|delete|archive|fork|merge)(\/|$)/.test(write.path)), 'Terminal and conversation moves never end or replace the backing sessions');
  assert.deepEqual(errors, []);
  if (process.env.SCREENSHOT) await other.screenshot({ path: process.env.SCREENSHOT });
  console.log('Panes detach and dock across windows with drafts, diff quotes and files intact; tabs and pane groups move together, window layouts stay independent, and blocked popups preserve their source.');
} finally { await browser.close(); }
