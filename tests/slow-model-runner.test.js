import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.js';
import { PlazaRunner } from '../skills/ai-plaza/scripts/runtime.mjs';
import { DshPetClient } from '../skills/ai-plaza/scripts/dsh-pet.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 10000) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() >= end) assert.fail('等待条件超时'); await sleep(25); }
}

test('真实60秒生成：桌宠和直连模型均持续MCP续租，最后预算仅一次且期限身份不变', { timeout: 85000, skip: process.env.PLAZA_LONG_MODEL !== '1' }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'plaza-slow-model-'));
  const app = await createApp({ dbPath: join(directory, 'world.sqlite'), demo: false, frontend: false });
  const started = await app.start(0), peers = new Map(), runners = [];
  const host = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/config')) return res.end(JSON.stringify({ main: { pets: [{ id: 'original', name: '原桌宠', display: 'both' }] } }));
    const mode = req.url.startsWith('/v1/') ? 'model' : 'dsh-pet', peer = peers.get(mode);
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    if (mode === 'dsh-pet') assert.ok(body.text.length <= 2000);
    const cp = JSON.parse(readFileSync(peer.checkpointPath));
    assert.equal(cp.calls_used, 1); assert.equal(cp.counters.requests, 1);
    peer.requests++; peer.requestAt = Date.now(); peer.savedAtRequest = cp;
    while (Date.now() - peer.requestAt < 60000) await sleep(Math.max(1, 60000 - (Date.now() - peer.requestAt)));
    peer.replyAt = Date.now();
    if (res.destroyed) return;
    const content = '{"type":"wait","payload":{}}';
    res.end(JSON.stringify(mode === 'model' ? { choices: [{ message: { content } }] } : { ok: true, text: content }));
  });
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
  const hostUrl = `http://127.0.0.1:${host.address().port}`;
  const originalCall = app.world.callTool.bind(app.world);
  app.world.callTool = (auth, name, args) => {
    if (name === 'get_events') { const peer = [...peers.values()].find(p => p.agent_id === auth.agent_id); if (peer) peer.polls++; }
    return originalCall(auth, name, args);
  };
  t.after(async () => {
    await Promise.all(runners.map(runner => runner.stop())); await app.close();
    started.server.closeAllConnections(); await new Promise(resolve => started.server.close(resolve));
    host.closeAllConnections(); await new Promise(resolve => host.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  for (const mode of ['model', 'dsh-pet']) {
    const agent = app.world.createAgent({ name: `慢速${mode}` }), controller = app.world.createController(agent.agent_id, { kind: 'external' });
    app.world.ownerControl(agent.agent_id, 'start', { controller_id: controller.controller_id, duration_minutes: 10, max_calls: 1 });
    const peer = { agent_id: agent.agent_id, checkpointPath: join(directory, `${mode}.json`), requests: 0, polls: 0,
      run: structuredClone(app.world.agent(agent.agent_id).run) };
    peers.set(mode, peer);
    const petClient = mode === 'dsh-pet' ? new DshPetClient({ petId: 'original', url: hostUrl, home: directory }) : undefined;
    const runner = new PlazaRunner({ mode, petClient, url: `${started.url}/mcp`, token: controller.token,
      checkpointPath: peer.checkpointPath, pollSeconds: 10, idleMs: 90000,
      model: { baseUrl: `${hostUrl}/v1`, model: 'delayed-fixture', apiKey: 'local-fixture' } });
    runners.push(runner); peer.runner = runner; runner.start();
  }
  await until(() => [...peers.values()].every(p => p.requests === 1));
  const bothStartedAt = Date.now();
  while (Date.now() - bothStartedAt < 55000) await sleep(Math.min(1000, 55000 - (Date.now() - bothStartedAt)));
  for (const peer of peers.values()) {
    const a = app.world.agent(peer.agent_id);
    assert.equal(a.status, 'active'); assert.equal(a.session_epoch, peer.savedAtRequest.session_epoch);
    assert.ok(Date.now() - a.last_contact_at < 15000); assert.ok(peer.polls >= 4);
    assert.equal(peer.runner.checkpoint.calls_used, 1); assert.equal(peer.requests, 1);
  }
  await until(() => [...peers.values()].every(p => p.runner.health.waiting_reason === 'budget_exhausted'), 12000);
  for (const [mode, peer] of peers) {
    assert.ok(peer.replyAt - peer.requestAt >= 60000); assert.equal(peer.requests, 1);
    assert.equal(peer.runner.checkpoint.counters.replies, 1);
    assert.equal(peer.runner.checkpoint.run_id, peer.run.run_id); assert.equal(peer.runner.checkpoint.expires_at, peer.run.expires_at);
    assert.equal(peer.runner.checkpoint.max_calls, 1); assert.equal(app.world.agent(peer.agent_id).run.expires_at, peer.run.expires_at);
    t.diagnostic(`${mode}: ${peer.replyAt - peer.requestAt}ms，${peer.polls}次事件轮询，1请求/1回复/1预算，原授权期限保留`);
  }
});
