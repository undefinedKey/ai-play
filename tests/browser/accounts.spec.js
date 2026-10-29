import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ACCOUNT_URL = 'http://127.0.0.1:3108';
const ADMIN_USERNAME = process.env.PLAZA_E2E_ADMIN_USERNAME || 'admin_test';
const ADMIN_PASSWORD = process.env.PLAZA_E2E_ADMIN_PASSWORD || 'Only-for-browser-tests-2026!';

async function login(page, username = ADMIN_USERNAME, password = ADMIN_PASSWORD) {
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByTestId('plaza-map')).toBeVisible();
}

async function createAgent(page, name) {
  await page.getByRole('button', { name: '创建新角色', exact: true }).click();
  await page.getByLabel('它叫什么名字？').fill(name);
  await page.getByRole('button', { name: '创建角色', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.my-agent-identity')).toContainText(name);
}

test('邀请账号：登录、一次性邀请、注册、角色归属及注销', async ({ page }) => {
  const errors = [];
  const privateReads = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().endsWith('/api/world')) privateReads.push(request.url()); });
  await page.goto(ACCOUNT_URL);
  await expect(page.getByRole('heading', { name: '欢迎回到广场' })).toBeVisible();
  await expect(page.getByTestId('plaza-map')).toHaveCount(0);
  expect(privateReads).toEqual([]);
  await page.screenshot({ path: 'artifacts/accounts-login-desktop.png', fullPage: true });
  await page.getByLabel('用户名', { exact: true }).fill(ADMIN_USERNAME);
  await page.getByLabel('密码', { exact: true }).fill('not-the-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await login(page);
  await expect(page.getByRole('button', { name: '邀请成员', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /暂停整个房间/ })).toBeVisible();
  const unique = Date.now().toString(36);
  const otherAgent = `管理员朋友-${unique}`;
  await createAgent(page, otherAgent);
  await page.getByRole('button', { name: '邀请成员', exact: true }).click();
  await page.getByLabel('邀请码有效期').selectOption('24');
  const inviteRequest = page.waitForRequest(request => request.url().endsWith('/api/admin/invites') && request.method() === 'POST');
  await page.getByRole('button', { name: '生成邀请码', exact: true }).click();
  expect((await inviteRequest).headers()['x-csrf-token']).toBeTruthy();
  const invitation = page.getByLabel('一次性邀请码', { exact: true });
  await expect(invitation).toBeVisible();
  const code = await invitation.inputValue();
  expect(code.length).toBeGreaterThan(12);
  await page.getByRole('button', { name: '选中手动复制', exact: true }).click();
  expect(await invitation.evaluate(element => element.selectionEnd - element.selectionStart)).toBe(code.length);
  await page.getByRole('button', { name: '我已保存，完成', exact: true }).click();
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '欢迎回到广场' })).toBeVisible();
  await expect(page.getByTestId('plaza-map')).toHaveCount(0);
  await page.getByRole('button', { name: '邀请码注册', exact: true }).click();
  const username = `member_${unique}`;
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('显示名称', { exact: true }).fill('受邀测试朋友');
  await page.getByLabel('密码', { exact: true }).fill('Member-Test-Password-2026!');
  await page.getByLabel('邀请码', { exact: true }).fill(code);
  await page.getByRole('button', { name: '创建账号并进入', exact: true }).click();
  await expect(page.getByTestId('plaza-map')).toBeVisible();
  await expect(page.getByRole('button', { name: '邀请成员', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /暂停整个房间/ })).toHaveCount(0);
  await expect(page.locator('.my-agent-empty')).toBeVisible();
  await page.locator('.resident').filter({ hasText: otherAgent }).click();
  await expect(page.locator('.profile-type')).toHaveText('朋友的 AI · 公开角色');
  const agentRequest = page.waitForRequest(request => request.url().endsWith('/api/agents') && request.method() === 'POST');
  await createAgent(page, `成员小芽-${unique}`);
  expect((await agentRequest).headers()['x-csrf-token']).toBeTruthy();
  await expect(page.locator('.profile-type')).toHaveText('我的 AI · 公开角色');
  await page.screenshot({ path: 'artifacts/accounts-member.png', fullPage: true });
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByRole('button', { name: '邀请码注册', exact: true }).click();
  await page.getByLabel('用户名', { exact: true }).fill(`other_${unique}`);
  await page.getByLabel('显示名称', { exact: true }).fill('邀请码重用测试');
  await page.getByLabel('密码', { exact: true }).fill('Member-Test-Password-2026!');
  await page.getByLabel('邀请码', { exact: true }).fill(code);
  await page.getByRole('button', { name: '创建账号并进入', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByTestId('plaza-map')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('账号会话失效：401 清空工作台并回到登录', async ({ page }) => {
  await page.goto(ACCOUNT_URL);
  await login(page);
  await page.route('**/api/agents', route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'NOT_AUTHORIZED', message: '登录状态已失效' } }) }));
  await page.getByRole('button', { name: '创建新角色', exact: true }).click();
  await page.getByLabel('它叫什么名字？').fill('会话过期角色');
  await page.getByRole('button', { name: '创建角色', exact: true }).click();
  await expect(page.getByRole('heading', { name: '欢迎回到广场' })).toBeVisible();
  await expect(page.getByText('登录状态已失效，请重新登录。')).toBeVisible();
  await expect(page.getByTestId('plaza-map')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('邀请入口：桌面和手机布局、注册错误及无障碍', async ({ page }) => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto(ACCOUNT_URL);
    await expect(page.getByRole('heading', { name: '欢迎回到广场' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const loginResults = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(loginResults.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
    await page.getByRole('button', { name: '邀请码注册', exact: true }).click();
    await expect(page.getByLabel('邀请码', { exact: true })).toBeVisible();
    const registerResults = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(registerResults.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (viewport.width===390) await page.screenshot({ path: 'artifacts/accounts-register-mobile.png', fullPage: true });
  }
});
