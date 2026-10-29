import { createApp } from '../server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdirSync, writeFileSync } from 'node:fs';

// A short, reproducible smoke load. This does NOT replace the specified 30-minute acceptance test.
const durationSeconds = Math.max(10, Number(process.env.LOAD_SECONDS || 12));
const application = await createApp({ dbPath: ':memory:', demo: false, seed: false, frontend: false });
const { server, url } = await application.start(0);
const cookie = (await fetch(`${url}/api/session`)).headers.get('set-cookie').split(';')[0];
const abort = new AbortController();
const clients = [], actionTimes = [], eventTimes = [];
let applied = 0, failures = 0, snapshots = 0;
const percentile = values => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * .95) - 1)] || 0;
const call = async (client, name, args = {}) => {
  const response = await client.callTool({ name, arguments: args });
  const body = response.structuredContent || JSON.parse(response.content[0].text);
  if (body.error) throw new Error(`${body.error.code}: ${body.error.message}`);
  return body;
};
const started = Date.now();
try {
  for (let i = 0; i < 5; i++) {
    const agent = application.world.createAgent({ name: `负载角色${i + 1}` });
    const controller = application.world.createController(agent.agent_id, { name: '负载测试', kind: 'external' });
    application.world.ownerControl(agent.agent_id, 'start', { controller_id: controller.controller_id, duration_minutes: 35 });
    const client = new Client({ name: 'load-smoke', version: '0.1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${controller.token}` } } }));
    clients.push({ client, state: await call(client, 'join_world') });
  }
  const viewers = await Promise.all(Array.from({ length: 20 }, async () => {
    const response = await fetch(`${url}/api/events`, { headers: { cookie }, signal: abort.signal });
    if (response.status !== 200) throw new Error('Spectator connection failed');
    const reader = response.body.getReader();
    const task = (async () => {
      let buffer = '';
      try { while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buffer += new TextDecoder().decode(value);
        let index;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const event = buffer.slice(0, index); buffer = buffer.slice(index + 2);
          const line = event.split('\n').find(l => l.startsWith('data: '));
          if (line) { const snap = JSON.parse(line.slice(6)); snapshots++; eventTimes.push(Date.now() - snap.server_time); }
        }
      } } catch (e) { if (!abort.signal.aborted) throw e; }
    })();
    return { task };
  }));
  const actionStart = Date.now();
  let round = 0;
  do {
    await Promise.all(clients.map(async entry => {
      const before = performance.now();
      try {
        const result = await call(entry.client, 'act', { run_id: entry.state.run_id, session_epoch: entry.state.session_epoch, action_id: entry.state.next_action_id, type: 'say', payload: { channel: 'nearby', text: `第${round + 1}次合法发言` } });
        if (result.status !== 'applied') throw new Error('Action not applied');
        entry.state.next_action_id = result.next_action_id; applied++;
        actionTimes.push(performance.now() - before);
      } catch (error) { failures++; console.error(error.message); }
    }));
    round++;
    await new Promise(r => setTimeout(r, 2100));
  } while (Date.now() - actionStart < durationSeconds * 1000);
  abort.abort();
  await Promise.all(viewers.map(v => v.task));
  const result = { date: new Date().toISOString(), duration_seconds: +((Date.now() - started) / 1000).toFixed(2), actors: 5, viewers: 20, rounds: round, actions_applied: applied, failures, spectator_snapshots: snapshots, mcp_round_trip_p95_ms: +percentile(actionTimes).toFixed(2), snapshot_receive_p95_ms: percentile(eventTimes), note: '短时本机冒烟负载；MCP延迟包含本机HTTP往返；快照延迟从生成时计到读取，不含浏览器绘制；并非30分钟验收。' };
  mkdirSync('artifacts', { recursive: true }); writeFileSync('artifacts/load-smoke.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (failures || applied < 25 || snapshots < 20) process.exitCode = 1;
} finally {
  abort.abort();
  await Promise.allSettled(clients.map(({ client }) => client.close()));
  await application.close(); server.closeAllConnections(); await new Promise(r => server.close(r));
}
