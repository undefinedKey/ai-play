import React from 'react';
import {CharacterSprite} from './PixelWorld.jsx';
import {presenceState,presenceLabel,publicName,recordTime} from './observer-state.js';
import {gatheringState} from './life-state.js';
import {encounterState,goalState} from './journey-state.js';
import {cooperationSummary} from './cooperation-state.js';
import {sceneName} from './scene-state.js';
import WorldCamera from './WorldCamera.jsx';

export {CameraContext} from './camera-context.js';
export function MapCamera({children,speech,status}){
  return <WorldCamera speech={speech} status={status}>{children}</WorldCamera>;
}

export function ObserverStatus({world,agent,live,now}){
  const active=world.agents.filter(a=>a.status==='active').length;
  const paused=world.agents.filter(a=>presenceState(a)==='paused').length;
  const latest=[...(world.events||[])].reverse().find(e=>!['move','moved','agent_moved'].includes(e.type));
  const plan=agent?.status==='active'?agent.adventure?.plan:null;
  const activity=agent?.status==='active'?agent.activity?.name:null;
  const gathering=gatheringState(agent,world.life||world.rules?.life,live?now:world.server_time||now);
  const discovery=encounterState(agent,live?now:world.server_time||now),goal=goalState(agent?.personal_goal,live?now:world.server_time||now);
  const cooperation=cooperationSummary(world,agent?.agent_id,live?now:world.server_time||now);
  const intent=discovery?.pending?`${discovery.title} · ${discovery.label}`:gathering?(gathering.approaching?`正在前往${gathering.name}采集点`:gathering.awaiting?'采集计时结束，等待确认':`正在采集${gathering.name} · ${gathering.seconds} 秒`):{explore:'正在探索',hunt:'正在讨伐',rest:'在营地休息',retreat:'返回营地'}[plan?.intent];
  return <section className="observer-status" data-testid="observer-status" aria-label="当前观察状态">
    {agent?<><span className="observer-avatar" aria-hidden="true"><CharacterSprite agent={agent} portrait/></span><div><strong>{publicName(agent,world.agents)}</strong><span>{!live?'最近记录 · ':''}{presenceLabel(agent)} · {sceneName(agent.scene_id)}{agent.status!=='offline'&&agent.position?` · (${agent.position.x}, ${agent.position.y})`:''}</span><span>{intent||activity||(agent.status==='active'?'当前没有执行计划，下一步由 AI 决定。':presenceState(agent)==='paused'?'活动已暂停，不会继续执行计划。':`最近在场：${recordTime(agent.presence?.last_seen_at,now)}`)}</span>{cooperation&&<span className="observer-cooperation-line" data-testid="cooperation-summary">合作 · {cooperation.text}</span>}{goal&&<span className="observer-goal-line">公开目标 · {goal.label} · {goal.progress}/{goal.target}</span>}</div><div className="observer-vitals">{agent.adventure&&<span>生命 <b>{agent.adventure.hp}/{agent.adventure.max_hp}</b></span>}{agent.fatigue&&<span>体力 <b>{Math.round(agent.fatigue.energy)}/{agent.fatigue.max_energy||100}</b></span>}</div></>:<div><strong>世界概况 · {active} 位活动中{paused?`，${paused} 位暂停`:''}</strong><span>{active?'选择一位角色，查看它当前的活动。':'此刻没有 AI 活动。历史记录保留，等待原 AI 再次连接。'}</span>{latest&&<span>最近公开记录：{recordTime(latest.occurred_at,now)}</span>}</div>}
  </section>;
}

export function ResidentList({agents,selected,onSelect,now}){
  const render=items=><div className="resident-list">{items.map(agent=><button key={agent.agent_id} className={`resident ${selected===agent.agent_id?'selected':''}`} onClick={()=>onSelect(agent.agent_id)} aria-label={`查看${publicName(agent,agents)}的档案`}><span className="observer-avatar" aria-hidden="true"><CharacterSprite agent={agent} portrait/></span><span className="resident-description"><strong>{publicName(agent,agents)}</strong><span>{presenceLabel(agent)}</span>{!['active','paused'].includes(agent.status)&&<small>{recordTime(agent.presence?.last_seen_at,now)}</small>}</span><i className={`presence-dot ${presenceState(agent)}`}/></button>)}</div>;
  const active=agents.filter(a=>presenceState(a)==='active'),paused=agents.filter(a=>presenceState(a)==='paused'),past=agents.filter(a=>!['active','paused'].includes(presenceState(a)));
  return <section className="panel residents-panel"><div className="section-heading"><h2>世界里的朋友</h2><span>{active.length} 位活动中</span></div>{active.length?render(active):<p className="resident-empty">当前没有活动中的 AI。</p>}{paused.length>0&&<><h3 className="resident-subheading">已暂停 · {paused.length}</h3>{render(paused)}</>}{past.length>0&&<details className="history-residents" data-testid="history-residents"><summary>历史与未入场角色 · {past.length}</summary>{render(past)}</details>}</section>;
}

export function DetailSection({title,children,className='',open=false}){
  return <details className={`observer-details ${className}`} open={open||undefined}><summary>{title}</summary>{children}</details>;
}
