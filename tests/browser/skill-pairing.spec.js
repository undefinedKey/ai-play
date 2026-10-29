import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ACCOUNT_URL = 'http://127.0.0.1:3108';
const ADMIN_PASSWORD = process.env.PLAZA_E2E_ADMIN_PASSWORD || 'Only-for-browser-tests-2026!';

async function pair(request, clientName = 'AI Skill 浏览器测试') {
  const response = await request.post(`${ACCOUNT_URL}/api/skill/pair`, { data: { client_name: clientName } });
  expect(response.status()).toBe(201);
  return response.json();
}

async function login(page) {
  await page.getByLabel('用户名', { exact: true }).fill(process.env.PLAZA_E2E_ADMIN_USERNAME || 'admin_test');
  await page.getByLabel('密码', { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '让你的 AI 进入广场' })).toBeVisible();
}

async function createAndApprove(page, name) {
  await page.getByLabel('使用哪个角色？').selectOption('new');
  await page.getByLabel('角色名字', { exact: true }).fill(name);
  const response = page.waitForResponse(response => /\/api\/skill\/pair\/[^/]+\/approve$/.test(response.url()));
  await page.getByRole('button', { name: '创建角色并连接', exact: true }).click();
  const approval = await response;
  expect(approval.ok()).toBe(true);
  const result = await approval.json();
  expect(result.token).toBeUndefined();
  await expect(page.getByRole('heading', { name: '已连接，请回到 AI 继续' })).toBeVisible();
  return result;
}

test('Skill 连接：保留登录前链接，一步创建角色授权，凭据仅由发起端领取', async ({ page, request }) => {
  const invitation = await pair(request, '我的桌面 AI');
  await page.goto(invitation.verification_url);
  await expect(page.getByRole('heading', { name: '欢迎回到广场' })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('connect')).toBe(invitation.user_code);
  await login(page);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('我的桌面 AI');
  await expect(dialog).toContainText(invitation.user_code);
  await expect(dialog).not.toContainText(invitation.device_secret);
  await page.getByLabel('使用哪个角色？').selectOption('new');
  await page.getByLabel('角色名字', { exact: true }).fill('Skill 小芽');
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const axe = await new AxeBuilder({ page }).include('.modal').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(axe.violations.map(v => ({ id: v.id, nodes: v.nodes.map(node => node.target) }))).toEqual([]);
    await page.screenshot({ path: `artifacts/skill-pairing-${viewport.width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const approved = await createAndApprove(page, 'Skill 小芽');
  const response = await request.post(`${ACCOUNT_URL}/api/skill/pair/poll`, { data: { pairing_id: invitation.pairing_id, device_secret: invitation.device_secret } });
  expect(response.ok()).toBe(true);
  const credential = await response.json();
  expect(credential.status).toBe('approved');
  expect(credential.agent_id).toBe(approved.agent_id);
  expect(credential.controller_id).toBe(approved.controller_id);
  expect(credential.token.length).toBeGreaterThan(20);
  await expect(dialog).not.toContainText(credential.token);
  await page.getByRole('button', { name: '完成，查看广场', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has('connect')).toBe(false);
  await expect(page.locator('.my-agent-identity')).toContainText('Skill 小芽');
});

test('Skill 连接：活动角色转交须显式确认，旧预算不会被默默覆盖', async ({ page, request }) => {
  const first = await pair(request, '原来的 AI');
  await page.goto(first.verification_url);
  await login(page);
  const previous = await createAndApprove(page, '等待转交的小芽');
  const second = await pair(request, '新的 AI');
  await page.goto(second.verification_url);
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByLabel('使用哪个角色？').selectOption(previous.agent_id);
  const transfer = page.getByRole('checkbox', { name: /我同意转交给本次连接/ });
  await expect(transfer).not.toBeChecked();
  const submit = page.getByRole('button', { name: '确认转交并连接', exact: true });
  await expect(submit).toBeDisabled();
  await transfer.check();
  await expect(submit).toBeEnabled();
  const posted = page.waitForRequest(request => /\/api\/skill\/pair\/[^/]+\/approve$/.test(request.url()));
  const response = page.waitForResponse(response => /\/api\/skill\/pair\/[^/]+\/approve$/.test(response.url()));
  await submit.click();
  expect((await posted).postDataJSON().transfer).toBe(true);
  const result = await (await response).json();
  expect(result.agent_id).toBe(previous.agent_id);
  expect(result.controller_id).not.toBe(previous.controller_id);
  await expect(page.getByRole('heading', { name: '已连接，请回到 AI 继续' })).toBeVisible();
});

test('Skill 连接：拒绝不给角色权限，失效链接说明重新发起', async ({ page, request }) => {
  const invitation = await pair(request, '取消测试 AI');
  await page.goto(invitation.verification_url);
  await login(page);
  await page.getByRole('button', { name: '拒绝连接', exact: true }).click();
  await expect(page.getByRole('heading', { name: '已拒绝这次连接' })).toBeVisible();
  const response = await request.post(`${ACCOUNT_URL}/api/skill/pair/poll`, { data: { pairing_id: invitation.pairing_id, device_secret: invitation.device_secret } });
  const result = await response.json();
  expect(result.status).toBe('denied');
  expect(result.token).toBeUndefined();
  await page.goto(`${ACCOUNT_URL}/?connect=XXXX-XXXX`);
  await expect(page.getByRole('alert')).toContainText(/不存在|过期/);
  await expect(page.getByRole('button', { name: '确认并连接', exact: true })).toHaveCount(0);
});
