// Only imported by the isolated load harness. Never used by a product AI runner.
// Four actors exercise two cooperative loops; a fifth keeps solo life active.
const action = (type, payload) => ({ type, payload });
const ref = project => ({ cooperation_id: project.cooperation_id, revision: project.revision });
const activeStates = new Set(['proposed', 'active', 'needs_review']);

export function cooperationLoadAction(observation, index, policy, shared) {
  const a = observation.self, now = observation.server_time, life = a.life;
  const project = activeStates.has(observation.cooperation?.status) ? observation.cooperation : null;
  const have = id => life.inventory?.[id] || 0;
  const coop = (intent, current = project) => action('cooperation', { intent, ...ref(current) });
  if (observation.cooperation_return) return action('cooperation', { intent: 'claim_return', cooperation_id: observation.cooperation_return.cooperation_id });
  if (project?.status === 'needs_review') return project.self_confirmed ? null : coop('confirm');

  if (index === 4) {
    if (life.gathering || a.adventure.plan) return null;
    if (a.fatigue.energy < 8) return action('adventure_plan', { intent: 'rest' });
    if (have('wood') > 0 && life.market.sell_remaining) return action('trade', { intent: 'sell', item_id: 'wood', quantity: 1 });
    return now >= life.gather_ready_at.wood ? action('gather', { intent: 'start', resource_id: 'wood' }) : null;
  }
  if (index === 0 && project && !shared.modes.has(project.cooperation_id)) {
    shared.modes.set(project.cooperation_id, ['complete', 'decline', 'exit', 'offer_expire', 'active_expire'][policy.cycle++ % 5]);
    if (shared.modes.size > 30) shared.modes.delete(shared.modes.keys().next().value);
  }
  const invitation = observation.cooperation_invitations?.[0];
  if (!project && invitation) {
    const mode = index === 1 ? shared.modes.get(invitation.cooperation_id) : 'complete';
    if (!mode || mode === 'offer_expire') return null;
    return action('cooperation', { intent: 'respond', ...ref(invitation), accept: mode !== 'decline',
      ...(mode === 'decline' ? {} : { role_id: invitation.role_id }) });
  }
  if (project?.status === 'proposed') return null;
  if (a.adventure.encounter?.status === 'pending') {
    const e = a.adventure.encounter;
    const choice = e.choices.find(c => c.choice_id !== 'decline' && (c.energy_cost || 0) <= a.fatigue.energy &&
      (!c.heal || a.adventure.hp < a.adventure.max_hp) && (!c.restore_energy || a.fatigue.energy < 100)) || e.choices.find(c => c.choice_id === 'decline');
    return action('adventure_event', { event_id: e.event_id, choice_id: choice.choice_id });
  }
  if (a.adventure.plan || life.gathering) return null;
  if (a.fatigue.energy < 10 || a.adventure.hp < a.adventure.max_hp / 2) return action('adventure_plan', { intent: 'rest' });

  if (project?.status === 'active' && project.template_id === 'camp_meal') {
    const mode = shared.modes.get(project.cooperation_id);
    if (index === 0) {
      if (project.escrow.turnip === 0) return coop('contribute');
      return mode === 'exit' ? action('cooperation', { intent: 'leave', cooperation_id: project.cooperation_id }) : null;
    }
    return mode === 'complete' && project.escrow.turnip === 4 ? coop('cook') : null;
  }
  if (project?.status === 'active' && project.template_id === 'scout_and_guard') {
    const scouted = project.progress.find(step => step.step_id === 'scout')?.progress === 1;
    if (index === 2) {
      if (scouted || a.adventure.discovery_ready_at > now) return a.adventure.in_field ? action('adventure_plan', { intent: 'retreat' }) : null;
      return action('adventure_plan', { intent: 'explore', zone_id: 'forest' });
    }
    if (!scouted) return null;
    const monster = observation.adventure.monsters.find(m => m.monster_id === 'forest_boar' && m.status === 'alive');
    return monster ? action('adventure_plan', { intent: 'hunt', monster_id: monster.monster_id }) : null;
  }
  if (!project && a.adventure.in_field) return action('adventure_plan', { intent: 'retreat' });
  if (!project && [0, 2].includes(index) && now >= (policy.nextProposalAt || 0)) {
    const targetId = shared.agentIds[index + 1];
    if (!observation.nearby_agents.some(peer => peer.agent_id === targetId)) return null;
    policy.nextProposalAt = now + 65000;
    return action('cooperation', { intent: 'propose', template_id: index === 0 ? 'camp_meal' : 'scout_and_guard',
      role_id: index === 0 ? 'supplier' : 'scout', target_agent_id: targetId, duration_seconds: index === 0 ? 300 : 600 });
  }
  return null;
}
