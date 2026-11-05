// Independent, read-only release check: shared authored terrain is data, not the
// runtime migration implementation. Never print private states in release logs.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { SCENE_IDS, SCENES, WORLD_MAP } from '../shared/world-layout.js';
import { COMMUNITY_VENUES } from '../shared/community.js';
import { PLAZA_LAYOUT_VERSION } from '../shared/plaza-layout.js';

export function expectedScene(agent) {
  if (SCENE_IDS.includes(agent.scene_id)) return agent.scene_id;
  const a = agent.adventure || {}, plan = a.plan;
  return a.in_field === true || plan && (plan.zone_id && plan.zone_id !== 'camp' || plan.monster_id) || a.encounter?.status === 'pending' ? 'adventure' : 'plaza';
}

export function expectedPosition(agent) {
  const scene = expectedScene(agent), definition = SCENES.find(s => s.id === scene), blocked = new Set(definition.blocked.map(p => `${p.x},${p.y}`));
  // Independently verify a saved physical point: a centre or a point on one
  // cardinal edge whose two endpoints are both authored walkable cells.
  const p = agent.position;
  const validCell = (x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < WORLD_MAP.width && y >= 0 && y < WORLD_MAP.height && !blocked.has(`${x},${y}`);
  if (Number.isFinite(p?.x) && Number.isFinite(p?.y) && (Number.isInteger(p.x) || Number.isInteger(p.y)) &&
      validCell(Math.floor(p.x), Math.floor(p.y)) && validCell(Math.ceil(p.x), Math.ceil(p.y))) return { x: p.x, y: p.y };
  // A new service fixture never relocates an existing resident. Independently
  // prove the saved point stood on original authored terrain, not a lake/tree,
  // before allowing a newly introduced table/noticeboard to overlap that point.
  const bodies = new Set(COMMUNITY_VENUES.filter(v => v.scene_id === scene).flatMap(v => v.footprint).map(c => `${c.x},${c.y}`));
  const originalBlocked = new Set(definition.props.flatMap(prop => prop.footprint).map(c => `${c.x},${c.y}`));
  if (scene !== 'plaza' && Number.isFinite(p?.x) && Number.isFinite(p?.y) && (Number.isInteger(p.x) || Number.isInteger(p.y))) {
    const endpoints = [{ x: Math.floor(p.x), y: Math.floor(p.y) }, { x: Math.ceil(p.x), y: Math.ceil(p.y) }];
    if (endpoints.some(c => bodies.has(`${c.x},${c.y}`)) && endpoints.every(c => c.x >= 0 && c.y >= 0 && c.x < WORLD_MAP.width && c.y < WORLD_MAP.height && !originalBlocked.has(`${c.x},${c.y}`)))
      return { x: p.x, y: p.y };
  }
  const clamp = (n, size) => Number.isFinite(n) ? Math.max(0, Math.min(size - 1, Math.floor(n))) : Math.floor(size / 2);
  const origin = { x: clamp(agent.position?.x, WORLD_MAP.width), y: clamp(agent.position?.y, WORLD_MAP.height) };
  let best, bestDistance = Infinity;
  // Ascending rows/columns independently establish the deterministic tie break.
  for (let y = 0; y < WORLD_MAP.height; y++) for (let x = 0; x < WORLD_MAP.width; x++) {
    const distance = Math.abs(x - origin.x) + Math.abs(y - origin.y);
    if (!blocked.has(`${x},${y}`) && distance < bestDistance) { best = { x, y }; bestDistance = distance; }
  }
  assert.ok(best, 'each scene must have a legal cell');
  return best;
}

export function verifyScenes(old, current) {
  assert.deepEqual(Object.keys(current.agents).sort(), Object.keys(old.agents).sort(), 'same residents');
  const restart = current.events?.find(e => e.type === 'server_restarted' && Number(e.cursor) > old.sequence);
  const fresh = (current.events || []).filter(e => Number(e.cursor) > old.sequence);
  const layoutProof = Object.hasOwn(current, 'plaza_layout_version');
  if (layoutProof) assert.equal(current.plaza_layout_version, PLAZA_LAYOUT_VERSION, 'authored layout version required');
  const upgraded = layoutProof && old.plaza_layout_version !== PLAZA_LAYOUT_VERSION;
  const changes = fresh.filter(e => e.type === 'plaza_layout_migrated');
  assert.equal(changes.length, upgraded ? Object.values(old.agents).filter(a => a.scene_id === 'plaza').length : 0, 'one layout record per original plaza resident only');
  let migrated = 0, repaired = 0;
  for (const [id, before] of Object.entries(old.agents)) {
    const after = current.agents[id], scene = expectedScene(before), position = expectedPosition(before);
    assert.equal(after.scene_id, scene, 'scene follows only authoritative saved evidence');
    assert.deepEqual(after.position, position, 'coordinates preserved unless authored terrain requires repair');
    assert.equal(after.movement, null, 'restart cannot replay movement');
    assert.equal(after.action ?? null, null, 'restart cannot replay a pending attack');
    assert.equal(after.hurt ?? null, null, 'restart cannot replay stale hit effects');
    for (const field of ['agent_id', 'name', 'bio', 'avatar', 'color', 'owner_id', 'is_platform']) assert.deepEqual(after[field], before[field], 'identity unchanged');
    if (upgraded && before.scene_id === 'plaza') {
      const record = after.plaza_layout_migration;
      assert.ok(Number.isSafeInteger(record?.at) && record.at >= 0 && restart && record.at <= restart.occurred_at && record.at >= Math.max(0, ...old.events.map(e=>e.occurred_at)), 'layout migration occurs at this restart');
      const repairedPoint = before.position?.x !== position.x || before.position?.y !== position.y;
      const expected = {version:1,from_layout_version:old.plaza_layout_version || 'plaza-pre036',layout_version:PLAZA_LAYOUT_VERSION,
        at:record.at,reason:repairedPoint?'terrain_repair':'position_preserved',from_position:{...before.position},position,
        from_movement_id:typeof before.movement?.movement_id==='string'?before.movement.movement_id:null};
      assert.deepEqual(record,expected,'exact prior point, cancelled route and permitted repair recorded');
      const events=changes.filter(e=>e.payload.agent_id===id); assert.equal(events.length,1);
      const {version,at,...publicRecord}=expected;
      assert.deepEqual(events[0].payload,{agent_id:id,name:before.name,...publicRecord,scene_id:'plaza',text:repairedPoint?
        '广场布局已更新，原位置因新实体占地调整到最近合法格；旧行程已停止，请本人重新决定。':
        '广场布局已更新，原位置保留；旧行程已停止，请本人重新决定。'},'migration cannot invent speech or authorization');
      // Initialization and event publication are distinct wall-clock instants.
      assert.ok(Number.isSafeInteger(events[0].occurred_at) && events[0].occurred_at>=record.at && events[0].occurred_at<=restart.occurred_at,'layout event is published after repair and before restart');
      assert.ok(Number(events[0].cursor)<Number(restart.cursor),'layout record precedes restart');
      assert.deepEqual(after.scene_migration,before.scene_migration,'plaza layout migration preserves older scene history');
      migrated++; if(repairedPoint)repaired++;
      continue;
    }
    assert.deepEqual(after.plaza_layout_migration,before.plaza_layout_migration,'other scenes and repeated restarts keep prior layout history');
    const changed = !SCENE_IDS.includes(before.scene_id) || before.position?.x !== position.x || before.position?.y !== position.y;
    if (!changed) { assert.deepEqual(after.scene_migration, before.scene_migration, 'existing migration record unchanged'); continue; }
    const record = after.scene_migration;
    assert.ok(Number.isSafeInteger(record?.at) && record.at >= 0, 'migration time recorded');
    assert.ok(restart && record.at <= restart.occurred_at && record.at >= Math.max(0, ...old.events.map(e => e.occurred_at)), 'migration took place at restart');
    assert.deepEqual(record, { version: 1, at: record.at,
      reason: SCENE_IDS.includes(before.scene_id) ? 'terrain_repair' : scene === 'adventure' ? 'legacy_adventure' : 'legacy_default_plaza',
      from_scene_id: SCENE_IDS.includes(before.scene_id) ? before.scene_id : null,
      scene_id: scene, from_position: { ...before.position }, position }, 'exact migration evidence retained');
    migrated++;
    if (before.position?.x !== position.x || before.position?.y !== position.y) repaired++;
  }
  assert.ok(!current.events.some(e => Number(e.cursor) > old.sequence && ['scene_changed', 'agent_moved'].includes(e.type)), 'migration must not invent gameplay');
  return { scene_locations_preserved: true, plaza_layout_verified: layoutProof, migrated, repaired };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  let input = ''; for await (const part of process.stdin) input += part;
  try { const { old, new: current } = JSON.parse(input); console.log(JSON.stringify(verifyScenes(old, current))); }
  catch (error) { process.stderr.write(`Scene migration rejected (${error.code || error.name || 'invalid'}).\n`); process.exitCode = 1; }
}
