import React, { useEffect, useId, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Crosshair, Eye, Leaf, MapPin, Minus, Mountain, Plus, Tent, Trees } from 'lucide-react';
import { CharacterSprite, PixelSprite, useActorMotion, usePixelManifest, usePixelNow } from './PixelWorld.jsx';
import { confirmedPosition } from './scene-state.js';
import { actorFacing, monsterAction } from './pixel-state.js';
import { publicName } from './observer-state.js';
import { treePresentation } from './survival-state.js';
import SpeechOverlay, { SpeechBubbles } from './SpeechOverlay.jsx';
import { JOURNEY_LENGTH, JOURNEY_TILE, journeyActors, journeyCamera, journeyExecution, journeyMonsterLabel, journeyPoint } from './sideview-state.js';
import './journey.css';

const WORLD_WIDTH = JOURNEY_LENGTH * JOURNEY_TILE;
const clamp = (value, max = 100) => Math.max(0, Math.min(max, Number(value) || 0));
const phaseNames = { dawn: '晨光', day: '白昼', dusk: '暮色', night: '夜晚' };

// Original scenery is decorative. Interactive trees, ore, berries and the fire
// below are rendered separately from the public world state, with real stock.
function Tree({ x, y = 0, size = 1, color = '#324e43', light = '#456252' }) {
  return <g transform={`translate(${x} ${y}) scale(${size})`}>
    <path d="M-7 0L-4-138H5L8 0Z" fill="#574b39" />
    <path d="M0-217L23-175H13L45-132H28L63-88H41L74-47H21L0-32L-22-44H-72L-42-87H-61L-29-130H-42L-14-173H-25Z" fill={color}/>
    <path d="M0-217L1-168L-25-169ZM0-166L1-117L-42-121ZM0-114L1-64L-59-71Z" fill={light}/>
    <path d="M0-140L-25-122M1-91L30-72M-1-43L-33-58" fill="none" stroke="#243e35" strokeOpacity=".25" strokeWidth="3"/>
  </g>;
}

function Scenery({ camera, zoom }) {
  const uid = useId().replace(/:/g, '');
  return <>
    <svg className="journey-sky" viewBox="0 0 1200 500" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id={`${uid}-sky`} x2="0" y2="1"><stop stopColor="#81988b"/><stop offset=".65" stopColor="#c2c9a4"/><stop offset="1" stopColor="#e7d8a8"/></linearGradient></defs><rect width="1200" height="500" fill={`url(#${uid}-sky)`}/><path d="M735 90h85m-550 70h102M959 163h125" stroke="#e9e5c9" strokeWidth="13" opacity=".25"/></svg><div className="journey-sun" aria-hidden="true"/>
    <svg className="journey-far" width={WORLD_WIDTH} viewBox={`0 0 ${WORLD_WIDTH} 430`} preserveAspectRatio="none" style={{ transform: `translateX(${-camera * .18}px)` }} aria-hidden="true"><path d={`M0 215L150 118L290 212L445 82L625 223L794 143L980 245L1160 87L1370 225L1540 150L1760 251L1950 101L2140 220L2350 131L2520 219L2700 95L2900 230L3072 161V430H0Z`} fill="#7b9480"/><path d="M0 304L240 188L390 290L590 178L860 304L1080 208L1300 311L1590 201L1830 309L2070 195L2330 300L2600 188L2840 305L3072 210V430H0Z" fill="#607c69"/>{Array.from({ length: 34 }, (_, i) => <Tree key={i} x={i * 98 + 30} y={430} size={.5 + (i % 3) * .1} color="#587461" light="#64816b"/>)}</svg>
    <div className="journey-midground" style={{ width: WORLD_WIDTH * zoom, transform: `translateX(${-camera * .46}px)` }} aria-hidden="true"><svg width={WORLD_WIDTH * zoom} viewBox={`0 0 ${WORLD_WIDTH} 380`} preserveAspectRatio="none">{Array.from({ length: 25 }, (_, i) => <Tree key={i} x={i * 134 + 32} y={370} size={.78 + (i % 4) * .14} color={i % 2 ? '#3b594b' : '#456351'} light="#57765b"/>)}</svg></div>
  </>;
}

function Ground({ zoom }) {
  return <svg className="journey-ground-art" width={WORLD_WIDTH * zoom} viewBox={`0 0 ${WORLD_WIDTH} 150`} preserveAspectRatio="none" style={{ top: `calc(74% - ${28 * zoom}px)`, height: 150 * zoom }} aria-hidden="true">
    <path d={`M0 18L130 14L260 19L390 11L520 18L650 15L780 19L910 13L1040 17L1170 15L1300 20L1430 13L1560 17L1690 13L1820 18L1950 14L2080 19L2210 12L2340 18L2470 14L2600 19L2730 12L2860 17L3072 13V150H0Z`} fill="#4b5c3d"/>
    <path d="M0 26H3072V150H0Z" fill="#685940"/><path d="M0 29H3072" stroke="#c5b77b" strokeWidth="12"/><path d="M0 38H3072" stroke="#867452" strokeWidth="4"/>
    {Array.from({ length: 72 }, (_, i) => <g key={i} transform={`translate(${i * 44 + 12},${60 + i % 4 * 20})`}><path d="M0 0h14m8 5h5" stroke={i % 2 ? '#7e6c48' : '#554a36'} strokeWidth="3"/></g>)}
    {[15, 32].map(x => <g key={x}><path d={`M${(x + .5) * 64} 28L${(x + .5) * 64} 84H${(x + 6.5) * 64}V28`} fill="none" stroke="#3c4532" strokeWidth="28"/><path d={`M${(x + .5) * 64} 28L${(x + .5) * 64} 84H${(x + 6.5) * 64}V28`} fill="none" stroke="#b09a65" strokeWidth="16"/><path d={`M${(x + 1.4) * 64} 84H${(x + 5.6) * 64}`} stroke="#d4c28c" strokeWidth="2" strokeDasharray="8 10"/></g>)}
  </svg>;
}

function Landmark({ node, zoom }) {
  const p = journeyPoint(node.position);
  return <div className={`journey-landmark journey-landmark-${node.id}`} style={{ left: p.x * zoom, transform: `scale(${zoom})`, transformOrigin: '0 0' }} data-testid={`journey-node-${node.id}`}>
    {node.id === 'entry' && <svg className="journey-gate" viewBox="0 0 130 170" aria-hidden="true"><path d="M16 165V42L25 30H109L116 42V165" fill="none" stroke="#564732" strokeWidth="13"/><path d="M9 45L63 10L123 45Z" fill="#5b6748" stroke="#354b3d" strokeWidth="4"/><path d="M28 45H103V65H28Z" fill="#a78950"/><path d="M33 50H96" stroke="#d7bb76" strokeWidth="3"/><path d="M17 100h-8v58h8m98-58h9v58h-9" fill="#71815a"/></svg>}
    {node.id === 'camp' && <svg className="journey-tent" viewBox="0 0 220 150" aria-hidden="true"><path d="M8 135L78 24H150L213 135Z" fill="#c5ae74" stroke="#594b35" strokeWidth="4"/><path d="M78 24L137 135H8Z" fill="#d9c58d"/><path d="M78 57L119 135H31Z" fill="#354538"/><path d="M80 22L80 6m-72 129L0 149m213-14L220 149" stroke="#66553a" strokeWidth="4"/><path d="M143 38L185 119M158 53l-48 8" stroke="#a58d5d" strokeWidth="3"/></svg>}
    <span className="journey-sign"><i/><strong>{node.name}</strong><small>{node.id === 'entry' ? '← 通往广场' : node.id === 'camp' ? '歇脚处 · 补给由自己选择' : node.id === 'clearing' ? '松木 · 矿脉' : '沿路向前 →'}</small></span>
  </div>;
}

function Resource({ node, zoom, onInspect }) {
  const p = journeyPoint(node.interaction_position || node.position), depleted = node.stock <= 0;
  const tree = node.kind === 'tree' ? treePresentation(node) : null;
  return <button className={`journey-resource ${depleted ? 'depleted' : ''}`} style={{ left: p.x * zoom, transform: `translate(-50%,-100%) scale(${zoom})`, transformOrigin: '50% 100%' }} onClick={() => onInspect({ kind: 'resource', id: node.id })} data-testid={`journey-resource-${node.id}`} aria-label={`查看${node.name}，储量 ${node.stock}/${node.max_stock}`}>
    <svg viewBox="0 0 120 180" aria-hidden="true">{tree ? ['stump', 'empty'].includes(tree.stage) ? <path d="M42 176V145H75V176M35 176H81" fill="#836c44" stroke="#4f4c33" strokeWidth="4"/> : <Tree x={60} y={177} size={.74 * tree.scale} color="#4e6a40" light="#759057"/> : node.tool_id === 'pickaxe' ? <g transform="translate(0 100)"><path d="M14 73L24 35L49 13L84 21L108 57L99 77Z" fill="#7e8b80" stroke="#414f46" strokeWidth="4"/><path d="M49 13L61 50L24 35M61 50L99 77M84 21L61 50" fill="none" stroke="#afb4a0" strokeWidth="4"/><path d="M42 44L49 40L56 48L46 58Z" fill="#d0b56e"/></g> : <g transform="translate(0 117)"><path d="M12 56L5 37L25 32L21 12L47 15L59 0L76 16L100 11L96 34L114 42L101 58Z" fill="#527348" stroke="#344f36" strokeWidth="3"/>{!depleted && [[24,38],[40,24],[62,36],[83,25],[94,45]].map(([x,y]) => <g key={x}><rect x={x} y={y} width="7" height="8" fill="#b76c55"/><rect x={x+1} y={y} width="3" height="3" fill="#db9974"/></g>)}</g>}</svg>
    <span>{node.name}<small>{depleted ? tree?.label || '等待再生' : `${node.stock} / ${node.max_stock}`}</small></span>
  </button>;
}

function JourneyActor({ actor, world, selected, onSelect, now, live, zoom }) {
  const clock = usePixelNow(now, live && actor.status === 'active', actor);
  const position = confirmedPosition(actor, clock, live && !window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const p = journeyPoint(position), name = publicName(actor, world.agents);
  const execution = journeyExecution(actor, clock);
  return <button className={`journey-actor ${selected === actor.agent_id ? 'selected' : ''} ${actor.status === 'paused' ? 'paused' : ''}`} style={{ left: p.x * zoom, '--journey-lane': `${p.lane * zoom}px`, '--journey-actor-scale': zoom }} onClick={() => onSelect(actor.agent_id)} data-testid={`journey-agent-${actor.agent_id}`} data-speech-agent={actor.agent_id} data-scene-id="journey" data-foot-x={position.x} data-foot-y={position.y} aria-label={`查看${name}，${actor.status === 'paused' ? '已暂停' : execution?.text || '停留在林间小路'}`}>
    <span className="journey-foot-shadow"/><CharacterSprite agent={actor} events={world.events} now={now} live={live}/><span className="journey-name">{name}</span>
    <span className="journey-hp" aria-hidden="true"><i style={{ width: `${clamp(actor.adventure?.hp / actor.adventure?.max_hp * 100)}%` }}/></span>
    {actor.hurt && clock >= actor.hurt.started_at && clock < actor.hurt.ends_at && <span className="journey-damage" aria-hidden="true">−{actor.hurt.damage}</span>}
  </button>;
}

function JourneyMonster({ monster, world, now, live, zoom, onInspect }) {
  const assets = usePixelManifest(), clock = usePixelNow(now, live && monster.status === 'alive', monster);
  const action = monsterAction(monster, world.events, clock);
  const facing = actorFacing(monster, action, clock, 'west');
  const definition = assets?.monsters?.[monster.sprite_id || (monster.monster_id.includes('boar') ? 'forest_boar' : 'forest_slime')];
  const timeline = useActorMotion(monster, action, clock, { enabled: live && monster.status === 'alive', facing, definition, events: world.events });
  const p = journeyPoint(monster.position), defeated = monster.status !== 'alive';
  return <button className={`journey-monster ${defeated ? 'defeated' : ''}`} style={{ left: p.x * zoom, '--journey-lane': `${p.lane * zoom}px`, '--journey-actor-scale': zoom }} onClick={() => onInspect({ kind: 'monster', id: monster.monster_id })} data-testid={`journey-monster-${monster.monster_id}`} data-action={action} aria-label={`查看${monster.name}，${journeyMonsterLabel(monster, live)}，生命 ${monster.hp}/${monster.max_hp}`}>
    <span className="journey-foot-shadow"/><PixelSprite definition={definition} action={action} facing={facing} sampledElapsed={timeline.elapsed} poseFrame={timeline.frame} visualPose={timeline.pose}/><span className="journey-name">{monster.name}</span><span className="journey-hp monster-hp" aria-hidden="true"><i style={{ width: `${clamp(monster.hp / monster.max_hp * 100)}%` }}/></span>
    {monster.hurt && clock >= monster.hurt.started_at && clock < monster.hurt.ends_at && <span className="journey-damage" aria-hidden="true">−{monster.hurt.damage}</span>}
  </button>;
}

function CampFire({ site, fire, zoom, live, onInspect }) {
  const p = journeyPoint(site.position), lit = !!fire?.lit && fire.fuel_seconds > 0;
  return <button className={`journey-fire ${lit ? 'lit' : ''} ${live ? 'live' : ''}`} style={{ left: p.x * zoom, '--journey-lane': `${p.lane * zoom}px`, transform: `translate(-50%,-100%) scale(${zoom})` }} onClick={() => onInspect({ kind: 'fire', id: site.id })} data-testid={`journey-fire-${site.id}`} data-lit={String(lit)} aria-label={`查看${site.name}，${lit ? '篝火燃烧中' : fire ? '篝火已熄灭' : '尚未建火'}`}>
    <svg viewBox="0 0 80 80" aria-hidden="true"><ellipse cx="40" cy="70" rx="30" ry="8" fill="#34422e55"/><path d="M17 67L62 76M19 76L61 65" stroke="#5b4734" strokeWidth="9"/>{lit && <><path className="journey-flame" d="M38 67C7 60 24 31 30 33C21 17 40 15 39 0C61 21 47 24 55 36C75 48 61 70 38 67Z" fill="#de9857"/><path d="M40 64C22 56 39 44 37 30C53 44 57 61 40 64Z" fill="#f4dc88"/></>}</svg>
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
  return <section className="journey-view" data-testid="journey-view" data-scene-id="journey" data-live={live ? 'true' : 'false'} aria-label="横版森林冒险">
    <div className="journey-heading"><div><span className="journey-eyebrow"><Trees size={13}/> THE MOSS ROAD</span><h2>苔光林间道</h2><p>从村口出发，故事在路上发生。</p></div><span className="journey-presence"><i className={live ? 'live' : ''}/>{live ? `${actors.length} 位在场` : '最近记录'}<small>{phaseNames[phase] || '林间'}</small></span></div>
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
      <div className="journey-grain" aria-hidden="true"/>
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
