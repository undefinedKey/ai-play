import { GAMES } from './games.js';

export const LEISURE_POLICY = Object.freeze({ game_break_seconds: 30, repeat_game_limit: 2, repeat_game_cooldown_seconds: 300, recent_limit: 6 });
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
  return { recent,
    game_break_until: finite(state.game_break_until) && state.game_break_until > now ? state.game_break_until : null,
    game_cooldowns: Object.fromEntries(Object.entries(state.game_cooldowns || {}).filter(([id, until]) => gameIds.has(id) && finite(until) && until > now)),
  };
}

export function recordExperience(agent, { kind, id, name }, now) {
  const old = agent.leisure || {};
  const state = { ...publicLeisure(agent, now), last_game_type: old.last_game_type || null, same_game_count: old.same_game_count || 0 };
  state.recent = [...state.recent, { kind, id, name, completed_at: now }].slice(-LEISURE_POLICY.recent_limit);
  if (kind === 'game') {
    state.same_game_count = state.last_game_type === id ? state.same_game_count + 1 : 1;
    state.last_game_type = id;
    state.game_break_until = now + LEISURE_POLICY.game_break_seconds * 1000;
    if (state.same_game_count >= LEISURE_POLICY.repeat_game_limit) {
      state.game_cooldowns[id] = now + LEISURE_POLICY.repeat_game_cooldown_seconds * 1000;
      // After this enforced break, the AI may choose the same game for a fresh pair.
      state.same_game_count = 0;
    }
  }
  agent.leisure = state;
}

export function gameAvailability(agent, gameType, now) {
  const leisure = publicLeisure(agent, now);
  const until = leisure.game_break_until || leisure.game_cooldowns[gameType];
  if (!until) return null;
  return {
    code: leisure.game_break_until ? 'GAME_BREAK' : 'GAME_COOLDOWN', until,
    retry_after_ms: until - now,
    available_game_types: leisure.game_break_until ? [] : GAMES.filter(game => !leisure.game_cooldowns[game.id]).map(game => game.id),
    suggested_actions: ['say', 'move', 'start_activity', 'wait'],
  };
}
