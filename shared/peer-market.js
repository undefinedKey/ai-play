// Public world rules: these describe possible contracts, never choose one for an AI.
import { PLAZA_SERVICES } from './plaza-layout.js';
export const PEER_MARKET_CATALOG = Object.freeze([
  ['wood', '木材', 'material'], ['ore', '矿石', 'material'], ['grass', '干草', 'material'], ['fish_bait', '草编鱼饵', 'material'],
  ['turnip_seed', '萝卜种子', 'seed'], ['wheat_seed', '小麦种子', 'seed'], ['pine_cone', '松果', 'seed'],
  ['turnip', '萝卜', 'food'], ['wheat', '小麦', 'food'], ['turnip_soup', '萝卜浓汤', 'food'], ['wheat_bread', '麦香面包', 'food'],
  ['berry', '野生浆果', 'food'], ['roasted_berry', '篝火烤浆果', 'food'], ['moon_herb', '月光草', 'food'],
  ['trail_ration', '烤浆果口粮', 'food'], ['moon_stew', '月草炖果', 'food'], ['pond_fish', '池塘鱼', 'food'],
  ['silver_fish', '银鳞鱼', 'food'], ['grilled_fish', '香烤池塘鱼', 'food'],
  ['ruins_leaf_medallion', '叶纹纪念章', 'relic'], ['ruins_stone_bird', '石雕小鸟', 'relic'], ['ruins_star_lens', '星光镜片', 'relic'],
].map(([id, name, kind]) => Object.freeze({ id, name, kind })));

export const PEER_MARKET_RULES = Object.freeze({
  version: 1,
  place: { ...PLAZA_SERVICES.market },
  kinds: ['exchange', 'gift', 'request'], max_quantity: 99, max_item_types: 4, max_gold: 10000,
  min_duration_seconds: 60, max_duration_seconds: 1800, default_duration_seconds: 600,
  max_open_per_agent: 1, max_open: 20, max_incoming_gifts: 2, max_terminal: 40, page_size: 2,
  catalog: PEER_MARKET_CATALOG,
  notice: '集市只保管和结算本人明确发布的不可变条款。approach只走到集市，不自动发布、交易或领取。post须本人在集市，give从本人实物及金币立即托管；exchange换物/买卖，request发布交货委托，gift指定收礼人且无需回礼。accept须本人在集市，按offer_id与revision一次交付全部want并取得全部give，只有指定收礼人可接受gift。发布者可走开；任一所需授权失效、离线、暂停、到期或重启即撤回未成交条款并退还原托管，容量不足保留本人待退物。cancel和decline可在任何场景执行；claim_return须本人到集市。平台不定价、不分配任务、不自动撮合。',
});

export const PEER_MARKET_STATUSES = Object.freeze(['open', 'settled', 'cancelled', 'expired', 'declined', 'interrupted']);
export const PEER_MARKET_END_REASONS = Object.freeze(['cancelled', 'expired', 'declined', 'authorization_ended', 'restarted']);
