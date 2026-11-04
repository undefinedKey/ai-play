import test from 'node:test';
import assert from 'node:assert/strict';
import { marketAssets, marketOffers, marketOfferState, marketArtwork } from '../src/peer-market-state.js';
import { spriteRenderPacket, renderSpace } from '../src/render-packet.js';

test('v031 market renderer shows exactly declared assets, never an inventory or suggested price', () => {
  const bundle = { items: { wood: 3, ruins_leaf_medallion: 1 }, gold: 8, inventory: { ore: 999 }, suggested_price: 100 };
  assert.deepEqual(marketAssets(bundle, [{ id: 'wood', name: '木材' }, { id: 'ruins_leaf_medallion', name: '叶纹圆章' }]), [
    { id: 'wood', name: '木材', quantity: 3 }, { id: 'ruins_leaf_medallion', name: '叶纹圆章', quantity: 1 }, { id: 'gold', name: '金币', quantity: 8 },
  ]);
  assert.deepEqual(marketAssets({ items: { wood: 0, ore: -1, turnip: 1.5 }, gold: Infinity }), []);
  assert.deepEqual(marketAssets(null), []);
});

test('v031 market clock cannot invent settlement or expiry and stale offers stay qualified', () => {
  const offer = { kind: 'request', status: 'open', expires_at: 1100 }, before = structuredClone(offer);
  const late = marketOfferState(offer, 9000);
  assert.equal(late.key, 'open'); assert.match(late.deadline, /等待服务器确认/);
  assert.equal(marketOfferState(offer, 100).deadline, '剩余 1 秒');
  assert.match(marketOfferState(offer, 9000, false).label, /最近记录/);
  assert.equal(marketOfferState(offer, 9000, false).deadline, '连接恢复后更新期限');
  assert.deepEqual(offer, before);
  assert.equal(marketOfferState({ ...offer, kind: 'gift', status: 'settled' }, 9000).label, '礼物已收下');
  assert.equal(marketOfferState({ ...offer, status: 'settled' }, 9000).label, '已交付结算');
  assert.equal(marketOfferState({ ...offer, status: 'expired' }, 9000).key, 'expired');
});

test('v031 filters separate actual waiting offers and factual terminal records without altering terms', () => {
  const market = { offers: [
    { offer_id: 'gift', kind: 'gift', status: 'open', created_at: 2, expires_at: 5000 },
    { offer_id: 'done', kind: 'request', status: 'settled', created_at: 1, ended_at: 1200, expires_at: 4000 },
    { offer_id: 'exchange', kind: 'exchange', status: 'open', created_at: 1, expires_at: 3000 },
    { offer_id: 'cancel', kind: 'gift', status: 'cancelled', created_at: 1, ended_at: 2000, expires_at: 3000 },
  ] }, before = structuredClone(market);
  assert.deepEqual(marketOffers(market).map(offer => offer.offer_id), ['exchange', 'gift']);
  assert.deepEqual(marketOffers(market, 'gift').map(offer => offer.offer_id), ['gift']);
  assert.deepEqual(marketOffers(market, 'history').map(offer => offer.offer_id), ['cancel', 'done']);
  assert.deepEqual(marketOffers(market, 'request'), []);
  assert.deepEqual(market, before);
});

test('v031 market stall draws at its real world anchor on a small footprint with matching renderer geometry', () => {
  const frame = marketArtwork.animations.idle.frames[0], position = { x: 28, y: 17 };
  const packet = spriteRenderPacket(marketArtwork, frame, renderSpace(position, { anchor: [48, 77.4], depth: 270 }));
  assert.equal(packet.x, 28.5 * 32); assert.equal(packet.y, 17.5 * 32);
  assert.equal(packet.scale, .6); assert.deepEqual(packet.anchor, [80, 129]);
  assert.ok(frame.w * packet.scale <= 96); assert.equal(packet.depth, 270);
});
