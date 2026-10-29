import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../../server/index.js';

// Each test starts a real, empty world. Test clients explicitly drive their own agents.
let application, server, base;
test.beforeEach(async () => {
  application = await createApp({ dbPath: ':memory:', authDbPath: ':memory:', authMode: 'local', production: true });
  ({ server, url: base } = await application.start(0));
});
test.afterEach(async () => {
  await application.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

async function owner(request) {
  const response = await request.get(base + '/api/session');
  const { csrf_token } = await response.json();
  return async (path, data) => {
    const result = await request.post(base + path, { headers: { Origin: base, 'X-CSRF-Token': csrf_token || '' }, data });
    expect(result.ok(), await result.text()).toBe(true);
    return result.json();
  };
}

async function actor(api, name) {
  const { agent } = await api('/api/agents', { name, bio: '由测试明确创建并驱动的 MCP 角色。' });
  const controller = await api(`/api/agents/${agent.agent_id}/controllers`, { kind: 'external', name: `${name}的测试接入端` });
  await api(`/api/agents/${agent.agent_id}/control`, { operation: 'start', controller_id: controller.controller_id, duration_minutes: 15, max_calls: 1000, goal: 'PRIVATE_GAME_TEST_GOAL' });
  const client = new Client({ name: 'games-browser-test', version: '1' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${controller.token}` } } }));
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return result.structuredContent || JSON.parse(result.content.find(item => item.type === 'text').text);
  };
  const joined = await call('join_world');
  const session = { run_id: joined.run_id, session_epoch: joined.session_epoch };
  let actionId = joined.next_action_id, lastAction = 0;
  const observe = () => call('observe', session);
  const act = async (type, payload = {}) => {
    await new Promise(resolve => setTimeout(resolve, Math.max(0, 2050 - (Date.now() - lastAction))));
    const result = await call('act', { ...session, action_id: actionId, type, payload });
    expect(result.status).toBe('applied');
    actionId = result.next_action_id; lastAction = Date.now();
    return result;
  };
  const walk = async (target, radius = 0) => {
    let position = (await observe()).self.position;
    while (Math.abs(position.x-target.x)+Math.abs(position.y-target.y)>radius) {
      const dx = Math.sign(target.x-position.x)*Math.min(3,Math.abs(target.x-position.x));
      const dy = Math.sign(target.y-position.y)*Math.min(3-Math.abs(dx),Math.abs(target.y-position.y));
      position = (await act('move', { x: position.x+dx, y: position.y+dy })).position;
    }
  };
  let heartbeatError;
  const heartbeat = setInterval(() => observe().catch(error => { heartbeatError = error; }), 10000);
  return { agent, token: controller.token, observe, act, walk, close: async () => { clearInterval(heartbeat); await client.close(); if (heartbeatError) throw heartbeatError; } };
}

test('新广场没有默认角色，创建名片也不会自行模拟；活动目录在桌面和手机可读', async ({ page, request }) => {
  const initial = await (await request.get(base + '/api/public/world')).json();
  expect(initial.agents).toEqual([]);
  await page.goto(base + '/watch');
  await expect(page.getByTestId('plaza-map')).toContainText('空场也没关系，等真实 AI 来玩');
  await expect(page.locator('.map-agent')).toHaveCount(0);
  await expect(page.locator('.catalog-cards').first().locator('article')).toHaveCount(3);
  await expect(page.locator('.solo-cards article')).toHaveCount(7);
  await expect(page.locator('.activity-catalog')).toContainText('地图寻宝');
  await expect(page.locator('.activity-catalog')).not.toContainText('finish_activity');
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(audit.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.target) }))).toEqual([]);
    await page.screenshot({ path: `artifacts/games-empty-${viewport.width}.png`, fullPage: true });
  }
  await page.goto(base + '/');
  await page.getByRole('button', { name: '创建我的 AI', exact: true }).first().click();
  await page.getByLabel('它叫什么名字？').fill('名片测试角色');
  await page.getByRole('button', { name: '创建角色', exact: true }).click();
  await expect(page.locator('.my-agent-identity')).toContainText('未入场');
  await expect(page.getByRole('button', { name: '先配置接入方式', exact: true })).toBeDisabled();
  await expect(page.locator('.controller-field')).toContainText('Skill');
  await expect(page.locator('.map-agent')).toHaveCount(0);
  const createdResponse = await page.request.get(base + '/api/world');
  expect(createdResponse.ok()).toBe(true);
  const created = await createdResponse.json();
  expect(created.agents).toHaveLength(1);
  expect(created.controllers).toEqual([]);
  expect(created.agents[0].is_platform).toBe(false);
});

test('两个 MCP 角色完成暗选三回合与六段故事；旁观只显示已揭晓的选择和真实段落', async ({ page, request }) => {
  test.setTimeout(150000);
  const api = await owner(request);
  const a = await actor(api, '测试棋手甲');
  const b = await actor(api, '测试棋手乙');
  try {
    await b.walk((await a.observe()).self.position, 4);
    const { group_id } = await a.act('create_group');
    const { invite_id } = await a.act('invite', { group_id, target_agent_id: b.agent.agent_id });
    await b.act('respond_invite', { invite_id, accept: true });
    const open = async type => {
      const { game_id } = await a.act('propose_game', { group_id, game_type: type });
      await b.act('respond_game', { game_id, accept: true });
      await expect.poll(async () => (await a.observe()).game?.status, { timeout: 35000, intervals: [500] }).toBe('active');
      return (await a.observe()).game;
    };
    let game = await open('rock_paper_scissors');
    await page.goto(base + '/watch');
    const card = page.getByTestId('public-game');
    await expect(card).toContainText('石头剪刀布');
    for (let round = 1; round <= 3; round++) {
      await a.act('submit_move', { game_id: game.game_id, turn_id: game.turn_id, choice: 'rock' });
      await expect(card).toContainText('已提交 1 / 2 位');
      await expect(card.locator('.round-results article')).toHaveCount(round-1);
      const pending = await (await request.get(base + '/api/public/world')).json();
      expect(pending.game.private_choices).toBeUndefined();
      expect(pending.game.rounds).toHaveLength(round-1);
      game = (await b.act('submit_move', { game_id: game.game_id, turn_id: game.turn_id, choice: 'scissors' })).game;
      await expect(card.locator('.round-results article')).toHaveCount(round);
    }
    await expect(card).toContainText('已结束');
    await expect(card.getByLabel('总得分')).toContainText('测试棋手甲3 分');
    await expect(card.getByLabel('总得分')).toContainText('测试棋手乙0 分');
    game = await open('story_chain');
    const paragraphs = ['小船停在花园的水边。', '路过的朋友带来一张地图。', '地图上标着一片会发光的叶子。', '他们沿着小路找到了老树。', '树下的盒子里装着一封邀请信。', '于是他们回到广场，邀请新朋友来讲下一个故事。'];
    for (const text of paragraphs) {
      const current = game.current_agent_id === a.agent.agent_id ? a : b;
      game = (await current.act('submit_story', { game_id: game.game_id, turn_id: game.turn_id, text })).game;
      await expect(card).toContainText(text);
    }
    await expect(card).toContainText('完成 6 段故事');
    await expect(page.locator('.room-summary')).toContainText('故事已完成');
    await expect(card.locator('.story-segments li')).toHaveCount(6);
    await expect(page.locator('body')).not.toContainText('PRIVATE_GAME_TEST_GOAL');
    await expect(page.locator('body')).not.toContainText(a.token);
    await page.getByRole('button', { name: '游戏', exact: true }).click();
    await expect(page.getByRole('log')).toContainText(paragraphs[5]);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(audit.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.target) }))).toEqual([]);
      await page.screenshot({ path: `artifacts/games-story-${width}.png`, fullPage: true });
    }
  } finally { await a.close(); await b.close(); }
});

test('独处题目来自真实服务；寻宝目标、移动后的进度与完成结果实时可见', async ({ page, request }) => {
  test.setTimeout(180000);
  const a = await actor(await owner(request), '测试探索者');
  try {
    await a.walk({ x: 19, y: 4 }, 3);
    const riddle = await a.act('start_activity', { activity_id: 'riddle' });
    await page.goto(base + '/watch');
    await page.getByTestId(`map-agent-${a.agent.agent_id}`).click();
    const activity = page.getByTestId('public-activity');
    await expect(activity).toContainText(riddle.activity.task.prompt);
    await a.act('finish_activity');
    await a.walk({ x: 19, y: 12 }, 3);
    const sequence = await a.act('start_activity', { activity_id: 'sequence' });
    await expect(activity).toContainText(sequence.activity.task.prompt);
    const numbers = sequence.activity.task.prompt.match(/\d+/g).map(Number);
    const answer = numbers.at(-1)+numbers[1]-numbers[0];
    const result = await a.act('finish_activity', { answer });
    expect(result.result.score).toBe(1);
    await a.walk({ x: 11, y: 8 }, 3);
    let treasure = (await a.act('start_activity', { activity_id: 'treasure_hunt' })).activity;
    for (let collected = 0; collected < 3; collected++) {
      await expect(activity).toContainText(`已找到 ${collected} / 3`);
      await expect(activity).toContainText(`下一处宝藏 (${treasure.target.x}, ${treasure.target.y})`);
      await expect(page.locator('.map-treasure')).toBeVisible();
      if (collected === 0) {
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 900 });
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
          expect(audit.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.target) }))).toEqual([]);
          await page.screenshot({ path: `artifacts/games-treasure-${width}.png`, fullPage: true });
        }
      }
      await a.walk(treasure.target);
      await expect(activity).toContainText('地图寻宝');
      const next = await a.act('finish_activity');
      treasure = next.activity;
      if (collected === 2) expect(next.result.score).toBe(3);
    }
    await expect(activity).toHaveCount(0);
    await expect(page.locator('.map-treasure')).toHaveCount(0);
    await page.getByRole('button', { name: '活动', exact: true }).click();
    await expect(page.getByRole('log')).toContainText('地图寻宝');
    await expect(page.getByRole('log')).toContainText('找到 3 / 3 件宝物');
  } finally { await a.close(); }
});
