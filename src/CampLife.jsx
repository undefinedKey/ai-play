import React,{useEffect,useRef,useState} from 'react';
import {PixelItem,PixelLandmark} from './PixelWorld.jsx';
import {projectMapPoint} from './map-projection.js';
import {gatheringState,lifeItemName,publicLifeResult} from './life-state.js';
import {recordTime} from './observer-state.js';
import {RenderSpace} from './world-render-context.jsx';

// All placements come from server rules; decorative trees are not gathering nodes.
export function CampLandmarks({catalog,map}) {
  const host=useRef(null),[scale,setScale]=useState(1);
  useEffect(()=>{const resize=new ResizeObserver(entries=>setScale(entries[0].contentRect.width/768));if(host.current)resize.observe(host.current);return()=>resize.disconnect();},[]);
  const resources=catalog?.gathering?.resources||[];
  const places=[...resources.map(node=>({...node,kind:node.id,label:node.item_id==='wood'?'拾枝':'碎矿'})),...[catalog?.cooking_place,catalog?.market?.place].filter(Boolean).map(place=>({...place,kind:place.id,label:place.id==='kitchen'?'料理':'补给'}))];
  return <div ref={host} className="camp-landmarks" aria-label="营地生活设施" style={{'--world-prop-scale':scale}}>{places.map(place=><span key={place.id} className={`camp-landmark landmark-${place.kind}`} style={{...projectMapPoint(place,map),zIndex:100+place.y*10}} role="img" aria-label={`${place.name}，坐标 ${place.x}, ${place.y}`} data-testid={`life-node-${place.id}`}><RenderSpace position={place} depth={100+place.y*10} anchor={[32,57.6]}><PixelLandmark id={place.kind}/></RenderSpace><span>{place.label}</span></span>)}</div>;
}

export default function CampLife({world,agent,now,live}) {
  const catalog=world.life||world.rules?.life;
  if(!catalog?.gathering)return null;
  const stateNow=live?now:world.server_time||now;
  const gathering=gatheringState(agent,catalog,stateNow);
  const last=publicLifeResult(agent,world.events);
  const resources=catalog.gathering.resources||[];
  const recipes=(catalog.recipes||[]).filter(recipe=>recipe.kind==='cooking');
  const market=catalog.market;
  return <section className="camp-life" data-testid="camp-life" aria-label="营地生活">
    {gathering&&<div className="gather-current" data-testid="gather-current" role="status"><PixelItem id={gathering.job.item_id}/><div><strong>{!live?'最近记录 · ':''}{gathering.awaiting?'等待服务器确认采集结果':`正在采集${gathering.name}`}</strong><span>{!live?'连接恢复后更新进度':gathering.awaiting?'材料到账后才算完成。':`约 ${gathering.seconds} 秒 · 本次完成后获得 ${gathering.job.quantity} 份${gathering.name}`}</span><progress aria-label="本次采集进度" max={gathering.duration} value={gathering.elapsed}/></div></div>}
    {last&&<p className="life-last-result" data-testid="life-last-result"><span>最近生活记录 · {recordTime(last.occurred_at,now)}</span><strong>{last.payload?.text||({'life_gather_finished':'采集已完成','life_gather_cancelled':'采集已取消','life_crafted':'制作已完成','life_consumed':'已使用补给','life_traded':'交易已完成'}[last.type])}</strong></p>}
    <details className="camp-life-catalog"><summary><span>营地生活</span><span>徒手采集 · 料理 · 补给</span></summary><p className="life-catalog-note">AI 自己选择是否劳作或休息。采集供给与交易额度按每位角色独立计算。</p>
      <div className="life-catalog-grid"><section aria-label="徒手采集目录"><h3>徒手采集</h3>{resources.map(node=>{const seconds=agent?Math.max(0,Math.ceil(((agent.life?.gather_ready_at?.[node.id]||0)-stateNow)/1000)):0;return <article className="life-catalog-item" key={node.id}><PixelItem id={node.item_id}/><div><strong>{node.name}</strong><span>({node.x}, {node.y}) · {node.duration_seconds} 秒 / 次 · {node.energy_cost} 体力</span><span>每次 {node.yield_count} 份 · 完成后间隔 {node.cooldown_seconds} 秒</span>{seconds>0&&<span>{!live?'最近记录：':''}所选角色约 {seconds} 秒后可再次开始</span>}</div></article>;})}<p>无需农具。离开、暂停或失联会取消本次工作；不会自动开始下一轮。</p></section>
      <section aria-label="料理目录"><h3>{catalog.cooking_place?.name||'料理台'}</h3>{recipes.map(recipe=>{const id=recipe.item_id||recipe.id;const item=catalog.items?.find(item=>item.id===id);return <article className="life-catalog-item" key={id}><PixelItem id={id}/><div><strong>{lifeItemName(catalog,id)}</strong><span>{Object.entries(recipe.ingredients||recipe.cost||{}).map(([key,value])=>`${lifeItemName(catalog,key)} × ${value}`).join(' · ')} · {recipe.energy_cost} 体力</span><span>{item?.heal>0?`恢复 ${item.heal} 生命`:''}{item?.energy_restore>0?`恢复 ${item.energy_restore} 体力`:''}</span></div></article>;})}<p>在营地即时制作，成功回执后才显示结果。营地免费休息仍然可用。</p></section>
      {market&&<section aria-label="补给价格目录"><h3>{market.place?.name||'补给柜'}</h3><div className="market-price-head"><span>物品</span><span>买入 / 卖出</span></div>{market.items.map(item=><div className="market-price" key={item.item_id}><span><PixelItem id={item.item_id}/>{lifeItemName(catalog,item.item_id)}</span><span>{item.buy_price??'—'} / {item.sell_price??'—'} 金币</span></div>)}<p>每人每 {market.window_seconds/60} 分钟最多买 {market.buy_limit} 件、卖 {market.sell_limit} 件；每次最多 {market.max_quantity} 件。— 表示不支持该方向。</p></section>}</div>
    </details>
  </section>;
}
