import { randomUUID } from 'node:crypto';
import { RUINS_RULES as LAYOUT } from '../shared/ruins-layout.js';
import { adjustInventory } from './life.js';
import { findWorldPath, recordMovement, stopMovement } from './spatial.js';
import { spendEnergy } from './fatigue.js';
import { leaveAdventureField } from './adventure.js';

const SYMBOL_NAMES = { leaf: '树叶', sun: '太阳', moon: '月亮' };
const SYMBOLS = LAYOUT.rune_symbols.map(id => ({ id, name: SYMBOL_NAMES[id] || id }));
const COMBINATION = ['moon', 'leaf', 'sun'];
export const RUINS_RULES = Object.freeze({ ...LAYOUT, max_job_seconds: 120,
  notice: '须实际走到入口进入遗迹。approach只前往交互位置，不会自动拾取、开门、修桥或解谜。正门消耗1把古铜钥匙永久打开；侧桥开始修理时消耗4木材、1矿石及2体力，连续12秒完工后永久通行，中断不退消耗、不发奖励。符文盘逐个转动，由本人选择提交；遗物每件全世界仅1份，拾取后可带回小屋展示，不自动领奖或重生。',
});
const objectFor = id => RUINS_RULES.objects.find(o => o.id === id);
const samePoint = (a, b) => !!a && !!b && Math.abs(a.x - b.x) + Math.abs(a.y - b.y) < 1e-8;
const permitted = (world, a) => world.state.room.status === 'active' && a.status === 'active' && a.run?.status === 'active' && a.run.expires_at > world.now() && (a.last_contact_at ?? -45000) + 45000 > world.now();
const localFail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const SHARED_EVENTS = new Set(['ruins_claimed', 'ruins_gate_opened', 'ruins_repair_started', 'ruins_bridge_repaired', 'ruins_dial_turned', 'ruins_runes_submitted']);
const emit = (world, a, type, fields = {}) => world.event(type, { agent_id: a.agent_id, name: a.name, scene_id: a.scene_id, ...fields },
  SHARED_EVENTS.has(type) ? [...new Set([a.agent_id, ...Object.values(world.state.agents).filter(other => other.status === 'active' && other.scene_id === 'ruins' && !other.home_presence).map(other => other.agent_id)])] : [a.agent_id]);
const claimed = (world, id) => world.state.ruins.claims[id] || null;
const repairer = world => Object.values(world.state.agents).find(a => a.ruins_job?.phase === 'repairing') || null;
const collectibles = () => RUINS_RULES.objects.filter(o => ['key', 'relic'].includes(o.kind));
const claimView = (world, o) => ({ ...structuredClone(o), claimed_by: claimed(world, o.id)?.agent_id || null, claimed_at: claimed(world, o.id)?.at ?? null });

/** Durable world facts survive restart; no unfinished intention is resumed. */
export function initializeRuins(world, { restore = false } = {}) {
  const old = world.state.ruins || {}, claims = {};
  for (const o of collectibles()) {
    const c = old.claims?.[o.id];
    if (c && typeof c.agent_id === 'string' && Number.isSafeInteger(c.at) && c.at >= 0) claims[o.id] = { agent_id: c.agent_id, at: c.at };
  }
  const attempt = old.last_attempt;
  world.state.ruins = { version: 1, gate_open: old.gate_open === true, bridge_repaired: old.bridge_repaired === true, archive_open: old.archive_open === true,
    dials: [0, 1, 2].map(i => Number.isInteger(old.dials?.[i]) && old.dials[i] >= 0 && old.dials[i] < SYMBOLS.length ? old.dials[i] : 0), claims,
    last_attempt: attempt && typeof attempt.agent_id === 'string' && Number.isSafeInteger(attempt.at) && attempt.at >= 0 && typeof attempt.success === 'boolean' ? { agent_id: attempt.agent_id, at: attempt.at, success: attempt.success } : null };
  for (const a of Object.values(world.state.agents)) {
    if (restore && a.ruins_job?.movement_id === a.movement?.movement_id && a.movement) stopMovement(a, world.now());
    if (restore || a.ruins_job === undefined) a.ruins_job = null;
  }
}

export function publicRuinsJob(a) {
  const j = a.ruins_job;
  return j ? { job_id: j.job_id, intent: j.intent, scene_id: j.scene_id, phase: j.phase, object_id: j.object_id,
    interaction_position: { ...j.interaction_position }, started_at: j.started_at, ends_at: j.ends_at, expires_at: j.expires_at } : null;
}

export function publicRuins(world) {
  const s = world.state.ruins, worker = repairer(world), j = worker?.ruins_job;
  const bridgeJob = j ? { agent_id: worker.agent_id, started_at: j.started_at, ends_at: j.ends_at, progress: Math.max(0, Math.min(1, (world.now() - j.started_at) / (j.ends_at - j.started_at))) } : null;
  const key = RUINS_RULES.objects.find(o => o.kind === 'key');
  return { version: 1, scene_id: 'ruins', entrance: structuredClone(RUINS_RULES.entrance), exit: structuredClone(RUINS_RULES.exit),
    gate: { ...structuredClone(objectFor('main_gate')), open: s.gate_open },
    bridge: { ...structuredClone(objectFor('broken_bridge')), repaired: s.bridge_repaired, job: bridgeJob },
    runes: { ...structuredClone(RUINS_RULES.runes), orientations: s.dials.map(i => SYMBOLS[i].id), symbols: structuredClone(SYMBOLS), clue: RUINS_RULES.clue, solved: s.archive_open, last_attempt: s.last_attempt ? { ...s.last_attempt } : null },
    key: key ? claimView(world, key) : null, relics: collectibles().filter(o => o.kind === 'relic').map(o => claimView(world, o)),
    objects: RUINS_RULES.objects.map(o => ({ ...structuredClone(o),
      ...(o.kind === 'dial' ? { orientation: SYMBOLS[s.dials[o.dial_index]].id } : {}),
      ...(['key', 'relic'].includes(o.kind) ? { claimed_by: claimed(world, o.id)?.agent_id || null, claimed_at: claimed(world, o.id)?.at ?? null } : {}),
      ...(o.id === 'main_gate' ? { open: s.gate_open } : {}), ...(o.id === 'broken_bridge' ? { repaired: s.bridge_repaired, job: bridgeJob } : {}),
      ...(o.id === 'archive_gate' ? { open: s.archive_open } : {}) })) };
}

function idle(world, a, fail) {
  if (!permitted(world, a)) fail('STALE_SESSION', '当前没有活动许可');
  if (a.home_presence || a.home_travel) fail('SCENE_REQUIRED', '须本人在室外场景');
  if (a.ruins_job || a.movement || a.activity || a.adventure?.plan || a.life?.gathering || a.survival?.travel || a.fishing || a.adventure?.encounter?.status === 'pending' || world.state.game?.status !== 'finished' && world.state.game?.participants?.includes(a.agent_id)) fail('ACTIVITY_BUSY', '先自行结束当前活动、游戏或行程');
}
function atObject(world, a, object, fail) {
  idle(world, a, fail);
  if (!object) fail('INVALID_ACTION', '请选择遗迹中的实际object_id');
  if (a.scene_id !== 'ruins') fail('SCENE_REQUIRED', '须本人进入遗迹');
  if (!samePoint(a.position, object.interaction_position)) fail('OUT_OF_RANGE', '须实际走到该物件的交互位置，可自行选择approach');
}
function pathTo(world, a, target, mode, fail) {
  idle(world, a, fail);
  if (mode === 'run' && a.fatigue.energy <= 0) fail('FATIGUE_EXHAUSTED', '体力不足以奔跑，仍可选择步行');
  const path = findWorldPath(world, a.scene_id, a.position, target);
  if (!path) fail('UNREACHABLE', '道路未接通，当前不能走到该交互位置');
  return path;
}
function claimAvailable(world, a, o, fail) {
  atObject(world, a, o, fail);
  if (!['key', 'relic'].includes(o.kind)) fail('INVALID_ACTION', '该物件不可拾取');
  if (claimed(world, o.id)) fail('RUINS_ALREADY_CLAIMED', '此物件已被领取，全世界只有这一份');
  if (!Number.isSafeInteger((a.life.inventory[o.item_id] || 0) + 1)) fail('INVENTORY_FULL', '此物品仓库数量已达上限');
}
function unlockAvailable(world, a, o, fail) {
  atObject(world, a, o, fail);
  if (o.id !== 'main_gate') fail('INVALID_ACTION', '古铜钥匙只能打开正门');
  if (world.state.ruins.gate_open) fail('RUINS_ALREADY_OPEN', '正门已经永久打开');
  if (!(a.life.inventory[RUINS_RULES.key_item_id] > 0)) fail('INSUFFICIENT_ITEMS', '打开正门需要自己持有1把古铜钥匙');
}
function repairAvailable(world, a, o, fail) {
  atObject(world, a, o, fail);
  if (o.id !== 'broken_bridge') fail('INVALID_ACTION', '请选择侧边断桥');
  if (world.state.ruins.bridge_repaired) fail('RUINS_ALREADY_OPEN', '侧桥已经修好');
  if (repairer(world)) fail('RUINS_OCCUPIED', '当前已有角色正在修桥');
  if (Object.entries(RUINS_RULES.bridge_cost).some(([id, n]) => (a.life.inventory[id] || 0) < n)) fail('INSUFFICIENT_ITEMS', '修桥需要4木材和1矿石');
  if (a.fatigue.energy < RUINS_RULES.repair_energy) fail('FATIGUE_EXHAUSTED', '本次修桥需要2体力');
  if (world.now() + RUINS_RULES.repair_seconds * 1000 >= a.run.expires_at) fail('INSUFFICIENT_TIME', '本次授权剩余时间不足以完成12秒修桥');
}
function runeAvailable(world, a, o, submit, fail) {
  atObject(world, a, o, fail);
  if (submit ? o.id !== RUINS_RULES.runes.id : o.kind !== 'dial') fail('INVALID_ACTION', submit ? '须在符文检验台提交符文组合' : '须选择一座符文盘');
  if (world.state.ruins.archive_open) fail('RUINS_ALREADY_OPEN', '内室门已经永久打开，无需继续调整');
}

export function cancelRuins(world, a, reason = 'cancelled') {
  const j = a.ruins_job; if (!j) return false;
  if (a.movement?.movement_id === j.movement_id) stopMovement(a, world.now());
  a.ruins_job = null;
  emit(world, a, 'ruins_cancelled', { job_id: j.job_id, object_id: j.object_id, intent: j.intent, reason, text: `${a.name}结束了本次遗迹行动，已发生的消耗保留，下一步由本人决定` });
  return true;
}
function job(world, a, intent, objectId, target, mode, path) {
  const now = world.now();
  recordMovement(a, path, now, mode);
  a.ruins_job = { job_id: `ruins_${randomUUID()}`, intent, object_id: objectId, scene_id: a.scene_id, interaction_position: { ...target },
    phase: 'approaching', started_at: now, ends_at: null, expires_at: Math.min(now + RUINS_RULES.max_job_seconds * 1000, a.run.expires_at),
    movement_id: a.movement?.movement_id || null, run_id: a.run.run_id, session_epoch: a.session_epoch, hp_at_start: a.adventure.hp, hurt_id_at_start: a.hurt?.action_id || null };
  emit(world, a, 'ruins_approaching', { ...publicRuinsJob(a), text: `${a.name}开始${intent === 'enter' ? '前往遗迹入口' : intent === 'leave' ? '前往遗迹出口' : '前往遗迹物件'}` });
  if (!a.movement) arrive(world, a);
}
function arrive(world, a) {
  const j = a.ruins_job;
  if (!samePoint(a.position, j.interaction_position) || a.movement) return cancelRuins(world, a, 'stopped');
  a.ruins_job = null;
  if (j.intent === 'enter' || j.intent === 'leave') {
    const entering = j.intent === 'enter', destination = entering ? RUINS_RULES.exit : RUINS_RULES.entrance;
    if (a.next_action_id) a.scene_stale_actions = [...(a.scene_stale_actions || []), a.next_action_id].slice(-8);
    a.next_action_id = `act_${randomUUID()}`;
    a.scene_id = destination.scene_id; a.position = { ...destination.position }; a.position_at = world.now(); a.movement = null; a.action = null; a.facing = entering ? 'north' : 'south';
    leaveAdventureField(world, a);
    if (!entering) a.adventure.in_field = true;
    emit(world, a, entering ? 'ruins_entered' : 'ruins_left', { job_id: j.job_id, from_scene_id: j.scene_id, position: { ...a.position }, text: `${a.name}${entering ? '步行进入遗迹前庭' : '走出遗迹，回到冒险地图'}` });
  } else emit(world, a, 'ruins_arrived', { job_id: j.job_id, object_id: j.object_id, position: { ...a.position }, text: `${a.name}走到了${objectFor(j.object_id)?.name || '物件'}旁，是否操作由本人决定` });
  return true;
}

const FIELDS = { enter: ['mode'], leave: ['mode'], approach: ['object_id', 'mode'], claim: ['object_id'], unlock: ['object_id'], repair: ['object_id'], turn: ['object_id', 'direction'], submit: ['object_id'], cancel: [] };
function validate(p, fail) {
  if (!p || typeof p !== 'object' || Array.isArray(p) || !Object.hasOwn(FIELDS, p.intent) || Object.keys(p).some(k => k !== 'intent' && !FIELDS[p.intent].includes(k))) fail('INVALID_ACTION', '遗迹动作参数无效');
  if (FIELDS[p.intent].includes('object_id') && (typeof p.object_id !== 'string' || !objectFor(p.object_id))) fail('INVALID_ACTION', '须选择实际object_id');
  if (p.mode !== undefined && !['walk', 'run'].includes(p.mode)) fail('INVALID_ACTION', 'mode只能选择walk或run');
  if (p.intent === 'turn' && !['next', 'previous'].includes(p.direction)) fail('INVALID_ACTION', 'direction只能选择next或previous');
}
export function performRuins(world, a, p, fail) {
  validate(p, fail); const o = objectFor(p.object_id), s = world.state.ruins;
  if (p.intent === 'cancel') {
    if (!a.ruins_job) fail('NO_RUINS_JOB', '当前没有进行中的遗迹行动');
    cancelRuins(world, a);
  } else if (['enter', 'leave', 'approach'].includes(p.intent)) {
    const source = p.intent === 'enter' ? RUINS_RULES.entrance : RUINS_RULES.exit;
    if (a.scene_id !== source.scene_id) fail('SCENE_REQUIRED', p.intent === 'enter' ? '须本人先进入冒险地图，再前往遗迹入口' : '须本人在遗迹中');
    const target = p.intent === 'approach' ? o.interaction_position : source.position;
    const path = pathTo(world, a, target, p.mode, fail);
    job(world, a, p.intent, p.object_id || (p.intent === 'enter' ? 'ruins_entrance' : 'ruins_exit'), target, p.mode, path);
  } else if (p.intent === 'claim') {
    claimAvailable(world, a, o, fail); adjustInventory(a, { [o.item_id]: 1 }, fail);
    s.claims[o.id] = { agent_id: a.agent_id, at: world.now() };
    emit(world, a, 'ruins_claimed', { object_id: o.id, item_id: o.item_id, quantity: 1, text: `${a.name}拾取了${o.name}，这件物品已进入自己的仓库` });
  } else if (p.intent === 'unlock') {
    unlockAvailable(world, a, o, fail); adjustInventory(a, { [RUINS_RULES.key_item_id]: -1 }, fail); s.gate_open = true;
    emit(world, a, 'ruins_gate_opened', { object_id: o.id, item_id: RUINS_RULES.key_item_id, text: `${a.name}用古铜钥匙打开了遗迹正门，所有来访者均可通行` });
  } else if (p.intent === 'repair') {
    repairAvailable(world, a, o, fail);
    if (!spendEnergy(world, a, 'repair')) fail('FATIGUE_EXHAUSTED', '本次修桥需要2体力');
    adjustInventory(a, Object.fromEntries(Object.entries(RUINS_RULES.bridge_cost).map(([id, n]) => [id, -n])), fail);
    const now = world.now();
    a.ruins_job = { job_id: `ruins_${randomUUID()}`, intent: 'repair', object_id: o.id, scene_id: 'ruins', interaction_position: { ...o.interaction_position }, phase: 'repairing', started_at: now,
      ends_at: now + RUINS_RULES.repair_seconds * 1000, expires_at: Math.min(now + RUINS_RULES.max_job_seconds * 1000, a.run.expires_at), movement_id: null,
      run_id: a.run.run_id, session_epoch: a.session_epoch, hp_at_start: a.adventure.hp, hurt_id_at_start: a.hurt?.action_id || null };
    emit(world, a, 'ruins_repair_started', { ...publicRuinsJob(a), text: `${a.name}花费4木材、1矿石和2体力，开始修复侧桥` });
  } else if (p.intent === 'turn') {
    runeAvailable(world, a, o, false, fail); s.dials[o.dial_index] = (s.dials[o.dial_index] + (p.direction === 'next' ? 1 : SYMBOLS.length - 1)) % SYMBOLS.length;
    emit(world, a, 'ruins_dial_turned', { object_id: o.id, dial_index: o.dial_index, orientation: SYMBOLS[s.dials[o.dial_index]].id, text: `${a.name}把${o.name}转向了${SYMBOLS[s.dials[o.dial_index]].name}` });
  } else {
    runeAvailable(world, a, o, true, fail); const success = s.dials.every((value, i) => SYMBOLS[value].id === COMBINATION[i]);
    s.last_attempt = { agent_id: a.agent_id, at: world.now(), success }; if (success) s.archive_open = true;
    emit(world, a, 'ruins_runes_submitted', { object_id: o.id, success, orientations: s.dials.map(i => SYMBOLS[i].id), text: success ? `${a.name}提交的符文组合使内室门打开了` : `${a.name}提交的符文组合没有使内室门打开，石盘保持原位` });
  }
  return { ruins: publicRuins(world), ruins_job: publicRuinsJob(a) };
}

export function tickRuins(world, survivalFrames = new Map()) {
  let changed = false;
  for (const a of Object.values(world.state.agents)) {
    const j = a.ruins_job; if (!j) continue; const now = world.now();
    const reason = !permitted(world, a) || j.run_id !== a.run?.run_id || j.session_epoch !== a.session_epoch ? 'permission_ended'
      : a.scene_id !== j.scene_id || a.home_presence ? 'moved'
      : a.adventure.hp < j.hp_at_start || a.hurt && a.hurt.action_id !== j.hurt_id_at_start || (survivalFrames.get(a.agent_id)?.stop_at ?? Infinity) <= now ? 'hurt'
      : a.movement && a.movement.movement_id !== j.movement_id ? 'replaced'
      : now >= j.expires_at ? 'expired' : null;
    if (reason) { changed = cancelRuins(world, a, reason) || changed; continue; }
    if (j.phase === 'repairing' && (!samePoint(a.position, j.interaction_position) || a.movement)) changed = cancelRuins(world, a, 'moved') || changed;
    else if (j.phase === 'repairing' && now >= j.ends_at) {
      if (world.state.ruins.bridge_repaired) { changed = cancelRuins(world, a, 'already_repaired') || changed; continue; }
      world.state.ruins.bridge_repaired = true; a.ruins_job = null;
      emit(world, a, 'ruins_bridge_repaired', { job_id: j.job_id, object_id: j.object_id, text: `${a.name}修好了遗迹侧桥，所有来访者均可通过` }); changed = true;
    } else if (j.phase === 'approaching' && !a.movement) changed = arrive(world, a) || changed;
  }
  return changed;
}

export function ruinsObservation(world, a) {
  const opportunities = [], add = payload => opportunities.push({ type: 'ruins', payload });
  const offer = (payload, check) => { try { check(); add(payload); } catch { /* Facts only: expose executable choices without ranking or solving. */ } };
  if (permitted(world, a)) {
    if (a.ruins_job) add({ intent: 'cancel' });
    else if (a.scene_id === 'adventure') offer({ intent: 'enter' }, () => pathTo(world, a, RUINS_RULES.entrance.position, 'walk', localFail));
    else if (a.scene_id === 'ruins') {
      offer({ intent: 'leave' }, () => pathTo(world, a, RUINS_RULES.exit.position, 'walk', localFail));
      for (const o of RUINS_RULES.objects) {
        if (!samePoint(a.position, o.interaction_position)) offer({ intent: 'approach', object_id: o.id }, () => pathTo(world, a, o.interaction_position, 'walk', localFail));
        if (['key', 'relic'].includes(o.kind)) offer({ intent: 'claim', object_id: o.id }, () => claimAvailable(world, a, o, localFail));
        if (o.id === 'main_gate') offer({ intent: 'unlock', object_id: o.id }, () => unlockAvailable(world, a, o, localFail));
        if (o.id === 'broken_bridge') offer({ intent: 'repair', object_id: o.id }, () => repairAvailable(world, a, o, localFail));
        if (o.kind === 'dial') for (const direction of ['next', 'previous']) offer({ intent: 'turn', object_id: o.id, direction }, () => runeAvailable(world, a, o, false, localFail));
        if (o.id === RUINS_RULES.runes.id) offer({ intent: 'submit', object_id: o.id }, () => runeAvailable(world, a, o, true, localFail));
      }
    }
  }
  return { ...publicRuins(world), opportunities };
}
