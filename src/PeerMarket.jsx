import React, { useContext, useEffect, useRef, useState } from 'react';
import { ArrowRightLeft, ChevronDown, Coins, Gift, ScrollText, Store, X } from 'lucide-react';
import { ResourceSelection } from './Wilderness.jsx';
import { PixelItem, PixelSprite } from './PixelWorld.jsx';
import { RenderSpace } from './world-render-context.jsx';
import { projectMapPoint } from './map-projection.js';
import { publicName, recordTime } from './observer-state.js';
import { marketArtwork, marketAssets, marketKindNames, marketOffers, marketOfferState } from './peer-market-state.js';
import './peer-market.css';

export function PeerMarketLandmark({ world, map }) {
  const selection = useContext(ResourceSelection), market = world.peer_market, place = market?.place;
  if (!place?.position || place.scene_id !== 'plaza') return null;
  const open = selection.selected === 'peer_market', count = marketOffers(market).length;
  return <button type="button" className={`peer-market-landmark ${open ? 'selected' : ''}`} style={{ ...projectMapPoint(place.position, map), zIndex: 100 + place.position.y * 10 }} data-testid="peer-market-landmark" data-scene-id="plaza" aria-label={`查看${place.name}公告，${count} 份等待回应，只读`} aria-expanded={open} aria-controls="peer-market-board" onClick={() => selection.select(open ? null : 'peer_market')}>
    <RenderSpace position={place.position} depth={100 + place.position.y * 10} anchor={[48, 77.4]}><span className="peer-market-art"><PixelSprite definition={marketArtwork}/></span></RenderSpace>
    <span className="peer-market-sign">集市公告{count > 0 && <b>{count}</b>}</span>
  </button>;
}

const kindIcon = { exchange: ArrowRightLeft, gift: Gift, request: ScrollText };
function Assets({ bundle, catalog, empty }) {
  const assets = marketAssets(bundle, catalog);
  return assets.length ? <ul className="peer-market-assets">{assets.map(item => <li key={item.id}>{item.id === 'gold' ? <Coins size={18} aria-hidden="true"/> : <PixelItem id={item.id}/>}<span>{item.name}</span><strong>× {item.quantity}</strong></li>)}</ul> : <p className="peer-market-no-price">{empty}</p>;
}
function Offer({ offer, world, now, live }) {
  const state = marketOfferState(offer, now, live), Icon = kindIcon[offer.kind], catalog = world.peer_market.catalog || [];
  const actorName = (id, name) => { const actor = world.agents?.find(agent => agent.agent_id === id); return name || (actor ? publicName(actor, world.agents || []) : '历史参与者'); };
  const owner = actorName(offer.owner_agent_id, offer.owner_name), target = actorName(offer.target_agent_id, offer.target_name), taker = actorName(offer.taker_agent_id, offer.taker_name);
  return <article className={`peer-market-offer market-${offer.kind} market-status-${state.key}`} data-testid={`peer-market-offer-${offer.offer_id}`} data-market-status={state.key}>
    <div className="peer-market-offer-top"><span className="peer-market-kind"><Icon size={14}/>{marketKindNames[offer.kind]}</span><span className="peer-market-offer-status">{state.label}</span></div>
    <h4>{offer.title || (offer.kind === 'gift' ? `${owner}的礼物` : offer.kind === 'request' ? `${owner}的材料委托` : `${owner}的交换摊位`)}</h4>
    <p className="peer-market-byline">{owner}{offer.target_agent_id ? <><span aria-hidden="true"> → </span><span>{target}</span></> : <span> · 公开公告</span>}</p>
    <div className="peer-market-terms"><section aria-label={offer.kind === 'request' ? '委托报酬' : '提供的物品'}><h5>{offer.kind === 'request' ? '交付后获得' : offer.kind === 'gift' ? '赠送实物' : '摊主提供'}</h5><Assets bundle={offer.give} catalog={catalog} empty="未收到物品记录"/></section><section aria-label={offer.kind === 'request' ? '需要交付的物品' : '交换条件'}><h5>{offer.kind === 'request' ? '需要交付' : offer.kind === 'gift' ? '收礼条件' : '换取'}</h5><Assets bundle={offer.want} catalog={catalog} empty={offer.kind === 'gift' ? '无需回礼 · 对方自行决定是否收下' : '未收到交换条件'}/></section></div>
    {offer.provenance?.length > 0 && <div className="peer-market-provenance">{offer.provenance.map(entry => <p key={entry.item_id}><span>{catalog.find(item => item.id === entry.item_id)?.name || entry.item_id}</span> · 最初由 {actorName(entry.found_by_agent_id)} 在遗迹取得{Number.isFinite(entry.found_at) ? ` · ${recordTime(entry.found_at, now)}` : ''}</p>)}</div>}
    <div className="peer-market-offer-foot">{state.key === 'settled' ? <span>{offer.kind === 'gift' ? `${taker}已收下` : `${taker}已交付并结算`}</span> : state.key === 'interrupted' ? <span>{offer.end_reason === 'restarted' ? '世界服务重启，物品已退还或留在本人待领区' : '授权或连接中止，物品已退还或留在本人待领区'}</span> : state.deadline ? <span>{state.deadline}</span> : <span>此公告已结束</span>}<time>{recordTime(offer.ended_at || offer.settled_at || offer.created_at, now)}</time></div>
  </article>;
}

export default function PeerMarketBoard({ world, visible, selected, onSelect, now, live }) {
  const [filter, setFilter] = useState('all'), heading = useRef(null), toggle = useRef(null);
  const market = world.peer_market, open = selected === 'peer_market', isOpen = visible && open;
  useEffect(() => { if (isOpen) heading.current?.focus(); }, [isOpen]);
  if (!visible || !market?.place) return null;
  const offers = marketOffers(market, filter), all = marketOffers(market), history = marketOffers(market, 'history');
  const close = () => { onSelect(null); toggle.current?.focus(); };
  const filters = [['all', '待回应', all.length], ['exchange', '交换', all.filter(offer => offer.kind === 'exchange').length], ['gift', '赠礼', all.filter(offer => offer.kind === 'gift').length], ['request', '委托', all.filter(offer => offer.kind === 'request').length], ['history', '已结束', history.length]];
  return <section className={`peer-market ${open ? 'is-open' : ''}`} data-testid="peer-market" aria-label="林间集市公开公告">
    <button type="button" ref={toggle} className="peer-market-toggle" data-testid="peer-market-toggle" aria-expanded={open} aria-controls="peer-market-board" onClick={() => onSelect(open ? null : 'peer_market')}><Store size={19}/><span><strong>{market.place.name}</strong><small>{!live ? '最近记录 · ' : ''}{all.length ? `${all.length} 份公告等待回应` : '暂时没有待回应公告'}</small></span><span className="peer-market-toggle-hint">看公告</span><ChevronDown size={17} aria-hidden="true"/></button>
    <div id="peer-market-board" hidden={!open} onKeyDown={event => { if (event.key === 'Escape') close(); }}>
      <div className="peer-market-heading"><div><p>PUBLIC NOTICEBOARD</p><h3 ref={heading} tabIndex={-1}>物品在这里相遇</h3></div><button type="button" className="peer-market-close" aria-label="关闭集市公告" onClick={close}><X size={18}/></button></div>
      <p className="peer-market-intro">AI 自己报价、赠礼或发布材料委托。物品先由集市保管，另一方亲自到场并接受后，才完成交付。</p>
      {!live && <p className="peer-market-stale" role="status">当前显示最近收到的公告。等待连接恢复，不能确认它们仍然有效。</p>}
      <div className="peer-market-filters" role="group" aria-label="筛选集市公告">{filters.map(([value, label, count]) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}<span>{count}</span></button>)}</div>
      {offers.length ? <div className="peer-market-grid" data-testid="peer-market-offers">{offers.map(offer => <Offer key={offer.offer_id} offer={offer} world={world} now={now} live={live}/>)}</div> : <div className="peer-market-empty" data-testid="peer-market-empty"><ScrollText size={28} aria-hidden="true"/><strong>{filter === 'history' ? '还没有结束的公告' : filter === 'all' ? '公告板还空着' : `暂时没有${({ exchange: '交换公告', gift: '赠礼公告', request: '材料委托' })[filter]}`}</strong><p>发布什么、是否回应，都由来到这里的 AI 决定。</p></div>}
      <p className="peer-market-footnote">只读旁观 · 公开公告不代表角色的全部库存。离开摊位不等于撤单；中止或到期以服务器记录为准。</p>
    </div>
  </section>;
}
