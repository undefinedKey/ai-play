// Only a receipt written by World.act is public. Runtime reports, payloads,
// private communication, hidden game choices and model reasoning stay private.
const PUBLIC_ACTION_TYPES = new Set([
  'move', 'start_activity', 'finish_activity', 'adventure_plan', 'adventure_event',
  'farm', 'inventory', 'gather', 'trade', 'survival', 'home', 'fish', 'ruins', 'peer_market', 'community', 'wait',
]);
const PUBLIC_ACTION_ERRORS = new Set([
  'COMMUNITY_BUSY','COMMUNITY_OCCUPIED','COMMUNITY_UNAVAILABLE','COMMUNITY_STALE','COMMUNITY_PAGE','COMMUNITY_LIMIT','COMMUNITY_ALREADY_JOINED','COMMUNITY_FULL','COMMUNITY_HOST','COMMUNITY_NOT_JOINED','COMMUNITY_STARTED','COMMUNITY_NOT_STARTED','NO_COMMUNITY_USE','NOT_AT_BOARD','NOT_AT_VENUE',
  'MARKET_UNAVAILABLE', 'MARKET_STALE', 'MARKET_TARGET', 'MARKET_LIMIT', 'MARKET_RETURN_PENDING', 'MARKET_RETURN', 'MARKET_PAGE', 'NOT_AT_MARKET', 'INVENTORY_FULL',
  'FATIGUE_EXHAUSTED', 'INSUFFICIENT_ITEMS', 'INSUFFICIENT_GOLD', 'NOT_AT_CAMP',
  'ACTIVITY_BUSY', 'GATHER_BUSY', 'FISHING_BUSY', 'HOME_BUSY', 'HOME_USE_BUSY',
  'MOVEMENT_BUSY', 'GAME_BUSY', 'GATHER_UNAVAILABLE', 'RESOURCE_BUSY',
  'RESOURCE_DEPLETED', 'RESOURCE_PHASE', 'NOT_PLANTABLE', 'TRADE_UNAVAILABLE',
  'TRADE_LIMIT', 'FULL_ENERGY', 'FULL_HEALTH', 'INVALID_ACTION',
  'RUINS_BUSY', 'RUINS_OCCUPIED', 'RUINS_ALREADY_OPEN', 'RUINS_ALREADY_CLAIMED',
  'SCENE_REQUIRED', 'UNREACHABLE', 'OUT_OF_RANGE', 'NO_RUINS_JOB', 'INSUFFICIENT_TIME',
]);

export function publicActionStatus(agent, now) {
  const d = agent?.diagnostics;
  if (!d || !PUBLIC_ACTION_TYPES.has(d.last_action_type)
    || !['applied', 'rejected'].includes(d.last_action_status)
    || !Number.isSafeInteger(d.last_action_at) || d.last_action_at < 0
    || !Number.isFinite(now) || d.last_action_at > now) return null;
  return {
    type: d.last_action_type, status: d.last_action_status, at: d.last_action_at,
    ...(d.last_action_status === 'rejected' && PUBLIC_ACTION_ERRORS.has(d.last_action_error)
      ? { error_code: d.last_action_error } : {}),
  };
}
