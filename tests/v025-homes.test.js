import {findPath} from '../server/spatial.js';
import {PLAZA_SERVICES} from '../shared/plaza-layout.js';
const CAMP=PLAZA_SERVICES.camp.interaction_position,HOME_ENTRY=PLAZA_SERVICES.home.interaction_position;
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World } from '../server/world.js';
import { HOME_RULES, publicHomes } from '../server/homes.js';
import { spectatorSnapshot, scopeSpectatorSnapshot } from '../server/spectator.js';
import { actInputSchema } from '../server/mcp.js';
import { cooperationOpportunities } from '../server/cooperation.js';
import { campAvailable } from '../server/life.js';

function fixture(t, count = 3, options = {}) {
  let now = 2000000000000;
  const world = new World({ now: () => now, actionIntervalMs: 0, ...options }); t.after(() => world.close());
  const players = Array.from({ length: count }, (_, n) => {
    const created = world.createAgent({ name: `家园旅人${n}`, owner_id: `owner${n}` }), id = created.agent_id, c = world.createController(id);
    world.ownerControl(id, 'start', { controller_id: c.controller_id, duration_minutes: 30, max_calls: 100 });
    const auth = world.authenticate(c.token); world.callTool(auth, 'join_world');
    Object.assign(world.agent(id).life.inventory, { wood: 100, ore: 100, grass: 100, pine_cone: 4 }); world.agent(id).position = { ...CAMP };
    return { id, auth, c, get a() { return world.agent(id); }, get home() { return world.state.homes[`home_${id}`]; },
      observe() { const a = world.agent(id); return world.callTool(auth, 'observe', { run_id: a.run.run_id, session_epoch: a.session_epoch }); },
      action(payload, type = 'home') { const o = this.observe(); return world.callTool(auth, 'act', { run_id: o.run_id, session_epoch: o.session_epoch, action_id: o.next_action_id, type, payload }); },
      ok(payload, type = 'home') { const r = this.action(payload, type); assert.equal(r.status, 'applied', JSON.stringify(r)); return r; },
    };
  });
  const tick = (ms, heartbeat = true) => { now += ms; if (heartbeat) for (const p of players) if (p.a.status === 'active') p.a.last_contact_at = now; world.tick(); };
  const build = p => p.ok({ intent: 'build', name: `${p.a.name}的小家` });
  const enter = (p, h = p.home) => { p.ok({ intent: 'visit', home_id: h.home_id }); tick((p.a.movement?.ends_at||now)-now+100); assert.equal(p.a.home_presence?.home_id, h.home_id); };
  const invite = (host, guest, accept = true) => { host.ok({ intent: 'invite', target_agent_id: guest.id }); const i = guest.observe().homes.invitations.at(-1); guest.ok({ intent: 'respond', invitation_id: i.invitation_id, accept }); return i; };
  const craft = (p, kind) => { p.ok({ intent: 'craft', kind }); return p.home.furniture.at(-1).instance_id; };
  return { world, players, tick, build, enter, invite, craft, now: () => now };
}

test('v025 voluntary homes preserve identity and costs; escrow is conserved and not collection progress', t => {
  const f = fixture(t, 1), [p] = f.players; const original = structuredClone({ id: p.id, appearance: p.a.appearance, run: p.a.run, life: p.a.life, adventure: p.a.adventure });
  assert.equal(p.observe().homes.own_home, null); assert.equal(f.world.getRules().max_capabilities, 16);
  f.build(p); assert.equal(p.a.life.inventory.wood, 94); assert.equal(p.a.life.inventory.grass, 98); f.enter(p);
  const shelf = f.craft(p, 'display_shelf'); p.ok({ intent: 'place', instance_id: shelf, x: 1, y: 1 });
  p.ok({ intent: 'set', kind: 'collect_item', target_id: 'wood', target_count: 2 }, 'personal_goal'); const before = p.a.life.inventory.wood;
  const o = p.observe(), request = { run_id: o.run_id, session_epoch: o.session_epoch, action_id: o.next_action_id, type: 'home', payload: { intent: 'display', instance_id: shelf, item_id: 'wood', title: '最初的树枝', text: '来自我的旅途' } };
  const receipt = f.world.callTool(p.auth, 'act', request); assert.equal(receipt.status, 'applied'); assert.equal(p.a.life.inventory.wood, before - 1);
  assert.deepEqual(f.world.callTool(p.auth, 'act', request), receipt); assert.equal(p.home.displays.length, 1);
  assert.equal(p.action({ intent: 'store', instance_id: shelf }).error.code, 'DISPLAY_OCCUPIED');
  p.ok({ intent: 'withdraw', display_id: p.home.displays[0].display_id }); assert.equal(p.a.life.inventory.wood, before); assert.equal(p.a.personal_goal.progress, 0);
  assert.equal(p.id, original.id); assert.deepEqual(p.a.appearance, original.appearance); assert.deepEqual(p.a.run, original.run); assert.equal(p.a.adventure.xp, original.adventure.xp);
  assert.deepEqual(p.a.life.tools, original.life.tools); assert.deepEqual(p.a.life.plots, original.life.plots);
});

test('v025 finite exterior/indoor walking is physical, stale pre-entry action is rejected', t => {
  const f = fixture(t, 1), [p] = f.players; f.build(p); const before = { ...p.a.position };
  p.ok({ intent: 'visit', home_id: p.home.home_id }); const old = p.observe(); assert.deepEqual(p.a.position, before); assert.equal(p.a.home_presence, undefined);
  f.tick(100); assert.ok(p.a.position.y < before.y && p.a.position.y > HOME_ENTRY.y); assert.equal(p.a.home_presence, undefined);
  f.tick(p.a.movement.ends_at-f.now()+100); assert.deepEqual(p.a.position, { ...HOME_ENTRY }); assert.deepEqual(p.a.home_presence.position, HOME_RULES.door);
  assert.throws(() => f.world.callTool(p.auth, 'act', { run_id: old.run_id, session_epoch: old.session_epoch, action_id: old.next_action_id, type: 'move', payload: { x: 8, y: 8 } }), e => e.code === 'STALE_ACTION');
  p.ok({ intent: 'move', x: 5, y: 4 }); assert.equal(p.a.home_presence.position.y, 7); f.tick(100); assert.ok(p.a.home_presence.position.y < 7 && p.a.home_presence.position.y > 4);
  assert.deepEqual(p.a.position, { ...HOME_ENTRY }); const projected = spectatorSnapshot(f.world).agents[0].home_presence;
  assert.equal(projected.movement.version, 2); assert.equal(projected.movement.speed, f.world.getRules().movement.modes.walk.speed); assert.equal(projected.position_at, f.now());
  f.tick(2000); assert.deepEqual(p.a.home_presence.position, { x: 5, y: 4 }); p.ok({ intent: 'leave' }); assert.equal(p.a.home_presence, null); assert.deepEqual(p.a.position, { ...HOME_ENTRY });
});

test('v025 furniture blocks movement, overlaps, reserved doors, occupants and disconnected floor', t => {
  const f = fixture(t, 2), [p, q] = f.players; f.build(p); f.enter(p); const chair = f.craft(p, 'chair');
  p.ok({ intent: 'place', instance_id: chair, x: 5, y: 6 }); const chair2 = f.craft(p, 'chair'); const before = structuredClone(p.home);
  for (const xy of [[5, 6], [5, 7], [4, 7], [6, 7], [10, 2], [1.5, 2]]) { assert.equal(p.action({ intent: 'place', instance_id: chair2, x: xy[0], y: xy[1] }).status, 'rejected'); assert.deepEqual(p.home, before); }
  assert.equal(p.action({ intent: 'move', x: 5, y: 6 }).error.code, 'HOME_COLLISION');
  f.invite(p, q); f.enter(q, p.home); assert.equal(p.action({ intent: 'place', instance_id: chair2, ...q.a.home_presence.position }).error.code, 'HOME_COLLISION');
  // Two adjacent barriers isolate (0,0), which is forbidden even though neither overlaps the doorway.
  p.ok({ intent: 'place', instance_id: chair2, x: 1, y: 0 }); const chair3 = f.craft(p, 'chair');
  assert.equal(p.action({ intent: 'place', instance_id: chair3, x: 0, y: 1 }).error.code, 'HOME_COLLISION');
  const table = f.craft(p, 'table'); assert.equal(p.action({ intent: 'place', instance_id: table, x: 9, y: 2 }).error.code, 'HOME_COLLISION'); p.ok({ intent: 'place', instance_id: table, x: 9, y: 2, rotation: 90 });
});

test('v025 two homes and outdoors isolate proximity, speech and all exterior world actions', t => {
  const f = fixture(t), [p, q, outdoor] = f.players; f.build(p); f.build(q); f.enter(p); f.enter(q); outdoor.a.position = { ...HOME_ENTRY };
  assert.deepEqual(p.observe().nearby_agents, []); assert.deepEqual(q.observe().nearby_agents, []); assert.deepEqual(outdoor.observe().nearby_agents, []);
  const cursor = String(f.world.state.sequence); p.ok({ channel: 'nearby', text: '房间内独白' }, 'say');
  for (const peer of [q, outdoor]) assert.equal(f.world.callTool(peer.auth, 'get_events', { run_id: peer.a.run.run_id, session_epoch: peer.a.session_epoch, cursor }).events.filter(e => e.type === 'message').length, 0);
  const msg = spectatorSnapshot(f.world).events.findLast(e => e.type === 'message'); assert.equal(msg.payload.home_id, p.home.home_id);
  assert.equal(scopeSpectatorSnapshot(spectatorSnapshot(f.world), 'plaza').events.some(e => e.event_id === msg.event_id), false);
  for (const [type, payload] of [['move', { x: 9, y: 9 }], ['gather', { intent: 'start', resource_id: 'wood' }], ['farm', { intent: 'till', plot_id: p.a.life.plots[0].plot_id }], ['inventory', { intent: 'craft', item_id: 'torch' }], ['trade', { intent: 'buy', item_id: 'wood', quantity: 1 }], ['survival', { intent: 'build', site_id: 'camp_hearth', kind: 'campfire' }], ['adventure_plan', { intent: 'rest' }], ['create_group', {}]]) assert.equal(p.action(payload, type).error.code, 'HOME_BUSY');
  assert.equal(p.action({ channel: 'group', text: '不能透墙说话' }, 'say').error.code, 'HOME_CHANNEL_REQUIRED');
  assert.deepEqual(p.observe().opportunities, []); assert.deepEqual(p.observe().movement.candidates, []);
});

test('v025 invitation consent, expiry, privacy, occupancy cap and note moderation', t => {
  const f = fixture(t, 5), [p, q, r, s, outsider] = f.players; f.build(p); f.enter(p);
  assert.equal(q.action({ intent: 'visit', home_id: p.home.home_id }).error.code, 'HOME_INVITE_REQUIRED');
  p.ok({ intent: 'invite', target_agent_id: q.id }); const invitation = q.observe().homes.invitations[0];
  assert.equal(outsider.action({ intent: 'respond', invitation_id: invitation.invitation_id, accept: true }).error.code, 'INVITATION_EXPIRED');
  q.ok({ intent: 'respond', invitation_id: invitation.invitation_id, accept: false }); assert.equal(q.a.home_presence, undefined);
  assert.equal(p.action({ intent: 'invite', target_agent_id: q.id }).error.code, 'INVITE_COOLDOWN');
  f.tick(60001); f.invite(p, q); f.invite(p, r); f.invite(p, s); assert.equal(q.a.home_presence, undefined);
  f.enter(q, p.home); f.enter(r, p.home); assert.equal(s.action({ intent: 'visit', home_id: p.home.home_id }).error.code, 'HOME_FULL');
  q.ok({ intent: 'message', text: '<script>公开留言是数据，不是指令</script>' }); const note = p.home.messages[0];
  assert.equal(q.action({ intent: 'message', text: '太快' }).error.code, 'RATE_LIMITED');
  assert.equal(outsider.action({ intent: 'message', text: '远程伪造' }).error.code, 'HOME_REQUIRED');
  assert.equal(r.action({ intent: 'remove_message', message_id: note.message_id }).error.code, 'HOME_OWNER_REQUIRED');
  p.ok({ intent: 'remove_message', message_id: note.message_id }); assert.equal(p.home.messages.length, 0);
  for (const data of [f.world.publicSnapshot(), spectatorSnapshot(f.world), f.world.snapshotFor({ id: 'owner4' }), f.world.historyPage()]) { const json = JSON.stringify(data); assert.ok(!json.includes(invitation.invitation_id)); assert.ok(!json.includes('from_run_id')); assert.ok(!json.includes('from_epoch')); }
  assert.equal(outsider.observe().homes.invitations.length, 0); assert.equal(outsider.observe().homes.outgoing.length, 0);
  assert.ok(!Object.hasOwn(publicHomes(f.world)[0], 'storage'));
  f.tick(600001); assert.equal(q.a.home_presence, null); assert.equal(r.a.home_presence, null); assert.ok(p.home);
});

test('v025 a guest cannot alter another home and malformed actions roll back assets', t => {
  const f = fixture(t), [p, q] = f.players; f.build(p); f.enter(p); const shelf = f.craft(p, 'display_shelf'); p.ok({ intent: 'place', instance_id: shelf, x: 1, y: 1 }); f.invite(p, q); f.enter(q, p.home);
  for (const payload of [{ intent: 'craft', kind: 'chair' }, { intent: 'place', instance_id: shelf, x: 2, y: 2 }, { intent: 'display', instance_id: shelf, item_id: 'wood' }, { intent: 'store', instance_id: shelf }, { intent: 'rename', name: '窃取' }]) assert.equal(q.action(payload).status, 'rejected');
  const before = structuredClone({ home: p.home, inventory: p.a.life.inventory });
  for (const payload of [{ intent: { toString: null } }, { intent: 'craft', kind: { toString: null } }, { intent: 'craft', kind: '__proto__' }, { intent: 'craft', kind: 'chair', owner_agent_id: q.id }, { intent: 'place', instance_id: shelf, x: NaN, y: 2 }, { intent: 'place', instance_id: shelf, x: 1, y: 1, rotation: 45 }, { intent: 'display', instance_id: shelf, item_id: 'wood', title: 'a'.repeat(31) }, { intent: 'message', text: '😀'.repeat(201) }, { intent: 'respond', invitation_id: 'fake', accept: 'true' }]) { assert.equal(p.action(payload).status, 'rejected'); assert.deepEqual({ home: p.home, inventory: p.a.life.inventory }, before); }
  const schemaBase = { run_id: 'run', session_epoch: 1, action_id: 'act', type: 'home' };
  assert.equal(actInputSchema.safeParse({ ...schemaBase, payload: { intent: 'visit', home_id: p.home.home_id, mode: 'run' } }).success, true);
  for (const payload of [{ intent: 'leave', home_id: p.home.home_id }, { intent: 'message', text: '' }, { intent: 'place', instance_id: shelf, x: 10, y: 2 }, { intent: 'respond', invitation_id: 'id', accept: 'yes' }]) assert.equal(actInputSchema.safeParse({ ...schemaBase, payload }).success, false);
});

test('v025 home movement costs energy, indoor light prevents darkness but hunger and original slow rest remain', t => {
  const f = fixture(t, 1), [p] = f.players; f.build(p); f.enter(p); p.a.fatigue.energy = 50; p.a.fatigue.updated_at = f.now(); p.a.fatigue.recover_after = f.now();
  f.world.state.day_cycle.epoch_at = f.now() - 360000; const satiety = p.a.survival.satiety, hp = p.a.adventure.hp;
  assert.equal(p.observe().self.survival.light.kind, 'indoor'); f.tick(10000); assert.equal(p.a.adventure.hp, hp); assert.ok(p.a.survival.satiety < satiety); assert.equal(p.a.fatigue.energy, 53);
  p.ok({ intent: 'move', x: 5, y: 4 }); const energy = p.a.fatigue.energy; f.tick(100); assert.ok(p.a.fatigue.energy < energy);
  f.tick(2000); p.a.survival.satiety = 0; p.a.survival.starvation_seconds = 9.9; p.a.survival.hunger_hits = 0; const tired = p.a.fatigue.energy;
  f.tick(100); assert.equal(p.a.adventure.hp, hp - 2); assert.equal(p.a.fatigue.energy, tired); assert.ok(p.a.home_presence);
});

for (const reason of ['pause', 'lease', 'grant']) test(`v025 ${reason} clears presence, guest permission and travel while preserving assets`, t => {
  const f = fixture(t, 2), [p, q] = f.players; f.build(p); f.enter(p); const chair = f.craft(p, 'chair'); p.ok({ intent: 'place', instance_id: chair, x: 1, y: 1 }); f.invite(p, q); f.enter(q, p.home);
  const assets = structuredClone(p.home), budget = p.a.run.max_calls;
  if (reason === 'pause') f.world.ownerControl(p.id, 'pause');
  else if (reason === 'lease') { q.a.last_contact_at = f.now() + 45001; f.tick(45001, false); }
  else { p.a.run.expires_at = f.now() + 100; f.tick(101); }
  assert.equal(p.a.home_presence, null); assert.equal(q.a.home_presence, null); assert.deepEqual(p.home, assets); assert.equal(p.a.run.max_calls, budget);
});

test('v025 explicit cancellation and failed travel never teleport or extend the grant', t => {
  const f = fixture(t, 1), [p] = f.players; f.build(p); p.a.position = { x: 30, y: 22 }; const grant = structuredClone(p.a.run);
  p.ok({ intent: 'visit', home_id: p.home.home_id }); f.tick(100); const point = { ...p.a.position }; p.ok({ intent: 'cancel' }); f.tick(1000); assert.deepEqual(p.a.position, point); assert.equal(p.a.home_presence, undefined); assert.equal(p.a.home_travel, null);
  p.a.scene_id = 'adventure'; assert.equal(p.action({ intent: 'visit', home_id: p.home.home_id }).error.code, 'SCENE_REQUIRED'); assert.deepEqual(p.a.run, grant);
});

test('v025 room pause and delayed invitation expiry stop indoor movement at the original boundary', t => {
  const make = () => {
    const f = fixture(t, 2), [host, guest] = f.players; f.build(host); f.enter(host); f.invite(host, guest); f.enter(guest, host.home);
    guest.a.fatigue.energy = 50; guest.a.fatigue.updated_at = f.now(); f.world.state.day_cycle.epoch_at = f.now() - 360000;
    const invitation = Object.values(f.world.state.home_invitations).find(i => i.target_agent_id === guest.id); invitation.expires_at = f.now() + 200;
    const origin = guest.a.home_presence.position;
    const target = guest.observe().homes.opportunities.find(o => o.payload.intent === 'move' && o.payload.y < origin.y)?.payload || guest.observe().homes.opportunities.find(o => o.payload.intent === 'move').payload;
    guest.ok(target); return { ...f, host, guest };
  };
  const stepped = make(), delayed = make(); for (let n = 0; n < 10; n++) stepped.tick(100); delayed.tick(1000);
  for (const f of [stepped, delayed]) { assert.equal(f.guest.a.home_presence, null); assert.equal(f.guest.a.movement, null); assert.equal(f.guest.a.survival.darkness_seconds, 0.8); assert.ok(f.guest.a.fatigue.energy < 50); }
  assert.equal(delayed.guest.a.fatigue.energy, stepped.guest.a.fatigue.energy); assert.equal(delayed.guest.a.survival.satiety, stepped.guest.a.survival.satiety);
  const paused = make(); const home = structuredClone(paused.host.home), energy = paused.guest.a.fatigue.energy; paused.world.ownerRoom('pause'); paused.tick(1000, false);
  assert.equal(paused.guest.a.home_presence, null); assert.equal(paused.host.a.home_presence, null); assert.deepEqual(paused.host.home, home); assert.ok(paused.guest.a.fatigue.energy >= energy, 'paused paths cannot charge new travel');
});

test('v025 asset and guestbook limits cannot consume materials or bypass note rate by deletion', t => {
  const f = fixture(t, 1), [p] = f.players; f.build(p); f.enter(p);
  for (let n = 0; n < HOME_RULES.max_furniture; n++) f.craft(p, n % 2 ? 'chair' : 'table');
  const wood = p.a.life.inventory.wood; assert.equal(p.action({ intent: 'craft', kind: 'chair' }).error.code, 'HOME_FULL'); assert.equal(p.a.life.inventory.wood, wood); assert.equal(p.home.furniture.length, HOME_RULES.max_furniture);
  p.ok({ intent: 'message', text: '第一条' }); p.ok({ intent: 'remove_message', message_id: p.home.messages[0].message_id });
  assert.equal(p.action({ intent: 'message', text: '删除后也不能刷屏' }).error.code, 'RATE_LIMITED');
  for (let n = 0; n < 21; n++) { f.tick(10000); p.ok({ intent: 'message', text: `第${n}条` }); }
  assert.equal(p.home.messages.length, 20); assert.equal(p.home.messages[0].text, '第1条'); assert.equal(p.home.messages.at(-1).text, '第20条');
});

test('v025 visiting another owner does not misattribute an explicit home action or expose invitation recipients', t => {
  const f = fixture(t), [p, q] = f.players; f.build(p); f.build(q); f.enter(q); f.invite(q, p); f.enter(p, q.home);
  p.ok({ intent: 'rename', name: '我自己的家' });
  const event = spectatorSnapshot(f.world).events.findLast(e => e.type === 'home_renamed'); assert.equal(event.payload.home_id, p.home.home_id); assert.equal(q.home.name, '家园旅人1的小家');
  const entered = f.world.state.events.findLast(e => e.type === 'home_entered' && e.payload.agent_id === p.id); assert.equal(entered.payload.owner_agent_id, q.id); assert.ok(entered.payload.recipient_agent_ids.includes(q.id));
  assert.ok(!JSON.stringify(spectatorSnapshot(f.world)).includes('recipient_agent_ids'));
  assert.equal(f.world.state.home_invitations[Object.keys(f.world.state.home_invitations)[0]].status, 'accepted');
  f.world.ownerControl(q.id, 'transfer', { controller_id: q.c.controller_id, duration_minutes: 30, max_calls: 100 });
  assert.equal(p.a.home_presence, null); assert.equal(q.a.home_presence, null); assert.equal(p.home.name, '我自己的家'); assert.equal(q.home.name, '家园旅人1的小家');
});

test('v025 observation remains read-only, proposes only valid placements and never grants a default home', t => {
  const f = fixture(t, 1), [p] = f.players; const state = structuredClone(f.world.state); f.world.observation(p.a); assert.deepEqual(f.world.state, state); assert.deepEqual(publicHomes(f.world), []);
  f.build(p); f.enter(p); const shelf = f.craft(p, 'display_shelf'); p.ok({ intent: 'place', instance_id: shelf, x: 2, y: 1 }); p.ok({ intent: 'display', instance_id: shelf, item_id: 'wood' });
  const before = structuredClone(f.world.state); const observed = f.world.observation(p.a); assert.deepEqual(f.world.state, before);
  const names = observed.homes.opportunities.filter(o => o.payload.intent === 'place'); assert.ok(names.length > 0);
  for (const option of names) { const trial = new World({ now: f.now, actionIntervalMs: 0 }); try { trial.state = structuredClone(f.world.state); const a = trial.agent(p.id); assert.equal(trial.callTool(p.auth, 'act', { run_id: a.run.run_id, session_epoch: a.session_epoch, action_id: a.next_action_id, ...option }).status, 'applied'); } finally { trial.close(); } }
});

test('v025 outdoor cook cannot award an indoor or home-bound supplier; leaving home preserves the original agreement', t => {
  const f = fixture(t, 2), [supplier, cook] = f.players; f.build(supplier); supplier.a.life.inventory.turnip = 4;
  const proposal = supplier.ok({ intent: 'propose', template_id: 'camp_meal', target_agent_id: cook.id, role_id: 'supplier' }, 'cooperation').cooperation;
  const params = { cooperation_id: proposal.cooperation_id, revision: proposal.revision };
  cook.ok({ intent: 'respond', ...params, accept: true, role_id: 'cook' }, 'cooperation'); supplier.ok({ intent: 'contribute', ...params }, 'cooperation');
  const agreement = structuredClone(f.world.state.cooperations[proposal.cooperation_id]); supplier.ok({ intent: 'visit', home_id: supplier.home.home_id });
  const before = () => structuredClone({ supplier: supplier.a.life.inventory, cook: cook.a.life.inventory, energy: cook.a.fatigue.energy, escrow: f.world.state.cooperations[proposal.cooperation_id].escrow });
  for (const entered of [false, true]) {
    if (entered) f.tick(supplier.a.movement.ends_at-f.now()+100);
    const balances = before(); assert.equal(cook.action({ intent: 'cook', ...params }, 'cooperation').error.code, 'NOT_AT_CAMP'); assert.deepEqual(before(), balances);
    assert.ok(!cooperationOpportunities(f.world, cook.a).some(o => o.action.payload.intent === 'cook'));
    assert.throws(() => campAvailable(f.world, supplier.a, code => { throw new Error(code); }), /HOME_BUSY/);
    assert.deepEqual(f.world.state.cooperations[proposal.cooperation_id], agreement, 'visiting never withdraws, confirms, renews or performs the existing agreement');
  }
  supplier.ok({ intent: 'leave' }); assert.equal(cook.action({ intent: 'cook', ...params }, 'cooperation').error.code, 'NOT_AT_CAMP');
  while(supplier.a.position.x!==CAMP.x||supplier.a.position.y!==CAMP.y){const path=findPath('plaza',supplier.a.position,CAMP),next=path[Math.min(3,path.length-1)];supplier.ok({x:next.x,y:next.y},'move');f.tick(supplier.a.movement.ends_at-f.now());}
  cook.ok({ intent: 'cook', ...params }, 'cooperation');
  assert.equal(supplier.a.life.inventory.turnip_soup, 1); assert.equal(cook.a.life.inventory.turnip_soup, 1); assert.equal(f.world.state.cooperations[proposal.cooperation_id].status, 'completed');
});

test('v025 indoor cooperation consent, review and withdrawal remain possible without starting work', t => {
  const f = fixture(t, 2), [resident, other] = f.players; f.build(resident);
  const proposal = other.ok({ intent: 'propose', template_id: 'camp_meal', target_agent_id: resident.id, role_id: 'supplier' }, 'cooperation').cooperation;
  f.enter(resident); resident.ok({ intent: 'respond', cooperation_id: proposal.cooperation_id, revision: proposal.revision, accept: true, role_id: 'cook' }, 'cooperation');
  const expiry = f.world.state.cooperations[proposal.cooperation_id].expires_at;
  f.world.ownerControl(other.id, 'pause'); f.world.ownerControl(other.id, 'resume', { controller_id: other.c.controller_id, duration_minutes: 30, max_calls: 100 }); f.world.callTool(other.auth, 'join_world');
  const params = { cooperation_id: proposal.cooperation_id, revision: f.world.state.cooperations[proposal.cooperation_id].revision };
  resident.ok({ intent: 'confirm', ...params }, 'cooperation'); other.ok({ intent: 'confirm', ...params }, 'cooperation');
  assert.equal(f.world.state.cooperations[proposal.cooperation_id].status, 'active'); assert.equal(f.world.state.cooperations[proposal.cooperation_id].expires_at, expiry);
  for (const intent of ['propose', 'contribute', 'cook']) assert.equal(resident.action({ intent, ...params }, 'cooperation').error.code, 'HOME_BUSY');
  assert.ok(!cooperationOpportunities(f.world, resident.a).some(o => ['propose', 'contribute', 'cook'].includes(o.action.payload.intent)));
  resident.ok({ intent: 'leave', cooperation_id: proposal.cooperation_id }, 'cooperation'); assert.equal(f.world.state.cooperations[proposal.cooperation_id].status, 'ended'); assert.ok(resident.a.home_presence);
  assert.ok(!cooperationOpportunities(f.world, resident.a).some(o => o.action.payload.intent === 'propose'));
});

test('v025 indoor cooperation escrow return stays exact and does not gain collection progress', t => {
  const f = fixture(t, 2), [supplier, cook] = f.players; f.build(supplier); supplier.a.life.inventory.turnip = 4;
  const proposal = supplier.ok({ intent: 'propose', template_id: 'camp_meal', target_agent_id: cook.id, role_id: 'supplier' }, 'cooperation').cooperation, params = { cooperation_id: proposal.cooperation_id, revision: proposal.revision };
  cook.ok({ intent: 'respond', ...params, accept: true, role_id: 'cook' }, 'cooperation'); supplier.ok({ intent: 'contribute', ...params }, 'cooperation'); f.enter(supplier);
  supplier.a.life.inventory.turnip = Number.MAX_SAFE_INTEGER; supplier.ok({ intent: 'leave', cooperation_id: proposal.cooperation_id }, 'cooperation'); assert.equal(supplier.a.cooperation_return.quantity, 4);
  supplier.a.life.inventory.turnip = 0; supplier.ok({ intent: 'set', kind: 'collect_item', target_id: 'turnip', target_count: 4 }, 'personal_goal');
  supplier.ok({ intent: 'claim_return', cooperation_id: proposal.cooperation_id }, 'cooperation'); assert.equal(supplier.a.life.inventory.turnip, 4); assert.equal(supplier.a.personal_goal.progress, 0); assert.equal(supplier.a.cooperation_return, null); assert.ok(supplier.a.home_presence);
});

test('v025 restart keeps the exact house, escrow, character and inventory but removes live visits', t => {
  const folder = mkdtempSync(join(tmpdir(), 'ai-play-homes-')), dbPath = join(folder, 'world.db'); let now = 2000000000000;
  let world = new World({ dbPath, now: () => now, actionIntervalMs: 0 });
  t.after(() => { world.close(); for (const suffix of ['', '-wal', '-shm']) if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix); rmdirSync(folder); });
  const a = world.createAgent({ name: '原来的我' }), id = a.agent_id, c = world.createController(id); world.ownerControl(id, 'start', { controller_id: c.controller_id, duration_minutes: 20, max_calls: 100 }); const auth = world.authenticate(c.token); world.callTool(auth, 'join_world');
  const act = p => { const a = world.agent(id), r = world.callTool(auth, 'act', { run_id: a.run.run_id, session_epoch: a.session_epoch, action_id: a.next_action_id, type: 'home', payload: p }); assert.equal(r.status, 'applied', JSON.stringify(r)); };
  world.agent(id).position = { ...CAMP }; Object.assign(world.agent(id).life.inventory, { wood: 20, grass: 5, ore: 3 }); act({ intent: 'build' }); act({ intent: 'visit', home_id: `home_${id}` }); now = world.agent(id).movement.ends_at + 100; world.tick(); act({ intent: 'craft', kind: 'display_shelf' }); const home = world.state.homes[`home_${id}`]; act({ intent: 'place', instance_id: home.furniture[0].instance_id, x: 0, y: 0 }); act({ intent: 'display', instance_id: home.furniture[0].instance_id, item_id: 'ore' }); act({ intent: 'message', text: '重启后也要保留' });
  const saved = structuredClone({ home, appearance: world.agent(id).appearance, inventory: world.agent(id).life.inventory, run: world.agent(id).run }); world.close(); now += 1000; world = new World({ dbPath, now: () => now });
  assert.deepEqual(world.state.homes[`home_${id}`], saved.home); assert.deepEqual(world.agent(id).appearance, saved.appearance); assert.deepEqual(world.agent(id).life.inventory, saved.inventory); assert.deepEqual(world.agent(id).run, saved.run); assert.equal(world.agent(id).home_presence, null); assert.equal(world.agent(id).home_travel, null); assert.deepEqual(world.state.home_invitations, {}); assert.deepEqual(world.agent(id).position, { ...HOME_ENTRY });
});
