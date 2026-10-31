import { RESOURCE_NODES } from '../shared/resources-layout.js';
import { publicDayCycle } from './day-cycle.js';

export { RESOURCE_NODES };
export const TREE_RULES = Object.freeze({ stages: ['empty', 'sapling', 'young', 'mature', 'stump'],
  stump_seconds: 60, wild_empty_seconds: 300, sapling_seconds: 180, young_seconds: 420,
  planting: { seed_item_id: 'pine_cone', seed_quantity: 1, duration_seconds: 4, energy_cost: 2 }, felling_bonus: { pine_cone: 1 },
  description: '成熟树每次只砍一段，stock是剩余段数，最后一段另得1松果并成为树桩；树桩60秒变空地，野生林地空300秒自然萌芽，人工空地须本人种植。树苗180秒→幼树420秒→成熟；幼树不可砍。种树须明确选择空地，到达工作4秒，完成扣1松果；不自动种下一棵。离线生长不自动给材料。',
});
export const RESOURCE_RULES = Object.freeze({ version: 2, max_job_seconds: 120, reservation_policy: 'one_worker_per_node', stock_policy: 'global_shared', nodes: RESOURCE_NODES, trees: TREE_RULES,
  description: '同场景具体节点共享有限库存，一次只预约一处，真实走到后工作；树木按生命周期生长，草丛/矿石等按时间补充。砍伐用斧头、采矿用镐，开工耗工具1耐久和体力；取消不退已花成本。完成后不自动续采、换树或种植。' });
const validTime = n => Number.isSafeInteger(n) && n >= 0;
const validId = s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(s);
export const resourceDefinition = id => RESOURCE_NODES.find(n => n.id === id) || null;
const nextFor = (stage, at, def) => ({ stump: at + TREE_RULES.stump_seconds * 1000,
  empty: def.natural_regrowth ? at + TREE_RULES.wild_empty_seconds * 1000 : null,
  sapling: at + TREE_RULES.sapling_seconds * 1000, young: at + TREE_RULES.young_seconds * 1000, mature: null })[stage];
function matureAt(ecology, def) {
  if (!ecology || ecology.next_at === null) return null;
  const remaining = { stump: def.natural_regrowth ? TREE_RULES.wild_empty_seconds + TREE_RULES.sapling_seconds + TREE_RULES.young_seconds : null,
    empty: TREE_RULES.sapling_seconds + TREE_RULES.young_seconds, sapling: TREE_RULES.young_seconds, young: 0, mature: null }[ecology.stage];
  return remaining === null ? null : ecology.next_at + remaining * 1000;
}
function initialTree(old, stock, def, now) {
  const value = old?.ecology;
  if (value && TREE_RULES.stages.includes(value.stage) && validTime(value.stage_started_at) && (value.next_at === null || validTime(value.next_at)) &&
      Number.isSafeInteger(value.generation) && value.generation >= 0 && ['wild', 'planted'].includes(value.origin)) {
    return { stage: value.stage, stage_started_at: value.stage_started_at, next_at: value.next_at, generation: value.generation, origin: value.origin };
  }
  const stage = old ? stock > 0 ? 'mature' : 'stump' : def.initial_stage;
  return { stage, stage_started_at: now, next_at: nextFor(stage, now, def), generation: 0, origin: def.natural_regrowth ? 'wild' : 'planted' };
}
export function initializeResources(state, now, { restore = false } = {}) {
  const before = state.resources, clock = Math.max(now, validTime(before?.last_at) ? before.last_at : now);
  const nodes = Object.fromEntries(RESOURCE_NODES.map(def => {
    const old = before?.nodes?.[def.id];
    let stock = Number.isSafeInteger(old?.stock) && old.stock >= 0 ? Math.min(def.max_stock, old.stock) : def.kind === 'tree' && def.initial_stage === 'empty' ? 0 : def.max_stock;
    const reserved = old?.reservation, ecology = def.kind === 'tree' ? initialTree(old, stock, def, clock) : null;
    if (ecology && ecology.stage !== 'mature') stock = 0;
    return [def.id, { stock, regrow_at: ecology ? matureAt(ecology, def) : stock < def.max_stock ? validTime(old?.regrow_at) ? old.regrow_at : clock + def.regrow_seconds * 1000 : null,
      ...(ecology ? { ecology } : {}),
      reservation: !restore && validId(reserved?.agent_id) && validId(reserved?.job_id) && validTime(reserved?.expires_at) && reserved.expires_at > clock ? { agent_id: reserved.agent_id, job_id: reserved.job_id, expires_at: reserved.expires_at } : null }];
  }));
  state.resources = { version: 2, last_at: clock, nodes };
}
const harvestable = (node, def) => !!node && node.stock > 0 && (def.kind !== 'tree' || node.ecology?.stage === 'mature');
const plantable = (node, def) => !!node && def.kind === 'tree' && node.ecology?.stage === 'empty' && node.stock === 0;
export function publicResources(state, now) {
  const phase = publicDayCycle(state, now).phase;
  return { version: 2, nodes: RESOURCE_NODES.map(def => {
    const node = state.resources?.nodes?.[def.id], r = node?.reservation;
    const reservation = validId(r?.agent_id) && validId(r?.job_id) && validTime(r?.expires_at) && r.expires_at > now ? { agent_id: r.agent_id, job_id: r.job_id, expires_at: r.expires_at } : null;
    const stock = Number.isSafeInteger(node?.stock) && node.stock >= 0 ? Math.min(def.max_stock, node.stock) : 0, e = node?.ecology;
    const ecology = def.kind === 'tree' ? { stage: TREE_RULES.stages.includes(e?.stage) ? e.stage : 'empty',
      stage_started_at: validTime(e?.stage_started_at) ? e.stage_started_at : null, next_at: validTime(e?.next_at) ? e.next_at : null,
      generation: Number.isSafeInteger(e?.generation) && e.generation >= 0 ? e.generation : 0, origin: e?.origin === 'wild' ? 'wild' : 'planted' } : null;
    return { ...structuredClone(def), stock, regrow_at: validTime(node?.regrow_at) ? node.regrow_at : null, reservation,
      ...(ecology ? { ecology } : {}), plantable: plantable(node, def) && !reservation,
      available: harvestable(node, def) && !reservation && def.available_phases.includes(phase) };
  }) };
}
export function reserveResource(world, a, nodeId, jobId, expiresAt, fail, intent = 'harvest') {
  if (!world.state.resources) initializeResources(world.state, world.now());
  const def = resourceDefinition(nodeId), node = world.state.resources.nodes[nodeId];
  if (!def || !node) fail('INVALID_ACTION', '未知资源点');
  if (!def.available_phases.includes(publicDayCycle(world.state, world.now()).phase)) fail('RESOURCE_PHASE', '这个资源点当前时段不可采集，请观察昼夜状态后自主选择');
  if (node.reservation && node.reservation.expires_at > world.now()) fail('RESOURCE_BUSY', '另一项工作已预约这处资源，请等待或自行选择其他节点');
  if (intent === 'plant' ? !plantable(node, def) : !harvestable(node, def)) fail(intent === 'plant' ? 'NOT_PLANTABLE' : 'RESOURCE_DEPLETED', intent === 'plant' ? '只能在公开的空林地种树' : '资源未成熟或已耗尽，请等待生长或自行选择其他事情', { regrow_at: node.regrow_at });
  node.reservation = { agent_id: a.agent_id, job_id: jobId, expires_at: expiresAt };
}
export function ownsResource(world, a, job) {
  const r = world.state.resources?.nodes?.[job.node_id]?.reservation;
  return r?.agent_id === a.agent_id && r.job_id === job.job_id && r.expires_at > world.now();
}
export function resourceWorkAvailable(world, a, job) {
  const node = world.state.resources?.nodes?.[job.node_id], def = resourceDefinition(job.node_id);
  return !!def && ownsResource(world, a, job) && (job.intent === 'plant' ? plantable(node, def) : harvestable(node, def));
}
export function releaseResource(world, job) {
  const node = world.state.resources?.nodes?.[job.node_id];
  if (node?.reservation?.job_id === job.job_id) { node.reservation = null; return true; }
  return false;
}
export function resourceHarvestItems(state, nodeId) {
  const def = resourceDefinition(nodeId), node = state.resources?.nodes?.[nodeId];
  if (!def || !harvestable(node, def)) return null;
  return { [def.item_id]: def.yield_count, ...(def.kind === 'tree' && node.stock === 1 ? TREE_RULES.felling_bonus : {}) };
}
function changeStage(node, def, stage, at, origin = node.ecology.origin) {
  node.ecology = { stage, stage_started_at: at, next_at: nextFor(stage, at, def),
    generation: node.ecology.generation + (stage === 'sapling' ? 1 : 0), origin };
  node.stock = stage === 'mature' ? def.max_stock : 0; node.regrow_at = matureAt(node.ecology, def);
}
function announceStage(world, def, node) {
  world.event('resource_stage_changed', { node_id: def.id, scene_id: def.scene_id, ...node.ecology, stock: node.stock,
    text: `${def.name}进入${{ empty: '空地', sapling: '树苗', young: '幼树', mature: '成熟', stump: '树桩' }[node.ecology.stage]}阶段` }, world.activeIds());
}
export function consumeResource(world, a, job) {
  const node = world.state.resources?.nodes?.[job.node_id], def = resourceDefinition(job.node_id);
  if (job.intent === 'plant' || !resourceWorkAvailable(world, a, job)) return false;
  node.stock--; node.reservation = null;
  if (def.kind === 'tree') {
    if (!node.stock) { changeStage(node, def, 'stump', Math.max(world.now(), world.state.resources.last_at)); announceStage(world, def, node); }
  } else node.regrow_at ??= Math.max(world.now(), world.state.resources.last_at) + def.regrow_seconds * 1000;
  return true;
}
export function plantResource(world, a, job) {
  const node = world.state.resources?.nodes?.[job.node_id], def = resourceDefinition(job.node_id);
  if (job.intent !== 'plant' || !resourceWorkAvailable(world, a, job)) return false;
  changeStage(node, def, 'sapling', Math.max(world.now(), world.state.resources.last_at), 'planted'); node.reservation = null;
  announceStage(world, def, node); return true;
}
export function tickResources(world) {
  if (!world.state.resources) initializeResources(world.state, world.now());
  const now = Math.max(world.now(), world.state.resources.last_at); world.state.resources.last_at = now;
  let changed = false;
  for (const def of RESOURCE_NODES) {
    const node = world.state.resources.nodes[def.id];
    if (!node) continue; // A missing target cannot reappear and award free stock.
    if (node.reservation && node.reservation.expires_at <= now) { node.reservation = null; changed = true; }
    if (def.kind === 'tree') {
      let advanced = false;
      // At most four phases lead to maturity. A planting reservation holds
      // natural germination until that explicit work finishes or is cancelled.
      for (let i = 0; i < 4 && node.ecology?.next_at !== null && node.ecology?.next_at <= now; i++) {
        if (node.reservation) break;
        const before = node.ecology.stage, next = { stump: 'empty', empty: 'sapling', sapling: 'young', young: 'mature' }[before];
        if (!next) break;
        changeStage(node, def, next, node.ecology.next_at, before === 'empty' ? 'wild' : node.ecology.origin); advanced = true;
      }
      if (advanced) { announceStage(world, def, node); changed = true; }
      continue;
    }
    if (node.stock < def.max_stock && node.regrow_at !== null && node.regrow_at <= now) {
      const units = Math.min(def.max_stock - node.stock, 1 + Math.floor((now - node.regrow_at) / (def.regrow_seconds * 1000)));
      node.stock += units; node.regrow_at = node.stock < def.max_stock ? node.regrow_at + units * def.regrow_seconds * 1000 : null;
      world.event('resource_regrown', { node_id: def.id, scene_id: def.scene_id, stock: node.stock, text: `${def.name}补充了${units}份可采资源` }, world.activeIds()); changed = true;
    }
  }
  return { changed, durable: changed };
}
