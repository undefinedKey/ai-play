import { RESOURCE_NODES } from '../shared/resources-layout.js';
import { publicDayCycle } from './day-cycle.js';

export { RESOURCE_NODES };
export const RESOURCE_RULES = Object.freeze({ version: 1, max_job_seconds: 120, reservation_policy: 'one_worker_per_node', stock_policy: 'global_shared', nodes: RESOURCE_NODES,
  description: '具体资源点共享有限库存，一次只预约一处、只采一次；同场景内真实走到交互格后开工。树木需要斧头、矿脉需要镐；营地枯枝和碎石可徒手。取消或中断释放预约，已开始工作的体力和工具耐久不退；枯竭后按各节点时间补充库存。' });
const validTime = n => Number.isSafeInteger(n) && n >= 0;
const validId = s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(s);
export const resourceDefinition = id => RESOURCE_NODES.find(n => n.id === id) || null;
export function initializeResources(state, now, { restore = false } = {}) {
  const before = state.resources;
  const nodes = Object.fromEntries(RESOURCE_NODES.map(def => {
    const old = before?.nodes?.[def.id];
    const stock = Number.isSafeInteger(old?.stock) && old.stock >= 0 ? Math.min(def.max_stock, old.stock) : def.max_stock;
    const reserved = old?.reservation;
    return [def.id, { stock, regrow_at: stock < def.max_stock ? validTime(old?.regrow_at) ? old.regrow_at : now + def.regrow_seconds * 1000 : null,
      reservation: !restore && validId(reserved?.agent_id) && validId(reserved?.job_id) && validTime(reserved?.expires_at) && reserved.expires_at > now ? { agent_id: reserved.agent_id, job_id: reserved.job_id, expires_at: reserved.expires_at } : null }];
  }));
  state.resources = { version: 1, last_at: Math.max(now, validTime(before?.last_at) ? before.last_at : now), nodes };
}
export function publicResources(state, now) {
  const phase = publicDayCycle(state, now).phase;
  return { version: 1, nodes: RESOURCE_NODES.map(def => {
    const node = state.resources?.nodes?.[def.id], r = node?.reservation;
    const reservation = validId(r?.agent_id) && validId(r?.job_id) && validTime(r?.expires_at) && r.expires_at > now ? { agent_id: r.agent_id, job_id: r.job_id, expires_at: r.expires_at } : null;
    const stock = Number.isSafeInteger(node?.stock) && node.stock >= 0 ? Math.min(def.max_stock, node.stock) : 0;
    return { ...structuredClone(def), stock, regrow_at: validTime(node?.regrow_at) ? node.regrow_at : null, reservation, available: stock > 0 && !reservation && def.available_phases.includes(phase) };
  }) };
}
export function reserveResource(world, a, nodeId, jobId, expiresAt, fail) {
  if (!world.state.resources) initializeResources(world.state, world.now());
  const def = resourceDefinition(nodeId), node = world.state.resources.nodes[nodeId];
  if (!def || !node) fail('INVALID_ACTION', '未知资源点');
  if (!def.available_phases.includes(publicDayCycle(world.state, world.now()).phase)) fail('RESOURCE_PHASE', '这个资源点当前时段不可采集，请观察昼夜状态后自主选择');
  if (node.reservation && node.reservation.expires_at > world.now()) fail('RESOURCE_BUSY', '另一项工作已预约这处资源，请等待或自行选择其他节点');
  if (node.stock < 1) fail('RESOURCE_DEPLETED', '这处共享资源已耗尽，请等待再生或自行选择其他事情', { regrow_at: node.regrow_at });
  node.reservation = { agent_id: a.agent_id, job_id: jobId, expires_at: expiresAt };
}
export function ownsResource(world, a, job) {
  const r = world.state.resources?.nodes?.[job.node_id]?.reservation;
  return r?.agent_id === a.agent_id && r.job_id === job.job_id && r.expires_at > world.now();
}
export function releaseResource(world, job) {
  const node = world.state.resources?.nodes?.[job.node_id];
  if (node?.reservation?.job_id === job.job_id) { node.reservation = null; return true; }
  return false;
}
export function consumeResource(world, a, job) {
  const node = world.state.resources?.nodes?.[job.node_id], def = resourceDefinition(job.node_id);
  if (!def || !ownsResource(world, a, job) || node.stock < 1) return false;
  node.stock--; node.reservation = null;
  node.regrow_at ??= Math.max(world.now(), world.state.resources.last_at) + def.regrow_seconds * 1000;
  return true;
}
export function tickResources(world) {
  if (!world.state.resources) initializeResources(world.state, world.now());
  const now = Math.max(world.now(), world.state.resources.last_at); world.state.resources.last_at = now;
  let changed = false;
  for (const def of RESOURCE_NODES) {
    const node = world.state.resources.nodes[def.id];
    // A missing runtime target cannot produce free replacement stock or keep a
    // reservation alive; its worker is cancelled by the normal life tick.
    if (!node) continue;
    if (node.reservation && node.reservation.expires_at <= now) { node.reservation = null; changed = true; }
    if (node.stock < def.max_stock && node.regrow_at !== null && node.regrow_at <= now) {
      const units = Math.min(def.max_stock - node.stock, 1 + Math.floor((now - node.regrow_at) / (def.regrow_seconds * 1000)));
      node.stock += units; node.regrow_at = node.stock < def.max_stock ? node.regrow_at + units * def.regrow_seconds * 1000 : null;
      world.event('resource_regrown', { node_id: def.id, scene_id: def.scene_id, stock: node.stock, text: `${def.name}补充了${units}份可采资源` }, world.activeIds()); changed = true;
    }
  }
  return { changed, durable: changed };
}
