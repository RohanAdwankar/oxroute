import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// This suite requires an isolated daemon with terminal-fixture-agent already stored.
const url = process.env.TEST_URL ?? 'http://127.0.0.1:3943';
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 750 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(`${url}/?agent=terminal-fixture-agent`);
  await page.getByLabel('Choose visible agents').click();
  await page.getByRole('button', { name: 'New terminal', exact: true }).click();
  const pane = page.locator('[data-terminal-pane]');
  await pane.waitFor();
  const id = await pane.getAttribute('data-terminal-pane');
  const typed = pane.locator('.xterm-helper-textarea');
  await typed.focus();
  await page.keyboard.type("printf '%s' 'user-' 'input'");
  await page.keyboard.press('Enter');
  const api = async (suffix, body) => {
    const response = await page.request[body ? 'post' : 'get'](`${url}/api/terminals/${id}${suffix}`, body ? { data: body } : {});
    return response;
  };
  const output = async () => Buffer.from((await (await api('')).json()).bytes).toString();
  const waitOutput = async text => {
    for (let n = 0; n < 100; n++) { if ((await output()).includes(text)) return; await page.waitForTimeout(100); }
    assert.fail(`Terminal never produced ${text}`);
  };
  await waitOutput('user-input');
  assert.equal((await api('/input', { agentId: 'terminal-fixture-agent', data: 'printf denied\r' })).ok(), false);
  await api('/access', { agentId: 'terminal-fixture-agent' });
  await page.getByRole('alertdialog', { name: 'Terminal access request' }).waitFor();
  await page.getByRole('button', { name: 'Allow', exact: true }).click();
  await page.getByRole('button', { name: 'Revoke', exact: true }).waitFor();
  assert.equal((await api('/input', { agentId: 'terminal-fixture-agent', data: "printf '%s' 'agent-' 'input'\r" })).ok(), true);
  await waitOutput('agent-input');
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  await page.getByRole('button', { name: 'Revoke', exact: true }).click();
  await page.getByRole('button', { name: 'Revoke', exact: true }).waitFor({ state: 'detached' });
  assert.equal((await api('/input', { agentId: 'terminal-fixture-agent', data: 'printf denied\r' })).ok(), false);
  await page.reload();
  await pane.waitFor();
  await typed.focus();
  await page.keyboard.type("printf '%s' 'reload-' 'works'");
  await page.keyboard.press('Enter');
  await waitOutput('reload-works');
  assert.deepEqual(errors, []);
  page.once('dialog', dialog => dialog.accept());
  await pane.getByRole('button', { name: 'End terminal session' }).click();
  await pane.waitFor({ state: 'detached' });
  console.log('Real terminal user input, agent approval, revocation, reload and ending pass.');
} finally { await browser.close(); }
