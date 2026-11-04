import { randomUUID } from 'node:crypto';
import { PEER_MARKET_RULES, PEER_MARKET_STATUSES, PEER_MARKET_END_REASONS } from '../shared/peer-market.js';
import { findWorldPath, recordMovement } from './spatial.js';
import { economyBalance, recordEconomyDelta } from './economy.js';
import { RUINS_RULES } from '../shared/ruins-layout.js';

export { PEER_MARKET_RULES };
const knownItems = new Set(PEER_MARKET_RULES.catalog.map(i => i.id));
const empty = () => ({ items: {}, gold: 0 });
const clone = value => structuredClone(value);
const whole = value => Number.isSafeInteger(value) && value >= 0;
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = (value, max = 160) => typeof value === 'string' ? [...value].slice(0, max).join('') : '';
const records = world => Object.values(world.state.peer_market?.offers || {});
const open = offer => offer.status === 'open';
const ownOffer = (world, a) => records(world).find(o => open(o) && o.owner_agent_id === a.agent_id) || null;
const positive = assets => assets.gold > 0 || Object.keys(assets.items).length > 0;
const binding = a => ({ run_id: a.run.run_id, session_epoch: a.session_epoch });
const online = (world, a) => world.state.room.status === 'active' && a?.status === 'active' && a.run?.status === 'active' && a.run.expires_at > world.now()
  && Number.isFinite(a.last_contact_at) && a.last_contact_at + 45000 > world.now() && world.state.controllers[a.run.controller_id] && !world.state.controllers[a.run.controller_id].revoked;
const bound = (world, id, b) => { const a = world.state.agents[id]; return online(world, a) && b?.run_id === a.run.run_id && b?.session_epoch === a.session_epoch; };
const localFail = (code, message) => { throw Object.assign(new Error(message), { code }); };

function assets(value, fail) {
  if (!plain(value) || Object.keys(value).some(k => !['items', 'gold'].includes(k)) || value.items !== undefined && !plain(value.items)) fail('INVALID_ACTION', '物资只接受 items 和 gold');
  const items = value.items || {}, gold = value.gold ?? 0;
  if (Object.keys(items).length > PEER_MARKET_RULES.max_item_types || !whole(gold) || gold > PEER_MARKET_RULES.max_gold) fail('INVALID_ACTION', '每份条款最多4种物品、10000金币');
  for (const [id, quantity] of Object.entries(items)) if (!knownItems.has(id) || !Number.isSafeInteger(quantity) || quantity <= 0 || quantity > PEER_MARKET_RULES.max_quantity
    || id.startsWith('ruins_') && quantity !== 1) fail('INVALID_ACTION', '请选择集市目录中的实物，每种1至99份，唯一遗物只能1份');
  return { items: Object.fromEntries(Object.entries(items).sort(([a], [b]) => a.localeCompare(b))), gold };
}
function projectedAssets(raw) {
  try { return assets(raw, localFail); } catch { return empty(); }
}
export function publicPeerOffer(o) {
  if (!o || !PEER_MARKET_RULES.kinds.includes(o.kind) || !PEER_MARKET_STATUSES.includes(o.status) || typeof o.offer_id !== 'string') return null;
  return { offer_id: text(o.offer_id), revision: o.revision === 1 ? 1 : 0, kind: o.kind, title: text(o.title, 60), owner_agent_id: text(o.owner_agent_id), owner_name: text(o.owner_name, 20),
    target_agent_id: typeof o.target_agent_id === 'string' ? text(o.target_agent_id) : null, target_name: typeof o.target_name === 'string' ? text(o.target_name, 20) : null,
    give: projectedAssets(o.give), want: projectedAssets(o.want), created_at: whole(o.created_at) ? o.created_at : 0, expires_at: whole(o.expires_at) ? o.expires_at : 0,
    status: o.status, settled_at: whole(o.settled_at) ? o.settled_at : null, ended_at: whole(o.ended_at) ? o.ended_at : null,
    taker_agent_id: typeof o.taker_agent_id === 'string' ? text(o.taker_agent_id) : null, taker_name: typeof o.taker_name === 'string' ? text(o.taker_name, 20) : null,
    end_reason: PEER_MARKET_END_REASONS.includes(o.end_reason) ? o.end_reason : null,
    provenance: (Array.isArray(o.provenance) ? o.provenance : []).filter(p => p && knownItems.has(p.item_id) && p.item_id.startsWith('ruins_') && typeof p.found_by_agent_id === 'string' && whole(p.found_at))
      .slice(0, 3).map(p => ({ item_id: p.item_id, found_by_agent_id: text(p.found_by_agent_id), found_at: p.found_at })) };
}
export function publicPeerMarket(world) {
  return { version: 1, place: clone(PEER_MARKET_RULES.place), catalog: clone(PEER_MARKET_RULES.catalog), offers: records(world).map(publicPeerOffer).filter(Boolean)
    .sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open') || b.created_at - a.created_at || a.offer_id.localeCompare(b.offer_id)) };
}
const atMarket = a => a.scene_id === 'plaza' && !a.home_presence && !a.home_travel && a.position && Math.abs(a.position.x - PEER_MARKET_RULES.place.interaction_position.x) + Math.abs(a.position.y - PEER_MARKET_RULES.place.interaction_position.y) <= PEER_MARKET_RULES.place.radius + 1e-8;
function idle(world, a, fail) {
  if (!online(world, a)) fail('STALE_SESSION', '当前活动授权不可用');
  if (a.home_presence || a.home_travel || a.scene_id !== 'plaza') fail('SCENE_REQUIRED', '集市交付需要本人先回到生活广场');
  if (a.movement || a.activity || a.life?.gathering || a.adventure?.plan || a.survival?.travel || a.fishing || a.ruins_job || a.adventure?.encounter?.status === 'pending'
    || world.state.game?.status !== 'finished' && world.state.game?.participants?.includes(a.agent_id)) fail('ACTIVITY_BUSY', '须先自行结束当前活动或行程');
}
function requireMarket(world, a, fail) {
  idle(world, a, fail);
  if (!atMarket(a)) fail('NOT_AT_MARKET', '须本人实际走到林间集市的交付范围，可自行选择 approach');
}
function balanceAfter(a, give, receive, fail) {
  const current = economyBalance(a), next = { inventory: { ...current.inventory }, gold: current.gold - give.gold + receive.gold };
  if (current.gold < give.gold) fail('INSUFFICIENT_GOLD', '本人金币不足以履行这份条款');
  if (!whole(next.gold)) fail('INVENTORY_FULL', '一方金币数量已达安全上限');
  for (const id of new Set([...Object.keys(give.items), ...Object.keys(receive.items)])) {
    const held = current.inventory[id] || 0, spend = give.items[id] || 0, gain = receive.items[id] || 0;
    if (held < spend) fail('INSUFFICIENT_ITEMS', '本人尚未持有全部交付物资');
    const quantity = held - spend + gain;
    if (!whole(quantity)) fail('INVENTORY_FULL', '一方物品数量已达安全上限');
    next.inventory[id] = quantity;
  }
  return next;
}
function assignBalance(a, next) {
  // Preserve unrelated zero-valued inventory keys and every stateful item record.
  Object.assign(a.life.inventory, next.inventory); a.adventure.gold = next.gold;
}
function delta(world, a, before, source_id, reason, countProgress = false) {
  recordEconomyDelta(a, before, { source_id, reason, at: world.now(), world, countProgress });
}
function provenanceFor(world, give, want) {
  return RUINS_RULES.relics.filter(r => give.items[r.item_id] || want.items[r.item_id]).flatMap(r => {
    const claim = world.state.ruins.claims[r.id]; return claim ? [{ item_id: r.item_id, found_by_agent_id: claim.agent_id, found_at: claim.at }] : [];
  });
}
function announce(world, offer, change) {
  const descriptions = { posted: '发布了集市条款', settled: offer.kind === 'gift' ? '完成了赠礼交付' : offer.kind === 'request' ? '完成了委托交货' : '完成了集市交换',
    cancelled: '撤回了集市条款', expired: '集市条款已到期', declined: '赠礼已被收礼人拒绝', interrupted: '集市条款因活动授权中断而撤回' };
  world.event('peer_market_changed', { scene_id: 'plaza', change, offer: publicPeerOffer(offer), text: `${offer.owner_name}：${descriptions[change]}` },
    [...new Set([offer.owner_agent_id, offer.target_agent_id, offer.taker_agent_id, ...world.activeIds()].filter(Boolean))]);
}
function prune(world) {
  const ended = records(world).filter(o => !open(o)).sort((a, b) => (b.ended_at || 0) - (a.ended_at || 0) || b.offer_id.localeCompare(a.offer_id));
  for (const o of ended.slice(PEER_MARKET_RULES.max_terminal)) delete world.state.peer_market.offers[o.offer_id];
}
function refund(world, offer) {
  if (!positive(offer.escrow)) return;
  const a = world.state.agents[offer.owner_agent_id];
  if (!a || a.peer_market_return) throw new Error('Invalid peer market escrow owner; preserve database for recovery');
  try {
    const before = economyBalance(a), next = balanceAfter(a, empty(), offer.escrow, localFail); assignBalance(a, next);
    delta(world, a, before, `peer_market:${offer.offer_id}:return`, 'peer_market_return');
  } catch (error) {
    if (error.code !== 'INVENTORY_FULL') throw error;
    a.peer_market_return = { offer_id: offer.offer_id, assets: clone(offer.escrow) };
  }
  offer.escrow = empty();
}
function end(world, offer, reason) {
  if (!open(offer)) return false;
  refund(world, offer); offer.status = ['cancelled', 'expired', 'declined'].includes(reason) ? reason : 'interrupted';
  offer.end_reason = reason; offer.ended_at = world.now(); announce(world, offer, offer.status); prune(world); return true;
}
export function endPeerMarket(world, a, reason = 'authorization_ended') {
  let changed = false;
  for (const offer of records(world)) if (open(offer) && (offer.owner_agent_id === a.agent_id || offer.target_agent_id === a.agent_id)) changed = end(world, offer, reason) || changed;
  return changed;
}
function live(world, offer) {
  return offer.expires_at > world.now() && bound(world, offer.owner_agent_id, offer.owner_binding) && (!offer.target_agent_id || bound(world, offer.target_agent_id, offer.target_binding));
}
export function tickPeerMarket(world) {
  let changed = false;
  for (const offer of records(world)) if (open(offer) && !live(world, offer)) changed = end(world, offer, offer.expires_at <= world.now() ? 'expired' : 'authorization_ended') || changed;
  return changed;
}
export function initializePeerMarket(world, { restore = false } = {}) {
  world.state.peer_market ??= { version: 1, offers: {} };
  if (world.state.peer_market.version !== 1 || !plain(world.state.peer_market.offers)) throw new Error('Invalid persisted peer market; preserve database for recovery');
  for (const a of Object.values(world.state.agents)) {
    a.peer_market_return ??= null;
    a.peer_market_page = whole(a.peer_market_page) ? a.peer_market_page : 0;
    if (a.peer_market_return && (!plain(a.peer_market_return) || Object.keys(a.peer_market_return).some(k => !['offer_id', 'assets'].includes(k))
      || typeof a.peer_market_return.offer_id !== 'string' || !positive(assets(a.peer_market_return.assets, localFail)))) throw new Error('Invalid peer market pending return');
  }
  const owners = new Set(), incoming = new Map();
  const validBinding = b => plain(b) && Object.keys(b).length === 2 && typeof b.run_id === 'string' && b.run_id.length > 0 && whole(b.session_epoch);
  for (const [id, offer] of Object.entries(world.state.peer_market.offers)) {
    const keys = ['offer_id', 'revision', 'kind', 'title', 'owner_agent_id', 'owner_name', 'target_agent_id', 'target_name', 'give', 'want', 'escrow', 'owner_binding', 'target_binding',
      'created_at', 'expires_at', 'status', 'settled_at', 'ended_at', 'taker_agent_id', 'taker_name', 'end_reason', 'provenance'];
    if (!plain(offer) || Object.keys(offer).some(k => !keys.includes(k)) || !publicPeerOffer(offer) || id !== offer.offer_id || offer.revision !== 1 || !world.state.agents[offer.owner_agent_id]
      || typeof offer.title !== 'string' || [...offer.title].length > 60 || typeof offer.owner_name !== 'string' || !validBinding(offer.owner_binding)
      || !whole(offer.created_at) || !whole(offer.expires_at) || offer.expires_at <= offer.created_at || offer.expires_at - offer.created_at > 1800000
      || !Array.isArray(offer.provenance) || JSON.stringify(publicPeerOffer(offer).provenance) !== JSON.stringify(offer.provenance)) throw new Error('Invalid persisted peer market offer');
    const give = assets(offer.give, localFail), want = assets(offer.want, localFail), escrow = assets(offer.escrow, localFail);
    if (!positive(give) || (offer.kind === 'gift' ? positive(want) || !world.state.agents[offer.target_agent_id] || offer.target_agent_id === offer.owner_agent_id || !validBinding(offer.target_binding)
      : !positive(want) || offer.target_agent_id !== null || offer.target_binding !== null) || give.gold && want.gold || Object.keys(give.items).some(id => want.items[id])
      || open(offer) && JSON.stringify(give) !== JSON.stringify(escrow) || !open(offer) && positive(escrow)) throw new Error('Invalid persisted peer market escrow');
    if (open(offer)) {
      if (owners.has(offer.owner_agent_id) || world.state.agents[offer.owner_agent_id].peer_market_return || offer.ended_at !== null || offer.settled_at !== null || offer.end_reason !== null || offer.taker_agent_id !== null) throw new Error('Invalid persisted open peer market offer');
      owners.add(offer.owner_agent_id);
      if (offer.target_agent_id) incoming.set(offer.target_agent_id, (incoming.get(offer.target_agent_id) || 0) + 1);
    } else if (!whole(offer.ended_at) || offer.ended_at < offer.created_at || (offer.status === 'settled'
      ? offer.settled_at !== offer.ended_at || !world.state.agents[offer.taker_agent_id] || offer.taker_agent_id === offer.owner_agent_id || offer.target_agent_id && offer.taker_agent_id !== offer.target_agent_id || offer.end_reason !== null
      : offer.settled_at !== null || offer.taker_agent_id !== null || !PEER_MARKET_END_REASONS.includes(offer.end_reason))) throw new Error('Invalid persisted ended peer market offer');
  }
  if (owners.size > PEER_MARKET_RULES.max_open || [...incoming.values()].some(n => n > PEER_MARKET_RULES.max_incoming_gifts)) throw new Error('Invalid persisted peer market capacity');
  for (const offer of records(world)) if (restore && open(offer)) end(world, offer, 'restarted');
  prune(world);
}
function exact(p, allowed, fail) { if (!plain(p) || Object.keys(p).some(k => !allowed.includes(k))) fail('INVALID_ACTION', '集市参数包含不支持的字段'); }
function checkedOffer(world, a, p, fail) {
  const offer = typeof p.offer_id === 'string' ? world.state.peer_market.offers[p.offer_id] : null;
  if (!offer || !open(offer)) fail('MARKET_UNAVAILABLE', '该条款已经结束或不存在，请重新观察');
  if (p.revision !== offer.revision) fail('MARKET_STALE', '请提供本次公开条款的原 revision');
  if (!live(world, offer)) fail('MARKET_UNAVAILABLE', '条款已到期或参与者活动授权已中断');
  return offer;
}
function canAccept(world, a, offer, fail) {
  requireMarket(world, a, fail);
  if (offer.owner_agent_id === a.agent_id) fail('NOT_AUTHORIZED', '不能接受自己发布的条款');
  if (offer.target_agent_id && offer.target_agent_id !== a.agent_id) fail('NOT_AUTHORIZED', '这份赠礼只交给指定的收礼人');
  const owner = world.state.agents[offer.owner_agent_id];
  return { owner, ownerBalance: balanceAfter(owner, empty(), offer.want, fail), takerBalance: balanceAfter(a, offer.want, offer.escrow, fail) };
}
export function performPeerMarket(world, a, p, fail, actionId) {
  const allowed = { browse: ['intent', 'page'], approach: ['intent', 'mode'], post: ['intent', 'kind', 'title', 'duration_seconds', 'give', 'want', 'target_agent_id'],
    accept: ['intent', 'offer_id', 'revision'], decline: ['intent', 'offer_id', 'revision'], cancel: ['intent', 'offer_id', 'revision'], claim_return: ['intent', 'offer_id'] };
  if (typeof p.intent !== 'string' || !Object.hasOwn(allowed, p.intent)) fail('INVALID_ACTION', '请选择集市目录中的操作');
  exact(p, allowed[p.intent], fail);
  if (p.intent === 'browse') {
    const { total_pages } = boardPage(world, a);
    if (!whole(p.page) || p.page >= total_pages) fail('MARKET_PAGE', '该页不存在，请按当前总页数选择从0开始的页码');
    a.peer_market_page = p.page; return {};
  }
  if (p.intent === 'approach') {
    idle(world, a, fail);
    if (p.mode !== undefined && !['walk', 'run'].includes(p.mode)) fail('INVALID_ACTION', '移动方式只能是 walk 或 run');
    if (p.mode === 'run' && a.fatigue.energy <= 0) fail('FATIGUE_EXHAUSTED', '没有体力奔跑，仍可自行选择步行');
    const path = findWorldPath(world, 'plaza', a.position, PEER_MARKET_RULES.place.interaction_position);
    if (!path) fail('UNREACHABLE', '当前道路无法到达集市');
    if (path.length > 1) recordMovement(a, path, world.now(), p.mode || 'walk');
    return {};
  }
  if (p.intent === 'post') {
    requireMarket(world, a, fail);
    const duration = p.duration_seconds ?? PEER_MARKET_RULES.default_duration_seconds;
    if (!PEER_MARKET_RULES.kinds.includes(p.kind) || !Number.isInteger(duration) || duration < 60 || duration > 1800 || p.title !== undefined && (typeof p.title !== 'string' || !p.title.trim() || [...p.title].length > 60)) fail('INVALID_ACTION', '条款类型、标题或期限无效');
    const give = assets(p.give, fail), want = p.kind === 'gift' ? empty() : assets(p.want, fail);
    if (!positive(give) || p.kind !== 'gift' && !positive(want) || p.kind === 'gift' && p.want !== undefined || p.kind !== 'gift' && p.target_agent_id !== undefined) fail('INVALID_ACTION', '发布须提供实际托管；交换/委托须声明所需物品或金币，赠礼只指定收礼人且不要求回礼');
    if (give.gold && want.gold || Object.keys(give.items).some(id => want.items[id])) fail('INVALID_ACTION', '同一种物品或金币不能同时出现在条款两侧');
    const target = p.kind === 'gift' && typeof p.target_agent_id === 'string' ? world.state.agents[p.target_agent_id] : null;
    if (p.kind === 'gift' && (!target || target === a || !online(world, target))) fail('MARKET_TARGET', '请选择已获准活动的其他原角色作为收礼人');
    if (ownOffer(world, a)) fail('MARKET_LIMIT', '本人已有一份未结束的集市条款');
    if (a.peer_market_return) fail('MARKET_RETURN_PENDING', '先自行领取上一份待退物资，之后可发布新条款');
    if (records(world).filter(open).length >= PEER_MARKET_RULES.max_open || target && records(world).filter(o => open(o) && o.target_agent_id === target.agent_id).length >= PEER_MARKET_RULES.max_incoming_gifts) fail('MARKET_LIMIT', '当前集市或该收礼人的待处理赠礼已达上限');
    const expires = Math.min(world.now() + duration * 1000, a.run.expires_at, target?.run.expires_at ?? Infinity);
    if (expires <= world.now()) fail('INSUFFICIENT_TIME', '本次活动授权已无可用时间');
    const before = economyBalance(a), next = balanceAfter(a, give, empty(), fail);
    const provenance = provenanceFor(world, give, want);
    const offer = { offer_id: `offer_${randomUUID()}`, revision: 1, kind: p.kind, title: (p.title || '').trim(), owner_agent_id: a.agent_id, owner_name: a.name,
      target_agent_id: target?.agent_id || null, target_name: target?.name || null, give, want, escrow: clone(give), owner_binding: binding(a), target_binding: target ? binding(target) : null,
      created_at: world.now(), expires_at: expires, status: 'open', settled_at: null, ended_at: null, taker_agent_id: null, taker_name: null, end_reason: null, provenance };
    assignBalance(a, next); world.state.peer_market.offers[offer.offer_id] = offer;
    delta(world, a, before, actionId, 'peer_market_escrow'); announce(world, offer, 'posted'); prune(world);
    return { offer_id: offer.offer_id };
  }
  if (p.intent === 'claim_return') {
    requireMarket(world, a, fail);
    const pending = a.peer_market_return;
    if (!pending || p.offer_id !== pending.offer_id) fail('MARKET_RETURN', '没有属于本人的这一笔待退物资');
    const before = economyBalance(a), next = balanceAfter(a, empty(), pending.assets, fail); assignBalance(a, next);
    delta(world, a, before, `peer_market:${pending.offer_id}:return`, 'peer_market_return'); a.peer_market_return = null;
    return {};
  }
  const offer = checkedOffer(world, a, p, fail);
  if (p.intent === 'cancel') {
    if (offer.owner_agent_id !== a.agent_id) fail('NOT_AUTHORIZED', '只有发布者本人可以撤回条款');
    end(world, offer, 'cancelled');
  } else if (p.intent === 'decline') {
    if (offer.kind !== 'gift' || offer.target_agent_id !== a.agent_id) fail('NOT_AUTHORIZED', '只有指定收礼人可以拒绝这份赠礼');
    end(world, offer, 'declined');
  } else {
    const { owner, ownerBalance, takerBalance } = canAccept(world, a, offer, fail);
    const ownerBefore = economyBalance(owner), takerBefore = economyBalance(a);
    assignBalance(owner, ownerBalance); assignBalance(a, takerBalance); offer.escrow = empty();
    offer.status = 'settled'; offer.settled_at = world.now(); offer.ended_at = world.now(); offer.taker_agent_id = a.agent_id; offer.taker_name = a.name;
    // A requested relic may have been discovered after the contract was posted.
    // Record its actual finder at delivery without changing the exchange terms.
    offer.provenance = provenanceFor(world, offer.give, offer.want);
    delta(world, owner, ownerBefore, `peer_market:${offer.offer_id}:settled:owner`, 'peer_market_received', true);
    delta(world, a, takerBefore, actionId, 'peer_market_accepted', true);
    announce(world, offer, 'settled'); prune(world);
  }
  return {};
}
function boardPage(world, a) {
  const sorted = records(world).filter(o => open(o) && live(world, o)).sort((a, b) => a.created_at - b.created_at || a.offer_id.localeCompare(b.offer_id));
  const total_pages = Math.max(1, Math.ceil(sorted.length / PEER_MARKET_RULES.page_size)), page = Math.min(whole(a.peer_market_page) ? a.peer_market_page : 0, total_pages - 1);
  return { sorted, page, total_pages, page_size: PEER_MARKET_RULES.page_size, total_open: sorted.length,
    pageOffers: sorted.slice(page * PEER_MARKET_RULES.page_size, (page + 1) * PEER_MARKET_RULES.page_size) };
}
export function peerMarketObservation(world, a) {
  const view = publicPeerMarket(world), opportunities = [], { sorted, pageOffers, page, total_pages, page_size, total_open } = boardPage(world, a);
  const add = payload => opportunities.push({ type: 'peer_market', payload });
  const attempt = fn => { try { fn(); return true; } catch { return false; } };
  if (!atMarket(a) && attempt(() => idle(world, a, localFail)) && findWorldPath(world, 'plaza', a.position, PEER_MARKET_RULES.place.interaction_position)) add({ intent: 'approach' });
  for (const offer of records(world).filter(o => open(o) && live(world, o))) {
    const ref = { offer_id: offer.offer_id, revision: offer.revision };
    if (offer.owner_agent_id === a.agent_id) add({ intent: 'cancel', ...ref });
    if (offer.target_agent_id === a.agent_id) add({ intent: 'decline', ...ref });
    if (pageOffers.includes(offer) && attempt(() => canAccept(world, a, offer, localFail))) add({ intent: 'accept', ...ref });
  }
  if (a.peer_market_return && attempt(() => { requireMarket(world, a, localFail); balanceAfter(a, empty(), a.peer_market_return.assets, localFail); })) add({ intent: 'claim_return', offer_id: a.peer_market_return.offer_id });
  for (let next = 0; next < total_pages; next++) if (next !== page) add({ intent: 'browse', page: next });
  return { ...view, offers: pageOffers.map(publicPeerOffer), page, total_pages, page_size, total_open,
    incoming_gifts: sorted.flatMap((o, index) => o.target_agent_id === a.agent_id ? [{ offer_id: o.offer_id, revision: o.revision, page: Math.floor(index / page_size) }] : []),
    own_offer: publicPeerOffer(ownOffer(world, a)), pending_return: a.peer_market_return ? clone(a.peer_market_return) : null, at_market: atMarket(a), opportunities };
}
