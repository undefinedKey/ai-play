import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { World } from '../server/world.js';
import { HOME_RULES } from '../server/homes.js';
import { spectatorSnapshot } from '../server/spectator.js';
import { combatStats } from '../server/life.js';
import { WARDROBE_CATALOG, WARDROBE_DYES, WARDROBE_RULES, AQUARIUM_RULES, validWardrobe, validAquarium } from '../skills/ai-plaza/scripts/lifestyle-contract.mjs';

function fixture(t, count = 2, options = {}) {
  let now = 2000000000000;
  const world = new World({ now: () => now, actionIntervalMs: 0, ...options }); let closed = false;
  const close = () => { if (!closed) { closed = true; world.close(); } }; t.after(close);
  const players = Array.from({ length: count }, (_, n) => {
    const { agent_id: id } = world.createAgent({ name: `衣橱与鱼缸旅人${n}`, owner_id: `style_owner${n}` }), controller = world.createController(id);
    world.ownerControl(id, 'start', { controller_id: controller.controller_id, duration_minutes: 60, max_calls: 1000 });
    const auth = world.authenticate(controller.token); world.callTool(auth, 'join_world');
    Object.assign(world.agent(id).life.inventory, { wood: 500, ore: 500, grass: 500, berry: 20, moon_herb: 20, turnip: 20, pond_fish: 10, silver_fish: 10 });
    world.agent(id).position = { x: 11, y: 8 };
    return { id, controller, auth, get a() { return world.agent(id); }, get home() { return world.state.homes[`home_${id}`]; },
      observe() { return world.callTool(auth, 'observe', { run_id: this.a.run.run_id, session_epoch: this.a.session_epoch }); },
      input(type, payload) { const o = this.observe(); return { run_id: o.run_id, session_epoch: o.session_epoch, action_id: o.next_action_id, type, payload }; },
      act(type, payload) { return world.callTool(auth, 'act', this.input(type, payload)); },
      ok(type, payload) { const r = this.act(type, payload); assert.equal(r.status, 'applied', JSON.stringify(r)); return r; },
    };
  });
  const tick = ms => { now += ms; for (const p of players) if (p.a.status === 'active') p.a.last_contact_at = now; world.tick(); };
  const build = p => p.ok('home', { intent: 'build', name: `${p.a.name}的小屋` });
  const enter = (p, home = p.home) => { p.ok('home', { intent: 'visit', home_id: home.home_id }); tick(3000); assert.equal(p.a.home_presence?.home_id, home.home_id); };
  const tank = (p, x = 1, y = 1, rotation = 0) => { p.ok('home', { intent: 'craft', kind: 'aquarium' }); const id = p.home.furniture.at(-1).instance_id; p.ok('home', { intent: 'place', instance_id: id, x, y, rotation }); return id; };
  const approach = (p, id) => { p.ok('aquarium', { intent: 'approach', instance_id: id }); tick(10000); assert.equal(p.a.home_presence?.movement, null); };
  return { world, players, tick, build, enter, tank, approach, now: () => now, close };
}

test('v035 portable wardrobe and aquarium contracts reject foreign fields and invalid finite values', () => {
  for (const p of [{ intent: 'craft', style_id: 'linen_shirt' }, { intent: 'dye', garment_id: 'garment_a', color_id: 'rose' }, { intent: 'hairstyle', style_id: 'original' }, { intent: 'browse', page: 5 }]) assert.equal(validWardrobe(p), true);
  for (const p of [{ intent: 'craft', style_id: 'linen_shirt', agent_id: 'other' }, { intent: 'dye', garment_id: 'garment_a', color_id: '#ff0000' }, { intent: 'browse', page: 6 }, { intent: 'remove', slot: 'weapon' }, { intent: 'hairstyle', style_id: 'wanderer_1' }, JSON.parse('{"intent":"browse","page":0,"__proto__":{}}')]) assert.equal(validWardrobe(p), false);
  for (const p of [{ intent: 'put', instance_id: 'furniture_a', item_id: 'pond_fish', name: '小银' }, { intent: 'decorate', instance_id: 'furniture_a', slot: 2, decoration_id: 'water_grass' }, { intent: 'browse', page: 15 }]) assert.equal(validAquarium(p), true);
  for (const p of [{ intent: 'put', instance_id: 'furniture_a', item_id: 'grilled_fish' }, { intent: 'put', instance_id: 'furniture_a', item_id: 'fish_bait' }, { intent: 'name', instance_id: 'furniture_a', fish_id: 'tankfish_a', name: '' }, { intent: 'decorate', instance_id: 'furniture_a', slot: 3, decoration_id: 'pebbles' }, { intent: 'browse', page: Infinity }, { intent: 'approach', instance_id: 'furniture_a', teleport: true }]) assert.equal(validAquarium(p), false);
});

test('v035 wardrobe uses real materials, persistent instances and independent visible slots, restoring original identity', t => {
  const f = fixture(t), [p, q] = f.players, original = structuredClone({ appearance: p.a.appearance, stats: combatStats(p.a), equipped: p.a.life.equipped, run: p.a.run });
  assert.equal(p.observe().wardrobe.owned_count, 0); assert.deepEqual(p.observe().wardrobe.wearing, { outfit: null, head: null, back: null });
  assert.equal(f.world.getRules().max_capabilities, 16); assert.equal(f.world.getRules().wardrobe.version, 1);
  const inventoryBefore = { ...p.a.life.inventory }, created = [];
  for (const style of WARDROBE_CATALOG) created.push(p.ok('wardrobe', { intent: 'craft', style_id: style.id }).garment);
  for (const item of created) assert.equal(item.color_id, 'natural');
  assert.equal(new Set(created.map(i => i.garment_id)).size, 7);
  const costs = WARDROBE_CATALOG.reduce((sum, s) => { for (const [id, n] of Object.entries(s.cost)) sum[id] = (sum[id] || 0) + n; return sum; }, {});
  for (const [id, n] of Object.entries(costs)) assert.equal(p.a.life.inventory[id], inventoryBefore[id] - n);
  assert.equal(q.act('wardrobe', { intent: 'wear', garment_id: created[0].garment_id }).error.code, 'WARDROBE_OWNER_REQUIRED');
  for (const item of [created[0], created[3], created[5]]) p.ok('wardrobe', { intent: 'wear', garment_id: item.garment_id });
  let publicActor = spectatorSnapshot(f.world).agents.find(a => a.agent_id === p.id);
  assert.equal(publicActor.wardrobe.wearing.outfit.style_id, 'linen_shirt'); assert.equal(publicActor.wardrobe.wearing.head.style_id, 'straw_hat'); assert.equal(publicActor.wardrobe.wearing.back.style_id, 'cloth_satchel');
  assert.equal('owned' in publicActor.wardrobe, false); assert.equal('items' in publicActor.wardrobe, false);
  assert.equal(JSON.stringify(spectatorSnapshot(f.world)).includes(created[1].garment_id), false);
  const berries = p.a.life.inventory.berry; p.ok('wardrobe', { intent: 'dye', garment_id: created[0].garment_id, color_id: 'rose' }); assert.equal(p.a.life.inventory.berry, berries - 1);
  assert.equal(p.act('wardrobe', { intent: 'dye', garment_id: created[0].garment_id, color_id: 'rose' }).error.code, 'WARDROBE_UNCHANGED'); assert.equal(p.a.life.inventory.berry, berries - 1);
  p.ok('wardrobe', { intent: 'hairstyle', style_id: 'ponytail' }); assert.equal(f.world.publicAgent(p.a).wardrobe.hairstyle, 'ponytail');
  p.ok('wardrobe', { intent: 'wear', garment_id: created[2].garment_id }); assert.equal(p.a.wardrobe.items.length, 7);
  for (const slot of WARDROBE_RULES.slots) p.ok('wardrobe', { intent: 'remove', slot });
  p.ok('wardrobe', { intent: 'hairstyle', style_id: 'original' }); publicActor = f.world.publicAgent(p.a);
  assert.deepEqual(publicActor.wardrobe.wearing, { outfit: null, head: null, back: null }); assert.equal(publicActor.wardrobe.hairstyle, 'original');
  assert.deepEqual(p.a.appearance, original.appearance); assert.deepEqual(combatStats(p.a), original.stats); assert.deepEqual(p.a.life.equipped, original.equipped); assert.deepEqual(p.a.run, original.run);
});

test('v035 wardrobe rejects unsafe location and depleted resources; paging and max24 remain authoritative', t => {
  const f = fixture(t, 1), [p] = f.players;
  p.a.position = { x: 20, y: 20 }; assert.equal(p.observe().wardrobe.can_change, false); assert.equal(p.act('wardrobe', { intent: 'craft', style_id: 'linen_shirt' }).error.code, 'NOT_AT_CAMP');
  p.a.position = { x: 11, y: 8 }; p.a.life.inventory.grass = 0;
  assert.equal(p.act('wardrobe', { intent: 'craft', style_id: 'linen_shirt' }).error.code, 'INSUFFICIENT_ITEMS'); assert.equal(p.a.wardrobe.items.length, 0);
  p.a.life.inventory.grass = 100;
  for (let i = 0; i < 24; i++) p.ok('wardrobe', { intent: 'craft', style_id: 'linen_shirt' });
  const stock = p.a.life.inventory.grass; assert.equal(p.act('wardrobe', { intent: 'craft', style_id: 'straw_hat' }).error.code, 'WARDROBE_FULL'); assert.equal(p.a.life.inventory.grass, stock);
  const ids = [];
  for (let page = 0; page < 6; page++) { const w = p.ok('wardrobe', { intent: 'browse', page }).wardrobe; assert.equal(w.owned_count, 24); assert.equal(w.page_size, 4); assert.equal(w.pages, 6); ids.push(...w.owned.map(i => i.garment_id)); }
  assert.equal(new Set(ids).size, 24); assert.equal(p.observe().wardrobe.page, 5);
  assert.equal(p.act('wardrobe', { intent: 'browse', page: 6 }).status, 'rejected');
  f.build(p); f.enter(p); assert.equal(p.observe().wardrobe.can_change, true);
  p.ok('home', { intent: 'move', x: 5, y: 4 }); assert.equal(p.observe().wardrobe.can_change, false);
  assert.equal(p.act('wardrobe', { intent: 'hairstyle', style_id: 'short' }).error.code, 'HOME_USE_BUSY');
  p.ok('home', { intent: 'cancel' }); p.ok('wardrobe', { intent: 'hairstyle', style_id: 'short' });
});

test('v035 wardrobe idempotent craft and dye never double charge; rejected request rolls back all state', t => {
  const f = fixture(t, 1), [p] = f.players, before = p.a.life.inventory.grass;
  const req = p.input('wardrobe', { intent: 'craft', style_id: 'garden_apron' }); const result = f.world.callTool(p.auth, 'act', req);
  assert.equal(result.status, 'applied'); assert.deepEqual(f.world.callTool(p.auth, 'act', req), result); assert.equal(p.a.life.inventory.grass, before - 3); assert.equal(p.a.wardrobe.items.length, 1);
  const dye = p.input('wardrobe', { intent: 'dye', garment_id: result.garment.garment_id, color_id: 'sky' }), herb = p.a.life.inventory.moon_herb;
  const dyed = f.world.callTool(p.auth, 'act', dye); assert.deepEqual(f.world.callTool(p.auth, 'act', dye), dyed); assert.equal(p.a.life.inventory.moon_herb, herb - 1);
  p.a.life.inventory.berry = 0; const stored = structuredClone(p.a.wardrobe);
  assert.equal(p.act('wardrobe', { intent: 'dye', garment_id: result.garment.garment_id, color_id: 'rose' }).error.code, 'INSUFFICIENT_ITEMS'); assert.deepEqual(p.a.wardrobe, stored);
  p.ok('wardrobe', { intent: 'dye', garment_id: result.garment.garment_id, color_id: 'natural' }); assert.equal(p.a.life.inventory.moon_herb, herb - 1);
});

test('v035 aquarium fits existing12furniture without replacing them, obeys16cap and room collision', t => {
  const f = fixture(t, 1), [p] = f.players; f.build(p); f.enter(p);
  for (let i = 0; i < 12; i++) p.ok('home', { intent: 'craft', kind: 'chair' }); const existing = structuredClone(p.home.furniture);
  const id = f.tank(p); assert.equal(p.home.furniture.length, 13); assert.deepEqual(p.home.furniture.slice(0, 12), existing);
  const placedBefore = structuredClone(p.home.furniture.at(-1));
  assert.equal(p.act('home', { intent: 'place', instance_id: id, x: 5, y: 7, rotation: 90 }).error.code, 'HOME_COLLISION'); assert.deepEqual(p.home.furniture.at(-1), placedBefore);
  for (let i = 13; i < HOME_RULES.max_furniture; i++) p.ok('home', { intent: 'craft', kind: 'aquarium' });
  assert.equal(p.home.furniture.length, 16); assert.equal(p.act('home', { intent: 'craft', kind: 'aquarium' }).error.code, 'HOME_FULL');
  assert.equal(p.observe().homes.opportunities.some(o => o.payload.intent === 'craft'), false);
});

test('v035 aquarium approach is real cancellable movement and does not insert fish by itself', t => {
  const f = fixture(t, 1), [p] = f.players; f.build(p); f.enter(p); const id = f.tank(p), before = { ...p.a.home_presence.position }, stock = p.a.life.inventory.pond_fish;
  assert.equal(p.act('aquarium', { intent: 'put', instance_id: id, item_id: 'pond_fish' }).error.code, 'AQUARIUM_TOO_FAR');
  assert.ok(p.observe().aquarium.opportunities.some(o => o.payload.intent === 'approach'));
  p.ok('aquarium', { intent: 'approach', instance_id: id }); assert.deepEqual(p.a.home_presence.position, before); assert.ok(p.a.home_presence.movement);
  assert.equal(p.act('aquarium', { intent: 'put', instance_id: id, item_id: 'pond_fish' }).error.code, 'HOME_USE_BUSY');
  f.tick(100); assert.notDeepEqual(p.a.home_presence.position, before); p.ok('home', { intent: 'cancel' }); const cancelled = { ...p.a.home_presence.position };
  f.tick(5000); assert.deepEqual(p.a.home_presence.position, cancelled); assert.equal(p.a.life.inventory.pond_fish, stock);
  f.approach(p, id); assert.equal(p.home.furniture.find(v => v.instance_id === id).aquarium.fish.length, 0);
  const inspected = p.ok('aquarium', { intent: 'inspect', instance_id: id }); assert.equal(inspected.aquarium.nearby, true);
  assert.equal(p.a.life.inventory.pond_fish, stock); assert.ok(p.observe().aquarium.opportunities.some(o => o.payload.intent === 'put'));
});

test('v035 real rawfish are conserved across put/remove/store and rejected capacity, names persist as content', t => {
  const f = fixture(t, 1), [p] = f.players; f.build(p); f.enter(p); const id = f.tank(p); f.approach(p, id);
  const rawFish = () => p.home.furniture.find(v => v.instance_id === id).aquarium.fish, initial = p.a.life.inventory.pond_fish;
  const req = p.input('aquarium', { intent: 'put', instance_id: id, item_id: 'pond_fish', name: '小水花' }), result = f.world.callTool(p.auth, 'act', req);
  assert.equal(result.status, 'applied'); assert.deepEqual(f.world.callTool(p.auth, 'act', req), result); assert.equal(rawFish().length, 1); assert.equal(p.a.life.inventory.pond_fish, initial - 1);
  p.ok('aquarium', { intent: 'name', instance_id: id, fish_id: result.fish.fish_id, name: '<b>鱼</b>' }); assert.equal(rawFish()[0].name, '<b>鱼</b>');
  for (let i = 1; i < 4; i++) p.ok('aquarium', { intent: 'put', instance_id: id, item_id: 'pond_fish' });
  const beforeFull = p.a.life.inventory.pond_fish;
  assert.equal(p.act('aquarium', { intent: 'put', instance_id: id, item_id: 'pond_fish' }).error.code, 'AQUARIUM_FULL'); assert.equal(p.a.life.inventory.pond_fish, beforeFull);
  assert.equal(p.act('aquarium', { intent: 'put', instance_id: id, item_id: 'grilled_fish' }).error.code, 'INVALID_ACTION');
  const all = structuredClone(rawFish()); p.ok('home', { intent: 'store', instance_id: id });
  assert.deepEqual(rawFish(), all); assert.equal(spectatorSnapshot(f.world).homes[0].furniture.some(v => v.instance_id === id), false);
  const storage = p.observe().homes.own_home.storage.find(v => v.instance_id === id); assert.deepEqual(storage.aquarium.fish, all);
  assert.equal(p.act('aquarium', { intent: 'remove', instance_id: id, fish_id: all[0].fish_id }).error.code, 'AQUARIUM_UNAVAILABLE');
  p.ok('home', { intent: 'place', instance_id: id, x: 1, y: 1 });
  p.a.life.inventory.pond_fish = Number.MAX_SAFE_INTEGER;
  assert.equal(p.act('aquarium', { intent: 'remove', instance_id: id, fish_id: all[0].fish_id }).error.code, 'INVENTORY_FULL'); assert.deepEqual(rawFish(), all);
  p.a.life.inventory.pond_fish = beforeFull;
  for (const fish of all) p.ok('aquarium', { intent: 'remove', instance_id: id, fish_id: fish.fish_id });
  assert.equal(p.a.life.inventory.pond_fish, initial); assert.equal(rawFish().length, 0);
  assert.equal(p.act('aquarium', { intent: 'remove', instance_id: id, fish_id: all[0].fish_id }).error.code, 'AQUARIUM_FISH_NOT_FOUND');
});

test('v035 decoration escrow is conserved on replace/clear and overflow rejects atomically', t => {
  const f = fixture(t, 1), [p] = f.players; f.build(p); f.enter(p); const id = f.tank(p); f.approach(p, id);
  const before = { ...p.a.life.inventory }, decor = () => p.home.furniture.find(v => v.instance_id === id).aquarium.decorations;
  p.ok('personal_goal', { intent: 'set', kind: 'collect_item', target_id: 'wood', target_count: 2 });
  for (const [slot, decoration_id] of ['water_grass', 'pebbles', 'driftwood'].entries()) p.ok('aquarium', { intent: 'decorate', instance_id: id, slot, decoration_id });
  for (const item of ['grass', 'ore', 'wood']) assert.equal(p.a.life.inventory[item], before[item] - 1);
  assert.equal(p.act('aquarium', { intent: 'decorate', instance_id: id, slot: 0, decoration_id: 'water_grass' }).error.code, 'AQUARIUM_UNCHANGED');
  p.ok('aquarium', { intent: 'decorate', instance_id: id, slot: 1, decoration_id: 'water_grass' }); assert.equal(p.a.life.inventory.ore, before.ore); assert.equal(p.a.life.inventory.grass, before.grass - 2);
  const stored = structuredClone(decor()); p.a.life.inventory.grass = Number.MAX_SAFE_INTEGER;
  assert.equal(p.act('aquarium', { intent: 'clear_decoration', instance_id: id, slot: 1 }).error.code, 'INVENTORY_FULL'); assert.deepEqual(decor(), stored);
  p.a.life.inventory.grass = before.grass - 2;
  for (const slot of [0, 1, 2]) p.ok('aquarium', { intent: 'clear_decoration', instance_id: id, slot });
  for (const item of ['grass', 'ore', 'wood']) assert.equal(p.a.life.inventory[item], before[item]); assert.deepEqual(decor(), []); assert.equal(p.a.personal_goal.progress, 0);
});

test('v035 guests can physically inspect placed tanks but never alter owner assets or see storage/wardrobe', t => {
  const f = fixture(t), [p, q] = f.players; f.build(p); f.enter(p); const id = f.tank(p); f.approach(p, id);
  const fish = p.ok('aquarium', { intent: 'put', instance_id: id, item_id: 'silver_fish', name: '星点' }).fish;
  const privateGarment = p.ok('wardrobe', { intent: 'craft', style_id: 'travel_pack' }).garment;
  p.ok('home', { intent: 'craft', kind: 'aquarium' }); const storedId = p.home.furniture.at(-1).instance_id;
  p.ok('home', { intent: 'invite', target_agent_id: q.id }); const invitation = q.observe().homes.invitations.at(-1);
  q.ok('home', { intent: 'respond', invitation_id: invitation.invitation_id, accept: true }); f.enter(q, p.home); f.approach(q, id);
  assert.equal(q.ok('aquarium', { intent: 'inspect', instance_id: id }).aquarium.aquarium.fish[0].name, '星点');
  for (const payload of [{ intent: 'put', item_id: 'pond_fish' }, { intent: 'remove', fish_id: fish.fish_id }, { intent: 'name', fish_id: fish.fish_id, name: '别人的鱼' }, { intent: 'decorate', slot: 0, decoration_id: 'pebbles' }]) assert.equal(q.act('aquarium', { ...payload, instance_id: id }).error.code, 'HOME_OWNER_REQUIRED');
  const observation = q.observe(); assert.equal(observation.aquarium.tank_count, 1); assert.equal(JSON.stringify(observation.aquarium).includes(storedId), false); assert.equal(JSON.stringify(observation).includes(privateGarment.garment_id), false);
  assert.equal(q.observe().wardrobe.can_change, false); assert.equal(p.home.furniture.find(v => v.instance_id === id).aquarium.fish[0].name, '星点');
});

test('v035 persisted identity, wardrobe and stored aquarium survive restart with no automatic work', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-plaza-lifestyle-'));
  const dbPath = join(dir, 'world.sqlite'), f = fixture(t, 1, { dbPath }), [p] = f.players; f.build(p); f.enter(p); const id = f.tank(p); f.approach(p, id);
  const item = p.ok('wardrobe', { intent: 'craft', style_id: 'soft_cap' }).garment; p.ok('wardrobe', { intent: 'wear', garment_id: item.garment_id }); p.ok('wardrobe', { intent: 'hairstyle', style_id: 'bob' });
  p.ok('aquarium', { intent: 'put', instance_id: id, item_id: 'pond_fish', name: '原来的鱼' }); p.ok('aquarium', { intent: 'decorate', instance_id: id, slot: 2, decoration_id: 'driftwood' }); p.ok('home', { intent: 'store', instance_id: id });
  const saved = structuredClone({ appearance: p.a.appearance, wardrobe: p.a.wardrobe, inventory: p.a.life.inventory, furniture: p.home.furniture, id: p.id, run: p.a.run }); f.world.commit(); f.close();
  const restored = new World({ dbPath, now: f.now }); t.after(() => restored.close()); t.after(() => { assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.ok(basename(dir).startsWith('ai-plaza-lifestyle-')); rmSync(dir, { recursive: true, force: true }); }); const a = restored.agent(p.id), home = restored.state.homes[`home_${p.id}`];
  assert.deepEqual(a.appearance, saved.appearance); assert.deepEqual(a.wardrobe, saved.wardrobe); assert.deepEqual(a.life.inventory, saved.inventory); assert.deepEqual(home.furniture, saved.furniture); assert.deepEqual(a.run, saved.run); assert.equal(a.agent_id, saved.id);
  assert.equal(a.home_presence, null); assert.equal(a.status, 'offline'); assert.equal(spectatorSnapshot(restored).homes[0].furniture.some(v => v.instance_id === id), false);
});

test('v035 busy travel, furniture use and pause cannot perform remote aquarium or wardrobe work', t => {
  const f = fixture(t, 1), [p] = f.players; f.build(p);
  p.ok('home', { intent: 'visit', home_id: p.home.home_id });
  assert.equal(p.act('wardrobe', { intent: 'hairstyle', style_id: 'short' }).error.code, 'HOME_BUSY');
  assert.equal(p.act('aquarium', { intent: 'approach', instance_id: 'furniture_missing' }).error.code, 'HOME_REQUIRED');
  f.tick(3000); const tank = f.tank(p);
  p.ok('home', { intent: 'craft', kind: 'chair' }); const chair = p.home.furniture.at(-1).instance_id;
  p.ok('home', { intent: 'place', instance_id: chair, x: 7, y: 3 }); p.ok('home', { intent: 'use', instance_id: chair, activity: 'sit' });
  assert.equal(p.observe().wardrobe.can_change, false); assert.equal(p.observe().aquarium.opportunities.length, 0);
  assert.equal(p.act('wardrobe', { intent: 'craft', style_id: 'soft_cap' }).error.code, 'HOME_USE_BUSY');
  assert.equal(p.act('aquarium', { intent: 'approach', instance_id: tank }).error.code, 'HOME_USE_BUSY');
  p.ok('home', { intent: 'cancel' });
  p.ok('aquarium', { intent: 'approach', instance_id: tank }); const saved = structuredClone({ inventory: p.a.life.inventory, tank: p.home.furniture.find(v => v.instance_id === tank), wardrobe: p.a.wardrobe });
  const old = p.input('aquarium', { intent: 'put', instance_id: tank, item_id: 'pond_fish' });
  f.world.ownerControl(p.id, 'pause'); f.tick(2000);
  assert.equal(p.a.home_presence, null); assert.throws(() => f.world.callTool(p.auth, 'act', old));
  assert.deepEqual(p.a.life.inventory, saved.inventory); assert.deepEqual(p.home.furniture.find(v => v.instance_id === tank), saved.tank); assert.deepEqual(p.a.wardrobe, saved.wardrobe);
});

test('v035 new modules obey an existing independently chosen feature job without replacing or queuing it', t => {
  const f = fixture(t, 1), [p] = f.players;
  p.ok('community', { intent: 'use', seat_id: 'picnic_west', activity: 'sit', duration_seconds: 30 });
  const saved = structuredClone(p.a.community_job), position = { ...p.a.position }, inventory = { ...p.a.life.inventory };
  assert.equal(p.act('wardrobe', { intent: 'craft', style_id: 'linen_shirt' }).error.code, 'COMMUNITY_BUSY');
  assert.equal(p.act('aquarium', { intent: 'approach', instance_id: 'furniture_missing' }).error.code, 'COMMUNITY_BUSY');
  assert.equal(p.observe().wardrobe.can_change, false); assert.deepEqual(p.a.community_job, saved); assert.deepEqual(p.a.position, position); assert.deepEqual(p.a.life.inventory, inventory);
  assert.equal(p.ok('wardrobe', { intent: 'browse', page: 0 }).wardrobe.can_change, false);
  p.ok('community', { intent: 'cancel_use' }); assert.equal(p.a.community_job, null);
});

test('v035 aquarium browsing has complete bounded pagination and current foreign-home projection hides all stored tanks', t => {
  const f = fixture(t, 1), [p] = f.players; f.build(p); f.enter(p);
  for (let i = 0; i < HOME_RULES.max_furniture; i++) p.ok('home', { intent: 'craft', kind: 'aquarium' });
  const ids = [];
  for (let page = 0; page < HOME_RULES.max_furniture; page++) {
    const observation = p.ok('aquarium', { intent: 'browse', page }).aquarium;
    assert.equal(observation.tank_count, 16); assert.equal(observation.pages, 16); assert.equal(observation.page_size, 1); assert.equal(observation.tanks.length, 1); assert.equal(observation.tanks[0].placed, false); assert.deepEqual(observation.opportunities, []); ids.push(observation.tanks[0].instance_id);
  }
  assert.equal(new Set(ids).size, 16); assert.equal(p.observe().aquarium.page, 15); assert.equal(p.act('aquarium', { intent: 'browse', page: 16 }).error.code, 'INVALID_ACTION');
  assert.deepEqual(spectatorSnapshot(f.world).homes[0].furniture, []);
});

test('v035 upgrading a legacy full house grants no garments or fish and retains every original asset', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-plaza-lifestyle-')), dbPath = join(dir, 'world.sqlite');
  const f = fixture(t, 1, { dbPath }), [p] = f.players; f.build(p); f.enter(p);
  for (let i = 0; i < 12; i++) p.ok('home', { intent: 'craft', kind: 'chair' });
  delete p.a.wardrobe; delete p.a.aquarium_page;
  const saved = structuredClone({ appearance: p.a.appearance, inventory: p.a.life.inventory, furniture: p.home.furniture, run: p.a.run, controller: p.controller });
  f.world.commit(); f.close();
  const restored = new World({ dbPath, now: f.now }); t.after(() => restored.close()); t.after(() => { assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.ok(basename(dir).startsWith('ai-plaza-lifestyle-')); rmSync(dir, { recursive: true, force: true }); });
  const a = restored.agent(p.id), home = restored.state.homes[`home_${p.id}`];
  assert.deepEqual(a.wardrobe, { version: 1, hairstyle: 'original', items: [], wearing: { outfit: null, head: null, back: null }, page: 0 });
  assert.deepEqual(a.appearance, saved.appearance); assert.deepEqual(a.life.inventory, saved.inventory); assert.deepEqual(a.run, saved.run); assert.deepEqual(home.furniture, saved.furniture);
  assert.equal(restored.authenticate(saved.controller.token).agent_id, p.id); assert.equal(restored.getRules().homes.max_furniture, 16);
});

test('v035 run expiry interrupts aquarium approach without resuming or changing escrow', t => {
  const f = fixture(t, 1), [p] = f.players; f.build(p); f.enter(p); const id = f.tank(p);
  p.ok('aquarium', { intent: 'approach', instance_id: id });
  const old = p.input('aquarium', { intent: 'put', instance_id: id, item_id: 'pond_fish' });
  const saved = structuredClone({ inventory: p.a.life.inventory, furniture: p.home.furniture, wardrobe: p.a.wardrobe });
  p.a.run.expires_at = f.now() + 100; f.tick(1000);
  assert.equal(p.a.home_presence, null); assert.notEqual(p.a.run.status, 'active');
  assert.throws(() => f.world.callTool(p.auth, 'act', old)); f.tick(10000);
  assert.deepEqual(p.a.life.inventory, saved.inventory); assert.deepEqual(p.home.furniture, saved.furniture); assert.deepEqual(p.a.wardrobe, saved.wardrobe);
});

test('v035 all aquarium rotations have real adjacent stations and moving the tank invalidates the old station', t => {
  const f = fixture(t, 1), [p] = f.players; f.build(p); f.enter(p); const id = f.tank(p);
  let firstFish;
  for (const [rotation, x, y] of [[0, 1, 1], [90, 7, 1], [180, 1, 4], [270, 7, 4]]) {
    if (rotation !== 0) p.ok('home', { intent: 'place', instance_id: id, x, y, rotation });
    assert.equal(p.act('aquarium', { intent: 'inspect', instance_id: id }).error.code, 'AQUARIUM_TOO_FAR');
    const before = { ...p.a.home_presence.position }, opportunity = p.observe().aquarium.opportunities.find(o => o.payload.intent === 'approach'); assert.ok(opportunity);
    p.ok(opportunity.type, opportunity.payload); f.tick(10000); assert.notDeepEqual(p.a.home_presence.position, before);
    const inspected = p.ok('aquarium', { intent: 'inspect', instance_id: id }).aquarium; assert.equal(inspected.nearby, true); assert.equal(inspected.rotation, rotation);
    if (rotation === 0) firstFish = p.ok('aquarium', { intent: 'put', instance_id: id, item_id: 'silver_fish', name: '四向同行' }).fish;
    else assert.deepEqual(inspected.aquarium.fish, [firstFish]);
  }
});

test('v035 real receipt and history projections describe completed lifestyle actions without disclosing private collection or fish names', t => {
  const f = fixture(t, 1), [p] = f.players;
  const receipt = p.input('wardrobe', { intent: 'craft', style_id: 'soft_cap' }), result = f.world.callTool(p.auth, 'act', receipt);
  assert.equal(result.status, 'applied');
  let actor = spectatorSnapshot(f.world).agents.find(a => a.agent_id === p.id);
  assert.deepEqual(actor.action_status, { type: 'wardrobe', status: 'applied', at: f.now() });
  p.ok('wardrobe', { intent: 'dye', garment_id: result.garment.garment_id, color_id: 'sky' });
  p.ok('wardrobe', { intent: 'hairstyle', style_id: 'bob' });
  const wardrobeRecords = f.world.historyPage({ category: 'life' }).items;
  assert.deepEqual(wardrobeRecords.map(e => e.type), ['wardrobe_changed', 'wardrobe_dyed', 'wardrobe_crafted']);
  assert.equal(JSON.stringify(wardrobeRecords).includes(result.garment.garment_id), false);
  const count = f.world.historyPage().items.length; assert.deepEqual(f.world.callTool(p.auth, 'act', receipt), result); assert.equal(f.world.historyPage().items.length, count);
  f.build(p); f.enter(p); const tank = f.tank(p);
  assert.equal(p.act('aquarium', { intent: 'put', instance_id: tank, item_id: 'pond_fish' }).error.code, 'AQUARIUM_TOO_FAR');
  actor = spectatorSnapshot(f.world).agents.find(a => a.agent_id === p.id);
  assert.deepEqual(actor.action_status, { type: 'aquarium', status: 'rejected', at: f.now(), error_code: 'AQUARIUM_TOO_FAR' });
  f.approach(p, tank); const fish = p.ok('aquarium', { intent: 'put', instance_id: tank, item_id: 'pond_fish', name: '不写入事件的鱼名' }).fish;
  const record = f.world.historyPage({ category: 'life' }).items[0]; assert.equal(record.type, 'aquarium_changed'); assert.equal(record.outcome, 'completed');
  assert.equal(record.details.instance_id, tank); assert.equal(record.details.intent, 'put');
  assert.equal(JSON.stringify(record).includes(fish.fish_id), false); assert.equal(JSON.stringify(record).includes(fish.name), false);
  assert.deepEqual(spectatorSnapshot(f.world).agents.find(a => a.agent_id === p.id).action_status, { type: 'aquarium', status: 'applied', at: f.now() });
});
