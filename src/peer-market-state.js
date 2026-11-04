import { qServiceArtwork } from './q-service-art.js';
// This view reads posted terms only. A browser clock never settles or expires an offer.
export const marketKindNames = Object.freeze({ exchange: '交换', gift: '赠礼', request: '自主委托' });
const statuses = Object.freeze({ open: '等待回应', settled: '已成交', cancelled: '已撤回', expired: '已到期', declined: '已拒绝', interrupted: '已中止' });
export function marketOfferState(offer, now, live = true) {
  if (!offer || !statuses[offer.status]) return { key: 'unknown', label: '状态未收到', deadline: '' };
  const seconds = Number.isFinite(offer.expires_at) ? Math.max(0, Math.ceil((offer.expires_at - now) / 1000)) : null;
  const label = offer.status === 'settled' && offer.kind === 'gift' ? '礼物已收下' : offer.status === 'settled' && offer.kind === 'request' ? '已交付结算' : statuses[offer.status];
  return { key: offer.status, label: `${live ? '' : '最近记录 · '}${label}`, deadline: offer.status !== 'open' ? '' : !live ? '连接恢复后更新期限' : seconds === null ? '期限未收到' : seconds === 0 ? '期限已到，等待服务器确认' : seconds < 60 ? `剩余 ${seconds} 秒` : `剩余 ${Math.ceil(seconds / 60)} 分钟` };
}
export function marketAssets(bundle, catalog = []) {
  const items = Object.entries(bundle?.items || {}).filter(([id, quantity]) => typeof id === 'string' && Number.isSafeInteger(quantity) && quantity > 0)
    .map(([id, quantity]) => ({ id, name: catalog.find(item => item.id === id)?.name || id, quantity }));
  if (Number.isSafeInteger(bundle?.gold) && bundle.gold > 0) items.push({ id: 'gold', name: '金币', quantity: bundle.gold });
  return items;
}
export function marketOffers(market, filter = 'all') {
  return (market?.offers || []).filter(offer => Object.hasOwn(marketKindNames, offer.kind) && Object.hasOwn(statuses, offer.status))
    .filter(offer => filter === 'history' ? offer.status !== 'open' : offer.status === 'open' && (filter === 'all' || offer.kind === filter))
    .slice().sort((a, b) => filter === 'history' ? (b.ended_at || b.settled_at || b.created_at) - (a.ended_at || a.settled_at || a.created_at) : a.expires_at - b.expires_at || a.created_at - b.created_at);
}
export const marketArtwork = Object.freeze(qServiceArtwork.market_stall);
