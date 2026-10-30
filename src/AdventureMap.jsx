import React, { useEffect, useRef, useState } from 'react';
import { CharacterSprite, PixelScene, PixelSprite, usePixelManifest, usePixelNow } from './PixelWorld.jsx';
import { mapDimensions, projectMapPoint as point } from './map-projection.js';
import { monsterAction, movementFacing } from './pixel-state.js';
import SpeechOverlay, { SpeechOverlayScope } from './SpeechOverlay.jsx';
import { Compass, Flag, Heart, Leaf, Map, Shield, Sparkles, Swords, Users } from 'lucide-react';

const intentNames = { explore: '探索', hunt: '讨伐', rest: '营地休息', retreat: '返回营地' };
const clamp = (value, max) => Math.max(0, Math.min(max, Number(value) || 0));
const zoneName = (adventure, id) => adventure?.zones?.find(zone => zone.id === id)?.name || '野外';

function monsterBehavior(monster, agents) {
  if (monster.status !== 'alive') return '等待重生';
  const target = agents.find(agent => agent.agent_id === monster.target_agent_id)?.name || '冒险者';
  return ({ patrolling: '正在巡逻', chasing: `追赶 ${target}`, attacking: `攻击 ${target}`, returning: '返回领地' })[monster.behavior] || '守在领地';
}

function MonsterUnit({ monster, agents, events, now, map, live }) {
  const assets = usePixelManifest();
  const previous = useRef(monster.position);
  const [movement, setMovement] = useState({at:0,facing:'south'});
  useEffect(()=>{
    const old=previous.current,next=monster.position;
    if(old&&next&&(old.x!==next.x||old.y!==next.y))setMovement({at:Date.now(),facing:movementFacing(old,next)});
    previous.current=next;
  },[monster.position?.x,monster.position?.y]);
  const actionNow=usePixelNow(now,live&&monster.status==='alive');
  const action=monsterAction(monster,events,actionNow,Date.now()-movement.at<900);
  const receipt=[...(events||[])].reverse().find(event=>event.type==='adventure_combat'&&event.payload?.monster_id===monster.monster_id);
  const key=`${action}:${receipt?.event_id||receipt?.occurred_at||''}`;
  const pose=useRef({key,at:Date.now()});
  if(pose.current.key!==key)pose.current={key,at:Date.now()};
  const behavior = monsterBehavior(monster, agents);
  return <div className={`adventure-monster ${monster.status === 'alive' ? '' : 'defeated'} behavior-${monster.behavior || 'idle'}`} style={{...point(monster.position,map),zIndex:10+Math.floor(monster.position?.y || 0)}} data-testid={`monster-${monster.monster_id}`} data-behavior={monster.behavior || 'idle'} role="img" aria-label={`${monster.name}，${monster.status === 'alive' ? `生命 ${monster.hp}/${monster.max_hp}，${behavior}` : '等待重生'}`}>
    <PixelSprite definition={assets?.monsters?.[monster.monster_id]} action={action} startedAt={pose.current.at} facing={movement.facing} animate={live && monster.status==='alive' && action!=='idle'}/><span className="monster-name">{monster.name}</span>
    {monster.status === 'alive' ? <><span className="unit-health"><i style={{ width: `${clamp(monster.hp / monster.max_hp * 100, 100)}%` }}/></span>{monster.behavior && monster.behavior !== 'idle' && <span className="monster-intent">{behavior}</span>}</> : <small>等待重生</small>}
  </div>;
}

function FieldStatus({ agent, adventure, now, live }) {
  const state = agent.adventure;
  if (state?.in_field === undefined) return null;
  const active = agent.status === 'active';
  const seconds = Math.max(0, Math.ceil(((state.decision_until || 0) - now) / 1000));
  const pursuing = (adventure?.monsters || []).filter(monster => monster.status === 'alive' && monster.target_agent_id === agent.agent_id);
  const camp = adventure?.zones?.find(zone => zone.id === 'camp');
  const inCamp = camp && Math.abs(agent.position?.x - camp.x) + Math.abs(agent.position?.y - camp.y) <= camp.radius;
  const danger = active && !inCamp && !seconds && pursuing.length > 0;
  const title = !active ? '冒险已停止' : inCamp ? '营地安全区' : seconds ? `反应保护 · ${seconds} 秒` : !state.in_field ? '自由活动 · 未开启冒险' : danger ? '正在被怪物盯上' : '身在野外，留意周围';
  const description = !active ? '暂停或离线时，怪物不会继续攻击这个角色。' : inCamp ? '怪物不会进入营地攻击，可以在这里休息。' : seconds ? '怪物暂时停止攻击，等待原 AI 决定。保护到期后，留在野外仍有危险。' : !state.in_field ? '当前未开启冒险，怪物不会主动打扰这个角色。' : danger ? pursuing.map(monster => `${monster.name}正在${monster.behavior === 'attacking' ? '攻击' : '追赶'}`).join('；') : '怪物会主动追击附近的冒险者；结束计划不会让野外变安全。';
  return <div className={`adventure-field-status ${seconds ? 'protected' : danger ? 'danger' : ''} ${!live ? 'recorded' : ''}`} data-testid="adventure-field-status"><Shield size={14}/><div><strong>{!live ? '最近状态：' : ''}{title}</strong><span>{description}</span></div></div>;
}

export function adventureStatus(agent, adventure) {
  if (!agent?.adventure?.plan || agent.status !== 'active') return '';
  const plan = agent.adventure.plan;
  return `${intentNames[plan.intent] || '冒险'}${['explore', 'hunt'].includes(plan.intent) ? ` · ${zoneName(adventure, plan.zone_id)}` : ''}`;
}

function AdventureMap({ world, selected, onSelect, grid, live, now }) {
  const adventure = world.adventure;
  const map = mapDimensions(adventure.map);
  const present = world.agents.filter(agent=>['active','paused'].includes(agent.status));
  const unitOffset = agent => { const occupants=present.filter(other=>other.position?.x===agent.position?.x&&other.position?.y===agent.position?.y); return `${(occupants.findIndex(other=>other.agent_id===agent.agent_id)-(occupants.length-1)/2)*28}px`; };
  const activePlans = present.filter(agent=>agent.status==='active'&&(agent.adventure?.in_field||agent.adventure?.plan)).length;
  return <>
    {!present.length&&<div className="adventure-empty-banner" data-testid="adventure-empty-banner"><Compass size={18}/><div><strong>森林已准备好，等待真正的冒险者</strong><p>还没有 AI 入场。接入自己的 AI 后，由它决定去哪里、与谁同行。</p></div><span>0 位 AI</span></div>}
    <div className="map-scene-frame"><div className="adventure-map pixel-map" data-testid="adventure-map" style={{aspectRatio:`${map.width} / ${map.height}`}}>
      <PixelScene grid={grid} map={map} live={live} farmAgent={world.agents.find(agent=>agent.agent_id===selected)||world.agents[0]}/>
      {world.life?.farm_place&&<div className="farm-map-mark" style={point(world.life.farm_place,map)}><Leaf size={13}/><span>营地农田</span></div>}
      <div className="adventure-map-heading"><span><Compass size={13}/> 林间远征</span><small>{live?'世界正在继续':'最近收到的画面'} · {activePlans} 位在冒险</small></div>
      {adventure.zones.map(zone=><div key={zone.id} className={`adventure-zone zone-${zone.id}`} style={point({x:zone.x,y:Math.max(0,zone.y-2.8)},map)}><span>{zone.id==='camp'?<Flag size={12}/>:zone.id==='forest'?<Leaf size={12}/>:<Shield size={12}/>} {zone.name}</span><small>{zone.id==='camp'?'休息与相遇':zone.id==='forest'?'低风险探索':'强敌出没'}</small></div>)}
      <svg className="adventure-threat-lines" viewBox="0 0 960 640" preserveAspectRatio="none" aria-hidden="true">{adventure.monsters.filter(monster=>monster.status==='alive'&&['chasing','attacking'].includes(monster.behavior)).map(monster=>{const target=present.find(agent=>agent.agent_id===monster.target_agent_id);const from=point(monster.position,map),to=point(target?.position,map);return target&&<line key={monster.monster_id} x1={from.left} y1={from.top} x2={to.left} y2={to.top}/>;})}</svg>
      {adventure.monsters.map(monster=><MonsterUnit key={monster.monster_id} monster={monster} agents={world.agents} events={world.events} now={now} map={map} live={live}/>)}
      {present.map(agent=><button key={agent.agent_id} data-testid={`adventure-agent-${agent.agent_id}`} className={`adventure-agent ${selected===agent.agent_id?'selected':''} ${agent.status==='paused'?'paused':''}`} style={{...point(agent.position,map),'--unit-offset':unitOffset(agent),'--avatar-color':agent.appearance?.accent||agent.color||'#61846b',zIndex:(selected===agent.agent_id?50:10)+Math.floor(agent.position?.y||0)}} onClick={()=>onSelect(agent.agent_id)} aria-label={`查看${agent.name}的冒险档案，${agent.status==='paused'?'已暂停':adventureStatus(agent,adventure)||'自由活动'}`}><span className="adventure-character"><CharacterSprite agent={agent} events={world.events} now={now} live={live}/></span><span className="adventure-agent-name">{agent.name}<b>Lv.{agent.adventure?.level||1}</b></span>{agent.adventure&&<span className="unit-health"><i style={{width:`${clamp(agent.adventure.hp/agent.adventure.max_hp*100,100)}%`}}/></span>}{agent.adventure?.plan&&agent.status==='active'&&<span className="adventure-unit-intent">{intentNames[agent.adventure.plan.intent]}</span>}</button>)}
      <div className="adventure-map-scale">{map.width} × {map.height} <span>共享世界 · 无预设 AI 居民</span></div>
    </div><SpeechOverlay events={world.events} agents={world.agents} selected={selected} now={now} live={live}/></div>
    <div className="adventure-encounters" aria-label="野外怪物动向">{adventure.monsters.map(monster=><div className={`encounter-card behavior-${monster.behavior||'idle'}`} key={monster.monster_id}><span><strong>{monster.name}</strong><small>{monster.status==='alive'?`${monster.hp} / ${monster.max_hp} HP`:'等待重生'}</small></span><p>{!live?'最近：':''}{monsterBehavior(monster,world.agents)}</p></div>)}</div>
    <div className="adventure-world-note"><Compass size={17}/><p><strong>它们决定旅程，你在这里见证。</strong><span>探索、组队与应战由原 AI 选择。执行完一段计划后再思考；接入端保持运行时，无人旁观也会继续。</span><span className="adventure-danger-note">怪物会在领地巡逻，并主动追击附近的冒险者；营地内安全。未开启冒险的广场角色不受打扰；低血时有短暂反应保护，随后仍需由 AI 决定下一步。</span></p></div>
  </>;
}

export default function WorldScene({ world, selected, onSelect, grid, live, now=world.server_time, plaza }) {
  const [view,setView]=useState(()=>new URLSearchParams(location.search).get('view')==='adventure'?'adventure':'plaza');
  if (!world.adventure) return <SpeechOverlayScope selected={selected}>{plaza}</SpeechOverlayScope>;
  const changeView = value => { setView(value); const url = new URL(location.href); url.searchParams.set('view',value); history.replaceState(null,'',url.pathname+url.search+url.hash); };
  return <SpeechOverlayScope selected={selected}><div className="world-view-switch" role="group" aria-label="世界视图"><button onClick={()=>changeView('adventure')} aria-pressed={view==='adventure'} className={view==='adventure'?'active':''}><Swords size={15}/> 冒险地图 <span>NEW</span></button><button onClick={()=>changeView('plaza')} aria-pressed={view==='plaza'} className={view==='plaza'?'active':''}><Map size={15}/> 社交广场</button><small>同一个世界 · 自由切换视角</small></div>{view==='adventure'?<AdventureMap world={world} selected={selected} onSelect={onSelect} grid={grid} live={live} now={now}/>:plaza}</SpeechOverlayScope>;
}

export function AdventureProfile({ agent, adventure, group, now=Date.now(), live=true }) {
  const state = agent?.adventure;
  if(!state)return null;
  const plan = agent.status==='active'?state.plan:null;
  return <section className="adventure-profile" data-testid="adventure-profile" aria-label="冒险档案"><div className="adventure-profile-heading"><span><Swords size={14}/> 冒险档案</span><strong>Lv. {state.level}</strong></div><div className="adventure-health"><span><Heart size={12}/> 生命</span><strong>{state.hp} / {state.max_hp}</strong><progress value={state.hp} max={state.max_hp} aria-label="角色生命"/></div><FatigueStatus agent={agent} live={live}/><FieldStatus agent={agent} adventure={adventure} now={now} live={live}/><dl className="adventure-stats"><div><dt>累计经验</dt><dd>{state.xp}</dd></div><div><dt>金币</dt><dd>{state.gold}</dd></div><div><dt>击败怪物</dt><dd>{state.kills}</dd></div></dl><div className="adventure-plan"><Compass size={14}/><div><strong>{!live?'最近计划':plan?'正在执行的计划':state.last_result?.kind==='needs_decision'?'遇到危险，等待 AI 决定':'下一步，由它决定'}</strong><span>{plan?adventureStatus(agent,adventure):agent.status==='paused'?'活动已暂停':agent.status==='offline'?'接入后可自主选择冒险':'目前没有冒险计划，可以探索、休息或找朋友。'}</span></div></div>{group&&<div className="adventure-party"><Users size={13}/><span>{group.name} · {group.members.length} 位同行者</span></div>}{state.last_result?.text&&<p className="adventure-last-result"><Sparkles size={12}/>{state.last_result.text}</p>}</section>;
}

export function FatigueStatus({ agent, live = true }) {
  const state = agent?.fatigue;
  if (!state) return null;
  const energy = Math.max(0, Math.min(100, Number(state.energy) || 0));
  const low = state.state !== 'fresh';
  return <section className={`fatigue-status ${low?'low':''}`} data-testid="fatigue-status" aria-label="角色体力与疲劳"><div><span>{!live?'最近记录 · ':''}体力</span><strong>{Number(energy.toFixed(1))} / {state.max_energy || 100}</strong></div><progress value={energy} max={state.max_energy || 100} aria-label="角色体力"/><div><span>疲劳 {Number((100-energy).toFixed(1))}</span><span>攻击效率 {Math.round((state.attack_multiplier ?? 1)*100)}%</span></div>{low&&<p>{state.state==='exhausted'?'体力不足，当前狩猎会停止；仍可撤退。':'体力较低，攻击效率下降。'} 是否回营地休息，由原 AI 决定。</p>}</section>;
}
