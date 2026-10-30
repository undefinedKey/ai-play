import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = 'http://127.0.0.1:3108';
async function owner(request) {
  const login = await request.post(`${BASE}/api/auth/login`, { headers: { Origin: BASE }, data: { username: 'admin_test', password: 'Only-for-browser-tests-2026!' } });
  expect(login.ok()).toBe(true);
  const { csrf_token } = await login.json();
  return async (path, data) => {
    const response = await request.post(BASE + path, { headers: { Origin: BASE, 'X-CSRF-Token': csrf_token }, data });
    expect(response.ok()).toBe(true);
    return response.json();
  };
}

test('独处活动先在无人旁观时开始；旁观显示实际题目、校准倒计时、断线状态与完成结果', async ({ page, request }) => {
  const api = await owner(request);
  const { agent } = await api('/api/agents', { name: '自由活动的小芽', bio: '这是一张原 AI 的公开名片。' });
  const controller = await api(`/api/agents/${agent.agent_id}/controllers`, { kind: 'external', name: '活动验证接入端' });
  await api(`/api/agents/${agent.agent_id}/control`, { operation: 'start', controller_id: controller.controller_id, duration_minutes: 10080, max_calls: 2000, goal: 'PRIVATE_AUTONOMY_GOAL' });
  const client = new Client({ name: 'autonomy-browser-test', version: '1' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(BASE + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${controller.token}` } } }));
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    expect(response.isError).not.toBe(true);
    return response.structuredContent || JSON.parse(response.content.find(item => item.type === 'text').text);
  };
  const session = await call('join_world');
  let actionId = session.next_action_id; let lastAction = 0;
  const act = async (type, payload = {}) => {
    await new Promise(resolve => setTimeout(resolve, Math.max(0, 2050 - (Date.now() - lastAction))));
    const result = await call('act', { run_id: session.run_id, session_epoch: session.session_epoch, action_id: actionId, type, payload });
    expect(result.status).toBe('applied');
    actionId = result.next_action_id; lastAction = Date.now(); return result;
  };
  try {
    let position = session.self.position;
    while (Math.abs(position.x - 19) + Math.abs(position.y - 12) > 3) {
      const dx = Math.sign(19 - position.x) * Math.min(3, Math.abs(19 - position.x));
      const dy = Math.sign(12 - position.y) * Math.min(3 - Math.abs(dx), Math.abs(12 - position.y));
      position = (await act('move', { x: position.x + dx, y: position.y + dy })).position;
    }
    const started = await act('start_activity', { activity_id: 'solo_game' });
    expect(page.url()).toBe('about:blank');
    const terms = started.activity.task.prompt.match(/^(\d+) \+ (\d+) = \?$/);
    expect(terms).not.toBeNull();

    // A browser clock four hours ahead must not make this one-minute activity look finished.
    await page.addInitScript(() => { const clock = Date.now; Date.now = () => clock() + 4 * 60 * 60 * 1000; });
    await page.goto('/watch');
    await expect(page.locator('.map-toolbar')).toContainText('实时公开空间');
    await page.getByTestId(`map-agent-${agent.agent_id}`).click();
    const activity = page.getByTestId('public-activity');
    await expect(activity).toContainText('心算小挑战');
    await expect(activity).toContainText(started.activity.task.prompt);
    await expect(activity).toContainText(/约 \d+ 秒后结束/);
    await expect(activity).not.toContainText('等待服务器确认结束');
    await expect(page.locator('body')).not.toContainText('PRIVATE_AUTONOMY_GOAL');
    await expect(page.locator('body')).not.toContainText(controller.token);

    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(audit.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.target) }))).toEqual([]);
      await page.screenshot({ path: `artifacts/autonomy-${viewport.width}.png`, fullPage: true });
    }
    await page.route('**/api/public/events*', route => route.abort('connectionfailed'));
    await page.reload();
    await page.getByTestId(`map-agent-${agent.agent_id}`).click();
    await expect(activity).toContainText('最近记录，等待重连');
    await expect(activity).not.toContainText(/约 \d+ 秒后结束/);
    await act('finish_activity', { answer: Number(terms[1]) + Number(terms[2]) });
    await page.unroute('**/api/public/events*');
    await page.getByRole('button', { name: '重新连接', exact: true }).click();
    await expect(page.locator('.map-toolbar')).toContainText('实时公开空间');
    await expect(activity).toHaveCount(0);
    await page.getByRole('button', { name: '活动', exact: true }).click();
    await expect(page.getByRole('log')).toContainText('心算小挑战');
    await expect(page.getByRole('log')).toContainText('1 分');
    await expect(page.getByRole('log')).not.toContainText('走到了');
    expect(await page.context().cookies()).toEqual([]);
  } finally {
    await api(`/api/agents/${agent.agent_id}/control`, { operation: 'recall' });
    await client.close();
  }
});

test('Skill 网页可授权七天和有限预算，工作台保留同样选项并说明接入端须持续运行', async ({ page, request }) => {
  const api = await owner(request);
  const response = await request.post(`${BASE}/api/skill/pair`, { data: { client_name: '原 AI 常驻接入端' } });
  expect(response.ok()).toBe(true);
  const pair = await response.json();
  await page.goto(pair.verification_url);
  await page.getByLabel('用户名', { exact: true }).fill('admin_test');
  await page.getByLabel('密码', { exact: true }).fill('Only-for-browser-tests-2026!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByLabel('使用哪个角色？').selectOption('new');
  await page.getByLabel('角色名字', { exact: true }).fill('原来的小伙伴');
  await page.locator('.pairing-settings summary').click();
  await page.getByLabel('本次活动时长', { exact: true }).selectOption('10080');
  await page.getByLabel('本次调用上限', { exact: true }).selectOption('2000');
  await expect(page.locator('.pairing-settings summary')).toContainText('授权 7 天 · 最多 2000 次调用');
  await expect(page.locator('.continuous-note')).toContainText('原 AI 的宿主或本机桥需要保持运行');
  const approvedResponse = page.waitForResponse(value => /\/api\/skill\/pair\/[^/]+\/approve$/.test(value.url()));
  await page.getByRole('button', { name: '创建角色并连接', exact: true }).click();
  const approved = await approvedResponse;
  expect(approved.ok()).toBe(true);
  const result = await approved.json();
  try {
    await page.getByRole('button', { name: '完成，查看广场', exact: true }).click();
    await expect(page.locator('.my-agent-identity')).toContainText('原来的小伙伴');
    await expect(page.locator('.run-summary')).toContainText('6天');
    await expect(page.locator('.run-summary')).toContainText('2000');
    await page.locator('#duration').selectOption('10080');
    await page.locator('#max-calls').selectOption('2000');
    await expect(page.locator('.controller-field')).toContainText('原 AI 接入端需持续运行');
    await page.getByRole('button', { name: '接入指南', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('单纯下载 Skill 不会自动常驻');
    await expect(page.getByRole('dialog')).toContainText('没有观众');
  } finally {
    await api(`/api/agents/${result.agent_id}/control`, { operation: 'recall' });
  }
});
