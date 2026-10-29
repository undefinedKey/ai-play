import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
mkdirSync('artifacts', { recursive: true });

test('桌面：创建、入场、模拟交谈、暂停、恢复、召回及隔离连接', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByTestId('plaza-map')).toBeVisible();
  await page.screenshot({ path: 'artifacts/desktop-empty.png', fullPage: true });
  await page.getByRole('button', { name: '创建我的 AI', exact: true }).first().click();
  await page.getByLabel('它叫什么名字？').fill('测试小芽');
  await page.getByLabel('公开介绍', { exact: false }).fill('喜欢自然和词语接龙，想认识新朋友。');
  await page.getByRole('button', { name: '创建角色', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '开始活动', exact: true }).click();
  await expect(page.getByRole('button', { name: '查看测试小芽，活动中', exact: true })).toBeVisible();
  await expect(page.locator('.map-agent')).toHaveCount(3, { timeout: 15000 });
  await expect(page.getByRole('log')).toContainText('大家好', { timeout: 15000 });
  await page.screenshot({ path: 'artifacts/desktop-active.png', fullPage: true });
  await page.getByRole('button', { name: '对话', exact: true }).click();
  await expect(page.locator('.event-list')).not.toContainText('已获准活动');
  await page.getByRole('button', { name: '暂停活动', exact: true }).click();
  await expect(page.getByRole('button', { name: '恢复活动', exact: true })).toBeVisible();
  await page.screenshot({ path: 'artifacts/desktop-paused.png', fullPage: true });
  await page.getByRole('button', { name: '恢复活动', exact: true }).click();
  await expect(page.getByRole('button', { name: '查看测试小芽，活动中', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '召回我的 AI', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始活动', exact: true })).toBeVisible();
  await expect(page.locator('.map-agent')).toHaveCount(0, { timeout: 15000 });
  await page.getByRole('button', { name: '配置', exact: true }).click();
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(page.getByText('第三方持续运行待验证')).toBeVisible();
  await page.screenshot({ path: 'artifacts/connection-test.png', fullPage: true });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('外部控制端：凭证创建、明确授权和未连接状态', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '配置', exact: true }).click();
  await page.getByLabel('控制端名称', { exact: true }).fill('测试外部运行器');
  await page.getByRole('button', { name: '创建凭证', exact: true }).click();
  await expect(page.locator('.code-line.secret')).toContainText('Bearer ');
  await page.getByRole('button', { name: '完成配置', exact: false }).click();
  await page.locator('#controller').selectOption({ label: '测试外部运行器' });
  await page.getByRole('button', { name: '允许开始', exact: true }).click();
  await expect(page.locator('.my-agent-identity')).toContainText('待连接');
  await expect(page.locator('.map-agent')).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/external-permission.png', fullPage: true });
  await page.getByRole('button', { name: '召回我的 AI', exact: true }).click();
});

test('手机390×844：布局、键盘、说明弹窗与减少动效', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.getByTestId('plaza-map')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: '接入指南', exact: false }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement.closest('[role="dialog"]'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/mobile.png', fullPage: true });
  const unnamed = await page.locator('button').evaluateAll(buttons => buttons.filter(b => !b.textContent.trim() && !b.getAttribute('aria-label') && !b.getAttribute('title')).length);
  expect(unnamed).toBe(0);
});

test('加载与错误状态给出明确反馈和重试操作', async ({ page }) => {
  let release;
  const gate = new Promise(r => { release = r; });
  await page.route('**/api/world', async route => { await gate; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: '测试服务暂时不可用' } }) }); });
  await page.goto('/');
  await expect(page.getByText('正在打开广场…', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'artifacts/loading.png', fullPage: true });
  release();
  await expect(page.getByRole('alert')).toContainText('测试服务暂时不可用');
  await expect(page.getByRole('button', { name: '重新连接', exact: true })).toBeVisible();
  await page.screenshot({ path: 'artifacts/error.png', fullPage: true });
});

test('实时流中断：保留快照并显示重连提示', async ({ page }) => {
  await page.route('**/api/events', route => route.abort('connectionfailed'));
  await page.goto('/');
  await expect(page.getByTestId('plaza-map')).toBeVisible();
  await expect(page.getByText('实时连接暂时中断，显示最近的广场快照。正在自动重连…', { exact: false })).toBeVisible();
  await page.screenshot({ path: 'artifacts/partial.png', fullPage: true });
});

test('无障碍：桌面和手机主要工作台通过WCAG AA自动检查', async ({ page }) => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.getByTestId('plaza-map')).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(results.violations.map(v => ({ id: v.id, help: v.help, nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })) }))).toEqual([]);
  }
});
