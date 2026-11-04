import React from 'react';
import {CharacterSprite} from './PixelWorld.jsx';
import {presenceState,presenceLabel,publicName,recordTime} from './observer-state.js';
import {goalState} from './journey-state.js';
import {cooperationSummary} from './cooperation-state.js';
import {sceneName} from './scene-state.js';
import {homeLocation} from './home-state.js';
import WorldCamera from './WorldCamera.jsx';
import WorldServices from './WorldServices.jsx';
import {observerExecution,observerActionResult,observerConditions} from './world-services-state.js';
import {wardrobeDescription} from './wardrobe-state.js';

export {CameraContext} from './camera-context.js';
export function MapCamera({children,speech,status}){
  return <WorldCamera speech={speech} status={status}>{children}</WorldCamera>;
}

export function ObserverStatus({world,agent,live,now}){
  const active=world.agents.filter(a=>a.status==='active').length;
  const paused=world.agents.filter(a=>presenceState(a)==='paused').length;
  const latest=[...(world.events||[])].reverse().find(e=>!['move','moved','agent_moved'].includes(e.type));
  const homeLabel=homeLocation(agent,world.homes);
  const position=agent?.home_presence?.position||agent?.position;
  const time=live?now:world.server_time||now;
  const execution=observerExecution(world,agent,time),receipt=observerActionResult(agent),conditions=observerConditions(world,agent);
  const goal=goalState(agent?.personal_goal,time),cooperation=cooperationSummary(world,agent?.agent_id,time);
  const wardrobe=wardrobeDescription(agent);
  return <><section className="observer-status" data-testid="observer-status" aria-label="当前观察状态">
    {agent?<>
      <span className="observer-avatar" aria-hidden="true"><CharacterSprite agent={agent} portrait/></span>
      <div className="observer-copy">
        <strong>{publicName(agent,world.agents)}</strong>
        <span>{!live?'最近记录 · ':''}{presenceLabel(agent)} · {homeLabel||sceneName(agent.scene_id)}{agent.status!=='offline'&&position?` · (${Number(position.x.toFixed(1))}, ${Number(position.y.toFixed(1))})`:''}</span>
        <span className="observer-execution-label" data-testid="observer-execution" data-execution={execution.kind}>{execution.text}</span>
        {conditions.length>0&&<span className="observer-condition-facts" data-testid="observer-conditions">{conditions.join(' · ')}</span>}
        {receipt&&<span className="observer-action-result" data-testid="observer-action-result" data-result={receipt.status}>最近操作 · {receipt.text} · {recordTime(receipt.at,time)}</span>}
        {cooperation&&<span className="observer-cooperation-line" data-testid="cooperation-summary">合作 · {cooperation.text}</span>}
        {goal&&<span className="observer-goal-line">公开目标 · {goal.label} · {goal.progress}/{goal.target}</span>}
        {wardrobe.length>0&&<span className="observer-wardrobe" data-testid="observer-wardrobe">当前穿着 · {wardrobe.join(' · ')}</span>}
      </div>
      <div className="observer-vitals">{agent.adventure&&<span className="vital-health">生命 <b>{agent.adventure.hp}/{agent.adventure.max_hp}</b><i aria-hidden="true" style={{'--vital-fill':`${Math.max(0,Math.min(100,100*agent.adventure.hp/(agent.adventure.max_hp||1)))}%`}}/></span>}{agent.fatigue&&<span className="vital-energy">体力 <b>{Math.round(agent.fatigue.energy)}/{agent.fatigue.max_energy||100}</b><i aria-hidden="true" style={{'--vital-fill':`${Math.max(0,Math.min(100,100*agent.fatigue.energy/(agent.fatigue.max_energy||100)))}%`}}/></span>}</div>
    </>:<div className="observer-copy"><strong>世界概况 · {active} 位活动中{paused?`，${paused} 位暂停`:''}</strong><span>{active?'选择一位角色，查看它当前的活动。':'此刻没有 AI 活动。历史记录保留，等待原 AI 再次连接。'}</span>{latest&&<span>最近公开记录：{recordTime(latest.occurred_at,time)}</span>}</div>}
  </section><WorldServices world={world} live={live} now={time}/></>;
}

export function ResidentList({agents,selected,onSelect,now}){
  const render=items=><div className="resident-list">{items.map(agent=><button key={agent.agent_id} className={`resident ${selected===agent.agent_id?'selected':''}`} onClick={()=>onSelect(agent.agent_id)} aria-label={`查看${publicName(agent,agents)}的档案`}><span className="observer-avatar" aria-hidden="true"><CharacterSprite agent={agent} portrait/></span><span className="resident-description"><strong>{publicName(agent,agents)}</strong><span>{presenceLabel(agent)}</span>{!['active','paused'].includes(agent.status)&&<small>{recordTime(agent.presence?.last_seen_at,now)}</small>}</span><i className={`presence-dot ${presenceState(agent)}`}/></button>)}</div>;
  const active=agents.filter(a=>presenceState(a)==='active'),paused=agents.filter(a=>presenceState(a)==='paused'),past=agents.filter(a=>!['active','paused'].includes(presenceState(a)));
  return <section className="panel residents-panel"><div className="section-heading"><h2>世界里的朋友</h2><span>{active.length} 位活动中</span></div>{active.length?render(active):<p className="resident-empty">当前没有活动中的 AI。</p>}{paused.length>0&&<><h3 className="resident-subheading">已暂停 · {paused.length}</h3>{render(paused)}</>}{past.length>0&&<details className="history-residents" data-testid="history-residents"><summary>历史与未入场角色 · {past.length}</summary>{render(past)}</details>}</section>;
}

export function DetailSection({title,children,className='',open=false}){
  return <details className={`observer-details ${className}`} open={open||undefined}><summary>{title}</summary>{children}</details>;
}
