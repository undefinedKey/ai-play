import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { World } from '../server/world.js';
import { PEER_MARKET_RULES } from '../shared/peer-market.js';

function fixture(t) {
  const root = resolve(tmpdir()), directory = mkdtempSync(join(root, 'v031-market-'));
  const dbPath = join(directory, 'world.sqlite'); let now = 2000000000000;
  let world = new World({ dbPath, now: () => now, actionIntervalMs: 0 });
  const id = world.createAgent({ name: '原居民', owner_id: 'original-owner', bio: '保留我的想法' }).agent_id, ctl = world.createController(id);
  world.ownerControl(id, 'start', { controller_id: ctl.controller_id, duration_minutes: 60, max_calls: null, goal: '原要求：自己选择生活' });
  const auth = world.authenticate(ctl.token); world.callTool(auth, 'join_world');
  world.agent(id).position = { ...PEER_MARKET_RULES.place.interaction_position };
  Object.assign(world.agent(id).life.inventory, { wood: 20, ore: 5 }); world.agent(id).adventure.gold = 100;
  const act = payload => {
    const a = world.agent(id), session = { run_id: a.run.run_id, session_epoch: a.session_epoch }, o = world.callTool(auth, 'observe', session);
    const r = world.callTool(auth, 'act', { ...session, type: 'peer_market', action_id: o.next_action_id, payload }); assert.equal(r.status, 'applied', JSON.stringify(r)); return r;
  };
  t.after(() => { world.close(); assert.equal(dirname(directory), root); rmSync(directory, { recursive: true, force: true }); });
  return { id, act, get world() { return world; }, get a() { return world.agent(id); }, restart() {
    const old = structuredClone(world.state); world.close(); now += 2000;
    world = new World({ dbPath, now: () => now, actionIntervalMs: 0 }); world.tick();
    return { old, current: structuredClone(world.state) };
  } };
}
function verify(old, current) {
  const script = `import importlib.util,json,sys\nfrom pathlib import Path\np=Path(sys.argv[1]);s=importlib.util.spec_from_file_location('migration',p/'deploy/verify-migration.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nx=json.load(sys.stdin);m.compare_states(x['old'],x['new'],project_root=p,require_history=True,require_scenes=True)\nprint('validated')`;
  return spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', script, resolve('.')], { input: JSON.stringify({ old, new: current }), encoding: 'utf8', timeout: 30000, maxBuffer: 1048576 });
}
const pass = pair => { const result = verify(pair.old, pair.current); assert.equal(result.status, 0, result.stdout + result.stderr); };

test('v031 old world upgrade creates an empty market and grants no personal stock, money, consent or goals', t => {
  const f = fixture(t); delete f.world.state.peer_market; delete f.a.peer_market_return; delete f.a.peer_market_page;
  const pair = f.restart(); pass(pair);
  assert.deepEqual(pair.current.peer_market, { version: 1, offers: {} });
  for (const mutate of [s => { s.agents[f.id].life.inventory.wood++; }, s => { s.agents[f.id].adventure.gold++; },
    s => { s.agents[f.id].goal = '现在去接单'; }, s => { s.agents[f.id].run.max_calls++; }]) {
    const bad = structuredClone(pair.current); mutate(bad); assert.notEqual(verify(pair.old, bad).status, 0);
  }
});

test('v031 SQLite restart refunds precisely escrowed items and gold, with independent deployment proof rejecting forged terms, ledger or settlement', t => {
  const f = fixture(t);
  f.act({ intent: 'post', kind: 'request', title: '自己发布的需求', give: { items: { wood: 3 }, gold: 7 }, want: { items: { ore: 2 } } });
  const offerId = Object.keys(f.world.state.peer_market.offers)[0];
  assert.equal(f.a.life.inventory.wood, 17); assert.equal(f.a.adventure.gold, 93);
  const pair = f.restart(); pass(pair);
  const a = pair.current.agents[f.id], offer = pair.current.peer_market.offers[offerId];
  assert.equal(a.life.inventory.wood, 20); assert.equal(a.adventure.gold, 100);
  assert.equal(offer.status, 'interrupted'); assert.equal(offer.end_reason, 'restarted'); assert.deepEqual(offer.escrow, { items: {}, gold: 0 });
  assert.equal(a.peer_market_return, null);
  assert.equal(pair.current.history.entries.filter(e => e.type === 'peer_market_changed').length, 1);
  for (const mutate of [s => { s.agents[f.id].life.inventory.wood++; }, s => { s.agents[f.id].adventure.gold--; },
    s => { s.peer_market.offers[offerId].want.items.ore++; }, s => { s.peer_market.offers[offerId].status = 'settled'; },
    s => { s.agents[f.id].life.ledger.entries.at(-1).items.wood++; }, s => { s.agents[f.id].peer_market_page = 1; },
    s => { s.events = s.events.filter(e => e.type !== 'peer_market_changed'); }]) {
    const bad = structuredClone(pair.current); mutate(bad); assert.notEqual(verify(pair.old, bad).status, 0, 'release must reject asset or intent changes');
  }
});

test('v031 a whole overflowing refund remains private and owned through two real restarts, never lost or awarded twice', t => {
  const f = fixture(t);
  f.act({ intent: 'post', kind: 'exchange', give: { items: { wood: 3 }, gold: 7 }, want: { items: { ore: 2 } } });
  const offerId = Object.keys(f.world.state.peer_market.offers)[0];
  f.a.life.inventory.wood = Number.MAX_SAFE_INTEGER;
  const first = f.restart(); pass(first);
  assert.deepEqual(f.a.peer_market_return, { offer_id: offerId, assets: { items: { wood: 3 }, gold: 7 } });
  assert.equal(f.a.life.inventory.wood, Number.MAX_SAFE_INTEGER); assert.equal(f.a.adventure.gold, 93);
  const second = f.restart(); pass(second);
  assert.deepEqual(second.current.agents[f.id].peer_market_return, first.current.agents[f.id].peer_market_return);
  assert.equal(second.current.agents[f.id].life.ledger.total_entries, first.current.agents[f.id].life.ledger.total_entries);
  const bad = structuredClone(second.current); bad.agents[f.id].peer_market_return.assets.gold++;
  assert.notEqual(verify(second.old, bad).status, 0);
});
