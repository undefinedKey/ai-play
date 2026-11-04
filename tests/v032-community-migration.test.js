import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { World } from '../server/world.js';
import { COMMUNITY_RULES } from '../shared/community.js';

const board = COMMUNITY_RULES.venues.find(v => v.id === 'board');
const stage = COMMUNITY_RULES.venues.find(v => v.id === 'stage');
const picnic = COMMUNITY_RULES.venues.find(v => v.id === 'picnic');
function fixture(t, count = 2) {
  const directory = mkdtempSync(join(resolve(tmpdir()), 'v032-community-migration-')), dbPath = join(directory, 'world.sqlite');
  let now = 2000000000000, world = new World({ dbPath, now: () => now, actionIntervalMs: 0 });
  t.after(() => {
    world.close(); const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir())); assert.ok(basename(target).startsWith('v032-community-migration-'));
    rmSync(target, { recursive: true, force: true });
  });
  const players = Array.from({ length: count }, (_, index) => {
    const id = world.createAgent({ name: `存档居民${index}`, owner_id: `original-community-owner-${index}`, bio: `原有性格${index}` }).agent_id;
    const ctl = world.createController(id);
    world.ownerControl(id, 'start', { controller_id: ctl.controller_id, duration_minutes: 60, max_calls: null, goal: `PRIVATE_ORIGINAL_GOAL_${index}` });
    const auth = world.authenticate(ctl.token); world.callTool(auth, 'join_world');
    Object.assign(world.agent(id).life.inventory, { wheat_bread: 4, wood: 8 });
    return { id, auth, get a() { return world.agent(id); },
      act(payload) {
        const session = { run_id: this.a.run.run_id, session_epoch: this.a.session_epoch };
        const o = world.callTool(auth, 'observe', session);
        const result = world.callTool(auth, 'act', { ...session, type: 'community', action_id: o.next_action_id, payload });
        assert.equal(result.status, 'applied', JSON.stringify(result)); return result;
      },
    };
  });
  return { players, get world() { return world; },
    advance(ms) { const end = now + ms; while (now < end) { now = Math.min(end, now + 100); for (const p of players) if (p.a.status === 'active') p.a.last_contact_at = now; world.tick(); } },
    restart() { const old = structuredClone(world.state); world.close(); now += 2000; world = new World({ dbPath, now: () => now, actionIntervalMs: 0 }); world.tick(); return { old, current: structuredClone(world.state) }; },
  };
}
function verify(old, current) {
  const script = `import importlib.util,json,sys\nfrom pathlib import Path\np=Path(sys.argv[1]);s=importlib.util.spec_from_file_location('migration',p/'deploy/verify-migration.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nx=json.load(sys.stdin);m.compare_states(x['old'],x['new'],project_root=p,require_history=True,require_scenes=True)\nprint('validated')`;
  return spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', script, resolve('.')], {
    input: JSON.stringify({ old, new: current }), encoding: 'utf8', timeout: 30000, maxBuffer: 1048576,
  });
}
const pass = pair => { const result = verify(pair.old, pair.current); assert.equal(result.status, 0, result.stdout + result.stderr); };
const rejects = (pair, mutations) => {
  for (const mutate of mutations) {
    const current = structuredClone(pair.current); mutate(current);
    const result = verify(pair.old, current); assert.notEqual(result.status, 0, 'forged migration must fail');
  }
};

test('v032 old save gains only empty services and keeps exact integer/fractional locations under new fixture bodies', t => {
  const f = fixture(t), [p, q] = f.players;
  p.a.position = { x: 18, y: 16 }; q.a.position = { x: 16, y: 12.5 };
  delete f.world.state.community;
  for (const player of f.players) { delete player.a.community_job; delete player.a.community_page; }
  const pair = f.restart(); pass(pair);
  assert.deepEqual(pair.current.community, { version: 1, events: {} });
  for (const player of f.players) {
    assert.deepEqual(pair.current.agents[player.id].position, pair.old.agents[player.id].position);
    assert.equal(pair.current.agents[player.id].community_page, 0);
  }
  rejects(pair, [
    s => { s.agents[p.id].position = { x: 17, y: 16 }; },
    s => { s.agents[q.id].position = { x: 16, y: 13 }; },
    s => { s.agents[p.id].life.inventory.wheat_bread++; },
    s => { s.agents[p.id].goal = '现在去野餐'; },
    s => { s.community.extra = 'injected service state'; },
    s => { s.agents[p.id].community_page = 1; },
  ]);
});

test('v032 real restart preserves exact original event terms/members/bindings and completed performance, cancels jobs without meals or new performances', t => {
  const f = fixture(t), [p, q] = f.players;
  const speaker = stage.seats.find(s => s.activities.includes('perform'));
  p.a.position = { ...speaker.position };
  const performed = '这是居民亲自写下并已完成演出的短文。';
  p.act({ intent: 'use', seat_id: speaker.id, activity: 'perform', title: '原有作品', text: performed, duration_seconds: 15 });
  f.advance(15000); assert.equal(p.a.community_job, null);
  const completed = structuredClone(f.world.state.history.entries.find(e => e.type === 'community_use_finished'));
  assert.ok(completed); assert.ok(JSON.stringify(completed).includes(performed));
  for (const [actor, venue] of [[p, picnic], [q, stage]]) {
    actor.a.position = { ...board.interaction_position };
    actor.act({ intent: 'post', venue_id: venue.id, title: `本人想办的${venue.name}`, text: '是否参加由你自己决定。', duration_seconds: 300 });
  }
  const [open, active] = Object.values(f.world.state.community.events);
  q.a.position = { ...stage.interaction_position }; q.act({ intent: 'start', event_id: active.event_id, revision: 1 });
  p.act({ intent: 'join', event_id: active.event_id, revision: 1 }); q.act({ intent: 'join', event_id: open.event_id, revision: 1 });
  p.a.survival.satiety = 30;
  p.act({ intent: 'use', seat_id: picnic.seats[0].id, activity: 'eat', item_id: 'wheat_bread', duration_seconds: 20 });
  const draft = '尚未到舞台，不能把这段草稿当作已演出。';
  q.act({ intent: 'use', seat_id: speaker.id, activity: 'perform', title: '未登台草稿', text: draft, duration_seconds: 30 });
  assert.equal(q.a.community_job.phase, 'approaching'); p.a.community_page = 7;
  const pair = f.restart(); pass(pair);
  for (const [id, event] of Object.entries(pair.old.community.events)) {
    assert.deepEqual(pair.current.community.events[id], { ...event, status: 'interrupted', end_reason: 'restarted', ended_at: pair.current.community.events[id].ended_at });
  }
  assert.deepEqual(pair.current.history.entries.find(e => e.entry_id === completed.entry_id), completed);
  assert.equal(pair.current.agents[p.id].community_page, 7);
  assert.equal(pair.current.agents[p.id].life.inventory.wheat_bread, 4);
  const fresh = pair.current.events.filter(e => Number(e.cursor) > pair.old.sequence);
  assert.equal(fresh.filter(e => e.type === 'community_event_changed').length, 2);
  assert.equal(fresh.filter(e => e.type === 'community_use_cancelled').length, 2);
  assert.equal(JSON.stringify(fresh).includes(draft), false);
  rejects(pair, [
    s => { s.community.events[open.event_id].title = '改写了原想法'; },
    s => { s.community.events[open.event_id].expires_at++; },
    s => { s.community.events[open.event_id].host_binding.run_id += '_other'; },
    s => { s.community.events[active.event_id].member_bindings[p.id].session_epoch++; },
    s => { s.community.events[active.event_id].member_agent_ids.pop(); },
    s => { s.community.events[active.event_id].status = 'active'; },
    s => { s.agents[p.id].life.inventory.wheat_bread--; },
    s => { s.agents[p.id].community_page = 0; },
    s => { s.events = s.events.filter(e => !(Number(e.cursor) > pair.old.sequence && e.type === 'community_use_cancelled')); },
    s => { s.events.find(e => Number(e.cursor) > pair.old.sequence && e.type === 'community_use_cancelled').payload.text = draft; },
    s => { s.events.find(e => Number(e.cursor) > pair.old.sequence && e.type === 'community_use_cancelled').type = 'community_use_finished'; },
    s => { s.history.entries.find(e => e.entry_id === completed.entry_id).summary = '伪造演出'; },
  ]);
  const again = f.restart(); pass(again);
  assert.deepEqual(again.current.community, pair.current.community);
  assert.equal(again.current.agents[p.id].life.inventory.wheat_bread, 4);
  assert.equal(again.current.agents[p.id].community_page, 7);
});

test('v032 restart of an already eating or performing resident cannot refund food, finish a show or invent rewards', t => {
  const f = fixture(t), [p, q] = f.players;
  p.a.position = { ...picnic.seats[0].position }; p.a.survival.satiety = 30;
  p.act({ intent: 'use', seat_id: picnic.seats[0].id, activity: 'eat', item_id: 'wheat_bread', duration_seconds: 30 });
  const speaker = stage.seats.find(s => s.activities.includes('perform'));
  q.a.position = { ...speaker.position };
  q.act({ intent: 'use', seat_id: speaker.id, activity: 'perform', title: '已开始的原作', text: '我在真实舞台上说的文字。', duration_seconds: 30 });
  assert.equal(p.a.community_job.phase, 'using'); assert.equal(q.a.community_job.phase, 'using');
  assert.equal(p.a.life.inventory.wheat_bread, 3);
  const pair = f.restart(); pass(pair);
  assert.equal(pair.current.agents[p.id].life.inventory.wheat_bread, 3);
  rejects(pair, [
    s => { s.agents[p.id].life.inventory.wheat_bread++; },
    s => { s.agents[p.id].community_job = structuredClone(pair.old.agents[p.id].community_job); },
    s => { s.events.find(e => Number(e.cursor) > pair.old.sequence && e.type === 'community_use_cancelled' && e.payload.agent_id === q.id).payload.title = '伪造的新作品'; },
  ]);
});
