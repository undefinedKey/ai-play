import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../../server/index.js';

let application, server, base, clients, clock;
test.beforeEach(async () => {
  application = await createApp({ dbPath: ':memory:', authDbPath: ':memory:', authMode: 'local', production: true });
  application.world.actionIntervalMs = 0;
  clock = Date.now(); application.world.now = () => clock;
  clients = [];
  ({ server, url: base } = await application.start(0));
});
test.afterEach(async () => {
  for (const client of clients) await client.close();
  await application.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
});
async function actor(request, name) {
  const session = await (await request.get(base + '/api/session')).json();
  const api = async (path, data) => {
    const response = await request.post(base + path, { headers: { Origin: base, 'X-CSRF-Token': session.csrf_token || '' }, data });
    expect(response.ok(), await response.text()).toBe(true); return response.json();
  };
  const { agent } = await api('/api/agents', { name });
  const controller = await api(`/api/agents/${agent.agent_id}/controllers`, { kind: 'external', name: '公开说话测试' });
  await api(`/api/agents/${agent.agent_id}/control`, { operation: 'start', controller_id: controller.controller_id, duration_minutes: 15, max_calls: 100, goal: 'PRIVATE_SPEECH_GOAL' });
  const client = new Client({ name: 'speech-test', version: '1' }, { capabilities: {} }); clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${controller.token}` } } }));
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args }); expect(response.isError).not.toBe(true);
    return response.structuredContent || JSON.parse(response.content.find(item => item.type === 'text').text);
  };
  const joined = await call('join_world'); let actionId = joined.next_action_id;
  return { agent, api, token: controller.token, act: async (type, payload = {}) => {
    const result = await call('act', { run_id: joined.run_id, session_epoch: joined.session_epoch, action_id: actionId, type, payload });
    expect(result.status, JSON.stringify(result)).toBe('applied'); actionId = result.next_action_id; return result;
  } };
}

test('真实公开发言在两张地图显示，关闭跨视图保留，新发言重新出现', async ({ page, request }) => {
  const a = await actor(request, '碎碎念旅人');
  await page.goto(base + '/watch?view=adventure');
  const speech = page.getByTestId('speech-window');
  await expect(speech).toHaveCount(0);
  await a.act('say', { channel: 'nearby', text: '打完这只怪，我想去看看萝卜。' });
  await expect(speech).toContainText('碎碎念旅人');
  await expect(speech).toContainText('打完这只怪，我想去看看萝卜。');
  await expect(speech).toContainText('附近');
  await page.getByRole('button', { name: '社交广场', exact: true }).click();
  await expect(speech).toContainText('打完这只怪，我想去看看萝卜。');
  await speech.getByRole('button', { name: /关闭/ }).click();
  await page.getByRole('button', { name: /冒险地图/ }).click();
  await expect(speech).toHaveCount(0);
  await a.act('say', { channel: 'nearby', text: '还是先去营地坐一会儿吧。' });
  await expect(speech).toContainText('还是先去营地坐一会儿吧。');
  await expect(page.getByRole('log')).toContainText('打完这只怪，我想去看看萝卜。');
  await expect(page.locator('body')).not.toContainText(a.token);
  await expect(page.locator('body')).not.toContainText('PRIVATE_SPEECH_GOAL');
});

test('长句可展开和收起，纯文本渲染，手机窗口可读且无障碍通过', async ({ page, request }) => {
  const a = await actor(request, '说故事的旅人');
  const text = '<img src=x onerror=alert(1)>' + '今天的风很舒服，萝卜也长得不错。'.repeat(7) + '结束啦。';
  await a.act('say', { channel: 'nearby', text });
  await page.goto(base + '/watch?view=adventure');
  const speech = page.getByTestId('speech-window');
  await speech.getByRole('button', { name: /展开/ }).click();
  await expect(speech).toContainText(text);
  await expect(speech.locator('img')).toHaveCount(0);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await speech.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const box = await speech.boundingBox(); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
    const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(audit.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
    await page.screenshot({ path: `artifacts/speech-window-${width}.png`, fullPage: true });
  }
  await speech.getByRole('button', { name: /收起/ }).click();
  await expect(speech.getByRole('button', { name: /展开/ })).toBeVisible();
});

test('公开小组发言有明确标识，时间到后消失但日志保留，离线不继续冒充说话', async ({ page, request }) => {
  const a = await actor(request, '小组旅人');
  const group = await a.act('create_group');
  await page.clock.install();
  await page.goto(base + '/watch?view=adventure');
  await a.act('say', { channel: 'group', group_id: group.group_id, text: '这句话说给小组里的朋友们。' });
  const speech = page.getByTestId('speech-window');
  await expect(speech).toContainText('小组');
  await expect(speech).toContainText('这句话说给小组里的朋友们。');
  // Advance both clocks: HTTP polling correctly reanchors the UI to server time.
  clock += 20000; application.world.tick();
  await page.clock.fastForward(20000);
  await expect(speech).toHaveCount(0);
  await expect(page.getByRole('log')).toContainText('这句话说给小组里的朋友们。');
  await a.act('say', { channel: 'nearby', text: '马上离开。' });
  await a.api(`/api/agents/${a.agent.agent_id}/control`, { operation: 'recall' });
  await expect(speech).toHaveCount(0);
});

test('断线只标记最近收到的公开发言，不生成新台词', async ({ page, request }) => {
  const a = await actor(request, '路边旅人');
  await a.act('say', { channel: 'nearby', text: '我刚刚看到了一只史莱姆。' });
  await page.route('**/api/public/events*', route => route.abort('connectionfailed'));
  await page.goto(base + '/watch?view=adventure');
  const speech = page.getByTestId('speech-window');
  await expect(speech).toContainText('最近收到');
  await expect(speech).toContainText('我刚刚看到了一只史莱姆。');
});
