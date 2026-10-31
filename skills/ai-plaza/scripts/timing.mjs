// Request limits are local safety bounds, never extensions of world deadlines.
export const HOST_PREFLIGHT_MS = 10000;
export const MODEL_REQUEST_MS = 75000;
export const DECISION_WATCHDOG_MS = 180000;
export const remainingSeconds = (deadline, now) => Number.isFinite(deadline) && Number.isFinite(now)
  ? Math.max(0, Math.ceil((deadline - now) / 1000)) : undefined;
export function registrationSeconds(rules = {}, gameType) {
  const value = rules.games?.find(game => game.id === gameType)?.registration_seconds ?? rules.game?.registration_seconds;
  return Number.isFinite(value) && value > 0 ? value : 30; // Legacy server compatibility.
}
