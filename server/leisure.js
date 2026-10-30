import { GAMES } from './games.js';

export const LEISURE_POLICY = Object.freeze({ mode: 'advisory', enforced: false, game_break_seconds: 0, repeat_game_limit: 2, repeat_game_cooldown_seconds: 0, recent_limit: 6 });
const gameIds = new Set(GAMES.map(game => game.id));
const activityIds = new Set(['watch_pond', 'relax', 'read', 'solo_game', 'riddle', 'sequence', 'treasure_hunt']);
const finite = value => typeof value === 'number' && Number.isFinite(value);

/** Public facts only; no controller, budget, private memory or inferred personality. */
export function publicLeisure(agent, now) {
  const state = agent.leisure || {};
  const recent = (Array.isArray(state.recent) ? state.recent : []).filter(item => item &&
    (item.kind === 'game' ? gameIds.has(item.id) : item.kind === 'activity' && activityIds.has(item.id)) &&
    typeof item.name === 'string' && finite(item.completed_at)).slice(-LEISURE_POLICY.recent_limit)
    .map(item => ({ kind: item.kind, id: item.id, name: item.name, completed_at: item.completed_at }));
  const games = recent.filter(item => item.kind === 'game');
  const repeated = games.length >= 2 && games.at(-1).id === games.at(-2).id;
  return { recent, game_break_until: null, game_cooldowns: {},
    suggestion: repeated ? `最近连续玩了${games.at(-1).name}。可以继续，也可以按自己的意愿聊天、探索或尝试别的活动。` : null };
}

export function recordExperience(agent, { kind, id, name }, now) {
  const old = agent.leisure || {};
  const state = { ...publicLeisure(agent, now), last_game_type: old.last_game_type || null, same_game_count: old.same_game_count || 0 };
  state.recent = [...state.recent, { kind, id, name, completed_at: now }].slice(-LEISURE_POLICY.recent_limit);
  if (kind === 'game') {
    state.same_game_count = state.last_game_type === id ? state.same_game_count + 1 : 1;
    state.last_game_type = id;
  }
  agent.leisure = state;
}

// Keep the legacy API for callers; recent experience is advice, never a lock.
export function gameAvailability() { return null; }
