const occurredAt = value => typeof value === 'number' ? value : Date.parse(value || '') || 0;
const recent = (at, now, duration = 1600) => Number.isFinite(at) && now >= at && now - at < duration;

/** Select only poses supported by an observed position, action receipt or public state. */
export function characterAction(agent, events, now, moving = false) {
  if (agent.status !== 'active') return 'idle';
  const own = (events || []).filter(event => event.payload?.agent_id === agent.agent_id && recent(occurredAt(event.occurred_at), now));
  const last = own.at(-1);
  // The server can resolve an attack and retaliation in the same tick. Give
  // both real receipts a visible pose instead of always hiding the attack.
  if (last?.type === 'adventure_combat') {
    const hits = own.filter(event => event.type === 'adventure_combat' && occurredAt(event.occurred_at) === occurredAt(last.occurred_at));
    const outgoing = hits.find(event => event.payload.attacker === 'agent');
    const incoming = hits.find(event => event.payload.attacker === 'monster');
    if (outgoing && incoming) return now - occurredAt(last.occurred_at) < 660 ? 'attack' : 'hurt';
  }
  for (const event of [...(events || [])].reverse()) {
    if (event.payload?.agent_id !== agent.agent_id || !recent(occurredAt(event.occurred_at), now)) continue;
    if (event.type === 'adventure_combat') return event.payload.attacker === 'monster' ? 'hurt' : 'attack';
    if (['agent_moved','moved','move'].includes(event.type)) return 'walk';
    const action = { life_tilled: 'till', life_planted: 'plant', life_watered: 'water', life_harvested: 'harvest', life_crafted: 'craft', life_tool_repaired: 'repair', life_tool_upgraded: 'upgrade' }[event.type];
    if (action) return action;
  }
  if (moving) return 'walk';
  const exertion = agent.fatigue?.recent_exertion;
  if (exertion && recent(exertion.last_at, now, 900) && ['move','attack','till','plant','water','harvest','craft','repair','upgrade'].includes(exertion.last_kind)) return exertion.last_kind === 'move' ? 'walk' : exertion.last_kind;
  if ((agent.adventure?.plan?.intent === 'rest' && agent.position?.x === 11 && agent.position?.y === 8) || agent.activity?.activity_id === 'relax') return 'rest';
  if (['tired','exhausted'].includes(agent.fatigue?.state)) return 'tired';
  return 'idle';
}

/** A repeated receipt restarts its one-shot pose, even if the action is unchanged. */
export function characterActionKey(agent, events, action) {
  const type = { attack:'adventure_combat',hurt:'adventure_combat',till:'life_tilled',plant:'life_planted',water:'life_watered',harvest:'life_harvested',craft:'life_crafted',repair:'life_tool_repaired',upgrade:'life_tool_upgraded' }[action];
  const receipt = [...(events || [])].reverse().find(event => event.payload?.agent_id === agent.agent_id && event.type === type && (action !== 'attack' && action !== 'hurt' || event.payload.attacker === (action === 'attack' ? 'agent' : 'monster')));
  return `${action}:${receipt?.event_id || receipt?.occurred_at || agent.fatigue?.recent_exertion?.last_at || ''}`;
}

export function monsterAction(monster, events, now, moving = false) {
  if (monster.status !== 'alive') return 'hurt';
  const hits = (events || []).filter(event => event.type === 'adventure_combat' && event.payload?.monster_id === monster.monster_id && recent(occurredAt(event.occurred_at), now));
  const latest = hits.at(-1);
  if (latest) {
    const sameTick = hits.filter(event => occurredAt(event.occurred_at) === occurredAt(latest.occurred_at));
    if (sameTick.some(event => event.payload.attacker === 'agent') && sameTick.some(event => event.payload.attacker === 'monster')) return now - occurredAt(latest.occurred_at) < 660 ? 'hurt' : 'attack';
    return latest.payload.attacker === 'monster' ? 'attack' : 'hurt';
  }
  return moving ? 'walk' : 'idle';
}

export function movementFacing(previous, current) {
  if (!previous || !current) return 'south';
  const dx = current.x - previous.x, dy = current.y - previous.y;
  return Math.abs(dx) > Math.abs(dy) ? dx < 0 ? 'west' : 'east' : dy < 0 ? 'north' : 'south';
}

export function animationFrame(definition, action, elapsed, animated = true, facing = 'south') {
  if (!definition?.animations) return null;
  const direction = facing === 'west' ? 'east' : facing;
  const key = action === 'walk' && definition.animations[`walk_${direction}`] ? `walk_${direction}` : action;
  const animation = definition.animations[key] || definition.animations.idle || Object.values(definition.animations)[0];
  if (!animation?.frames?.length) return null;
  const duration = animation.frames.reduce((sum, frame) => sum + (frame.duration || 240), 0);
  let time = animated ? animation.loop === false ? Math.min(Math.max(0, elapsed), duration - 1) : Math.max(0, elapsed) % duration : 0;
  for (const frame of animation.frames) { time -= frame.duration || 240; if (time < 0) return frame; }
  return animation.frames[0];
}
