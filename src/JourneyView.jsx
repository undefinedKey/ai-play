import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Crosshair, Eye, Leaf, MapPin, Minus, Mountain, Plus, Tent, Trees } from 'lucide-react';
import { usePixelNow } from './PixelWorld.jsx';
import { JourneyCharacterSprite, JourneyMonsterSprite } from './JourneySprites.jsx';
import { confirmedPosition } from './scene-state.js';
import { monsterAction } from './pixel-state.js';
import { publicName } from './observer-state.js';
import { treePresentation } from './survival-state.js';
import SpeechOverlay, { SpeechBubbles } from './SpeechOverlay.jsx';
import { JOURNEY_LENGTH, JOURNEY_TILE, journeyActors, journeyCamera, journeyExecution, journeyMonsterLabel, journeyPoint } from './sideview-state.js';
import './journey.css';

const WORLD_WIDTH = JOURNEY_LENGTH * JOURNEY_TILE;
const clamp = (value, max = 100) => Math.max(0, Math.min(max, Number(value) || 0));
const phaseNames = { dawn: '晨光', day: '白昼', dusk: '暮色', night: '夜晚' };

// Original pixel scenery. These decorative trees never advertise a resource;
// actual resource nodes below retain their canonical stock and click targets.
function Tree({ x, y = 0, size = 1, color = '#4d9a40', light = '#9fd358' }) {
  return <g transform={`translate(${x} ${y}) scale(${size * 3})`} shapeRendering="crispEdges">
    <path d="M-5 0V-27H5V0Z" fill="#664a35"/><path d="M-2-2V-27H3V-2Z" fill="#ae7b43"/><path d="M3-14H8V-18H11V-21H7V-18H3Z" fill="#664a35"/>
    <path d="M-12-61H10V-58H17V-53H22V-45H25V-33H22V-27H16V-22H7V-19H-8V-22H-17V-27H-23V-34H-26V-45H-22V-53H-17V-58H-12Z" fill="#315e35"/>
    <path d="M-11-58H9V-55H16V-50H19V-42H22V-34H18V-28H10V-24H-8V-27H-16V-32H-20V-42H-18V-50H-13V-55H-11Z" fill={color}/>
    <path d="M-11-55H7V-52H12V-46H5V-43H-6V-46H-13V-50H-15V-53H-11Z" fill={light}/>
    <path d="M-19-41H-13V-36H-5V-33H1V-28H-9V-31H-16V-34H-19ZM7-42H16V-39H19V-33H14V-30H6V-33H10V-37H7Z" fill={light} opacity=".65"/>
    <path d="M-4-48H1V-45H-4ZM12-51H16V-48H12ZM-16-31H-12V-28H-16ZM4-25H9V-22H4Z" fill="#c1e57c"/>
  </g>;
}
function Cloud({ x, y, scale = 1 }) {
  return <g transform={`translate(${x} ${y}) scale(${scale})`} shapeRendering="crispEdges"><path d="M0 16H8V8H22V0H42V7H54V12H66V18H72V30H0Z" fill="#d6f0fc"/><path d="M0 16H8V8H22V0H42V7H54V12H66V18H72V24H0Z" fill="#fffdf0"/><path d="M10 24H25V27H62V24H66V30H10Z" fill="#b9e4f1"/></g>;
}
function Scenery({ camera, zoom }) {
  return <>
    <svg className="journey-sky" viewBox="0 0 1200 500" preserveAspectRatio="xMidYMin slice" aria-hidden="true" shapeRendering="crispEdges"><Cloud x={160} y={80} scale={1.8}/><Cloud x={565} y={42} scale={2}/><Cloud x={1020} y={150} scale={1.4}/></svg>
    <svg className="journey-sun" viewBox="0 0 32 32" aria-hidden="true" shapeRendering="crispEdges"><g className="journey-sun-disc"><path d="M11 3H21V6H26V11H29V21H26V26H21V29H11V26H6V21H3V11H6V6H11Z" fill="#ffe477"/><path d="M11 6H20V9H24V13H26V21H23V24H19V26H11V23H8V19H6V12H9V9H11Z" fill="#fff3ac"/><path d="M12 9H17V12H12ZM8 13H11V17H8Z" fill="#fffdf0"/></g><path className="journey-moon-disc" d="M10 3H19V6H15V10H12V19H16V23H23V20H27V24H23V28H12V25H7V20H4V10H7V6H10Z" fill="#fff2b2"/></svg>
    <svg className="journey-far" width={WORLD_WIDTH} viewBox={`0 0 ${WORLD_WIDTH} 330`} preserveAspectRatio="none" style={{ transform: `translateX(${-camera * .18}px)` }} aria-hidden="true" shapeRendering="crispEdges">
      {Array.from({length:7},(_,i)=><g key={i} transform={`translate(${i*490-90} ${i%2*28})`}><path d="M0 330V235H22V205H48V177H78V151H117V129H160V115H230V129H278V151H315V180H345V211H374V244H404V330Z" fill="#9bdb8a"/><path d="M48 330V248H82V218H120V194H160V183H218V201H254V228H283V264H316V330Z" fill="#8ed17d"/></g>)}
    </svg>
    <div className="journey-midground" style={{ width: WORLD_WIDTH * zoom, transform: `translateX(${-camera * .46}px)` }} aria-hidden="true"><svg width={WORLD_WIDTH * zoom} viewBox={`0 0 ${WORLD_WIDTH} 300`} preserveAspectRatio="none" shapeRendering="crispEdges">
      <path d="M0 292H3072V300H0Z" fill="#66b849"/>
      {Array.from({length:22},(_,i)=><Tree key={i} x={i*152+30} y={295} size={i%4===0?.82:i%3===0?1.12:.96} color={i%2?'#63ad4c':'#54a644'} light={i%2?'#a2d866':'#8bcb5b'}/>)}
    </svg></div>
  </>;
}
function Ground({ zoom }) {
  return <svg className="journey-ground-art" width={WORLD_WIDTH * zoom} viewBox={`0 0 ${WORLD_WIDTH} 150`} preserveAspectRatio="none" style={{ top: `calc(74% - ${28 * zoom}px)`, height: 150 * zoom }} aria-hidden="true" shapeRendering="crispEdges">
    <path d="M0 14H3072V150H0Z" fill="#b98250"/><path d="M0 14H3072V25H0Z" fill="#71bf46"/><path d="M0 14H3072V19H0Z" fill="#a4d85b"/><path d="M0 25H3072V34H0Z" fill="#f2d481"/><path d="M0 34H3072V39H0Z" fill="#925e3c"/>
    {Array.from({length:70},(_,i)=><g key={i} transform={`translate(${i*45+10} ${54+i%4*23})`}><path d="M0 0H14V5H0ZM18 9H24V13H18Z" fill={i%2?'#d29b61':'#a56e46'}/></g>)}
    {Array.from({length:46},(_,i)=><g key={i} transform={`translate(${i*69+5} 11)`}><path d="M0 3V-4H3V-1H6V-6H9V3Z" fill="#448f3b"/>{i%4===0&&<><path d="M16 3V-5H19V3Z" fill="#448f3b"/><path d="M13-6H16V-9H19V-6H22V-3H13Z" fill={i%8===0?'#fff0a6':'#f5aac0'}/></>}</g>)}
    {[15,32].map(x=><g key={x}><path d={`M${(x+.5)*64} 28V84H${(x+6.5)*64}V28`} fill="none" stroke="#775033" strokeWidth="30"/><path d={`M${(x+.5)*64} 28V84H${(x+6.5)*64}V28`} fill="none" stroke="#81c14b" strokeWidth="24"/><path d={`M${(x+.5)*64} 28V84H${(x+6.5)*64}V28`} fill="none" stroke="#efd38a" strokeWidth="14"/><path d={`M${(x+1.1)*64} 84H${(x+5.9)*64}`} stroke="#d6ac65" strokeWidth="3" strokeDasharray="5 15"/></g>)}
  </svg>;
}
function Landmark({ node, zoom }) {
  const p = journeyPoint(node.position);
  return <div className={`journey-landmark journey-landmark-${node.id}`} style={{left:p.x*zoom,transform:`scale(${zoom})`,transformOrigin:'0 0'}} data-testid={`journey-node-${node.id}`}>
    {node.id==='entry'&&<svg className="journey-gate" viewBox="0 0 48 56" aria-hidden="true" shapeRendering="crispEdges"><path d="M4 56V19H10V56ZM38 56V19H44V56Z" fill="#765238"/><path d="M6 21H9V54H6ZM40 21H43V54H40Z" fill="#b77e46"/><path d="M0 20V14H5V10H10V6H17V2H31V6H38V10H43V14H48V20Z" fill="#356b56"/><path d="M4 15H9V11H15V7H33V11H39V15H44V18H4Z" fill="#67ac73"/><path d="M11 18H37V29H11Z" fill="#765238"/><path d="M13 20H35V26H13Z" fill="#f6d886"/><path d="M18 21H20V25H18ZM24 21H26V25H24ZM29 21H31V25H29Z" fill="#a07842"/></svg>}
    {node.id==='camp'&&<svg className="journey-tent" viewBox="0 0 64 44" aria-hidden="true" shapeRendering="crispEdges"><path d="M2 42V36H6V29H10V22H14V15H18V8H23V3H46V8H50V15H54V22H58V29H62V42Z" fill="#785a3e"/><path d="M5 39V34H9V27H13V20H17V13H21V7H25V4H44V9H48V16H52V23H56V30H60V39Z" fill="#edb744"/><path d="M25 5H29V12H33V19H37V26H41V33H45V39H5V34H9V27H13V20H17V13H21V7H25Z" fill="#ffe18a"/><path d="M23 15H27V22H31V29H35V36H38V39H12V35H15V28H19V21H23Z" fill="#506052"/><path d="M24 17H26V23H24ZM20 24H24V31H20ZM16 32H21V38H16Z" fill="#64866a"/><path d="M42 9H47V15H51V22H55V29H59V35H55V29H51V22H47V15H42Z" fill="#d2913e"/><path d="M0 40H6V44H0ZM58 40H64V44H58Z" fill="#785a3e"/></svg>}
    <span className="journey-sign"><strong>{node.name}</strong><small>{node.id==='entry'?'← 通往广场':node.id==='camp'?'可以歇歇脚':node.id==='clearing'?'松木 · 矿脉':'沿路向前 →'}</small></span>
  </div>;
}
function Resource({ node, zoom, onInspect }) {
  const p=journeyPoint(node.interaction_position||node.position),depleted=node.stock<=0,tree=node.kind==='tree'?treePresentation(node):null;
  return <button className={`journey-resource ${depleted?'depleted':''}`} style={{left:p.x*zoom,transform:`translate(-50%,-100%) scale(${zoom})`,transformOrigin:'50% 100%'}} onClick={()=>onInspect({kind:'resource',id:node.id})} data-testid={`journey-resource-${node.id}`} aria-label={`查看${node.name}，储量 ${node.stock}/${node.max_stock}`}>
    <svg viewBox="0 0 120 180" aria-hidden="true" shapeRendering="crispEdges">{tree?['stump','empty'].includes(tree.stage)?<g><path d="M42 176V147H47V141H73V147H78V176Z" fill="#765137"/><path d="M48 149H73V176H48Z" fill="#b98347"/><path d="M48 144H72V152H48Z" fill="#e2bd76"/><path d="M53 146H67V149H53Z" fill="#a77745"/></g>:<Tree x={60} y={177} size={.85*tree.scale} color="#4b9b3b" light="#a4d762"/>:node.tool_id==='pickaxe'?<g transform="translate(15 117) scale(3)"><path d="M0 18V11H3V6H8V2H20V5H25V10H29V20H0Z" fill="#536e78"/><path d="M3 17V11H6V6H11V4H19V7H23V12H26V17Z" fill="#94b7c2"/><path d="M6 10H11V6H16V11H12V14H6ZM18 13H23V17H18Z" fill="#cedcda"/><path d="M13 10H16V15H19V18H15V16H11V12H13Z" fill="#f0c96b"/></g>:<g transform="translate(8 132) scale(3)"><path d="M0 13V5H4V1H10V4H14V0H22V3H28V7H32V15H0Z" fill="#387b3c"/><path d="M3 11V6H7V4H11V7H17V3H22V6H27V10H29V13H3Z" fill="#73b94c"/>{!depleted&&[[7,8],[13,11],[20,7],[25,10]].map(([x,y])=><g key={x}><path d={`M${x} ${y}h3v3h-3Z`} fill="#d65b62"/><path d={`M${x} ${y}h1v1h-1Z`} fill="#ffe5ba"/></g>)}</g>}</svg>
    <span>{node.name}<small>{depleted?tree?.label||'等待再生':`${node.stock} / ${node.max_stock}`}</small></span>
  </button>;
}

function JourneyActor({ actor, world, selected, onSelect, now, live, zoom }) {
  const clock = usePixelNow(now, live && actor.status === 'active', actor);
  const position = confirmedPosition(actor, clock, live && !window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const p = journeyPoint(position), name = publicName(actor, world.agents);
  const execution = journeyExecution(actor, clock);
  return <button className={`journey-actor ${selected === actor.agent_id ? 'selected' : ''} ${actor.status === 'paused' ? 'paused' : ''}`} style={{ left: p.x * zoom, '--journey-lane': `${p.lane * zoom}px`, '--journey-actor-scale': zoom }} onClick={() => onSelect(actor.agent_id)} data-testid={`journey-agent-${actor.agent_id}`} data-speech-agent={actor.agent_id} data-scene-id="journey" data-foot-x={position.x} data-foot-y={position.y} aria-label={`查看${name}，${actor.status === 'paused' ? '已暂停' : execution?.text || '停留在林间小路'}`}>
    <span className="journey-foot-shadow"/><JourneyCharacterSprite actor={actor} world={world} now={now} live={live}/><span className="journey-name">{name}</span>
    <span className="journey-hp" aria-hidden="true"><i style={{ width: `${clamp(actor.adventure?.hp / actor.adventure?.max_hp * 100)}%` }}/></span>
  </button>;
}

function JourneyMonster({ monster, world, now, live, zoom, onInspect }) {
  const clock = usePixelNow(now, live && monster.status === 'alive', monster);
  const action = monsterAction(monster, world.events, clock);
  const p = journeyPoint(monster.position), defeated = monster.status !== 'alive';
  return <button className={`journey-monster ${defeated ? 'defeated' : ''}`} style={{ left: p.x * zoom, '--journey-lane': `${p.lane * zoom}px`, '--journey-actor-scale': zoom }} onClick={() => onInspect({ kind: 'monster', id: monster.monster_id })} data-testid={`journey-monster-${monster.monster_id}`} data-action={action} aria-label={`查看${monster.name}，${journeyMonsterLabel(monster, live)}，生命 ${monster.hp}/${monster.max_hp}`}>
    <span className="journey-foot-shadow"/><JourneyMonsterSprite monster={monster} world={world} now={now} live={live}/><span className="journey-name">{monster.name}</span><span className="journey-hp monster-hp" aria-hidden="true"><i style={{ width: `${clamp(monster.hp / monster.max_hp * 100)}%` }}/></span>
  </button>;
}

function CampFire({ site, fire, zoom, live, onInspect }) {
  const p = journeyPoint(site.position), lit = !!fire?.lit && fire.fuel_seconds > 0;
  return <button className={`journey-fire ${lit ? 'lit' : ''} ${live ? 'live' : ''}`} style={{ left: p.x * zoom, '--journey-lane': `${p.lane * zoom}px`, transform: `translate(-50%,-100%) scale(${zoom})` }} onClick={() => onInspect({ kind: 'fire', id: site.id })} data-testid={`journey-fire-${site.id}`} data-lit={String(lit)} aria-label={`查看${site.name}，${lit ? '篝火燃烧中' : fire ? '篝火已熄灭' : '尚未建火'}`}>
    <svg viewBox="0 0 32 32" aria-hidden="true" shapeRendering="crispEdges"><path d="M3 26H9V24H24V26H29V30H24V32H9V30H3Z" fill="#667757"/><path d="M5 27H12V25H23V27H27V29H19V31H10V29H5Z" fill="#849570"/><path d="M9 25H14V27H24V30H19V29H8V27H5V25Z" fill="#825331"/>{lit&&<><path className="journey-flame" d="M10 26V23H6V17H9V12H12V7H15V2H18V9H21V14H24V18H27V23H23V27H13V26Z" fill="#e98a3d"/><path d="M12 23V18H15V12H18V18H21V24H18V27H15V25H12Z" fill="#ffe476"/><path d="M15 23V19H18V25H15Z" fill="#fff5bf"/></>}</svg>
    <span>{lit ? `篝火 · ${Math.ceil(fire.fuel_seconds)} 秒燃料` : fire ? '火已熄灭' : '宿营火塘 · 尚未建火'}</span>
  </button>;
}

function Inspector({ selection, world, live, onClose }) {
  if (!selection) return null;
  const value = selection.kind === 'fire' ? world.survival?.sites?.find(site => site.id === selection.id) : selection.kind === 'resource' ? world.resources?.nodes?.find(node => node.id === selection.id) : world.journey?.monsters?.find(monster => monster.monster_id === selection.id);
  if (!value) return null;
  const fire = selection.kind === 'fire' && world.survival?.fires?.find(item => item.site_id === value.id);
  return <section className="journey-inspector" data-testid="journey-inspector" aria-label="林间观察详情"><div><strong>{value.name}</strong><button onClick={onClose} aria-label="关闭林间观察详情">关闭</button></div>{!live && <p>最近记录 · 等待连接恢复</p>}{selection.kind === 'fire' ? <p>{fire ? `${fire.lit && fire.fuel_seconds > 0 ? '篝火燃烧中' : '火已熄灭'} · 燃料 ${Math.ceil(fire.fuel_seconds)} 秒。` : '这里尚未建火，夜晚不提供免费照明。'}是否建造、添柴或休息，由到场的 AI 决定。</p> : selection.kind === 'resource' ? <p>共享储量 {value.stock}/{value.max_stock} · {value.tool_id ? ({ axe: '需要斧头', pickaxe: '需要镐' })[value.tool_id] || '需要工具' : '可以徒手采集'}。采集所得进入原背包，吃东西是独立行动。</p> : <p>{journeyMonsterLabel(value, live)} · 生命 {value.hp}/{value.max_hp}。沿下方小径可以绕过；是否交战由 AI 自己决定。</p>}</section>;
}

export default function JourneyView({ world, selected, onSelect, now, live, onView }) {
  const viewport = useRef(null), [width, setWidth] = useState(900), [zoom, setZoom] = useState(1), [center, setCenter] = useState(7), [following, setFollowing] = useState(false), [inspection, setInspection] = useState(null);
  const actors = journeyActors(world), actor = actors.find(item => item.agent_id === selected), followed = following ? actor : null;
  const clock = usePixelNow(now, live && !!followed, followed);
  const camera = journeyCamera({ actor: followed, now: clock, live, width, center, zoom });
  const nodes = world.journey?.nodes || [], monsters = world.journey?.monsters || [];
  const resources = (world.resources?.nodes || []).filter(node => node.scene_id === 'journey');
  const phase = world.day_cycle?.phase || 'day';
  useEffect(() => { const el = viewport.current; if (!el) return; const observer = new ResizeObserver(entries => setWidth(entries[0].contentRect.width)); observer.observe(el); return () => observer.disconnect(); }, []);
  useEffect(() => { if (!actor) setFollowing(false); }, [actor?.agent_id]);
  const pan = value => { setFollowing(false); setCenter(Math.max(0, Math.min(JOURNEY_LENGTH - 1, value))); };
  const selectActor = id => { onSelect(id); setFollowing(true); setInspection(null); };
  return <section className="journey-view" data-testid="journey-view" data-art-style="q-pixel" data-scene-id="journey" data-live={live ? 'true' : 'false'} aria-label="横版森林冒险">
    <div className="journey-heading"><div><span className="journey-eyebrow"><Trees size={13}/> FOREST ADVENTURE</span><h2>苔光林间道</h2><p>沿着小路，去看看今天的森林。</p></div><span className="journey-presence"><i className={live ? 'live' : ''}/>{live ? `${actors.length} 位在场` : '最近记录'}<small>{phaseNames[phase] || '林间'}</small></span></div>
    <nav className="journey-route" aria-label="观察林间路段">{nodes.map((node, i) => <button key={node.id} onClick={() => pan(node.position.x)} aria-label={`观察${node.name}`} aria-pressed={!following && Math.abs(center - node.position.x) < 1} data-testid={`journey-look-${node.id}`}><span className="journey-route-mark">{node.id === 'entry' ? <MapPin size={14}/> : node.id === 'camp' ? <Tent size={14}/> : node.id === 'clearing' ? <Leaf size={14}/> : <Mountain size={14}/>}</span><span><small>0{i + 1}</small>{node.name}</span></button>)}</nav>
    <div className={`journey-viewport phase-${phase}`} ref={viewport} data-testid="journey-viewport" tabIndex={0} aria-label="森林冒险画面，左右方向键移动观察镜头" onKeyDown={event => { if (event.target !== event.currentTarget) return; if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); pan((following && actor ? actor.position.x : center) + (event.key === 'ArrowLeft' ? -5 : 5)); } }}>
      <Scenery camera={camera} zoom={zoom}/>
      <div className="journey-stage" style={{ width: WORLD_WIDTH * zoom, transform: `translateX(${-camera}px)` }} data-camera-x={camera}>
        <Ground zoom={zoom}/>
        <div className="journey-track-label" style={{ left: 18.5 * JOURNEY_TILE * zoom, top: `calc(74% + ${84 * zoom}px)` }}>下方小径 · 可以绕行</div><div className="journey-track-label" style={{ left: 35.5 * JOURNEY_TILE * zoom, top: `calc(74% + ${84 * zoom}px)` }}>下方小径 · 可以绕行</div>
        {nodes.map(node => <Landmark key={node.id} node={node} zoom={zoom}/>)}
        {resources.map(node => <Resource key={node.id} node={node} zoom={zoom} onInspect={setInspection}/>)}
        {(world.survival?.sites || []).filter(site => site.scene_id === 'journey').map(site => <CampFire key={site.id} site={site} fire={world.survival?.fires?.find(fire => fire.site_id === site.id)} zoom={zoom} live={live} onInspect={setInspection}/>)}
        {monsters.map(monster => <JourneyMonster key={monster.monster_id} monster={monster} world={world} now={now} live={live} zoom={zoom} onInspect={setInspection}/>)}
        {actors.map(item => <JourneyActor key={item.agent_id} actor={item} world={world} selected={selected} onSelect={selectActor} now={now} live={live} zoom={zoom}/>)}
      </div>
      {actor?.journey_job?.phase==='fighting'&&<div className="journey-battle-banner" data-testid="journey-battle-banner"><span>交战中</span>{monsters.find(m=>m.monster_id===actor.journey_job.monster_id)?.name||'林间遭遇'}</div>}
      <div className="journey-scene-caption"><span><Trees size={14}/> 森林路线</span><small>{following && actor ? `关注 ${publicName(actor, world.agents)}` : '自由观察'}</small></div>
      {!actors.length && <div className="journey-empty" data-testid="journey-empty"><Eye size={20}/><strong>小路静静等待冒险者</strong><p>还没有 AI 来到这里。出发、探索或留在家中，都由它们自己决定。</p></div>}
      {!live && <div className="journey-stale" role="status">连接中断 · 画面停留在最近确认的位置</div>}
      <SpeechBubbles events={world.events} agents={actors} selected={selected} now={now} live={live} sceneId="journey"/>
    </div>
    <div className="journey-controls"><div className="journey-pan"><button onClick={() => pan((followed?.position.x ?? center) - 6)} aria-label="镜头向左"><ArrowLeft size={17}/></button><button onClick={() => pan((followed?.position.x ?? center) + 6)} aria-label="镜头向右"><ArrowRight size={17}/></button><span>只移动镜头</span></div><div><button disabled={!actor} aria-pressed={following} onClick={() => setFollowing(value => !value)}><Crosshair size={15}/>{following ? '停止跟随' : '跟随所选角色'}</button><button disabled={zoom <= .7} onClick={() => setZoom(value => Math.max(.7, value - .15))} aria-label="缩小冒险画面"><Minus size={15}/></button><button disabled={zoom >= 1.3} onClick={() => setZoom(value => Math.min(1.3, value + .15))} aria-label="放大冒险画面"><Plus size={15}/></button></div></div>
    <Inspector selection={inspection} world={world} live={live} onClose={() => setInspection(null)}/>
    <div className="journey-footnote"><span>同一条路 · 同一个世界</span><p>遇敌、绕行、采集与休息，由原 AI 选择。</p><button onClick={() => onView('plaza')}>看看生活广场 <ArrowRight size={13}/></button></div>
    <SpeechOverlay events={world.events} agents={world.agents} selected={selected} now={now} live={live}/>
  </section>;
}
