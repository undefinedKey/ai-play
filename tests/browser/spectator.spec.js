import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = 'http://127.0.0.1:3108';
async function owner(request) {
  const response = await request.post(`${BASE}/api/auth/login`, { headers: { Origin: BASE }, data: { username: 'admin_test', password: 'Only-for-browser-tests-2026!' } });
  expect(response.ok()).toBe(true);
  const session = await response.json();
  const headers = { Origin: BASE, 'X-CSRF-Token': session.csrf_token };
  return async (path, data) => {
    const result = await request.post(BASE + path, { headers, data });
    expect(result.ok()).toBe(true);
    return result.json();
  };
}

test('旁观页：匿名访问真实地图及公开互动，实时出现聊天、小组和接龙，无控制权限', async ({ page, request }) => {
  const api = await owner(request);
  const created = await api('/api/agents', { name: '旁观测试小芽', bio: '喜欢讲故事的公开角色。', avatar: '🌱', color: '#477755' });
  const id = created.agent.agent_id;
  const controller = await api(`/api/agents/${id}/controllers`, { kind: 'external', name: '旁观测试控制端' });
  await api(`/api/agents/${id}/control`, { operation: 'start', controller_id: controller.controller_id, goal: 'OWNER_PRIVATE_GOAL_NOT_PUBLIC', duration_minutes: 5, max_calls: 100 });
  const client = new Client({ name: 'spectator-browser-test', version: '1' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(BASE + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${controller.token}` } } }));
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    expect(response.isError).not.toBe(true);
    return response.structuredContent || JSON.parse(response.content.find(c => c.type === 'text').text);
  };
  const session = await call('join_world');
  let action = session.next_action_id; let last = 0;
  const act = async (type, payload = {}) => {
    await new Promise(resolve => setTimeout(resolve, Math.max(0, 2050 - (Date.now() - last))));
    const result = await call('act', { run_id: session.run_id, session_epoch: session.session_epoch, action_id: action, type, payload });
    expect(result.status).toBe('applied');action = result.next_action_id;last = Date.now();return result;
  };
  const requests = [];
  page.on('request', req => { if (new URL(req.url()).pathname.startsWith('/api/')) requests.push({ path: new URL(req.url()).pathname, method: req.method() }); });
  try {
    await page.goto('/watch');
    await expect(page.getByRole('heading', { name: '旁观广场，看看它们的相遇。' })).toBeVisible();
    await expect(page.getByText('正在实时观察', { exact: true })).toBeVisible();
    await expect(page.getByTestId(`map-agent-${id}`)).toBeVisible();
    await page.getByTestId(`map-agent-${id}`).click();
    await expect(page.locator('.profile-info')).toContainText('喜欢讲故事的公开角色。');
    await act('say', { channel: 'nearby', text: '旁观朋友们好，这条消息正在实时送达。' });
    await expect(page.getByRole('log')).toContainText('旁观朋友们好，这条消息正在实时送达。');
    const group = await act('create_group');
    await expect(page.locator('.spectator-groups')).toContainText('旁观测试小芽的小聚');
    await act('propose_game', { group_id: group.group_id, game_type: 'word_chain' });
    await expect(page.locator('.activity-panel')).toContainText('报名中');
    await page.getByRole('button', { name: '对话', exact: true }).click();
    await expect(page.getByRole('log')).toContainText('旁观朋友们好');
    await expect(page.getByRole('log')).not.toContainText('发起词语接龙');
    for (const name of ['创建我的 AI', '配置', '暂停活动', '恢复活动', '召回我的 AI', '暂停整个房间']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('OWNER_PRIVATE_GOAL_NOT_PUBLIC');
    await expect(page.locator('body')).not.toContainText(controller.token);
    expect(requests.every(req => req.method === 'GET' && ['/api/public/world', '/api/public/events'].includes(req.path))).toBe(true);
    expect(await page.context().cookies()).toEqual([]);
    const denied = await page.evaluate(async () => (await fetch('/api/room/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'pause' }) })).status);
    expect(denied).toBe(401);
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect((await page.getByTestId('plaza-map').boundingBox()).width).toBeGreaterThan(viewport.width * 0.6);
      if (viewport.width < 700) expect((await page.locator('.profile-panel').boundingBox()).width).toBeGreaterThan(viewport.width * 0.6);
      const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(audit.violations.map(v => ({ id: v.id, help: v.help, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
      await page.screenshot({ path: `artifacts/spectator-${viewport.width}.png`, fullPage: true });
    }
  } finally {
    await api(`/api/agents/${id}/control`, { operation: 'recall' });
    await client.close();
  }
});

test('旁观页：实时连接中断保留画面并明确标记，重新连接恢复实况', async ({ page }) => {
  await page.route('**/api/public/events*', route => route.abort('connectionfailed'));
  await page.goto('/watch');
  await expect(page.getByTestId('plaza-map')).toBeVisible();
  await expect(page.getByText('实时连接暂时中断，正在显示最近收到的公开记录。系统会自动重连。', { exact: false })).toBeVisible();
  await expect(page.locator('.map-toolbar')).toContainText('最近收到的画面');
  await expect(page.locator('.event-heading')).toContainText('最近记录');
  await page.unroute('**/api/public/events*');
  await page.getByRole('button', { name: '重新连接', exact: true }).click();
  await expect(page.getByText('正在实时观察', { exact: true })).toBeVisible();
  await expect(page.locator('.spectator-stale')).toHaveCount(0);
});

test('旁观页：登录入口可以直接围观，初次加载失败可重试且不授予会话', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: '先看看广场' })).toBeVisible();
  await page.route('**/api/public/world', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: '旁观测试服务暂时不可用' } }) }));
  await page.getByRole('link', { name: '先看看广场' }).click();
  await expect(page.getByRole('alert')).toContainText('旁观测试服务暂时不可用');
  await expect(page.getByRole('heading', { name: '欢迎回到广场' })).toHaveCount(0);
  await page.unroute('**/api/public/world');
  await page.getByRole('button', { name: '重新连接', exact: true }).click();
  await expect(page.getByTestId('plaza-map')).toBeVisible();
  expect(await page.context().cookies()).toEqual([]);
  await expect(page.getByRole('link', { name: '带我的 AI 加入' })).toHaveAttribute('href', '/');
});
