import { randomUUID } from 'node:crypto';
import { LIFE_RULES, adjustInventory, campAvailable } from './life.js';
import { economyBalance, recordEconomyDelta } from './economy.js';
import { FATIGUE_RULES, publicFatigue, spendEnergy } from './fatigue.js';
import { progressPersonalGoal } from './personal-goals.js';

export const COOPERATION_RULES = {
  version: '0.15.0', invitation_seconds: 150, proposal_cooldown_seconds: 60,
  min_duration_seconds: 300, max_duration_seconds: 1800, default_duration_seconds: 900,
  max_members: 2, max_incoming: 2, max_ongoing: 5, max_terminal: 20, max_pending_returns_per_agent: 1,
  templates: [
    { template_id: 'camp_meal', name: '共同备餐', description: '供菜者交菜，厨师明确烹饪，双方各得一碗浓汤。',
      roles: [{ role_id: 'supplier', name: '供菜者', description: '在营地自愿提交自己仓库中的四个萝卜。' }, { role_id: 'cook', name: '厨师', description: '双方在营地时，自愿消耗四点体力烹饪一批浓汤。' }],
      steps: [{ step_id: 'supply', role_id: 'supplier', target_count: 4, description: '明确交四个萝卜到本次托管。' }, { step_id: 'cook', role_id: 'cook', target_count: 1, description: '一次烹饪两碗汤，双方各一碗。' }],
      terms: '供菜者自愿交4萝卜；厨师另行决定消耗本人4体力，双方各得1浓汤。接受不自动交菜或烹饪。退出/到期退还未用原菜；容量满可稍后本人领取。' },
    { template_id: 'scout_and_guard', name: '林地巡查', description: '侦察员先处理森林发现，护卫随后自行击败一只森林怪物。',
      roles: [{ role_id: 'scout', name: '侦察员', description: '合作成立后发现并明确处理森林探索事件，拒绝不计进度。' }, { role_id: 'guard', name: '护卫', description: '侦察完成后，自行取得森林怪物的有效击杀战利品。' }],
      steps: [{ step_id: 'scout', role_id: 'scout', target_count: 1, description: '先处理新发现的森林事件。' }, { step_id: 'guard', role_id: 'guard', target_count: 1, description: '随后实际参与击败森林怪物。' }],
      terms: '先处理成立后新森林发现（非decline），护卫再自行击杀森林怪。行动与费用各自选择；仅实际参战者获原战利品，无额外奖励。' },
  ],
  examples: [{ intent: 'propose', template_id: 'camp_meal', target_agent_id: '观察到的角色ID', role_id: 'supplier' },
    { intent: 'respond', cooperation_id: '邀约ID', revision: 1, accept: true, role_id: 'cook' },
    { intent: 'respond', cooperation_id: '邀约ID', revision: 1, accept: false }, { intent: 'leave', cooperation_id: '本人约定ID' }],
};
const ongoing = p => ['proposed', 'active', 'needs_review'].includes(p.status);
const template = id => COOPERATION_RULES.templates.find(t => t.template_id === id);
const members = p => p.members || [];
const member = (p, id) => members(p).find(m => m.agent_id === id);
const records = world => Object.values(world.state.cooperations || {});
const current = (world, id) => records(world).find(p => ongoing(p) && member(p, id));
const time = value => Number.isSafeInteger(value) && value >= 0;
const inCamp = a => a?.position && Math.abs(a.position.x - 11) + Math.abs(a.position.y - 8) <= 2;
const online = (world, a) => a?.status === 'active' && a.run?.status === 'active' && a.run.expires_at > world.now()
  && !!world.state.controllers[a.run.controller_id] && !world.state.controllers[a.run.controller_id].revoked && world.state.room.status === 'active';
const binding = a => ({ run_id: a.run.run_id, session_epoch: a.session_epoch });
const bound = (world, m) => { const a = world.state.agents[m.agent_id]; return online(world, a) && m.run_id === a.run.run_id && m.session_epoch === a.session_epoch; };
const ready = (world, p) => p.status === 'active' && p.expires_at > world.now() && members(p).length === 2 && members(p).every(m => m.confirmed && bound(world, m));

export function publicCooperation(p) {
  if (!p || !template(p.template_id)) return null;
  const string = value => typeof value === 'string' ? [...value].slice(0, 240).join('') : '';
  const t = template(p.template_id), publicMembers = (Array.isArray(p.members) ? p.members : []).filter(m => m && string(m.agent_id) && t.roles.some(r => r.role_id === m.role_id))
    .slice(0, 2).map(m => ({ agent_id: string(m.agent_id), role_id: m.role_id, confirmed: m.confirmed === true }));
  return { cooperation_id: string(p.cooperation_id), revision: time(p.revision) ? p.revision : 0, template_id: t.template_id,
    status: ['proposed', 'active', 'needs_review', 'completed', 'ended'].includes(p.status) ? p.status : 'ended',
    created_at: time(p.created_at) ? p.created_at : 0, invite_expires_at: time(p.invite_expires_at) ? p.invite_expires_at : 0,
    expires_at: time(p.expires_at) ? p.expires_at : 0, started_at: time(p.started_at) ? p.started_at : null,
    ended_at: time(p.ended_at) ? p.ended_at : null, end_reason: ['not_formed', 'withdrawn', 'expired', 'member_left', 'authorization_ended'].includes(p.end_reason) ? p.end_reason : null,
    members: publicMembers,
    progress: t.steps.map(step => { const s = (Array.isArray(p.progress) ? p.progress : []).find(s => s?.step_id === step.step_id);
      return { step_id: step.step_id, role_id: step.role_id, progress: time(s?.progress) ? Math.min(step.target_count, s.progress) : 0,
        target_count: step.target_count, completed_at: time(s?.completed_at) ? s.completed_at : null }; }),
    escrow: { turnip: time(p.escrow?.turnip) && p.escrow.turnip <= 4 ? p.escrow.turnip : 0 },
    public_result: p.public_result && typeof p.public_result === 'object' ? { text: string(p.public_result.text), completed_at: time(p.public_result.completed_at) ? p.public_result.completed_at : null,
      ...(p.template_id === 'camp_meal' && p.public_result.items_by_agent ? { items_by_agent: Object.fromEntries(publicMembers.map(m => [m.agent_id, { turnip_soup: p.public_result.items_by_agent[m.agent_id]?.turnip_soup === 1 ? 1 : 0 }])) } : {}) } : null };
}
export function publicCooperations(world) {
  return records(world).map(publicCooperation).filter(Boolean).sort((a, b) => b.created_at - a.created_at || b.cooperation_id.localeCompare(a.cooperation_id));
}
function invitation(p) {
  return { cooperation_id: p.cooperation_id, revision: p.revision, template_id: p.template_id, from_agent_id: p.members[0].agent_id,
    role_id: template(p.template_id).roles.find(role => role.role_id !== p.members[0].role_id).role_id, invite_expires_at: p.invite_expires_at, expires_at: p.expires_at };
}
export function cooperationObservation(world, a) {
  const p = current(world, a.agent_id) || records(world).filter(p => member(p, a.agent_id)).sort((x, y) => y.created_at - x.created_at || y.cooperation_id.localeCompare(x.cooperation_id))[0];
  const self = p && member(p, a.agent_id);
  return { cooperation: p ? { ...publicCooperation(p), self_role_id: self.role_id, self_confirmed: self.confirmed === true } : null,
    cooperation_invitations: records(world).filter(p => p.status === 'proposed' && p.target_agent_id === a.agent_id && p.invite_expires_at > world.now())
      .sort((x, y) => x.invite_expires_at - y.invite_expires_at || x.cooperation_id.localeCompare(y.cooperation_id)).slice(0, 2).map(invitation),
    cooperation_return: a.cooperation_return ? { cooperation_id: a.cooperation_return.cooperation_id, item_id: 'turnip', quantity: a.cooperation_return.quantity } : null };
}
function announce(world, p, type) {
  world.event(type, publicCooperation(p), [...new Set([...members(p).map(m => m.agent_id), ...world.activeIds()])]);
}
function prune(world) {
  const ended = records(world).filter(p => !ongoing(p)).sort((a, b) => (b.ended_at || 0) - (a.ended_at || 0) || b.cooperation_id.localeCompare(a.cooperation_id));
  // Returns are independent per-owner records; pruning a public history never loses a return.
  for (const p of ended.slice(COOPERATION_RULES.max_terminal)) delete world.state.cooperations[p.cooperation_id];
}
function refund(world, p) {
  if (!p.escrow.turnip) return;
  const a = world.state.agents[p.contributor_id], quantity = p.escrow.turnip;
  if (!a) throw new Error('Cooperation contributor missing');
  if (a.cooperation_return) throw new Error('Duplicate pending cooperation return');
  if (Number.isSafeInteger((a.life.inventory.turnip || 0) + quantity)) {
    const before = economyBalance(a); a.life.inventory.turnip = (a.life.inventory.turnip || 0) + quantity;
    recordEconomyDelta(a, before, { source_id: `cooperation:${p.cooperation_id}:return`, reason: 'cooperation_return', at: world.now(), world, countProgress: false });
  } else a.cooperation_return = { cooperation_id: p.cooperation_id, quantity };
  p.escrow.turnip = 0;
}
function end(world, p, reason) {
  if (!ongoing(p)) return false;
  refund(world, p); p.status = 'ended'; p.ended_at = world.now(); p.end_reason = reason;
  announce(world, p, 'cooperation_ended'); prune(world); return true;
}
function review(world, p, interruptedId) {
  if (p.status === 'proposed') return end(world, p, 'not_formed');
  if (!ongoing(p)) return false;
  if (p.expires_at <= world.now()) return end(world, p, 'expired');
  if (p.status === 'needs_review' && (interruptedId ? !member(p, interruptedId)?.confirmed : !members(p).some(m => m.confirmed))) return false;
  p.status = 'needs_review'; p.revision++; for (const m of members(p)) m.confirmed = false;
  announce(world, p, 'cooperation_review'); return true;
}
export function reviewCooperations(world, a) {
  let changed = false;
  for (const p of records(world)) if (member(p, a.agent_id) || p.status === 'proposed' && p.target_agent_id === a.agent_id) changed = review(world, p, a.agent_id) || changed;
  return changed;
}
export function endCooperations(world, a, reason = 'authorization_ended') {
  let changed = false;
  for (const p of records(world)) if (member(p, a.agent_id) || p.status === 'proposed' && p.target_agent_id === a.agent_id) changed = end(world, p, p.status === 'proposed' ? 'not_formed' : reason) || changed;
  return changed;
}
export function initializeCooperations(world, { restore = false } = {}) {
  world.state.cooperations ??= {};
  for (const a of Object.values(world.state.agents)) { a.cooperation_return ??= null; a.cooperation_proposed_at ??= null; }
  for (const p of records(world)) {
    if (!template(p.template_id) || !Array.isArray(p.members) || !Array.isArray(p.progress) || !p.escrow || !Number.isSafeInteger(p.escrow.turnip) || p.escrow.turnip < 0 || p.escrow.turnip > 4)
      throw new Error('Invalid persisted cooperation; preserve database for recovery');
    if (restore && ongoing(p)) review(world, p);
  }
  prune(world);
}
export function tickCooperations(world) {
  let changed = false;
  for (const p of records(world)) {
    if (!ongoing(p)) continue;
    if (p.expires_at <= world.now()) { changed = end(world, p, 'expired') || changed; continue; }
    if (members(p).some(m => { const a = world.state.agents[m.agent_id]; return !a?.run || a.run.status === 'closed' || world.state.controllers[a.run.controller_id]?.revoked; })) {
      changed = end(world, p, p.status === 'proposed' ? 'not_formed' : 'authorization_ended') || changed; continue;
    }
    if (p.status === 'proposed') {
      const target = world.state.agents[p.target_agent_id];
      if (p.invite_expires_at <= world.now() || !members(p).every(m => bound(world, m)) || !online(world, target) ||
        target.run.run_id !== p.target_binding.run_id || target.session_epoch !== p.target_binding.session_epoch) changed = end(world, p, 'not_formed') || changed;
    } else if (p.status === 'active' && !ready(world, p) || p.status === 'needs_review' && members(p).some(m => m.confirmed && !bound(world, m))) changed = review(world, p) || changed;
  }
  return changed;
}
function complete(world, p, result) {
  p.status = 'completed'; p.ended_at = world.now(); p.public_result = { ...result, completed_at: world.now() };
  announce(world, p, 'cooperation_completed'); prune(world);
}
function progress(p, stepId, now) { const step = p.progress.find(s => s.step_id === stepId); step.progress = step.target_count; step.completed_at = now; }
export function progressCooperation(world, a, { kind, zone_id, source_id, found_at, at = world.now() }) {
  const p = current(world, a.agent_id);
  if (!p || p.template_id !== 'scout_and_guard' || !ready(world, p) || typeof source_id !== 'string' || p.sources.includes(source_id)) return false;
  const m = member(p, a.agent_id), scout = p.progress[0];
  if (kind === 'exploration' && m.role_id === 'scout' && zone_id === 'forest' && found_at > p.started_at && scout.progress === 0) {
    p.sources.push(source_id); progress(p, 'scout', at); announce(world, p, 'cooperation_progress'); return true;
  }
  if (kind === 'monster' && m.role_id === 'guard' && zone_id === 'forest' && scout.progress === 1 && at > scout.completed_at && p.progress[1].progress === 0) {
    p.sources.push(source_id); progress(p, 'guard', at); complete(world, p, { text: '侦察员先处理森林发现，护卫随后实际击败森林怪物，共同完成林地巡查。战利品仅归原有有效参战者。' }); return true;
  }
  return false;
}
function exact(p, keys, fail) { if (Object.keys(p).some(key => !keys.includes(key))) fail('INVALID_ACTION', '合作参数包含不支持的字段'); }
export function performCooperation(world, a, p, fail, actionId) {
  const allowed = {
    propose: ['intent', 'template_id', 'target_agent_id', 'role_id', 'duration_seconds'], respond: ['intent', 'cooperation_id', 'revision', 'accept', 'role_id'],
    confirm: ['intent', 'cooperation_id', 'revision'], leave: ['intent', 'cooperation_id'], contribute: ['intent', 'cooperation_id', 'revision'],
    cook: ['intent', 'cooperation_id', 'revision'], claim_return: ['intent', 'cooperation_id'],
  };
  if (typeof p.intent !== 'string' || !Object.hasOwn(allowed, p.intent)) fail('INVALID_ACTION', '请选择合作目录中的操作');
  exact(p, allowed[p.intent], fail);
  if (p.intent === 'propose') {
    const t = template(p.template_id), target = world.state.agents[p.target_agent_id], duration = p.duration_seconds ?? COOPERATION_RULES.default_duration_seconds;
    if (!t || !t.roles.some(r => r.role_id === p.role_id) || !Number.isInteger(duration) || duration < 300 || duration > 1800) fail('INVALID_ACTION', '合作模板、分工或期限无效');
    if (typeof p.target_agent_id !== 'string' || !target || target === a || !online(world, target) || Math.abs(target.position.x - a.position.x) + Math.abs(target.position.y - a.position.y) > 6) fail('COOPERATION_TARGET', '只能邀请六格内已获准活动的其他角色');
    if (current(world, a.agent_id) || current(world, target.agent_id)) fail('COOPERATION_BUSY', '本人或对方已有进行中的约定');
    if (time(a.cooperation_proposed_at) && world.now() - a.cooperation_proposed_at < 60000) fail('COOPERATION_COOLDOWN', '每次发起合作至少间隔60秒');
    if (records(world).filter(p => ongoing(p)).length >= 5 || records(world).filter(p => p.status === 'proposed' && p.target_agent_id === target.agent_id).length >= 2) fail('COOPERATION_LIMIT', '当前待处理合作已达上限');
    const expires = Math.min(world.now() + duration * 1000, a.run.expires_at, target.run.expires_at);
    const project = { cooperation_id: `cooperation_${randomUUID()}`, revision: 1, template_id: t.template_id, status: 'proposed', created_at: world.now(),
      invite_expires_at: Math.min(world.now() + 150000, expires), expires_at: expires, started_at: null, ended_at: null, end_reason: null,
      members: [{ agent_id: a.agent_id, role_id: p.role_id, confirmed: true, ...binding(a) }], target_agent_id: target.agent_id, target_binding: binding(target),
      progress: t.steps.map(s => ({ step_id: s.step_id, role_id: s.role_id, progress: 0, target_count: s.target_count, completed_at: null })),
      escrow: { turnip: 0 }, contributor_id: null, sources: [], public_result: null };
    world.state.cooperations[project.cooperation_id] = project; a.cooperation_proposed_at = world.now();
    announce(world, project, 'cooperation_proposed');
    world.event('cooperation_invitation', { ...invitation(project), target_agent_id: target.agent_id }, [a.agent_id, target.agent_id]);
  } else if (p.intent === 'claim_return') {
    const pending = a.cooperation_return;
    if (!pending || p.cooperation_id !== pending.cooperation_id) fail('COOPERATION_RETURN', '没有属于本人的这笔待退物品');
    const before = economyBalance(a); adjustInventory(a, { turnip: pending.quantity }, fail);
    recordEconomyDelta(a, before, { source_id: `cooperation:${pending.cooperation_id}:return`, reason: 'cooperation_return', at: world.now(), world, countProgress: false });
    a.cooperation_return = null;
  } else {
    const project = world.state.cooperations[p.cooperation_id];
    if (!project || typeof p.cooperation_id !== 'string') fail('COOPERATION_UNAVAILABLE', '约定不存在或已移出保留历史');
    const self = member(project, a.agent_id);
    if (!self && !(p.intent === 'respond' && project.target_agent_id === a.agent_id)) fail('NOT_AUTHORIZED', '不能操作他人的合作');
    if (p.intent !== 'leave' && (!Number.isSafeInteger(p.revision) || p.revision !== project.revision)) fail('COOPERATION_STALE', '约定已进入新的复核阶段，请重新观察');
    if (!ongoing(project)) fail('COOPERATION_UNAVAILABLE', '约定已经结束');
    if (p.intent === 'leave') end(world, project, project.status === 'proposed' ? 'withdrawn' : 'member_left');
    else if (p.intent === 'respond') {
      if (project.status !== 'proposed' || project.target_agent_id !== a.agent_id || project.invite_expires_at <= world.now()) fail('COOPERATION_UNAVAILABLE', '这份邀约已不可响应');
      const offer = invitation(project);
      if (typeof p.accept !== 'boolean' || p.accept && p.role_id !== offer.role_id || !p.accept && p.role_id !== undefined) fail('INVALID_ACTION', '接受须选择约定的剩余分工，拒绝不填写分工');
      if (p.accept && current(world, a.agent_id)) fail('COOPERATION_BUSY', '本人已有其他约定');
      world.event('cooperation_response', { ...offer, target_agent_id: a.agent_id, accepted: p.accept }, [offer.from_agent_id, a.agent_id]);
      if (!p.accept) end(world, project, 'not_formed');
      else {
        project.members.push({ agent_id: a.agent_id, role_id: p.role_id, confirmed: true, ...binding(a) });
        project.status = 'active'; project.started_at = world.now();
        project.expires_at = Math.min(project.expires_at, ...project.members.map(m => world.state.agents[m.agent_id].run.expires_at));
        announce(world, project, 'cooperation_started');
        for (const other of records(world)) if (other !== project && other.status === 'proposed' && project.members.some(m => other.target_agent_id === m.agent_id)) end(world, other, 'not_formed');
      }
    } else if (p.intent === 'confirm') {
      if (project.status !== 'needs_review') fail('COOPERATION_REVIEW', '这份约定当前无需复核');
      if (self.confirmed) fail('COOPERATION_CONFIRMED', '本人已确认这一复核版本');
      Object.assign(self, binding(a), { confirmed: true });
      project.expires_at = Math.min(project.expires_at, a.run.expires_at);
      if (project.members.every(m => m.confirmed && bound(world, m))) { project.status = 'active'; announce(world, project, 'cooperation_started'); }
      else announce(world, project, 'cooperation_progress');
    } else {
      if (!ready(world, project)) fail('COOPERATION_REVIEW', '双方需在有效授权下确认约定后才能继续');
      if (project.template_id !== 'camp_meal') fail('INVALID_ACTION', '这一操作只用于共同备餐');
      campAvailable(world, a, fail);
      if (p.intent === 'contribute') {
        if (self.role_id !== 'supplier') fail('NOT_AUTHORIZED', '只有自愿承担供菜的本人可以交菜');
        if (a.cooperation_return) fail('COOPERATION_RETURN_PENDING', '先领取本人上一笔待退物品，之后可提交新托管');
        if (project.progress[0].progress || project.escrow.turnip) fail('COOPERATION_CONTRIBUTED', '这份约定已经交过菜');
        const before = economyBalance(a); adjustInventory(a, { turnip: -4 }, fail);
        project.escrow.turnip = 4; project.contributor_id = a.agent_id; progress(project, 'supply', world.now());
        recordEconomyDelta(a, before, { source_id: actionId, reason: 'cooperation_contribute', at: world.now(), world });
        announce(world, project, 'cooperation_progress');
      } else {
        if (self.role_id !== 'cook') fail('NOT_AUTHORIZED', '只有自愿承担厨师的本人可以烹饪');
        if (project.escrow.turnip !== 4) fail('COOPERATION_MATERIALS', '本次托管还没有四个萝卜');
        const participants = project.members.map(m => world.state.agents[m.agent_id]);
        if (!participants.every(inCamp)) fail('NOT_AT_CAMP', '双方需在安全营地才能完成共同备餐');
        if (participants.some(a => !Number.isSafeInteger((a.life.inventory.turnip_soup || 0) + 1))) fail('INVENTORY_FULL', '一位参与者的浓汤数量已达上限');
        const recipe = LIFE_RULES.recipes.find(r => r.item_id === 'turnip_soup'), cost = recipe.energy_cost * 2;
        if (recipe.ingredients.turnip * 2 !== 4 || !spendEnergy(world, a, 'craft', cost / FATIGUE_RULES.costs.craft)) fail('FATIGUE_EXHAUSTED', '厨师需要四点体力才能烹饪这一批');
        project.escrow.turnip = 0; progress(project, 'cook', world.now());
        for (const participant of participants) {
          const before = economyBalance(participant); adjustInventory(participant, { turnip_soup: 1 }, fail);
          recordEconomyDelta(participant, before, { source_id: actionId, reason: 'cooperation_cook', at: world.now(), world });
        }
        progressPersonalGoal(world, a, { kind: 'cook_item', target_id: 'turnip_soup', amount: 2, source_id: actionId });
        complete(world, project, { text: '供菜者自愿交四个萝卜，厨师消耗四点体力做成两碗浓汤，双方各得一碗。', items_by_agent: Object.fromEntries(participants.map(a => [a.agent_id, { turnip_soup: 1 }])) });
      }
    }
  }
  return cooperationObservation(world, a);
}

export function cooperationOpportunities(world, a) {
  if (!online(world, a)) return [];
  const options = [], p = current(world, a.agent_id), observation = cooperationObservation(world, a);
  const add = (id, label, reason, payload) => options.push({ id: `cooperation_${id}`, label, reason, action: { type: 'cooperation', payload } });
  const workAvailable = () => { try { campAvailable(world, a, (code) => { throw new Error(code); }); return true; } catch { return false; } };
  const pending = observation.cooperation_return;
  if (pending && Number.isSafeInteger((a.life.inventory.turnip || 0) + pending.quantity)) add('return', '领取本人待退萝卜', '只取回此前本人交出的原物品，不算新采集', { intent: 'claim_return', cooperation_id: pending.cooperation_id });
  const offer = observation.cooperation_invitations[0];
  if (offer) {
    const fields = { cooperation_id: offer.cooperation_id, revision: offer.revision };
    if (!p) add('accept', '自愿接受这份合作', template(offer.template_id).terms, { intent: 'respond', ...fields, accept: true, role_id: offer.role_id });
    add('decline', '拒绝这份合作', '不花物资或体力，也可以不响应，超时不等于拒绝', { intent: 'respond', ...fields, accept: false });
    return options.slice(0, 3);
  }
  if (p) {
    const self = member(p, a.agent_id), fields = { cooperation_id: p.cooperation_id, revision: p.revision };
    if (p.status === 'needs_review' && !self.confirmed) add('confirm', '本人复核原合作', '期限不顺延；仅确认约定，不自动开始工作', { intent: 'confirm', ...fields });
    if (ready(world, p) && p.template_id === 'camp_meal' && workAvailable() && a.adventure?.encounter?.status !== 'pending') {
      if (self.role_id === 'supplier' && !a.cooperation_return && !p.progress[0].progress && (a.life.inventory.turnip || 0) >= 4)
        add('contribute', '自愿交四个萝卜备餐', '本次托管只用于这份共同备餐，退出退还未用原菜', { intent: 'contribute', ...fields });
      if (self.role_id === 'cook' && p.escrow.turnip === 4 && publicFatigue(a).energy >= 4 && members(p).every(m => {
        const a = world.state.agents[m.agent_id]; return inCamp(a) && Number.isSafeInteger((a.life.inventory.turnip_soup || 0) + 1);
      })) add('cook', '烹饪双方的两碗浓汤', '消耗托管四个萝卜和本人四点体力，双方各得一碗', { intent: 'cook', ...fields });
    }
    add('leave', p.status === 'proposed' ? '撤回本人的合作提案' : '退出本人的合作', '不替同伴选行动；未用托管退还原贡献者，不取消个人玩法', { intent: 'leave', cooperation_id: p.cooperation_id });
    return options.slice(0, 2);
  }
  if ((!time(a.cooperation_proposed_at) || world.now() - a.cooperation_proposed_at >= 60000) && records(world).filter(ongoing).length < 5) {
    const target = Object.values(world.state.agents).find(b => b !== a && online(world, b) && !current(world, b.agent_id) &&
      Math.abs(b.position.x - a.position.x) + Math.abs(b.position.y - a.position.y) <= 6 && records(world).filter(p => p.status === 'proposed' && p.target_agent_id === b.agent_id).length < 2);
    if (target) add('propose', `邀请${target.name}共同备餐`, '自己承担供菜职责；对方可拒绝或等待，未接受不扣物资', { intent: 'propose', template_id: 'camp_meal', target_agent_id: target.agent_id, role_id: 'supplier' });
  }
  return options;
}
