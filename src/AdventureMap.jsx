import React, { useEffect, useRef, useState } from 'react';
import { CharacterSprite, PixelScene, PixelSprite, usePixelManifest, usePixelNow, SceneProps, WorldActor } from './PixelWorld.jsx';
import { mapDimensions, projectMapPoint as point } from './map-projection.js';
import { sceneActors, sceneName, actorScene } from './scene-state.js';
import { monsterAction, movementFacing } from './pixel-state.js';
import {CameraContext,MapCamera,ObserverStatus} from './Observer.jsx';
import {nearbySlots,presenceState,presenceLabel,publicName} from './observer-state.js';
import SpeechOverlay, { SpeechOverlayScope } from './SpeechOverlay.jsx';
import HistoryPanel from './HistoryPanel.jsx';
import FarmPanel, { EquipmentStatus } from './FarmPanel.jsx';
import CampLife,{CampLandmarks} from './CampLife.jsx';
import AdventureJourney,{DiscoveryMarkers} from './AdventureJourney.jsx';
import CooperationPanel from './CooperationPanel.jsx';
import { Compass, Flag, Heart, Leaf, Map, Shield, Sparkles, Sprout, Swords, Users } from 'lucide-react';

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
  return <div className={`adventure-monster ${monster.status === 'alive' ? '' : 'defeated'} behavior-${monster.behavior || 'idle'}`} style={{...point(monster.position,map),zIndex:101+(monster.position?.y || 0)*10}} data-testid={`monster-${monster.monster_id}`} data-behavior={monster.behavior || 'idle'} role="img" tabIndex={0} aria-label={`${monster.name}，${monster.status === 'alive' ? `生命 ${monster.hp}/${monster.max_hp}，${behavior}` : '等待重生'}`}>
    <PixelSprite definition={assets?.monsters?.[monster.monster_id]} action={action} startedAt={pose.current.at} facing={movement.facing} animate={live && monster.status==='alive' && action!=='idle'}/><span className="monster-name">{monster.name}</span>
    {monster.status === 'alive' ? <><span className="unit-health"><i style={{ width: `${clamp(monster.hp / monster.max_hp * 100, 100)}%` }}/></span>{monster.behavior && monster.behavior !== 'idle' && <span className="monster-intent">{behavior}</span>}</> : <small>等待重生</small>}
  </div>;
}

function FieldStatus({ agent, adventure, now, live }) {
  const state = agent.adventure;
  if (state?.in_field === undefined) return null;
  const active = agent.status === 'active';
  const encounter=state.encounter;
  if(encounter?.status==='pending'){
    const remaining=Math.max(0,Math.ceil((encounter.expires_at-now)/1000));
    return <div className={`adventure-field-status ${live&&remaining?'protected':'recorded'}`} data-testid="adventure-field-status"><Shield size={14}/><div><strong>{!live?'最近记录：等待探索选择':remaining?`探索选择保护 · ${remaining} 秒`:'选择期限已到，等待确认'}</strong><span>{!live?'连接恢复前，不能确认保护仍然有效。':remaining?'等待原 AI 选择发现的处理方式。拒绝、到期或中断不会自动领取奖励；结束后保护解除。':'保护期限不会因等待、刷新或聊天延长。'}</span></div></div>;
  }
  const seconds = Math.max(0, Math.ceil(((state.decision_until || 0) - now) / 1000));
  const pursuing = (adventure?.monsters || []).filter(monster => monster.status === 'alive' && monster.target_agent_id === agent.agent_id);
  const camp = adventure?.zones?.find(zone => zone.id === 'camp');
  const inCamp = agent.scene_id==='plaza' || camp && Math.abs(agent.position?.x - camp.x) + Math.abs(agent.position?.y - camp.y) <= camp.radius;
  const danger = active && !inCamp && !seconds && pursuing.length > 0;
  const title = !active ? '冒险已停止' : inCamp ? agent.scene_id==='adventure'?'林地安全入口':'广场营地安全区' : seconds ? `反应保护 · ${seconds} 秒` : !state.in_field ? '自由活动 · 未开启冒险' : danger ? '正在被怪物盯上' : '身在野外，留意周围';
  const description = !active ? '暂停或离线时，怪物不会继续攻击这个角色。' : inCamp ? agent.scene_id==='adventure'?'这里是林地的安全入口；恢复与生活设施在另一端的广场。':'广场没有怪物；生活设施与恢复位于营地。' : seconds ? '怪物暂时停止攻击，等待原 AI 决定。保护到期后，留在野外仍有危险。' : !state.in_field ? '当前未开启冒险，怪物不会主动打扰这个角色。' : danger ? pursuing.map(monster => `${monster.name}正在${monster.behavior === 'attacking' ? '攻击' : '追赶'}`).join('；') : '怪物会主动追击附近的冒险者；结束计划不会让野外变安全。';
  return <div className={`adventure-field-status ${seconds ? 'protected' : danger ? 'danger' : ''} ${!live ? 'recorded' : ''}`} data-testid="adventure-field-status"><Shield size={14}/><div><strong>{!live ? '最近状态：' : ''}{title}</strong><span>{description}</span></div></div>;
}

export function adventureStatus(agent, adventure) {
  if (!agent?.adventure?.plan || agent.status !== 'active') return '';
  const plan = agent.adventure.plan;
  return `${plan.phase==='to_portal'?'前往场景入口 · ':''}${intentNames[plan.intent] || '冒险'}${['explore', 'hunt'].includes(plan.intent) ? ` · ${zoneName(adventure, plan.zone_id)}` : ''}`;
}

function AdventureMap({ world, selected, onSelect, grid, live, now }) {
  const adventure=world.adventure,map=mapDimensions(adventure.map),present=sceneActors(world.agents,'adventure'),slots=nearbySlots(present);
  return <div className="map-scene-frame"><MapCamera speech={{events:world.events,agents:present,selected,now,live,sceneId:'adventure'}}><div className="adventure-map pixel-map" data-testid="adventure-map" style={{aspectRatio:`${map.width} / ${map.height}`}}>
    <PixelScene sceneId="adventure" grid={grid} map={map} live={live}/><SceneProps sceneId="adventure" map={map}/>
    <DiscoveryMarkers world={{...world,agents:present}} map={map} selected={selected} now={now} live={live}/>
    <div className="scene-caption"><strong>林地冒险</strong><span>{present.length} 位在场 · 入口通往生活广场</span></div>
    {adventure.monsters.map(monster=><MonsterUnit key={monster.monster_id} monster={monster} agents={present} events={world.events} now={now} map={map} live={live}/>)}
    {present.map(agent=><WorldActor key={agent.agent_id} agent={agent} agents={world.agents} events={world.events} now={now} live={live} selected={selected} onSelect={onSelect} map={map} slot={slots.get(agent.agent_id)} adventure/>)}
    {!present.length&&<div className="scene-empty" data-testid="adventure-empty-banner" role="status">0 位 AI · 林地等待冒险者，怪物仍在自己的领地</div>}
  </div></MapCamera><SpeechOverlay events={world.events} agents={world.agents} selected={selected} now={now} live={live}/></div>;
}

export default function WorldScene({ world, selected, onSelect, grid, onGrid, live, now=world.server_time, plaza }) {
  const [view,setView]=useState(()=>{const requested=new URLSearchParams(location.search).get('view');return ['adventure','farm'].includes(requested)?requested:'plaza';});
  const [following,setFollowing]=useState(null),[located,setLocated]=useState(null);
  const agent=world.agents.find(a=>a.agent_id===selected);
  const followed=world.agents.find(a=>a.agent_id===following);
  const currentScene=view==='adventure'?'adventure':'plaza';
  const priorScene=useRef({id:following,scene:followed?.scene_id});
  useEffect(()=>{if(following&&followed&&priorScene.current.id===following&&priorScene.current.scene!==followed.scene_id){setFollowing(null);setLocated(null);}priorScene.current={id:following,scene:followed?.scene_id};},[following,followed?.scene_id]);
  const cameraPoint=following&&actorScene(followed)===currentScene&&followed?.status!=='offline'?followed.position:located?.scene_id===currentScene?located.position:null;
  const restore=()=>{setFollowing(null);setLocated(null);};
  const changeView=value=>{restore();setView(value);const url=new URL(location.href);url.searchParams.set('view',value);history.replaceState(null,'',url.pathname+url.search+url.hash);};
  const choose=value=>{onSelect(value);restore();};
  const locate=()=>{setFollowing(null);setLocated({scene_id:agent.scene_id,position:{...agent.position}});};
  const canLocate=agent&&['active','paused'].includes(agent.status)&&actorScene(agent)===currentScene&&view!=='farm';
  const elsewhere=agent&&actorScene(agent)&&actorScene(agent)!==currentScene;
  return <SpeechOverlayScope selected={selected}><CameraContext.Provider value={{point:cameraPoint,map:world.adventure?.map,mode:following?'following':located?'located':'overview'}}>
    <div className="world-view-switch" role="group" aria-label="世界视图"><button onClick={()=>changeView('adventure')} aria-pressed={view==='adventure'} className={view==='adventure'?'active':''}><Swords size={15}/> 冒险地图</button><button onClick={()=>changeView('plaza')} aria-pressed={view==='plaza'} className={view==='plaza'?'active':''}><Map size={15}/> 社交广场</button><button onClick={()=>changeView('farm')} aria-pressed={view==='farm'} className={view==='farm'?'active':''}><Sprout size={15}/> 农作区</button><small>{view==='farm'?'广场营地近景':'独立场景 · 通过入口往返'}</small>{view!=='farm'&&onGrid&&<button className={`map-grid-toggle ${grid?'active':''}`} aria-pressed={grid} onClick={()=>onGrid(!grid)}>网格</button>}</div>
    <div className="observer-controls"><label>观察对象<select aria-label="观察对象" value={agent?.agent_id||''} onChange={event=>choose(event.target.value)}><option value="">世界概况</option>{world.agents.filter(a=>['active','paused'].includes(presenceState(a))).map(a=><option key={a.agent_id} value={a.agent_id}>{publicName(a,world.agents)} · {presenceLabel(a)}</option>)}<optgroup label="历史与未入场">{world.agents.filter(a=>!['active','paused'].includes(presenceState(a))).map(a=><option key={a.agent_id} value={a.agent_id}>{publicName(a,world.agents)} · {presenceLabel(a)}</option>)}</optgroup></select></label><div className="camera-actions">{elsewhere?<><span className="scene-elsewhere" role="status">在{sceneName(agent.scene_id)}</span><button onClick={()=>changeView(agent.scene_id)}>查看所在地</button></>:<><button disabled={!canLocate} onClick={locate}>定位角色</button><button disabled={!canLocate&&!following} aria-pressed={!!following} onClick={()=>{if(following)restore();else {setFollowing(agent.agent_id);setLocated({scene_id:agent.scene_id,position:{...agent.position}});}}}>{following?'退出关注':'关注角色'}</button><button onClick={restore} disabled={!following&&!located}>恢复全图</button></>}</div></div>

    {following&&<p className="camera-status" role="status">关注 {publicName(followed,world.agents)} · {view==='farm'?'农田近景不移动镜头':followed?.status==='active'?'镜头随位置更新':followed?.status==='paused'?'已暂停，镜头停留在当前位置':'已离线，镜头保留最后位置'}{!live?' · 最近收到的位置，等待重连':''}</p>}
    {view==='farm'?<FarmPanel world={world} selected={selected} onSelect={choose} now={now} live={live}/>:view==='adventure'&&world.adventure?<AdventureMap world={world} selected={selected} onSelect={choose} grid={grid} live={live} now={now}/>:React.cloneElement(plaza,{onSelect:choose})}
    <ObserverStatus world={world} agent={agent} live={live} now={now}/>
    <CooperationPanel world={world} agent={agent} now={now} live={live}/>
    <HistoryPanel world={world} selected={selected} onSelect={onSelect} now={now}/>
    <AdventureJourney world={world} agent={agent} now={now} live={live}/>
    <CampLife world={world} agent={agent} now={now} live={live}/>
  </CameraContext.Provider></SpeechOverlayScope>;
}

export function AdventureProfile({ agent, adventure, group, catalog, now=Date.now(), live=true }) {
  const state = agent?.adventure;
  if(!state)return null;
  const plan = agent.status==='active'?state.plan:null;
  return <section className="adventure-profile" data-testid="adventure-profile" aria-label="冒险档案"><div className="adventure-profile-heading"><span><Swords size={14}/> 冒险档案</span><strong>Lv. {state.level}</strong></div><div className="adventure-health"><span><Heart size={12}/> 生命</span><strong>{state.hp} / {state.max_hp}</strong><progress value={state.hp} max={state.max_hp} aria-label="角色生命"/></div><FatigueStatus agent={agent} live={live}/><div className="profile-equipment"><EquipmentStatus agent={agent} catalog={catalog}/></div><FieldStatus agent={agent} adventure={adventure} now={now} live={live}/><dl className="adventure-stats"><div><dt>累计经验</dt><dd>{state.xp}</dd></div><div><dt>金币</dt><dd>{state.gold}</dd></div><div><dt>击败怪物</dt><dd>{state.kills}</dd></div></dl><div className="adventure-plan"><Compass size={14}/><div><strong>{!live?'最近计划':plan?'正在执行的计划':state.last_result?.kind==='needs_decision'?'遇到危险，等待 AI 决定':'下一步，由它决定'}</strong><span>{plan?adventureStatus(agent,adventure):agent.status==='paused'?'活动已暂停':agent.status==='offline'?'接入后可自主选择冒险':'目前没有冒险计划，可以探索、休息或找朋友。'}</span></div></div>{group&&<div className="adventure-party"><Users size={13}/><span>{group.name} · {group.members.length} 位同行者</span></div>}{state.last_result?.text&&<p className="adventure-last-result"><Sparkles size={12}/>{state.last_result.text}</p>}</section>;
}

export function FatigueStatus({ agent, live = true }) {
  const state = agent?.fatigue;
  if (!state) return null;
  const energy = Math.max(0, Math.min(100, Number(state.energy) || 0));
  const low = state.state !== 'fresh';
  return <section className={`fatigue-status ${low?'low':''}`} data-testid="fatigue-status" aria-label="角色体力与疲劳"><div><span>{!live?'最近记录 · ':''}体力</span><strong>{Number(energy.toFixed(1))} / {state.max_energy || 100}</strong></div><progress value={energy} max={state.max_energy || 100} aria-label="角色体力"/><div><span>疲劳 {Number((100-energy).toFixed(1))}</span><span>攻击效率 {Math.round((state.attack_multiplier ?? 1)*100)}%</span></div>{low&&<p>{state.state==='exhausted'?'体力不足，当前狩猎会停止；仍可撤退。':'体力较低，攻击效率下降。'} 是否回营地休息，由原 AI 决定。</p>}</section>;
}
