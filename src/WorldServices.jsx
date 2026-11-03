import React from 'react';
import { sceneName } from './scene-state.js';
import { phaseNames, resourceState } from './wilderness-state.js';
import { worldFoodServices, foodEffects } from './world-services-state.js';
import './world-services.css';

const coordinates = point => point && Number.isFinite(point.x) && Number.isFinite(point.y) ? `(${point.x}, ${point.y})` : '位置待确认';

export default function WorldServices({ world, live, now }) {
  const { market, offers, forage } = worldFoodServices(world);
  const time = live ? now : world.server_time || now;
  if (!offers.length && !forage.length) return null;
  return <details className="world-services" data-testid="world-services">
    <summary><strong>世界服务</strong><span>补给与拾取条件 · 只读</span></summary>
    <div className="world-services-body">
      {!live && <p className="service-snapshot">最近记录 · 连接恢复后更新库存与条件</p>}
      <div className="world-service-grid">
        {offers.length > 0 && <section className="world-service-card" aria-label="公开食物交易目录" data-testid="food-market">
          <h3>{market.place?.name || '食物补给柜'}</h3>
          <p>{sceneName(market.place?.scene_id)} · 服务中心 {coordinates(market.place?.service_center || market.place)}{Number.isFinite(market.place?.radius) ? ` · ${market.place.radius} 格范围` : ''}</p>
          <ul>{offers.map(({ item, price }) => <li key={item.id}><div><strong>{item.name}</strong><b>{price} 金币 / 份</b></div><span>食用效果：{foodEffects(item) || '以物品目录为准'}</span></li>)}</ul>
          <p className="service-limits">{Number.isFinite(market.max_quantity) ? `单次最多 ${market.max_quantity} 份。` : ''}{Number.isFinite(market.window_seconds) && Number.isFinite(market.buy_limit) ? `每位角色每 ${market.window_seconds} 秒最多购买 ${market.buy_limit} 份。` : ''}</p>
          <small>购买后存入角色仓库；吃东西是独立行动。</small>
        </section>}
        {forage.map(({ node, item }) => {
          const state = resourceState(node, world.agents, time);
          return <section className="world-service-card" key={node.id} aria-label={`${node.name}公开采集条件`} data-testid={`food-resource-${node.id}`}>
            <h3>{node.name}</h3><p>{sceneName(node.scene_id)} · 交互位置 {coordinates(node.interaction_position || node.position)}</p>
            <div className="service-facts"><span>共享储量 <b>{node.stock} / {node.max_stock}</b></span><span><b>{node.energy_cost}</b> 体力基础消耗</span><span>{node.tool_id ? '需要对应工具' : '无需工具'}</span><span><b>{node.duration_seconds}</b> 秒基础工作</span></div>
            <p>{state.label}{state.key === 'depleted' ? state.seconds > 0 ? ` · 约 ${state.seconds} 秒后恢复` : ' · 等待服务器确认恢复' : ''}</p>
            <p>每次获得 {item.name} × {node.yield_count}；{foodEffects(item)}。</p>
            {Number.isFinite(node.regrow_seconds) && <p>耗尽后 {node.regrow_seconds} 秒再生。</p>}
            {node.available_phases?.length > 0 && node.available_phases.length < 4 && <p>可采时段：{node.available_phases.map(phase => phaseNames[phase] || phase).join('、')}</p>}
            <small>到达交互位置后完成一次拾取；实际工作耗时按开始时段结算。食用是独立行动。</small>
          </section>;
        })}
      </div>
      <p className="service-boundary">这里展示世界提供的条件。选择什么、是否行动，由原 AI 自己决定。</p>
    </div>
  </details>;
}
