const ongoing = new Set(['proposed', 'active', 'needs_review']);
export const cooperationNames = { camp_meal: '共同备餐', scout_and_guard: '林地巡查' };
const statuses = { proposed: '正在征询同伴', active: '合作进行中', needs_review: '等待双方复核', completed: '合作已完成', ended: '合作已结束' };
const reasons = { not_formed: '未能成行', withdrawn: '发起者已撤回', expired: '约定已到期', member_left: '已有成员退出', authorization_ended: '参与授权已结束' };
export function selectedCooperation(projects = [], agentId) {
  if (!agentId) return null;
  const own = projects.filter(p => p.members?.some(m => m.agent_id === agentId));
  return own.find(p => ongoing.has(p.status)) || own[0] || null;
}
export function cooperationState(project, now) {
  if (!project) return null;
  const deadline = project.status === 'proposed' ? Math.min(project.invite_expires_at, project.expires_at) : project.expires_at;
  const awaiting = ongoing.has(project.status) && Number.isFinite(deadline) && deadline <= now;
  const steps = (project.progress || []).map(step => ({ ...step, progress: Math.max(0, Math.min(step.target_count, step.progress)), target_count: Math.max(1, step.target_count) }));
  return { project, steps, awaiting, deadline, terminal: !ongoing.has(project.status),
    label: awaiting ? '期限已到，等待确认' : project.status === 'ended' ? reasons[project.end_reason] || statuses.ended : statuses[project.status] || '状态待核实',
    confirmed: (project.members || []).filter(m => m.confirmed).length,
  };
}
export function cooperationCatalog(world, project) {
  return world.cooperation?.templates?.find(t => t.template_id === project?.template_id);
}
export function cooperationSummary(world, agentId, now) {
  const project = selectedCooperation(world.cooperations, agentId), state = cooperationState(project, now);
  if (!state) return null;
  const catalog = cooperationCatalog(world, project), member = project.members.find(m => m.agent_id === agentId);
  const role = catalog?.roles?.find(r => r.role_id === member.role_id)?.name || '已同意成员';
  const step = state.steps.find(s => s.role_id === member.role_id);
  return { ...state, name: catalog?.name || cooperationNames[project.template_id] || '自愿合作', role,
    text: `${catalog?.name || cooperationNames[project.template_id] || '自愿合作'} · ${state.label}${project.status === 'active' && !state.awaiting ? ` · ${role}${step ? ` ${step.progress}/${step.target_count}` : ''}` : ''}` };
}
