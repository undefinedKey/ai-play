// Public server facts only. This module presents choices; it never starts work.
const seconds = (value, now) => Number.isFinite(value) ? Math.max(0, Math.ceil((value - now) / 1000)) : null;
export const supportsResources = (observation, rules) => observation?.resources?.version === 1 && rules?.resources?.version === 1;
export const RESOURCE_GUIDANCE = 'resources是共享真实节点。gather{intent:start,node_id,mode?:walk|run}只选当前场景实际ID，服务器先到交互点再采一次，固定期限包括路程；不跨场景、不续采或换目标。available只表示库存、预约和时段允许，仍须自查工具owned/耐久、体力与本场景；他人先采可能使旧观察失效。gather{intent:cancel}仅intent，移动也取消。夜间工作成本按开工时服务规则锁定。工具axe/pickaxe按目录craft/repair/upgrade，工具不当武器equip。制作口粮/装备、补给、休息、继续探索都由原AI选择。旧服沿用resource_id，不虚构节点。';

export function resourceJobContext(observation) {
  const job = observation?.self?.life?.gathering;
  if (!job?.node_id) return undefined;
  const now = observation.server_time ?? Date.now();
  return [job.node_id, job.phase, seconds(job.ends_at, now), seconds(job.expires_at, now), job.mode || 'walk', job.energy_cost, job.yield_count];
}

export function resourcePromptNotice(observation = {}, rules = {}, compact = false) {
  const now = observation.server_time ?? Date.now(), own = observation.self || {}, day = observation.day_cycle;
  let notice = day && ['day', 'dusk', 'night', 'dawn'].includes(day.phase)
    ? compact ? `昼夜${day.phase}/${seconds(day.next_at, now)}秒换段。\n` : `天时[日,段,余秒]=${JSON.stringify([day.day_index, day.phase, seconds(day.next_at, now)])}。\n` : '';
  if (!supportsResources(observation, rules)) return notice;
  const job = resourceJobContext(observation);
  if (job) return notice; // The active job is mandatory data in both ordinary and cooperation routes.
  const game = observation.game, participating = game && !['finished', 'ended'].includes(game.status) && game.participants?.includes(own.agent_id);
  const allies = new Set([own.agent_id, ...(observation.group?.members || [])]);
  const danger = observation.adventure?.monsters?.some(m => ['chasing', 'attacking'].includes(m.behavior) && allies.has(m.target_agent_id));
  const liveGoal = ['active', 'needs_review'].includes(own.personal_goal?.status);
  const liveCooperation = observation.cooperation && !['completed', 'ended'].includes(observation.cooperation.status);
  if (own.activity || own.movement || participating || game?.status === 'recruiting' || own.adventure?.plan || own.adventure?.encounter?.status === 'pending' || liveGoal || danger || liveCooperation || observation.cooperation_invitations?.length || compact === 'critical') return notice;
  const nodes = (observation.resources.nodes || []).filter(n => n.scene_id === own.scene_id);
  const distance = n => Math.abs((n.interaction_position?.x ?? n.position?.x) - own.position?.x) + Math.abs((n.interaction_position?.y ?? n.position?.y) - own.position?.y);
  const offers = (observation.opportunities || []).filter(o => o.action?.type === 'gather' && o.action.payload?.intent === 'start')
    .map(o => o.action.payload.node_id || ({ wood: 'camp_branches', ore: 'camp_stones' })[o.action.payload.resource_id]);
  nodes.sort((a, b) => Number(!!b.available) - Number(!!a.available) || Number(offers.includes(b.id)) - Number(offers.includes(a.id)) || distance(a) - distance(b) || a.id.localeCompare(b.id));
  if (!nodes.length) return notice;
  const selected = nodes.slice(0, compact ? 1 : 4);
  const rows = selected.map(n => [n.id, n.item_id, n.interaction_position?.x, n.interaction_position?.y, n.stock, n.available,
    n.tool_id || null, n.duration_seconds, n.energy_cost, n.available_phases, seconds(n.regrow_at, now), !!n.reservation]);
  const tools = [...new Set(selected.map(n => n.tool_id).filter(Boolean))].map(id => {
    const t = own.life?.tools?.[id]; return [id, t?.owned === true, t?.durability ?? 0];
  });
  if (compact) {
    const n = selected[0], tool = own.life?.tools?.[n.tool_id];
    return notice + `可查看节点${n.id}@${n.interaction_position?.x},${n.interaction_position?.y}→${n.item_id}×${n.yield_count}，库存${n.stock}，${n.available ? '可约' : '不可约'}${n.tool_id ? `，需${n.tool_id}(拥有${!!tool?.owned}/耐久${tool?.durability ?? 0})` : '，徒手'}，基础${n.duration_seconds}秒/${n.energy_cost}体` +
      `${n.regrow_at ? `，${seconds(n.regrow_at, now)}秒再生` : ''}${n.reservation ? '，已预约' : ''}${n.available_phases?.length < 4 ? `，限${n.available_phases.join('/')}` : ''}。` +
      (day?.phase === 'night' && rules.day_cycle ? `夜间开工时间×${rules.day_cycle.night_work_duration_multiplier}/体力×${rules.day_cycle.night_work_energy_multiplier}。` : '') +
      `gather{intent:start,node_id,mode?}≤${rules.resources.max_job_seconds}秒含走路采一次，不跨图/续采；可约仍须体力工具足。\n`;
  }
  notice += `同场景部分节点[id,物,交互x/y,库存,可预约,需工具,基础工作秒/体,时段,再生秒,占用]=${JSON.stringify(rows)}；工具[id,已拥有,耐久]=${JSON.stringify(tools)}。\n`;
  const night = rules.day_cycle;
  notice += `gather{intent:start,node_id,mode?:walk|run}先走再采一次≤${rules.resources.max_job_seconds || 120}秒；可预约不代表工具/体力足` +
    (night ? `；夜间开工秒×${night.night_work_duration_multiplier}/体×${night.night_work_energy_multiplier}` : '') + '；不跨场景/续采。\n';
  if (tools.length) {
    const life = observation.life || rules.life;
    const recipes = life?.recipes?.filter(r => tools.some(t => t[0] === r.item_id)).map(r => [r.item_id, r.ingredients]);
    notice += `工具配方[id,材料]=${JSON.stringify(recipes || [])}；inventory{intent:craft|repair|upgrade,item_id}，不用equip。\n`;
  }
  return notice;
}
