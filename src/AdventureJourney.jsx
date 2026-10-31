import React from 'react';
import {PixelDiscovery} from './PixelWorld.jsx';
import {projectMapPoint} from './map-projection.js';
import {encounterState,goalState,goalKinds} from './journey-state.js';
import {lifeItemName} from './life-state.js';
import {publicName,recordTime} from './observer-state.js';
import {RenderSpace} from './world-render-context.jsx';

const resultText=result=>typeof result==='string'?result:result?.text;
const targetName=(world,goal)=>lifeItemName(world.life,goal.target_id)||goal.target_id;
function goalTarget(world,goal){return world.adventure?.zones?.find(zone=>zone.id===goal.target_id)?.name||world.adventure?.monsters?.find(monster=>monster.monster_id===goal.target_id)?.name||targetName(world,goal);}
function optionDescription(choice,catalog){const parts=[];if(choice.energy_cost)parts.push(`消耗 ${choice.energy_cost} 体力`);for(const[id,count]of Object.entries(choice.items||{}))parts.push(`${lifeItemName(catalog,id)} × ${count}`);if(choice.heal)parts.push(`最多恢复 ${choice.heal} 生命`);if(choice.restore_energy)parts.push(`最多恢复 ${choice.restore_energy} 体力`);return parts.join(' · ')||'不消耗，也不领取奖励';}

export function DiscoveryMarkers({world,map,selected,now,live}){
 const stateNow=live?now:world.server_time||now;
 const clusters=new Map();
 for(const agent of world.agents){const state=encounterState(agent,stateNow);if(!state)continue;const e=state.encounter;const terminalRecent=e.resolved_at&&stateNow>=e.resolved_at&&stateNow-e.resolved_at<15000;if(!e.position||!state.pending&&!terminalRecent)continue;const key=`${e.position.x},${e.position.y}`;const cluster=clusters.get(key)||[];cluster.push({agent,state});clusters.set(key,cluster);}
 return <div className="discovery-markers" role="group" aria-label="真实探索发现">{[...clusters.values()].map(cluster=>{
  const {agent,state}=cluster.find(entry=>entry.agent.agent_id===selected)||cluster[0],e=state.encounter;
  const flash=live&&agent.status==='active'&&e.status==='resolved'&&stateNow>=e.resolved_at&&stateNow-e.resolved_at<1500;
  return <span key={agent.agent_id} className={`discovery-marker ${selected===agent.agent_id?'selected':''} ${state.pending?'pending':'closed'}`} style={projectMapPoint(e.position,map)} data-testid={`discovery-${agent.agent_id}`} data-encounter-status={e.status} role="img" aria-label={`${publicName(agent,world.agents)}发现${state.title}，${!live?'最近记录：':''}${state.label}${cluster.length>1?`；此处共 ${cluster.length} 位角色有发现，可切换观察对象查看`:''}`}><RenderSpace position={e.position} depth={260} anchor={[24,42]} screenSize={.833333} alpha={state.pending?1:.7}><PixelDiscovery id={e.template_id} resolved={e.status==='resolved'} animate={flash}/></RenderSpace><span className="discovery-status-mark" aria-hidden="true">{cluster.length>1?cluster.length:state.pending?'?':e.status==='resolved'?'✓':'·'}</span>{selected===agent.agent_id&&<span className="discovery-map-label">{state.title}</span>}</span>;
 })}</div>;
}

export default function AdventureJourney({world,agent,now,live}){
 const stateNow=live?now:world.server_time||now;
 const encounter=encounterState(agent,stateNow),goal=goalState(agent?.personal_goal,stateNow);
 if(!encounter&&!goal)return null;
 const e=encounter?.encounter;
 const effects=e?.public_result&&typeof e.public_result==='object'?[...Object.entries(e.public_result.items||{}).filter(([,amount])=>amount>0).map(([id,amount])=>`${lifeItemName(world.life,id)} +${amount}`),...(e.public_result.hp>0?[`生命 +${e.public_result.hp}`]:[]),...(e.public_result.energy?[`体力 ${e.public_result.energy>0?'+':''}${e.public_result.energy}`]:[])]:[];
 return <section className="adventure-journey" aria-label="所选角色的公开旅程" data-testid="adventure-journey">
  {encounter&&<details className="encounter-details" key={e.event_id} data-testid="encounter-panel"><summary><PixelDiscovery id={e.template_id} resolved={e.status==='resolved'}/><span className="encounter-summary-text"><b>{encounter.title}</b><span>{!live?'最近记录 · ':''}{encounter.label}</span></span><span>{encounter.pending&&encounter.seconds>0?`${encounter.seconds} 秒`:recordTime(e.resolved_at||e.found_at,now)}</span></summary><div className="encounter-body"><p>{encounter.pending?!live?'最近收到待选事件，重连前无法确认保护仍有效。':encounter.seconds>0?'原 AI 需要在期限内选择；等待期间受保护。旁观者可以查看规则。':'期限已到，等待服务器确认；此处不再显示保护仍然有效。':'以下是服务器确认的处理结果。'}</p><dl className="journey-facts"><div><dt>发现地点</dt><dd>{world.adventure?.zones?.find(zone=>zone.id===e.zone_id)?.name||e.zone_id} · ({e.position?.x}, {e.position?.y})</dd></div><div><dt>发现时间</dt><dd>{recordTime(e.found_at,now)}</dd></div><div><dt>选择截止</dt><dd>{recordTime(e.expires_at,now)}</dd></div><div><dt>下次可发现</dt><dd>{recordTime(agent.adventure.discovery_ready_at,now)}</dd></div></dl><ul className="encounter-options" aria-label="AI 可选择的公开规则">{(e.choices||[]).map(choice=><li key={choice.choice_id} className={choice.choice_id===e.selected_choice_id?'chosen':''}><strong>{choice.name}{choice.choice_id===e.selected_choice_id?' · AI 已选择':''}</strong><span>{optionDescription(choice,world.life)}</span></li>)}</ul>{resultText(e.public_result)&&<p className="encounter-result" role="status">{resultText(e.public_result)}</p>}{effects.length>0&&<ul className="encounter-effects" aria-label="这次选择的实际变化">{effects.map(effect=><li key={effect}>{effect}</li>)}</ul>}<p className="journey-note">这些是公开规则，不表示角色能支付对应成本。聊天或重复探索不会延长选择期限；离开、过期或中断不会自动领取奖励。</p></div></details>}
  {goal&&<section className={`personal-goal status-${goal.goal.status}`} data-testid="personal-goal"><div className="goal-heading"><span>AI 的公开短期目标</span><strong>{!live?'最近记录 · ':''}{goal.label}</strong></div><p className="goal-public-title">{goal.goal.title||`${goalKinds[goal.goal.kind]||'自主目标'}：${goalTarget(world,goal.goal)}`}</p><div className="goal-progress"><span>{goalKinds[goal.goal.kind]||'目标'} · {goalTarget(world,goal.goal)}</span><strong>{goal.progress} / {goal.target}</strong></div><progress aria-label="公开目标已确认进度" value={goal.progress} max={goal.target}/><details className="goal-details"><summary>进度来源与期限</summary><p>只统计这个目标建立之后服务器确认的成功结果，不代表当前仓库余额。完成目标不会自动领奖或开始下一项活动。</p><dl className="journey-facts"><div><dt>建立时间</dt><dd>{recordTime(goal.goal.created_at,now)}</dd></div><div><dt>最近状态更新</dt><dd>{recordTime(goal.goal.updated_at,now)}</dd></div><div><dt>固定截止</dt><dd>{recordTime(goal.goal.expires_at,now)}</dd></div></dl>{goal.goal.status==='needs_review'&&<p>活动中断后需要原 AI 明确复核，复核前不累计进度，原截止时间不顺延。</p>}</details></section>}
 </section>;
}
