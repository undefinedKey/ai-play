import { RESOURCE_NODES } from '../shared/resources-layout.js';

// Generic movement and auto-approach helpers must not bypass encounter stops.
// They remain unchanged in every original scene. In the trail, travel owns the
// route; harvesting starts only once the AI has actually reached the resource.
export function journeyActionAllowed(a, type, payload = {}) {
  if (a.scene_id !== 'journey') return true;
  if (['journey', 'wait', 'say', 'personal_goal', 'inventory', 'create_group', 'invite', 'respond_invite', 'leave_group'].includes(type)) return true;
  if (type === 'cooperation') return ['respond', 'confirm', 'leave', 'claim_return'].includes(payload.intent);
  if (type === 'survival') return payload.intent !== 'approach';
  if (type !== 'gather') return false;
  if (payload.intent === 'cancel') return true;
  const node = RESOURCE_NODES.find(n => n.id === payload.node_id && n.scene_id === 'journey');
  return !!node && Math.abs(a.position.x - node.interaction_position.x) + Math.abs(a.position.y - node.interaction_position.y) <= 3;
}

export function filterJourneyObservation(a, observation) {
  if (a.scene_id !== 'journey') return observation;
  const permitted = row => {
    const action = row.action || row;
    return journeyActionAllowed(a, action.type, action.payload);
  };
  const result = { ...observation, movement: { ...observation.movement, candidates: [] } };
  if (Array.isArray(result.opportunities)) result.opportunities = result.opportunities.filter(permitted);
  for (const [key, value] of Object.entries(result)) {
    if (value && !Array.isArray(value) && Array.isArray(value.opportunities))
      result[key] = { ...value, opportunities: value.opportunities.filter(permitted) };
  }
  return result;
}
