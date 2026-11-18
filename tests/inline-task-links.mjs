import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
const agent = { id: 'reference-fixture', name: 'References', status: 'complete', backend: 'codex', model: 'fixture', updatedAt: Date.now()/1000 };
const tasks = ['a', 'b', 'c'].map((letter, index) => ({ id: `task_${letter.repeat(32)}`, text: ['Inspect a change', 'Validate a release', 'Review a deployment'][index], status: ['incomplete', 'complete', 'done'][index], agentId: agent.id, blockedByTaskId: '', images: [], createdAt: index, updatedAt: index }));
const unknown = `task_${'e'.repeat(32)}`;
const text = `Review ${tasks[2].id}. See ${tasks[0].id} and \`${tasks[1].id}\`. Unknown ${unknown}. Lookalike ${tasks[0].id}extra.\n\n\`\`\`text\n${tasks[0].id}\n\`\`\`\n\n[Existing link](https://example.invalid/${tasks[0].id})`;
const timeline = [{ id: 1, agentId: agent.id, kind: 'said', text, at: Date.now()/1000, detail: '' },
  { id: 2, agentId: agent.id, kind: 'notice', text: `Resuming open work:\n- ${tasks[0].id}\n- ${tasks[1].id}\n- ${tasks[2].id}`, at: Date.now()/1000, detail: '' }];
const browser = await (process.env.BROWSER==='webkit'?webkit:chromium).launch(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{});
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  await page.route('**/api/**',r=>new URL(r.request().url()).pathname==='/api/version'?r.continue():r.fulfill({json:[]}));
  await page.route('**/api/state', r => r.fulfill({ json: { mode: 'ask', agents: [agent], archived: [], messages: {}, tasks, taskNotes: [], inbox: [], paneLinks: {}, tags: {}, boards: [], sources: [], models: [], backends: [] } }));
  await page.route('**/api/events', r => r.fulfill({ contentType: 'text/event-stream', body: ': test\n\n' }));
  await page.route('**/api/agents/*', r => r.fulfill({ json: { agent, timeline, delivery: 'start' } }));
  await page.route('**/api/terminals', r => r.fulfill({ json: [] }));
  let fail = false;
  await page.route('**/api/tasks/*', async r => {
    const body = r.request().postDataJSON();
    if (fail) return r.fulfill({ status: 500, json: { error: 'Could not save approval' } });
    assert.equal(body.status, 'complete');
    assert.equal(body.approved, true);
    assert.equal(body.note, 'approved');
    tasks[2] = { ...tasks[2], ...body };
    await r.fulfill({ json: tasks[2] });
  });
  timeline[0].text += `\n\nWe are validating ${tasks[0].id}. Next comes the deployment.\n\n- Current work: ${tasks[0].id}. Keep the surrounding sentence intact.\n- Pending decision: ${tasks[2].id}. Preserve its actions.`;
  const writes = [];
  page.on('request', r => { if (r.method() !== 'GET') writes.push(r.url()); });
  await page.route('**/api/focus/agent',r=>r.fulfill({json:agent}));
  await page.goto(`${process.env.TEST_URL ?? 'http://127.0.0.1:3946'}/?${process.env.FOCUS?'view=focus':`agent=${agent.id}`}`);
  const message = page.locator('[data-entry="1"]');
  await message.getByRole('button', { name: `Task ${tasks[0].text}`, exact: true }).first().waitFor();
  assert.equal(await message.getByRole('button', { name: /^Task / }).count(), 5);
  assert.ok((await message.innerText()).includes(unknown));
  assert.ok((await message.innerText()).includes(`${tasks[0].id}extra`));
  assert.equal((await message.locator('pre').innerText()).trim(), tasks[0].id);
  assert.equal(await message.getByRole('link', { name: 'Existing link' }).getAttribute('href'), `https://example.invalid/${tasks[0].id}`);
  const notice = page.locator('[data-entry="2"]');
  assert.equal(await notice.getByRole('button', { name: /^Task / }).count(), 2, 'Resume notices hide completed task previews');
  for (const task of tasks.filter(task=>task.status!=='complete')) assert.equal((await notice.innerText()).split(task.text).length - 1, 1, 'Notice titles appear once');
  writes.length=0;
  for(const width of [1100,475]) {
    await page.setViewportSize({width,height:900});
    for(const row of [message.locator('p').filter({hasText:'We are validating'}),message.locator('li').filter({hasText:'Current work:'})]) {
    await row.waitFor();
    const badge=row.locator('[data-task-reference]');
    const layout=await row.evaluate(row=>{
      const badge=row.querySelector('[data-task-reference]');
      const prefix=[...row.childNodes].find(node=>node.nodeType===Node.TEXT_NODE&&node.textContent.trim()&&!node.textContent.startsWith('.'));
      const suffix=[...row.childNodes].find(node=>node.nodeType===Node.TEXT_NODE&&node.textContent.startsWith('.'));
      const rect=node=>{const range=document.createRange();range.selectNodeContents(node);range.setEnd(node,1);return range.getBoundingClientRect();};
      return {width:badge.getBoundingClientRect().width,available:row.getBoundingClientRect().width,prefix:rect(prefix).y,badge:badge.getBoundingClientRect().y,period:rect(suffix).y,overflow:document.documentElement.scrollWidth>window.innerWidth};
    });
    assert.ok(layout.width<layout.available-20,'Reference uses its content width');assert.ok(Math.abs(layout.prefix-layout.badge)<8,'Task stays with its preceding prose');assert.ok(Math.abs(layout.period-layout.badge)<8,'Punctuation stays on the same line');assert.equal(layout.overflow,false);
    await badge.getByRole('button',{name:`Task ${tasks[0].text}`,exact:true}).focus();
    }
    if(process.env.ARTIFACT_DIR)await page.screenshot({path:`${process.env.ARTIFACT_DIR}/inline-tasks-${width}.png`});
  }
  await page.setViewportSize({width:1100,height:900});
  for (const task of tasks.filter(task=>task.status!=='complete')) {
    const trigger=message.getByRole('button', { name: `Task ${task.text}`, exact: true }).first();
    await trigger.focus();await page.keyboard.press('Enter');
    await page.locator('[data-task-row]').filter({ hasText: task.text }).waitFor();
    await page.locator('[data-task-row][aria-current="true"]').filter({ hasText: task.text }).waitFor();
  }
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  assert.deepEqual(writes, []);
  const reference = message.locator(`[data-task-reference="${tasks[2].id}"]`).first();
  await reference.getByRole('button', { name: 'Not yet', exact: true }).click();
  if(process.env.FOCUS)await reference.getByRole('textbox',{name:`Revision for ${tasks[2].text}`}).waitFor();
  else await page.getByText(`Not yet: ${tasks[2].text}`, { exact: true }).waitFor();
  assert.deepEqual(writes, [], 'Correction opens the existing composer without changing a task');
  // Failed approval must leave the same controls available to retry.
  fail = true;
  await reference.getByRole('button',{name:`Task ${tasks[2].text}`,exact:true}).focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'Approve');
  await page.keyboard.press('Space');
  await page.getByText('Could not save approval', { exact: true }).waitFor();
  await reference.getByRole('button', { name: 'Approve', exact: true }).waitFor();
  fail = false;

  await reference.getByRole('button', { name: 'Approve', exact: true }).click();
  await reference.waitFor({state:'detached'});
  assert.equal(await reference.getByRole('button', { name: 'Approve', exact: true }).count(), 0);
  assert.equal(await page.locator('[data-task-row]').filter({hasText:tasks[2].text}).count(),0);
  assert.equal(tasks[2].status,'complete','Hiding a task preserves its stored approval');
  assert.equal(writes.filter(url => new URL(url).pathname.startsWith('/api/tasks/')).length, 2, 'One failed approval and one explicit retry');
  console.log('Task references support navigation, inline approval, correction, failure recovery and synchronized task status.');
} finally { await browser.close(); }
