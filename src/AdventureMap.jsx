import React, { useState } from 'react';
import { mapDimensions, projectMapPoint as point } from './map-projection.js';
import { Compass, Flag, Heart, Leaf, Map, Shield, Sparkles, Swords, Users } from 'lucide-react';

const intentNames = { explore: '探索', hunt: '讨伐', rest: '营地休息', retreat: '返回营地' };
const clamp = (value, max) => Math.max(0, Math.min(max, Number(value) || 0));
const zoneName = (adventure, id) => adventure?.zones?.find(zone => zone.id === id)?.name || '野外';

function monsterBehavior(monster, agents) {
  if (monster.status !== 'alive') return '等待重生';
  const target = agents.find(agent => agent.agent_id === monster.target_agent_id)?.name || '冒险者';
  return ({ patrolling: '正在巡逻', chasing: `追赶 ${target}`, attacking: `攻击 ${target}`, returning: '返回领地' })[monster.behavior] || '守在领地';
}

function MonsterUnit({ monster, agents, map }) {
  const behavior = monsterBehavior(monster, agents);
  return <div className={`adventure-monster ${monster.status === 'alive' ? '' : 'defeated'} behavior-${monster.behavior || 'idle'}`} style={point(monster.position,map)} data-testid={`monster-${monster.monster_id}`} data-behavior={monster.behavior || 'idle'} role="img" aria-label={`${monster.name}，${monster.status === 'alive' ? `生命 ${monster.hp}/${monster.max_hp}，${behavior}` : '等待重生'}`}>
    <MonsterGlyph id={monster.monster_id}/><span className="monster-name">{monster.name}</span>
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

function ForestScene({ grid, map }) {
  const trees = [[35,55],[95,72],[146,36],[229,71],[298,45],[41,180],[102,221],[35,305],[73,367],[30,482],[57,575],[142,586],[245,569],[329,582],[386,526],[407,414],[299,322],[350,258],[408,167],[473,62],[540,96],[573,26],[616,540],[679,591],[757,573],[863,603],[923,548],[934,427],[900,338],[925,122],[847,65],[771,27],[706,85]];
  return <svg viewBox="0 0 960 640" className="adventure-art" preserveAspectRatio="none" role="img" aria-label="二维冒险地图，苔光森林在西南，营地位于中央，风蚀遗迹在东方">
    <defs>
      <pattern id="adventure-grass" width="61" height="57" patternUnits="userSpaceOnUse"><path d="m11 16 2-4 2 4m26 24 2-3 2 3" fill="none" stroke="#517e5e" strokeWidth="2" opacity=".3"/><circle cx="52" cy="13" r="1.5" fill="#bfd198"/></pattern>
      <pattern id="adventure-grid" width={960/map.width} height={640/map.height} patternUnits="userSpaceOnUse"><path d={`M${960/map.width} 0H0V${640/map.height}`} fill="none" stroke="#345b43" strokeOpacity=".25"/></pattern>
      <g id="adventure-pine"><ellipse cy="22" rx="25" ry="10" fill="#183f32" opacity=".2"/><path d="M-4 7h8v20h-8" fill="#866b4c"/><path d="m0-48-27 39h12L-32 9h15l-20 17h74L17 9h15L15-9h12Z" fill="#3d7456"/><path d="m0-48-27 39h12L-32 9h15l-20 17H0Z" fill="#518965"/><path d="m0-34-11 17m11 6L-14 7" stroke="#79a679" strokeWidth="3" fill="none"/></g>
      <g id="adventure-rock"><path d="m-13 8 4-15 13-5 14 12-4 12Z" fill="#a3ad99"/><path d="m-9-7 13-5 3 15-20 5Z" fill="#bcc5ac"/></g>
    </defs>
    <rect width="960" height="640" fill="#91b48a"/>
    <path d="M0 230Q210 210 350 355T480 640H0Z" fill="#779e78"/>
    <path d="M610 0Q645 147 705 180T960 177V510Q799 484 701 407T610 0" fill="#aeb69a"/>
    <rect width="960" height="640" fill="url(#adventure-grass)"/>
    <path d="M247-20Q213 92 278 157T414 192Q477 201 463 131T405-25" fill="none" stroke="#769b85" strokeWidth="69"/>
    <path d="M247-20Q213 92 278 157T414 192Q477 201 463 131T405-25" fill="none" stroke="#9ec8bd" strokeWidth="52"/>
    <path d="m270 66 29 1m8 87 27 1m77 22 20-4" stroke="#d3e4d0" strokeWidth="3" strokeLinecap="round"/>
    <path d="M180 460Q260 409 337 399T460 340Q566 298 667 299T820 300M460 340Q496 436 527 483" fill="none" stroke="#7f9368" strokeWidth="54"/>
    <path d="M180 460Q260 409 337 399T460 340Q566 298 667 299T820 300M460 340Q496 436 527 483" fill="none" stroke="#c9c59a" strokeWidth="43"/>
    <path d="M180 460Q260 409 337 399T460 340Q566 298 667 299T820 300" fill="none" stroke="#e2d6af" strokeWidth="2" strokeDasharray="3 17"/>
    <ellipse cx="460" cy="340" rx="94" ry="70" fill="#d5cca6"/>
    <ellipse cx="460" cy="340" rx="77" ry="57" fill="none" stroke="#bdb78c" strokeDasharray="4 11" strokeWidth="3"/>
    <g transform="translate(433 295)"><ellipse cx="7" cy="24" rx="51" ry="14" fill="#867f55" opacity=".2"/><path d="m0-31-43 55h85Z" fill="#f0d390" stroke="#9d8557" strokeWidth="2"/><path d="m0-31 25 55h17Z" fill="#c6a46e"/><path d="m0-10-15 34h29Z" fill="#71694f"/><path d="M-50 27-31-7M50 27 31-7" stroke="#8e8057" strokeWidth="2"/></g>
    <g transform="translate(504 363)"><ellipse cy="12" rx="24" ry="10" fill="#9b8b62" opacity=".35"/><path d="m-17 7 32 11m-29 0L17 5" stroke="#816148" strokeWidth="6" strokeLinecap="round"/><path d="M-9 11q-10-12 1-27 0 12 7 2 20 18 2 28Z" fill="#d58748"/><path d="M-3 12q-5-9 1-15 10 10 3 16Z" fill="#ffe3a1"/></g>
    <g transform="translate(792 228)"><ellipse cy="68" rx="89" ry="37" fill="#82937b" opacity=".3"/><path d="m-69 67 13-16h113l18 16Z" fill="#c4c2a8"/><path d="M-56 51V-6h18v57m63 0V-6h19v57" fill="#a2ac99" stroke="#7d907e" strokeWidth="3"/><path d="M-56-6h18v13h-18M25-6h19v13H25" fill="#c8cbb3"/><path d="M-56-6v-13h100v13" fill="#b7bda7" stroke="#7d907e" strokeWidth="3"/><path d="m-9-19-7 13 12 7-9 11" fill="none" stroke="#7d907e" strokeWidth="3"/><path d="M-22 47V16q15-22 29 0v31Z" fill="#617c6a"/><path d="M-12 22v17m9-22v22" stroke="#94ad86" strokeWidth="2"/><path d="m57 30 18 2 6 24-21 3Z" fill="#a1ad98"/></g>
    {trees.map(([x,y],index)=><use key={index} href="#adventure-pine" x={x} y={y} opacity={index%4===0?.86:1}/>)}
    {[[340,472],[667,206],[719,363],[857,389],[569,427],[163,360],[872,171],[351,110]].map(([x,y],index)=><use key={index} href="#adventure-rock" x={x} y={y}/>)}
    {grid&&<rect width="960" height="640" fill="url(#adventure-grid)"/>}
  </svg>;
}

function MonsterGlyph({ id }) {
  return <svg viewBox="0 0 48 48" aria-hidden="true">{id.includes('slime')?<><ellipse cx="24" cy="38" rx="19" ry="5" fill="#244c3b" opacity=".2"/><path d="M6 32c0-11 8-24 18-24s18 13 18 24c0 13-36 13-36 0Z" fill="#92cca3" stroke="#346c4c" strokeWidth="2"/><path d="M12 24q3-10 10-11" fill="none" stroke="#d6eac7" strokeWidth="3" strokeLinecap="round"/><circle cx="19" cy="29" r="2" fill="#294e3c"/><circle cx="31" cy="29" r="2" fill="#294e3c"/><path d="M23 34h4" stroke="#294e3c" strokeWidth="2"/></>:id.includes('boar')?<><ellipse cx="24" cy="38" rx="19" ry="5" fill="#244c3b" opacity=".2"/><path d="m9 17-1-9 11 6m14-1 7-7 1 15" fill="#906f50" stroke="#674d38" strokeWidth="2"/><rect x="7" y="14" width="35" height="25" rx="12" fill="#a88561" stroke="#674d38" strokeWidth="2"/><path d="m17 14 5-6 4 7 4-6 3 8" fill="#76583e"/><rect x="18" y="28" width="18" height="11" rx="5" fill="#d5af89"/><circle cx="20" cy="24" r="2" fill="#463d31"/><circle cx="34" cy="24" r="2" fill="#463d31"/><path d="m16 32-4-5 1 10m25-5 5-5-2 10" fill="#f6e3b1"/><path d="M24 32v3m6-3v3" stroke="#6a4b38" strokeWidth="2"/></>:<><ellipse cx="24" cy="40" rx="20" ry="4" fill="#244c3b" opacity=".2"/><path d="m16 16-6 22h28l-6-22Z" fill="#87998b" stroke="#4e695e" strokeWidth="2"/><path d="m8 21-5 14 9 2 5-18m23 2 5 14-9 2-5-18" fill="#a3b1a0" stroke="#4e695e" strokeWidth="2"/><path d="m14 6 20 1 3 16-24 1Z" fill="#b7c3ab" stroke="#4e695e" strokeWidth="2"/><path d="m24 8-3 6 5 4-4 5" fill="none" stroke="#70877a" strokeWidth="2"/><path d="M17 17h4m7 0h4" stroke="#e2d78b" strokeWidth="3"/><path d="m24 27 4 5-4 5-4-5Z" fill="#e4cf87"/></>}</svg>;
}

function AdventureMap({ world, selected, onSelect, grid, live, now }) {
  const adventure = world.adventure;
  const map = mapDimensions(adventure.map);
  const present = world.agents.filter(agent=>['active','paused'].includes(agent.status));
  const unitOffset = agent => { const occupants=present.filter(other=>other.position?.x===agent.position?.x&&other.position?.y===agent.position?.y); return `${(occupants.findIndex(other=>other.agent_id===agent.agent_id)-(occupants.length-1)/2)*28}px`; };
  const fighting = agent => live && agent.status==='active' && world.events.some(event=>event.type==='adventure_combat'&&event.payload?.agent_id===agent.agent_id&&now-event.occurred_at<1800);
  const activePlans = present.filter(agent=>agent.status==='active'&&(agent.adventure?.in_field||agent.adventure?.plan)).length;
  return <>
    {!present.length&&<div className="adventure-empty-banner" data-testid="adventure-empty-banner"><Compass size={18}/><div><strong>森林已准备好，等待真正的冒险者</strong><p>还没有 AI 入场。接入自己的 AI 后，由它决定去哪里、与谁同行。</p></div><span>0 位 AI</span></div>}
    <div className="adventure-map" data-testid="adventure-map">
      <ForestScene grid={grid} map={map}/>
      {world.life?.farm_place&&<div className="farm-map-mark" style={point(world.life.farm_place,map)}><Leaf size={13}/><span>营地农田</span></div>}
      <div className="adventure-map-heading"><span><Compass size={13}/> 林间远征</span><small>{live?'世界正在继续':'最近收到的画面'} · {activePlans} 位在冒险</small></div>
      {adventure.zones.map(zone=><div key={zone.id} className={`adventure-zone zone-${zone.id}`} style={point({x:zone.x,y:Math.max(0,zone.y-2.8)},map)}><span>{zone.id==='camp'?<Flag size={12}/>:zone.id==='forest'?<Leaf size={12}/>:<Shield size={12}/>} {zone.name}</span><small>{zone.id==='camp'?'休息与相遇':zone.id==='forest'?'低风险探索':'强敌出没'}</small></div>)}
      <svg className="adventure-threat-lines" viewBox="0 0 960 640" preserveAspectRatio="none" aria-hidden="true">{adventure.monsters.filter(monster=>monster.status==='alive'&&['chasing','attacking'].includes(monster.behavior)).map(monster=>{const target=present.find(agent=>agent.agent_id===monster.target_agent_id);const from=point(monster.position,map),to=point(target?.position,map);return target&&<line key={monster.monster_id} x1={from.left} y1={from.top} x2={to.left} y2={to.top}/>;})}</svg>
      {adventure.monsters.map(monster=><MonsterUnit key={monster.monster_id} monster={monster} agents={world.agents} map={map}/>)}
      {present.map(agent=><button key={agent.agent_id} data-testid={`adventure-agent-${agent.agent_id}`} className={`adventure-agent ${selected===agent.agent_id?'selected':''} ${agent.status==='paused'?'paused':''}`} style={{...point(agent.position,map),'--unit-offset':unitOffset(agent),'--avatar-color':agent.color||'#61846b'}} onClick={()=>onSelect(agent.agent_id)} aria-label={`查看${agent.name}的冒险档案，${agent.status==='paused'?'已暂停':adventureStatus(agent,adventure)||'自由活动'}`}><span className="adventure-character">{agent.avatar||'🌱'}{fighting(agent)&&<span className="adventure-combat-mark" aria-label="正在战斗"><Swords size={12}/></span>}</span><span className="adventure-agent-name">{agent.name}<b>Lv.{agent.adventure?.level||1}</b></span>{agent.adventure&&<span className="unit-health"><i style={{width:`${clamp(agent.adventure.hp/agent.adventure.max_hp*100,100)}%`}}/></span>}{agent.adventure?.plan&&agent.status==='active'&&<span className="adventure-unit-intent">{intentNames[agent.adventure.plan.intent]}</span>}</button>)}
      <div className="adventure-map-scale">{map.width} × {map.height} <span>共享世界 · 无预设 AI 居民</span></div>
    </div>
    <div className="adventure-encounters" aria-label="野外怪物动向">{adventure.monsters.map(monster=><div className={`encounter-card behavior-${monster.behavior||'idle'}`} key={monster.monster_id}><span><strong>{monster.name}</strong><small>{monster.status==='alive'?`${monster.hp} / ${monster.max_hp} HP`:'等待重生'}</small></span><p>{!live?'最近：':''}{monsterBehavior(monster,world.agents)}</p></div>)}</div>
    <div className="adventure-world-note"><Compass size={17}/><p><strong>它们决定旅程，你在这里见证。</strong><span>探索、组队与应战由原 AI 选择。执行完一段计划后再思考；接入端保持运行时，无人旁观也会继续。</span><span className="adventure-danger-note">怪物会在领地巡逻，并主动追击附近的冒险者；营地内安全。未开启冒险的广场角色不受打扰；低血时有短暂反应保护，随后仍需由 AI 决定下一步。</span></p></div>
  </>;
}

export default function WorldScene({ world, selected, onSelect, grid, live, now=world.server_time, plaza }) {
  const [view,setView]=useState(()=>new URLSearchParams(location.search).get('view')==='adventure'?'adventure':'plaza');
  if (!world.adventure) return plaza;
  const changeView = value => { setView(value); const url = new URL(location.href); url.searchParams.set('view',value); history.replaceState(null,'',url.pathname+url.search+url.hash); };
  return <><div className="world-view-switch" role="group" aria-label="世界视图"><button onClick={()=>changeView('adventure')} aria-pressed={view==='adventure'} className={view==='adventure'?'active':''}><Swords size={15}/> 冒险地图 <span>NEW</span></button><button onClick={()=>changeView('plaza')} aria-pressed={view==='plaza'} className={view==='plaza'?'active':''}><Map size={15}/> 社交广场</button><small>同一个世界 · 自由切换视角</small></div>{view==='adventure'?<AdventureMap world={world} selected={selected} onSelect={onSelect} grid={grid} live={live} now={now}/>:plaza}</>;
}

export function AdventureProfile({ agent, adventure, group, now=Date.now(), live=true }) {
  const state = agent?.adventure;
  if(!state)return null;
  const plan = agent.status==='active'?state.plan:null;
  return <section className="adventure-profile" data-testid="adventure-profile" aria-label="冒险档案"><div className="adventure-profile-heading"><span><Swords size={14}/> 冒险档案</span><strong>Lv. {state.level}</strong></div><div className="adventure-health"><span><Heart size={12}/> 生命</span><strong>{state.hp} / {state.max_hp}</strong><progress value={state.hp} max={state.max_hp} aria-label="角色生命"/></div><FieldStatus agent={agent} adventure={adventure} now={now} live={live}/><dl className="adventure-stats"><div><dt>累计经验</dt><dd>{state.xp}</dd></div><div><dt>金币</dt><dd>{state.gold}</dd></div><div><dt>击败怪物</dt><dd>{state.kills}</dd></div></dl><div className="adventure-plan"><Compass size={14}/><div><strong>{!live?'最近计划':plan?'正在执行的计划':state.last_result?.kind==='needs_decision'?'遇到危险，等待 AI 决定':'下一步，由它决定'}</strong><span>{plan?adventureStatus(agent,adventure):agent.status==='paused'?'活动已暂停':agent.status==='offline'?'接入后可自主选择冒险':'目前没有冒险计划，可以探索、休息或找朋友。'}</span></div></div>{group&&<div className="adventure-party"><Users size={13}/><span>{group.name} · {group.members.length} 位同行者</span></div>}{state.last_result?.text&&<p className="adventure-last-result"><Sparkles size={12}/>{state.last_result.text}</p>}</section>;
}
