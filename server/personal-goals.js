import { randomUUID } from 'node:crypto';

export const PERSONAL_GOAL_RULES = {
  kinds: [
    { kind: 'collect_item', name: '获取物品', target_ids: ['wood', 'ore', 'turnip', 'wheat', 'turnip_seed', 'wheat_seed'] },
    { kind: 'cook_item', name: '制作料理', target_ids: ['turnip_soup', 'wheat_bread'] },
    { kind: 'resolve_exploration', name: '处理探索发现', target_ids: ['forest', 'ruins'] },
    { kind: 'defeat_monster', name: '参与击败怪物', target_ids: ['forest_slime', 'forest_boar', 'ruins_guardian'] },
  ],
  min_count: 1, max_count: 10, min_duration_seconds: 300, max_duration_seconds: 1800, default_duration_seconds: 900,
  examples: [{ intent: 'set', kind: 'collect_item', target_id: 'wood', target_count: 3, duration_seconds: 900, title: '收集一些木材' },
    { intent: 'confirm', goal_id: '观察中的goal_id' }, { intent: 'cancel', goal_id: '观察中的goal_id' }],
  description: '原AI自己设置一个公开的短期方向，只统计设置之后的真实成功结果。目标不执行行动、不发额外奖励、不改变主人授权或预算；暂停、失联、会话变更和重启后须明确复核，截止时间不顺延。',
};
const statuses = ['active', 'needs_review', 'completed', 'cancelled', 'expired'];
const time = n => Number.isSafeInteger(n) && n >= 0;
const count = n => Number.isSafeInteger(n) && n >= 1 && n <= PERSONAL_GOAL_RULES.max_count;
const validTarget = (kind, id) => PERSONAL_GOAL_RULES.kinds.some(rule => rule.kind === kind && rule.target_ids.includes(id));
const title = value => typeof value === 'string' ? [...value].slice(0, 60).join('') : '';
const reasons = new Set(['connection_changed', 'restarted', 'authorization_changed']);
const targetNames = { wood: '木材', ore: '矿石', turnip: '萝卜', wheat: '小麦', turnip_seed: '萝卜种子', wheat_seed: '小麦种子',
  turnip_soup: '萝卜浓汤', wheat_bread: '麦香面包', forest: '苔光森林', ruins: '风蚀遗迹', forest_slime: '苔藓史莱姆', forest_boar: '荆棘野猪', ruins_guardian: '遗迹守卫' };

export function initializePersonalGoal(a) {
  const g = a.personal_goal;
  if (!g || typeof g.goal_id !== 'string' || !validTarget(g.kind, g.target_id) || !count(g.target_count) || !statuses.includes(g.status) ||
    !time(g.created_at) || !time(g.updated_at) || !time(g.expires_at)) { a.personal_goal = null; return; }
  g.progress = Number.isSafeInteger(g.progress) ? Math.max(0, Math.min(g.target_count, g.progress)) : 0;
  g.title = title(g.title); g.review_reason = reasons.has(g.review_reason) ? g.review_reason : null;
  g.sources = Array.isArray(g.sources) ? g.sources.filter(s => typeof s === 'string').slice(-16) : [];
}
export function publicPersonalGoal(a) {
  const g = a.personal_goal;
  if (!g || !validTarget(g.kind, g.target_id) || !statuses.includes(g.status)) return null;
  return { goal_id: g.goal_id, kind: g.kind, target_id: g.target_id, target_count: g.target_count, progress: g.progress,
    title: title(g.title), status: g.status, created_at: g.created_at, updated_at: g.updated_at, expires_at: g.expires_at,
    review_reason: reasons.has(g.review_reason) ? g.review_reason : null };
}
function announce(world, a, type, text) {
  world.event(type, { agent_id: a.agent_id, name: a.name, text, ...publicPersonalGoal(a) }, [...new Set([a.agent_id, ...world.activeIds()])]);
}
export function expirePersonalGoal(world, a) {
  const g = a.personal_goal;
  if (!g || !['active', 'needs_review'].includes(g.status) || g.expires_at > world.now()) return false;
  g.status = 'expired'; g.updated_at = world.now(); g.review_reason = null;
  announce(world, a, 'personal_goal_ended', `${a.name}的公开短期目标已到期`); return true;
}
export function reviewPersonalGoal(world, a, reason = 'connection_changed') {
  if (expirePersonalGoal(world, a)) return true;
  const g = a.personal_goal;
  if (!g || g.status !== 'active') return false;
  g.status = 'needs_review'; g.updated_at = world.now(); g.review_reason = reasons.has(reason) ? reason : 'connection_changed';
  announce(world, a, 'personal_goal_review', `${a.name}的公开目标等待本人复核，截止时间不变`); return true;
}
export function tickPersonalGoals(world) {
  let changed = false;
  for (const a of Object.values(world.state.agents)) {
    if (expirePersonalGoal(world, a)) { changed = true; continue; }
    const g = a.personal_goal;
    if (g?.status === 'active' && (a.status !== 'active' || a.run?.status !== 'active' || a.run.run_id !== g.run_id || a.session_epoch !== g.session_epoch))
      changed = reviewPersonalGoal(world, a) || changed;
  }
  return changed;
}
export function performPersonalGoal(world, a, p, fail) {
  if (!['set', 'confirm', 'cancel'].includes(p.intent)) fail('INVALID_ACTION', '目标只接受 set/confirm/cancel');
  const keys = p.intent === 'set' ? ['intent', 'kind', 'target_id', 'target_count', 'duration_seconds', 'title'] : ['intent', 'goal_id'];
  if (Object.keys(p).some(key => !keys.includes(key))) fail('INVALID_ACTION', '目标参数包含不支持的字段');
  if (p.intent === 'set') {
    const seconds = p.duration_seconds === undefined ? PERSONAL_GOAL_RULES.default_duration_seconds : p.duration_seconds;
    if (!validTarget(p.kind, p.target_id) || !count(p.target_count) || !Number.isSafeInteger(seconds) || seconds < 300 || seconds > 1800 ||
      p.title !== undefined && (typeof p.title !== 'string' || [...p.title].length > 60)) fail('INVALID_ACTION', '请选择目录目标、1到10次、300到1800秒及最多60字公开标题');
    const previous = a.personal_goal;
    if (previous && ['active', 'needs_review'].includes(previous.status)) {
      previous.status = 'cancelled'; previous.updated_at = world.now(); previous.review_reason = null;
      announce(world, a, 'personal_goal_ended', `${a.name}决定修改原来的公开目标`);
    }
    a.personal_goal = { goal_id: `goal_${randomUUID()}`, kind: p.kind, target_id: p.target_id, target_count: p.target_count, progress: 0,
      title: p.title?.trim() || `${PERSONAL_GOAL_RULES.kinds.find(k => k.kind === p.kind).name}：${targetNames[p.target_id]} × ${p.target_count}`,
      status: 'active', created_at: world.now(), updated_at: world.now(), expires_at: Math.min(world.now() + seconds * 1000, a.run.expires_at), review_reason: null,
      run_id: a.run.run_id, session_epoch: a.session_epoch, sources: [] };
    announce(world, a, 'personal_goal_set', `${a.name}公开了自己的短期目标：${a.personal_goal.title}`);
  } else {
    const g = a.personal_goal;
    if (typeof p.goal_id !== 'string' || !g || p.goal_id !== g.goal_id) fail('GOAL_UNAVAILABLE', '该目标不属于当前角色或已被替换，请重新观察');
    if (g.status === 'expired' || g.expires_at <= world.now()) fail('GOAL_EXPIRED', '目标已到期，不能延长或继续原目标');
    if (['completed', 'cancelled'].includes(g.status)) fail('GOAL_UNAVAILABLE', '该目标已经结束');
    if (p.intent === 'confirm') {
      if (g.status !== 'needs_review') fail('GOAL_REVIEW_REQUIRED', '当前目标无需复核');
      g.status = 'active'; g.updated_at = world.now(); g.review_reason = null; g.run_id = a.run.run_id; g.session_epoch = a.session_epoch;
      g.expires_at = Math.min(g.expires_at, a.run.expires_at);
      announce(world, a, 'personal_goal_set', `${a.name}确认继续自己的公开目标：${g.title}`);
    } else {
      g.status = 'cancelled'; g.updated_at = world.now(); g.review_reason = null;
      announce(world, a, 'personal_goal_ended', `${a.name}取消了自己的公开目标`);
    }
  }
  return { personal_goal: publicPersonalGoal(a) };
}
export function progressPersonalGoal(world, a, { kind, target_id, amount = 1, source_id }) {
  const g = a.personal_goal;
  if (!world || !g || g.status !== 'active' || g.kind !== kind || g.target_id !== target_id || !Number.isSafeInteger(amount) || amount <= 0 ||
    a.status !== 'active' || a.run?.status !== 'active' || a.run.expires_at <= world.now() || g.expires_at <= world.now() ||
    g.run_id !== a.run.run_id || g.session_epoch !== a.session_epoch || typeof source_id !== 'string' || g.sources.includes(source_id)) return false;
  g.sources = [...g.sources, source_id].slice(-16); g.progress = Math.min(g.target_count, g.progress + amount); g.updated_at = world.now();
  if (g.progress >= g.target_count) { g.status = 'completed'; g.review_reason = null; }
  announce(world, a, g.status === 'completed' ? 'personal_goal_ended' : 'personal_goal_progress',
    `${a.name}的公开目标${g.status === 'completed' ? '已完成' : '取得进展'}：${g.progress}/${g.target_count}`);
  return true;
}
