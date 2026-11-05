import {PLAZA_SERVICES,PLAZA_FISHING_SPOTS} from '../shared/plaza-layout.js';
const CAMP=PLAZA_SERVICES.camp.interaction_position,TOOLS=PLAZA_SERVICES.tools.interaction_position,SHORE=PLAZA_FISHING_SPOTS[0].interaction_position;
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World } from '../server/world.js';
import { spectatorSnapshot, scopeSpectatorSnapshot } from '../server/spectator.js';
import { actInputSchema } from '../server/mcp.js';
import { FISHING_SPOTS } from '../shared/fishing-layout.js';
import { SCENES, isWalkable } from '../shared/world-layout.js';

function fixture(t, count = 1, options = {}) {
  let now = 2000000000000;
  const world = new World({ now: () => now, actionIntervalMs: 0, ...options }); t.after(() => { if (!options.manualClose) world.close(); });
  const players = Array.from({ length: count }, (_, n) => {
    const id = world.createAgent({ name: `闲暇旅人${n}`, owner_id: `owner${n}` }).agent_id, ctl = world.createController(id);
    world.ownerControl(id, 'start', { controller_id: ctl.controller_id, duration_minutes: 30, max_calls: 1000 });
    const auth = world.authenticate(ctl.token); world.callTool(auth, 'join_world');
    const p = { id, auth, get a() { return world.agent(id); }, get home() { return world.state.homes[`home_${id}`]; },
      observe() { return world.callTool(auth, 'observe', { run_id: this.a.run.run_id, session_epoch: this.a.session_epoch }); },
      request(type, payload) { const o = this.observe(); return { run_id: o.run_id, session_epoch: o.session_epoch, action_id: o.next_action_id, type, payload }; },
      act(type, payload) { return world.callTool(auth, 'act', this.request(type, payload)); },
      ok(type, payload) { const r = this.act(type, payload); assert.equal(r.status, 'applied', JSON.stringify(r)); return r; } };
    p.a.position = { ...(options.position||TOOLS) }; Object.assign(p.a.life.inventory, { wood: 100, grass: 100, ore: 100 }); return p;
  });
  const tick = (ms, heartbeat = true) => { now += ms; if (heartbeat) for (const p of players) if (p.a.status === 'active') p.a.last_contact_at = now; world.tick(); };
  const enter = p => { p.ok('home', { intent: 'build' }); p.ok('home', { intent: 'visit', home_id: p.home.home_id }); tick(p.a.movement.ends_at-now+100); assert.ok(p.a.home_presence); };
  const furnish = (p, kind, x, y) => { p.ok('home', { intent: 'craft', kind }); const id = p.home.furniture.at(-1).instance_id; p.ok('home', { intent: 'place', instance_id: id, x, y }); return id; };
  const gear = p => { p.ok('inventory', { intent: 'craft', item_id: 'fishing_rod' }); p.ok('inventory', { intent: 'craft', item_id: 'fish_bait' }); };
  const write = (p, table, title = '池边的午后', text = '我想把今天听到的风写下来。') => p.ok('home', { intent: 'write_book', instance_id: table, title, text });
  const catchCount = p => (p.a.life.inventory.pond_fish || 0) + (p.a.life.inventory.silver_fish || 0);
  return { world, players, tick, enter, furnish, gear, write, catchCount, now: () => now };
}
const start = { intent: 'start', spot_id: 'plaza_pond_south', bait_id: 'fish_bait' };

test('v027 all shore choices point to authored water and walkable dry banks, with read-only scoped public data', t => {
  const f = fixture(t), [p] = f.players;
  for (const spot of FISHING_SPOTS) {
    const pond = SCENES.find(s => s.id === spot.scene_id).props.find(prop => prop.kind === 'pond' && prop.footprint.some(c => c.x === spot.position.x && c.y === spot.position.y));
    assert.ok(pond); assert.equal(isWalkable(spot.scene_id, spot.position), false); assert.equal(isWalkable(spot.scene_id, spot.interaction_position), true);
  }
  const saved = JSON.stringify(p.a); p.observe(); assert.equal(JSON.stringify(p.a), saved);
  assert.equal(scopeSpectatorSnapshot(spectatorSnapshot(f.world), 'adventure').fishing.spots.length, 0);
  assert.equal(p.observe().fishing.opportunities.some(o => o.type === 'inventory' && o.payload.item_id === 'fishing_rod'), true);
});

test('v027 fish travels physically, charges once at arrival, returns exactly one catch and never repeats', t => {
  const f = fixture(t), [p] = f.players; f.gear(p);
  const request = p.request('fish', start), before = structuredClone(p.a.position), receipt = f.world.callTool(p.auth, 'act', request);
  assert.equal(receipt.status, 'applied'); assert.equal(p.a.fishing.phase, 'approaching'); assert.deepEqual(p.a.position, before); assert.equal(p.a.life.inventory.fish_bait, 1); assert.equal(p.a.life.tools.fishing_rod.durability, 12);
  assert.deepEqual(f.world.callTool(p.auth, 'act', request), receipt); f.tick(100); assert.notDeepEqual(p.a.position, before); assert.equal(f.catchCount(p), 0);
  f.tick(p.a.movement.ends_at - f.now()); assert.equal(p.a.fishing.phase, 'fishing'); assert.equal(p.a.facing, 'north'); assert.deepEqual(p.a.position, { ...SHORE });
  assert.equal(p.a.life.inventory.fish_bait || 0, 0); assert.equal(p.a.life.tools.fishing_rod.durability, 11); assert.equal(p.a.fishing.ends_at - p.a.fishing.started_at, 30000);
  f.tick(29999); assert.equal(f.catchCount(p), 0); f.tick(1); assert.equal(f.catchCount(p), 1); assert.equal(p.a.fishing, null); f.tick(90000); assert.equal(f.catchCount(p), 1);
  assert.equal(p.a.life.ledger.entries.filter(e => e.reason === 'fish_bait').length, 1); assert.equal(p.a.life.ledger.entries.filter(e => e.reason === 'fish_caught').length, 1);
  assert.equal(f.world.historyPage({}).items.some(e => e.type === 'fish_finished'), true);
});

test('v027 cancellation before arrival keeps bait and durability; cancellation after work keeps costs but no catch', t => {
  const f = fixture(t), [p] = f.players; f.gear(p); p.ok('fish', start); f.tick(100); p.ok('fish', { intent: 'cancel' });
  assert.equal(p.a.life.inventory.fish_bait, 1); assert.equal(p.a.life.tools.fishing_rod.durability, 12); assert.equal(p.a.movement, null);
  p.ok('fish', start); f.tick(15000); assert.equal(p.a.fishing.phase, 'fishing'); p.ok('fish', { intent: 'cancel' }); f.tick(40000);
  assert.equal(f.catchCount(p), 0); assert.equal(p.a.life.inventory.fish_bait || 0, 0); assert.equal(p.a.life.tools.fishing_rod.durability, 11);
});

for (const reason of ['pause', 'lease', 'run', 'hurt']) test(`v027 ${reason} terminates fishing without future reward or implicit resumption`, t => {
  const f = fixture(t), [p] = f.players; f.gear(p); p.ok('fish', start); f.tick(15000);
  if (reason === 'pause') f.world.ownerControl(p.id, 'pause');
  else if (reason === 'lease') { p.a.last_contact_at = f.now() - 44900; f.tick(100, false); }
  else if (reason === 'run') { p.a.run.expires_at = f.now() + 100; f.tick(100); }
  else { p.a.adventure.hp--; f.tick(1); }
  assert.equal(p.a.fishing, null); f.tick(90000); assert.equal(f.catchCount(p), 0);
});

test('v027 exclusive spot reservation and atomic strict payloads reject other activities, wrong scene and no gear', t => {
  const f = fixture(t, 2), [p, q] = f.players;
  assert.equal(p.act('fish', start).error.code, 'TOOL_REQUIRED'); f.gear(p); f.gear(q); p.ok('fish', start);
  assert.equal(q.act('fish', start).error.code, 'FISHING_OCCUPIED'); assert.equal(p.act('home', { intent: 'build' }).error.code, 'FISHING_BUSY');
  assert.equal(p.observe().opportunities.every(o => ['inventory', 'survival', 'cooperation'].includes(o.action.type)), true);
  const inventory = structuredClone(q.a.life.inventory);
  for (const payload of [{ ...start, spot_id: 'unknown' }, { ...start, x: 3 }, { ...start, bait_id: 'wood' }, { ...start, mode: 'fly' }, { intent: 'cancel', spot_id: start.spot_id }]) {
    assert.equal(q.act('fish', payload).status, 'rejected'); assert.deepEqual(q.a.life.inventory, inventory);
    if (payload.spot_id !== 'unknown') assert.equal(actInputSchema.safeParse({ run_id: 'r', session_epoch: 0, action_id: 'a', type: 'fish', payload }).success, false);
  }
  q.a.scene_id = 'adventure'; assert.equal(q.act('fish', start).error.code, 'SCENE_REQUIRED');
  p.ok('fish', { intent: 'cancel' }); q.a.scene_id = 'plaza'; q.ok('fish', start);
});

test('v027 fish upkeep, food, overflow and finite lifetime stay in the normal economy', t => {
  const f = fixture(t), [p] = f.players; f.gear(p); p.a.life.tools.fishing_rod.durability = 0;
  assert.equal(p.act('fish', start).error.code, 'TOOL_REQUIRED'); p.ok('inventory', { intent: 'repair', item_id: 'fishing_rod' }); p.ok('inventory', { intent: 'upgrade', item_id: 'fishing_rod' });
  assert.equal(p.a.life.tools.fishing_rod.level, 2); assert.equal(p.a.life.tools.fishing_rod.durability, 24);
  p.a.life.inventory.pond_fish = Number.MAX_SAFE_INTEGER; assert.equal(p.act('fish', start).error.code, 'INVENTORY_FULL'); p.a.life.inventory.pond_fish = 1; p.a.survival.satiety = 20;
  p.ok('inventory', { intent: 'use', item_id: 'pond_fish' }); assert.equal(p.a.survival.satiety, 35);
  p.a.position = { ...SHORE }; p.a.run.expires_at = f.now() + 10000; p.ok('fish', start); assert.equal(p.a.fishing, null); assert.equal(p.a.life.inventory.fish_bait, 1);
});

test('v027 immediate fishing costs exactly the selected rod level and exhausted arrival never charges bait', t => {
  const f = fixture(t), [p] = f.players; f.gear(p); p.a.position = { ...SHORE }; p.a.fatigue.energy = 20;
  const ledger = p.a.life.ledger.entries.length; p.ok('fish', start);
  assert.equal(p.a.fishing.phase, 'fishing'); assert.equal(p.a.fatigue.energy, 17); assert.equal(p.a.life.ledger.entries.length, ledger + 1); assert.equal(p.a.life.tools.fishing_rod.durability, 11);
  p.ok('fish', { intent: 'cancel' }); p.a.position = { ...TOOLS }; p.ok('inventory', { intent: 'craft', item_id: 'fish_bait' }); p.a.fatigue.energy = 3;
  p.ok('fish', start); f.tick(15000); assert.equal(p.a.fishing, null); assert.equal(p.a.life.inventory.fish_bait, 1); assert.equal(p.a.life.tools.fishing_rod.durability, 11); assert.equal(f.catchCount(p), 0);
});

test('v027 late update agrees with fine ticks and cannot grant fish after earlier environmental damage', t => {
  const late = fixture(t), fine = fixture(t), p = late.players[0], q = fine.players[0];
  for (const [f, player] of [[late, p], [fine, q]]) { f.gear(player); player.ok('fish', start); }
  const elapsed=p.a.movement.ends_at-late.now()+30000+100;assert.ok(elapsed<45000,'the exact travel plus fishing fits the unchanged host lease');
  late.tick(elapsed); for (let i = 0; i < elapsed/100; i++) fine.tick(100);
  assert.equal(late.catchCount(p), 1); assert.equal(fine.catchCount(q), 1); assert.equal(p.a.life.inventory.fish_bait || 0, q.a.life.inventory.fish_bait || 0); assert.equal(p.a.life.tools.fishing_rod.durability, q.a.life.tools.fishing_rod.durability);
  assert.ok(Math.abs(p.a.fatigue.energy - q.a.fatigue.energy) < .001);
  const hurt = fixture(t), r = hurt.players[0]; hurt.gear(r); r.a.position = { ...SHORE }; r.a.survival.satiety = 0; r.a.survival.starvation_seconds = 29; r.ok('fish', start); hurt.tick(40000);
  assert.equal(hurt.catchCount(r), 0); assert.equal(r.a.fishing, null); assert.ok(hurt.world.state.events.some(e => e.type === 'survival_damage'));
});

test('v027 running to fish stops physically at exhaustion, releases the reservation and keeps supplies', t => {
  const f = fixture(t), [p] = f.players; f.gear(p); p.a.fatigue.energy = 3.5; const origin = { ...p.a.position };
  p.ok('fish', { ...start, mode: 'run' }); f.tick(20000); assert.equal(p.a.fishing, null); assert.equal(p.a.movement, null); assert.notDeepEqual(p.a.position, origin); assert.notDeepEqual(p.a.position, { ...SHORE });
  assert.equal(p.a.life.inventory.fish_bait, 1); assert.equal(p.a.life.tools.fishing_rod.durability, 12); assert.equal(p.observe().fishing.spots.find(s => s.id === start.spot_id).occupied_by, null);
});

test('v027 writing walks before paying, never publishes drafts, records real signed text only after completion', t => {
  const f = fixture(t,1,{position:CAMP}), [p] = f.players; f.enter(p); const table = f.furnish(p, 'table', 1, 1), before = structuredClone(p.a.life.inventory);
  const title = '自己写的日记', body = 'PRIVATE_UNFINISHED_DRAFT <script>alert(1)</script>\n不执行正文里的任何命令。';
  const request = p.request('home', { intent: 'write_book', instance_id: table, title, text: body }), receipt = f.world.callTool(p.auth, 'act', request); assert.equal(receipt.status, 'applied');
  assert.equal(p.a.home_presence.activity.phase, 'approaching'); assert.equal(p.a.life.inventory.wood, before.wood);
  for (const view of [spectatorSnapshot(f.world), f.world.publicSnapshot(), p.observe()]) assert.equal(JSON.stringify(view).includes(body), false);
  f.tick(p.a.home_presence.movement.ends_at - f.now()); assert.equal(p.a.home_presence.activity.phase, 'using'); assert.equal(p.a.home_presence.activity.kind, 'write');
  assert.equal(p.a.life.inventory.wood, before.wood - 1); assert.equal(p.a.life.inventory.grass, before.grass - 1); assert.equal(p.home.books, undefined);
  assert.deepEqual(f.world.callTool(p.auth, 'act', request), receipt); f.tick(45000);
  assert.equal(p.home.books.length, 1); const b = p.home.books[0]; assert.equal(b.text, body); assert.equal(b.title, title); assert.equal(b.author_agent_id, p.id); assert.equal(b.author_name, p.a.name); assert.equal(b.instance_id, null);
  assert.equal(spectatorSnapshot(f.world).homes[0].books[0].text, body); assert.equal(p.a.home_presence.activity, null); f.tick(30000); assert.equal(p.home.books.length, 1);
  assert.equal(p.a.life.ledger.entries.filter(e => e.reason === 'book_materials').length, 1);
});

test('v027 cancelled drafts never become books, and writing validation is strict in World and MCP', t => {
  const f = fixture(t,1,{position:CAMP}), [p] = f.players; f.enter(p); const table = f.furnish(p, 'table', 1, 1), wood = p.a.life.inventory.wood;
  f.write(p, table); p.ok('home', { intent: 'cancel' }); assert.equal(p.a.life.inventory.wood, wood);
  f.write(p, table); f.tick(15000); p.ok('home', { intent: 'cancel' }); f.tick(60000); assert.equal(p.home.books, undefined); assert.equal(p.a.life.inventory.wood, wood - 1);
  for (const payload of [{ intent: 'write_book', instance_id: table, title: ' ', text: 'x' }, { intent: 'write_book', instance_id: table, title: 'x', text: '😀'.repeat(801) }, { intent: 'write_book', instance_id: table, title: '😀'.repeat(41), text: 'x' }, { intent: 'write_book', instance_id: table, title: 'x', text: 'x', author_agent_id: 'other' }, { intent: 'use', instance_id: table, activity: 'write' }, { intent: 'use', instance_id: table, activity: 'eat', item_id: 'turnip', book_id: 'other' }]) {
    assert.equal(p.act('home', payload).status, 'rejected'); assert.equal(actInputSchema.safeParse({ run_id: 'r', session_epoch: 0, action_id: 'a', type: 'home', payload }).success, false);
  }
});

test('v027 full furniture storage still permits eight bounded books and comments remain capped', t => {
  const f = fixture(t,1,{position:CAMP}), [p] = f.players; f.enter(p); const table = f.furnish(p, 'table', 4, 6);
  for (let i = 1; i < 12; i++) p.ok('home', { intent: 'craft', kind: 'chair' }); assert.equal(p.home.furniture.length, 12);
  for (let i = 0; i < 8; i++) { f.write(p, table, i ? `作品${i}` : '😀'.repeat(40), i ? `正文${i}` : '😀'.repeat(800)); f.tick(45000); }
  assert.equal(p.home.books.length, 8); assert.equal([...p.home.books[0].text].length, 800); assert.equal(p.observe().homes.writing_desks.length, 0);
  const inventory = structuredClone(p.a.life.inventory); assert.equal(p.act('home', { intent: 'write_book', instance_id: table, title: '第九本', text: '不会扣材料' }).error.code, 'BOOK_UNAVAILABLE'); assert.deepEqual(p.a.life.inventory, inventory);
  const id = p.home.books[0].book_id;
  for (let i = 0; i < 12; i++) { p.ok('home', { intent: 'book_comment', book_id: id, text: `评论${i}` }); f.tick(10000); }
  assert.equal(p.home.books[0].comments.length, 10); assert.equal(p.home.books[0].comments[0].text, '评论2');
});

for (const reason of ['run', 'lease', 'pause', 'hurt']) test(`v027 ${reason} stops an unfinished book and cannot publish a partial draft`, t => {
  const f = fixture(t,1,{position:CAMP}), [p] = f.players; f.enter(p); const table = f.furnish(p, 'table', 4, 6); f.write(p, table); const inventory = structuredClone(p.a.life.inventory);
  if (reason === 'run') { p.a.run.expires_at = f.now() + 1000; f.tick(1000); }
  if (reason === 'lease') { p.a.last_contact_at = f.now() - 44000; f.tick(1000, false); }
  if (reason === 'pause') f.world.ownerControl(p.id, 'pause');
  if (reason === 'hurt') { p.a.adventure.hp--; f.tick(1); }
  f.tick(60000); assert.equal((p.home.books || []).length, 0); assert.equal(p.a.home_presence?.activity || null, null); assert.deepEqual(p.a.life.inventory, inventory);
});

test('v027 books use existing tables/chairs, guest consent and shelves; no guest authorship or remote comments', t => {
  const f = fixture(t,2,{position:CAMP}), [p, q] = f.players; f.enter(p); const table = f.furnish(p, 'table', 1, 1), chair = f.furnish(p, 'chair', 7, 1), shelf = f.furnish(p, 'display_shelf', 1, 4);
  f.write(p, table); f.tick(60000); const book = p.home.books[0];
  assert.ok(p.observe().homes.opportunities.some(o => o.payload.book_id === book.book_id && o.payload.activity === 'read'));
  assert.equal(q.act('home', { intent: 'book_comment', book_id: book.book_id, text: '远处的评论' }).error.code, 'HOME_REQUIRED');
  p.ok('home', { intent: 'invite', target_agent_id: q.id }); q.ok('home', { intent: 'respond', invitation_id: q.observe().homes.invitations[0].invitation_id, accept: true }); q.ok('home', { intent: 'visit', home_id: p.home.home_id }); f.tick(q.a.movement.ends_at-f.now()+100);
  assert.equal(q.act('home', { intent: 'use', instance_id: chair, activity: 'read', book_id: book.book_id }).error.code, 'BOOK_UNAVAILABLE');
  assert.equal(q.act('home', { intent: 'write_book', instance_id: table, title: '冒名', text: '不要' }).error.code, 'HOME_OWNER_REQUIRED');
  p.ok('home', { intent: 'shelve_book', book_id: book.book_id, instance_id: shelf });
  assert.equal(p.act('home', { intent: 'store', instance_id: shelf }).error.code, 'DISPLAY_OCCUPIED');
  assert.equal(p.act('home', { intent: 'display', instance_id: shelf, item_id: 'wood' }).error.code, 'DISPLAY_UNAVAILABLE');
  q.ok('home', { intent: 'use', instance_id: chair, activity: 'read', book_id: book.book_id }); f.tick(12000);
  const reading = q.observe().self.home_presence.activity.reading; assert.equal(reading.book_id, book.book_id); assert.equal(reading.text, book.text); assert.equal(reading.author_name, p.a.name);
  assert.equal(p.act('home', { intent: 'unshelve_book', book_id: book.book_id }).error.code, 'BOOK_BUSY');
  q.ok('home', { intent: 'book_comment', book_id: book.book_id, text: '这阵风让我想到池塘。' }); assert.equal(p.home.books[0].comments.length, 1); assert.equal(p.home.books[0].comments[0].author_agent_id, q.id);
  assert.equal(q.act('home', { intent: 'book_comment', book_id: book.book_id, text: '再评论' }).error.code, 'RATE_LIMITED');
  f.tick(45000); p.ok('home', { intent: 'unshelve_book', book_id: book.book_id }); assert.equal(p.home.books[0].instance_id, null); assert.equal(q.act('home', { intent: 'unshelve_book', book_id: book.book_id }).error.code, 'HOME_OWNER_REQUIRED');
});

test('v027 authored assets survive restart but draft and fishing jobs cannot resume or create phantom results', t => {
  const dir = mkdtempSync(join(tmpdir(), 'v027-world-')), dbPath = join(dir, 'state.db');
  const f = fixture(t, 2, { dbPath, manualClose: true, position:CAMP }), [p, q] = f.players; f.enter(p); const table = f.furnish(p, 'table', 1, 1); f.write(p, table); f.tick(60000); const books = structuredClone(p.home.books);
  f.write(p, table, '未完成', '不能公开或自动补写'); q.a.position={...TOOLS}; f.gear(q); q.ok('fish', start); f.tick(1000); const pInv = structuredClone(p.a.life.inventory), qInv = structuredClone(q.a.life.inventory), rod = structuredClone(q.a.life.tools.fishing_rod); f.world.save(); f.world.close();
  const restored = new World({ dbPath, now: () => f.now() + 100000 }); t.after(() => { restored.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.deepEqual(restored.state.homes[p.home.home_id].books, books); assert.equal(restored.agent(p.id).home_presence, null); assert.equal(restored.agent(q.id).fishing, null);
  assert.deepEqual(restored.agent(p.id).life.inventory, pInv); assert.deepEqual(restored.agent(q.id).life.inventory, qInv); assert.deepEqual(restored.agent(q.id).life.tools.fishing_rod, rod);
});
