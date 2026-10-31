import { progressPersonalGoal } from './personal-goals.js';
// The ledger is private, bounded evidence of actual changes, not a public feed.
export const LEDGER_LIMIT = 100;
export const MARKET_RULES = {
  place: { id: 'supply', scene_id: 'plaza', name: '营地补给柜', x: 12, y: 7, service_center: { x: 11, y: 8 }, radius: 2 },
  max_quantity: 10, window_seconds: 300, buy_limit: 20, sell_limit: 30, stock_policy: 'per_agent_window',
  items: [
    { item_id: 'wood', buy_price: 4, sell_price: 1 }, { item_id: 'ore', buy_price: 6, sell_price: 2 },
    { item_id: 'turnip_seed', buy_price: 1, sell_price: null }, { item_id: 'wheat_seed', buy_price: 2, sell_price: null },
    { item_id: 'turnip', buy_price: null, sell_price: 2 }, { item_id: 'wheat', buy_price: null, sell_price: 3 },
  ],
};
const quantity = value => Number.isSafeInteger(value) && value >= 0;
const itemId = id => /^[a-z][a-z0-9_]{0,39}$/.test(id);
const quantities = (values, allowed, signed = false) => Object.fromEntries(Object.entries(values || {}).filter(([id, value]) =>
  itemId(id) && (!allowed || allowed.has(id)) && Number.isSafeInteger(value) && (signed || value >= 0) && value !== 0));
export function economyBalance(a) {
  return { inventory: quantities(a.life?.inventory), gold: quantity(a.adventure?.gold) ? a.adventure.gold : 0 };
}
export function initializeEconomy(a, now, { initial = false } = {}) {
  if (!a.life.ledger || !Array.isArray(a.life.ledger.entries) || !quantity(a.life.ledger.total_entries)) {
    const balances = economyBalance(a);
    a.life.ledger = { limit: LEDGER_LIMIT, total_entries: 1, entries: [{ entry_id: 'ledger_1', source_id: `${initial ? 'initial' : 'opening'}:${a.agent_id}`,
      at: now, reason: initial ? 'initial_grant' : 'opening_balance', items: {}, gold_delta: 0, balances }] };
  } else { a.life.ledger.limit = LEDGER_LIMIT; a.life.ledger.entries = a.life.ledger.entries.slice(-LEDGER_LIMIT); }
  if (!a.life.market || !quantity(a.life.market.window_started_at)) a.life.market = { window_started_at: now, bought: 0, sold: 0 };
  for (const key of ['bought', 'sold']) if (!quantity(a.life.market[key])) a.life.market[key] = key === 'bought' ? MARKET_RULES.buy_limit : MARKET_RULES.sell_limit;
}
export function recordEconomyDelta(a, before, { source_id, reason, at, world, countProgress = true }) {
  const balances = economyBalance(a), items = {};
  for (const id of new Set([...Object.keys(before.inventory), ...Object.keys(balances.inventory)])) {
    const delta = (balances.inventory[id] || 0) - (before.inventory[id] || 0);
    if (delta) items[id] = delta;
  }
  const gold_delta = balances.gold - before.gold;
  if (!Object.keys(items).length && !gold_delta) return;
  const ledger = a.life.ledger;
  if (ledger.entries.some(entry => entry.source_id === source_id)) return;
  ledger.total_entries = Math.min(Number.MAX_SAFE_INTEGER, ledger.total_entries + 1);
  ledger.entries.push({ entry_id: `ledger_${ledger.total_entries}`, source_id, at, reason, items, gold_delta, balances });
  if (ledger.entries.length > LEDGER_LIMIT) ledger.entries.splice(0, ledger.entries.length - LEDGER_LIMIT);
  if (world && countProgress) for (const [target_id, amount] of Object.entries(items)) if (amount > 0)
    progressPersonalGoal(world, a, { kind: 'collect_item', target_id, amount, source_id });
}
export function publicLedger(a, allowedIds) {
  const allowed = new Set(allowedIds), ledger = a.life?.ledger;
  return { limit: LEDGER_LIMIT, total_entries: quantity(ledger?.total_entries) ? ledger.total_entries : 0,
    entries: (ledger?.entries || []).slice(-LEDGER_LIMIT).map(entry => ({ entry_id: String(entry.entry_id).slice(0, 80), source_id: String(entry.source_id).slice(0, 200),
      at: quantity(entry.at) ? entry.at : 0, reason: String(entry.reason).slice(0, 40), items: quantities(entry.items, allowed, true),
      gold_delta: Number.isSafeInteger(entry.gold_delta) ? entry.gold_delta : 0,
      balances: { inventory: quantities(entry.balances?.inventory, allowed), gold: quantity(entry.balances?.gold) ? entry.balances.gold : 0 } })) };
}
export function marketWindow(a, now) {
  const current = a.life?.market || { window_started_at: now, bought: 0, sold: 0 }, duration = MARKET_RULES.window_seconds * 1000;
  const elapsed = Math.max(0, now - current.window_started_at), windows = Math.floor(elapsed / duration);
  return { window_started_at: current.window_started_at + windows * duration, bought: windows ? 0 : current.bought, sold: windows ? 0 : current.sold };
}
export function publicMarket(a, now) {
  const window = marketWindow(a, now);
  return { resets_at: window.window_started_at + MARKET_RULES.window_seconds * 1000,
    buy_remaining: Math.max(0, MARKET_RULES.buy_limit - window.bought), sell_remaining: Math.max(0, MARKET_RULES.sell_limit - window.sold) };
}
