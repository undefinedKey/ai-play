import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../../server/index.js';

let app, server, base, client, fixture, at;

test.beforeEach(async ({ request, page }) => {
  app = await createApp({ dbPath: ':memory:', authDbPath: ':memory:', authMode: 'local', production: true });
  at = Date.now(); app.world.now = () => at; app.world.actionIntervalMs = 0;
  ({ server, url: base } = await app.start(0));
  const session = await (await request.get(base + '/api/session')).json();
  const api = async (path, data) => {
    const response = await request.post(base + path, { headers: { Origin: base, 'X-CSRF-Token': session.csrf_token || '' }, data });
    expect(response.ok(), await response.text()).toBe(true); return response.json();
  };
  const { agent } = await api('/api/agents', { name: '传输恢复旅人' });
  const controller = await api(`/api/agents/${agent.agent_id}/controllers`, { kind: 'external', name: '隔离传输测试' });
  await api(`/api/agents/${agent.agent_id}/control`, { operation: 'start', controller_id: controller.controller_id, duration_minutes: 15, max_calls: 100, goal: 'PRIVATE_RECOVERY_GOAL' });
  client = new Client({ name: 'spectator-recovery-test', version: '1' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${controller.token}` } } }));
  const joined = await client.callTool({ name: 'join_world', arguments: {} }); expect(joined.isError).not.toBe(true);
  fixture = await (await request.get(base + '/api/public/world?scene=plaza')).json();
  expect(fixture.agents).toHaveLength(1);
  await page.clock.install({ time: new Date(at) }); await page.clock.pauseAt(new Date(at));
  await page.addInitScript(() => {
    // Control delivery order at the transport boundary, not inside React or the
    // merger. Closed streams can deliver an explicitly queued late callback.
    const streams = []; let maxLive = 0;
    class ControlledEventSource {
      constructor(url) {
        this.url = String(url); this.readyState = 0; this.closed = false; this.listeners = new Map();
        streams.push(this); maxLive = Math.max(maxLive, streams.filter(stream => !stream.closed).length);
      }
      addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(listener);
      }
      close() { this.closed = true; this.readyState = 2; }
      emit(type, value, queued = false) {
        if (this.closed && !queued) return;
        if (type === 'open') this.readyState = 1;
        if (type === 'error') this.readyState = 0;
        const event = ['snapshot', 'delta', 'message'].includes(type)
          ? new MessageEvent(type, { data: JSON.stringify(value) }) : new Event(type);
        this[`on${type}`]?.(event);
        for (const listener of this.listeners.get(type) || []) listener(event);
      }
    }
    window.EventSource = ControlledEventSource;
    window.__spectatorTransport = {
      emit: (index, type, value, queued) => streams[index].emit(type, value, queued),
      stats: () => ({ total: streams.length, live: streams.filter(stream => !stream.closed).length, maxLive, urls: streams.map(stream => stream.url) }),
    };
  });
});

test.afterEach(async () => {
  await client?.close(); await app?.close(); server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
});

// These are delivery-order fixtures based on a real filtered public response.
// Changed labels/positions identify the delivered frame; they are not AI actions.
function frame(name, x, { time = at, scene = 'plaza', id, revision = fixture.room.world_revision } = {}) {
  const value = structuredClone(fixture);
  value.server_time = time; value.room.world_revision = revision;
  value.scope = { scene_id: scene, events: 'scene', roster: 'world' };
  Object.assign(value.agents[0], { name, scene_id: scene, position: { x, y: 8 } });
  if (id) value.stream_frame_id = id;
  return value;
}
const fulfill = (route, value) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
const stats = page => page.evaluate(() => window.__spectatorTransport.stats());
async function emit(page, index, type, value, queued = false) {
  await page.evaluate(({ index, type, value, queued }) => window.__spectatorTransport.emit(index, type, value, queued), { index, type, value, queued });
}
async function streamSnapshot(page, index, value) { await emit(page, index, 'open'); await emit(page, index, 'snapshot', value); }
async function shows(page, name, x) {
  await expect(page.getByTestId('observer-selection')).toContainText(name);
  await expect(page.getByTestId('observer-status')).toContainText(`(${x}, 8)`);
}
async function singleStream(page, total) {
  await expect.poll(() => stats(page)).toMatchObject({ total, live: 1, maxLive: 1 });
}

test('首次公开请求失败后自动重试成功，重复轮询不额外建立实时连接', async ({ page }) => {
  let requests = 0;
  const current = frame('自动恢复的旅人', 11);
  await page.route('**/api/public/world*', route => ++requests === 1
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '临时断开，请稍后自动恢复' } }) })
    : fulfill(route, current));
  await page.goto(base + '/watch?view=plaza');
  await expect(page.getByRole('alert')).toContainText('临时断开'); expect((await stats(page)).total).toBe(0);
  await page.clock.fastForward(12000);
  await expect.poll(() => requests).toBe(2); await shows(page, '自动恢复的旅人', 11); await singleStream(page, 1);
  // The stream is still connecting: a second polling tick may fetch, but must
  // reuse the one EventSource rather than opening another connection.
  await page.clock.fastForward(12000); await expect.poll(() => requests).toBe(3); await singleStream(page, 1);
  await streamSnapshot(page, 0, { ...current, stream_frame_id: 'first:1' });
  await expect(page.locator('.spectator-stale')).toHaveCount(0);
  await page.clock.fastForward(24000); expect(requests).toBe(3); await singleStream(page, 1);
  await expect(page.locator('body')).not.toContainText('PRIVATE_RECOVERY_GOAL');
});

test('断线轮询的迟到 HTTP 即使同时间同版本，也不能覆盖已经恢复的实时帧', async ({ page }) => {
  let requests = 0, pending;
  const initial = frame('连接前的旅人', 10), oldPoll = frame('迟到的轮询画面', 11, { time: at + 2000 });
  await page.route('**/api/public/world*', route => {
    if (++requests === 1) return fulfill(route, initial);
    pending = () => fulfill(route, oldPoll);
  });
  await page.goto(base + '/watch?view=plaza'); await singleStream(page, 1);
  await streamSnapshot(page, 0, { ...initial, stream_frame_id: 'late:1' });
  await emit(page, 0, 'error'); await expect(page.locator('.spectator-stale')).toBeVisible();
  await page.clock.fastForward(12000); await expect.poll(() => typeof pending).toBe('function');
  // Equal coarse revision/time deliberately gives HTTP no ordering advantage:
  // the recovered stream owns the displayed state until its next disconnect.
  await streamSnapshot(page, 0, frame('实时恢复的旅人', 14, { id: 'late:2', time: at + 2000 }));
  await shows(page, '实时恢复的旅人', 14); await pending(); await page.clock.runFor(20);
  await shows(page, '实时恢复的旅人', 14); await expect(page.locator('.spectator-stale')).toHaveCount(0);
  await expect(page.getByTestId('observer-status')).not.toContainText('迟到的轮询画面');
  await page.clock.fastForward(12000); expect(requests).toBe(2); await singleStream(page, 1); await shows(page, '实时恢复的旅人', 14);
});

test('仍在断线时同版本旧时间的轮询不能倒退位置，后续新时间可继续恢复画面', async ({ page }) => {
  let requests = 0;
  const initial = frame('开始观察', 10);
  const responses = [initial, frame('时间倒退的旧画面', 11, { time: at + 1000 }), frame('轮询的新画面', 13, { time: at + 3000 })];
  await page.route('**/api/public/world*', route => fulfill(route, responses[Math.min(requests++, responses.length - 1)]));
  await page.goto(base + '/watch?view=plaza'); await singleStream(page, 1);
  await streamSnapshot(page, 0, frame('断线前最后实况', 12, { id: 'time:1', time: at + 2000 }));
  await emit(page, 0, 'error');
  const oldResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/public/world');
  await page.clock.fastForward(12000); await (await oldResponse).finished(); await page.clock.runFor(20); await expect.poll(() => requests).toBe(2);
  await shows(page, '断线前最后实况', 12); await expect(page.locator('.spectator-stale')).toBeVisible();
  await page.clock.fastForward(12000); await expect.poll(() => requests).toBe(3); await shows(page, '轮询的新画面', 13);
  await expect(page.locator('.spectator-stale')).toBeVisible(); await singleStream(page, 1);
});

test('V2 基线失配关闭旧流并延迟取得完整快照，随后合法增量恢复且不重复连接', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/public/world*', route => fulfill(route, ++requests === 1 ? frame('旧连接角色', 10) : frame('新连接角色', 12)));
  await page.goto(base + '/watch?view=plaza'); await singleStream(page, 1);
  await streamSnapshot(page, 0, frame('旧连接角色', 10, { id: 'before:1' }));
  await emit(page, 0, 'delta', { protocol: 2, base_frame_id: 'foreign:1', frame_id: 'foreign:2', patch: [{ op: 'replace', path: '/agents/0/name', value: '错误基线污染' }] });
  await expect(page.locator('.spectator-stale')).toBeVisible(); await expect.poll(() => stats(page)).toMatchObject({ total: 1, live: 0, maxLive: 1 });
  await shows(page, '旧连接角色', 10);
  await page.clock.fastForward(999); expect((await stats(page)).total).toBe(1); expect(requests).toBe(1);
  await page.clock.fastForward(1); await singleStream(page, 2); expect(requests).toBe(2);
  await streamSnapshot(page, 1, frame('新连接角色', 12, { id: 'after:1', time: at + 1000 }));
  await emit(page, 1, 'delta', { protocol: 2, base_frame_id: 'after:1', frame_id: 'after:2', patch: [
    { op: 'replace', path: '/agents/0/name', value: '合法增量已恢复' },
    { op: 'replace', path: '/agents/0/position/x', value: 13 },
    { op: 'replace', path: '/server_time', value: at + 2000 },
  ] });
  await shows(page, '合法增量已恢复', 13); await expect(page.locator('.spectator-stale')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('错误基线污染');
  await page.clock.fastForward(24000); await singleStream(page, 2); expect(requests).toBe(2);
});

test('切换场景关闭旧连接，排队的旧快照和增量均不能污染新场景', async ({ page }) => {
  const requests = [];
  await page.route('**/api/public/world*', route => {
    const scene = new URL(route.request().url()).searchParams.get('scene'); requests.push(scene);
    return fulfill(route, scene === 'adventure' ? frame('林地当前角色', 13, { scene }) : frame('广场当前角色', 11));
  });
  await page.goto(base + '/watch?view=plaza'); await singleStream(page, 1);
  await streamSnapshot(page, 0, frame('广场当前角色', 11, { id: 'plaza:1' }));
  await page.getByRole('button', { name: '冒险地图', exact: true }).click(); await singleStream(page, 2);
  await streamSnapshot(page, 1, frame('林地当前角色', 13, { id: 'adventure:1', scene: 'adventure', time: at + 1000 }));
  await shows(page, '林地当前角色', 13); await expect(page.getByTestId('observer-status')).toContainText('林地冒险');
  await emit(page, 0, 'snapshot', frame('旧广场快照污染', 10, { id: 'plaza:2', time: at + 100000, revision: fixture.room.world_revision + 100 }), true);
  await emit(page, 0, 'delta', { protocol: 2, base_frame_id: 'plaza:2', frame_id: 'plaza:3', patch: [{ op: 'replace', path: '/agents/0/name', value: '旧广场增量污染' }] }, true);
  await shows(page, '林地当前角色', 13); await expect(page.getByTestId(`adventure-agent-${fixture.agents[0].agent_id}`)).toHaveCount(1);
  await expect(page.getByTestId(`map-agent-${fixture.agents[0].agent_id}`)).toHaveCount(0);
  await page.clock.fastForward(24000); await singleStream(page, 2); expect(requests).toEqual(['plaza', 'adventure']);
  expect((await stats(page)).urls.map(url => new URL(url, base).searchParams.get('scene'))).toEqual(['plaza', 'adventure']);
  await expect(page.locator('.spectator-stale')).toHaveCount(0);
});
