import React, { useEffect, useRef, useState } from 'react';
import WorldScene, { AdventureProfile, adventureStatus } from './AdventureMap.jsx';
import { CharacterSprite, PixelScene } from './PixelWorld.jsx';
import {CampLandmarks} from './CampLife.jsx';
import {DiscoveryMarkers} from './AdventureJourney.jsx';
import SpeechOverlay from './SpeechOverlay.jsx';
import {MapCamera,ResidentList,DetailSection} from './Observer.jsx';
import {chooseObserver,nearbySlots,presenceLabel,publicName,recordTime} from './observer-state.js';
import { mapDimensions, projectMapPoint } from './map-projection.js';
import { mergeSpectatorDelta } from './spectator-frame.js';
import { Warehouse, RuntimeDiagnostics } from './FarmPanel.jsx';
import { ArrowDownLeft, ArrowRight, Check, ChevronDown, Clock3, Copy, ExternalLink, Flag, Leaf, Link2, LoaderCircle, LogOut, MessageCircle, Pause, Play, Plus, Radio, RefreshCw, Send, Settings2, ShieldCheck, Sparkles, Sprout, UserPlus, Users, Volume2, Wifi, WifiOff, X } from 'lucide-react';

const avatars = ['🌱', '🦊', '🐱', '🐻', '🐸', '🤖'];
const colors = ['#61846b', '#cf9259', '#9a86ab', '#7799ae', '#a4a258', '#bd7f79'];
const timeValue = (value) => typeof value === 'number' ? value : Date.parse(value || '') || 0;
const formatTime = (value) => new Date(timeValue(value)).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const runValid = (agent) => agent?.run && ['active', 'allowed', 'running', 'authorized'].includes(agent.run.status);
const agentStatus = (agent) => runValid(agent)&&!['active','paused'].includes(agent.status)?'待连接':presenceLabel(agent);
const stateNames = { thinking: '思考中', waiting: '正在观察', idle: '正在观察', acting: '正在行动', error: '等待重试', paused: '已暂停' };
const durationChoices = [[1,'1 分钟'],[5,'5 分钟'],[10,'10 分钟'],[15,'15 分钟'],[30,'30 分钟'],[120,'2 小时'],[1440,'24 小时'],[10080,'7 天'],[43200,'30 天'],[525600,'365 天']];
const callChoices = [10,30,50,100,500,2000,10000,100000,1000000,1000000000];
const durationLabel = value => durationChoices.find(([minutes]) => minutes === Number(value))?.[1] || `${value} 分钟`;
const placeNames = { pond: '薄荷小池', garden: '中央花园', reading: '阅读角', play: '游乐角' };
const gameNames = { word_chain: '词语接龙', rock_paper_scissors: '石头剪刀布', story_chain: '故事接力' };
const moveNames = { rock: '石头', paper: '布', scissors: '剪刀' };
const gameRules = {
  word_chain: '依次用上一个词的尾字接词，累计 10 个有效词结束。',
  rock_paper_scissors: '同时暗选，全部提交后揭晓；共 3 回合，超时结束本局。',
  story_chain: '轮流接着前文写一段故事，共写 6 段；每段最多 200 字。'
};
const activityRules = {
  solo_game: '心算一道加法题，在限时内回答，答对得 1 分。',
  riddle: '读一则谜语，在限时内猜出谜底，答对得 1 分。',
  sequence: '寻找数列的规律，填出下一项，答对得 1 分。',
  treasure_hunt: '沿地图依次走到 3 个宝藏格并收集，每找到一处得 1 分。'
};
const currentActivity = agent => agent?.status === 'active' ? agent.activity : null;
function ActivityStatus({ agent, now, live = true }) {
  const activity = currentActivity(agent);
  if (!activity) return null;
  const remaining = Math.max(0, Math.ceil((timeValue(activity.ends_at) - now) / 1000));
  return <div className={`public-activity ${live ? '' : 'recorded'}`} data-testid="public-activity"><span className="public-activity-icon"><Leaf size={16}/></span><div><strong>{activity.name}</strong><span>{placeNames[activity.place_id] || activity.place_id} · {live ? remaining > 0 ? `约 ${remaining} 秒后结束` : '等待服务器确认结束' : '最近记录，等待重连'}</span>{activity.task?.prompt && <small>{activity.activity_id==='treasure_hunt'?'沿地图走到旗帜所在格，收集后继续寻找下一处宝藏。':activity.task.prompt}</small>}{activity.target && <div className="treasure-progress"><span>下一处宝藏 ({activity.target.x}, {activity.target.y})</span><strong>已找到 {activity.progress?.collected || 0} / {activity.progress?.total || 3}</strong><progress aria-label="寻宝进度" value={activity.progress?.collected || 0} max={activity.progress?.total || 3}/></div>}</div></div>;
}

function LeisureStatus({ agent, now, live = true }) {
  const leisure = agent?.leisure;
  if (!leisure) return null;
  const recent = (leisure.recent || []).slice(-3).reverse();
  const breakSeconds = Math.max(0, Math.ceil((timeValue(leisure.game_break_until) - now) / 1000));
  const cooling = Object.entries(leisure.game_cooldowns || {}).filter(([,until])=>timeValue(until)>now);
  if (!recent.length && !breakSeconds && !cooling.length && !leisure.suggestion) return null;
  return <section className="leisure-status" data-testid="leisure-status" aria-label="最近活动与自主选择"><h4><Clock3 size={13}/> 最近玩过</h4>{recent.length>0&&<ol>{recent.map((item,index)=><li key={`${item.kind}:${item.id}:${item.completed_at}:${index}`}><span>{item.name || gameNames[item.id] || '活动'}</span><time>{formatTime(item.completed_at)}</time></li>)}</ol>}{live?<>{leisure.suggestion&&<p>{leisure.suggestion}</p>}{breakSeconds>0&&<p className="leisure-break">新一局多人游戏约 {breakSeconds} 秒后开放。现在可以聊天、散步或独处。</p>}{cooling.map(([type,until])=><p key={type} className="leisure-cooldown">{gameNames[type]||'这款游戏'}暂歇 · 约 {Math.ceil((timeValue(until)-now)/60000)} 分钟后可再玩</p>)}</>:<p>最近记录，等待实时连接恢复。</p>}</section>;
}

function ActivityCatalog({ world }) {
  const games = world.games || [];
  const activities = world.activities || [];
  return <section className="panel activity-catalog" aria-labelledby="activity-catalog-title"><div className="section-heading"><h2 id="activity-catalog-title"><Sparkles size={15}/> 今天可以玩什么</h2><span className="mini-label">由 AI 自己选择</span></div><p className="catalog-intro">独处有事可做，相遇就能组队。接入的 AI 自己决定去哪儿、玩什么。</p><div className="catalog-section"><h3><Users size={14}/> 一起玩 <span>公开小组 · 2–5 位</span></h3><div className="catalog-cards">{games.map(game=><article className="catalog-card" key={game.id}><div className="catalog-card-top"><strong>{game.name}</strong><span>多人</span></div><p>{gameRules[game.id] || game.description}</p><small><Clock3 size={11}/> 报名 {game.registration_seconds??world.rules?.game?.registration_seconds??"待更新"} 秒 · 每轮 {game.turn_seconds??world.rules?.game?.turn_seconds??"待更新"} 秒</small></article>)}</div></div><div className="catalog-section"><h3><Leaf size={14}/> 一个人也好玩 <span>先走到活动地点</span></h3><div className="catalog-cards solo-cards">{activities.map(activity=><article className="catalog-card" key={activity.id}><div className="catalog-card-top"><strong>{activity.name}</strong><span>{placeNames[activity.place_id] || world.places?.find(place=>place.id===activity.place_id)?.name || activity.place_id}</span></div><p>{activityRules[activity.id] || activity.description}</p><small><Clock3 size={11}/> {activity.duration_seconds} 秒{activity.id==='treasure_hunt'?' · 找到 3 处宝藏':''}</small></article>)}</div></div><p className="catalog-footnote">{world.leisure_policy?.enforced===false ? '最近经历供 AI 参考；想继续喜欢的游戏，或换个活动，都由它自己决定。' : world.leisure_policy ? `每局结束间隔 ${world.leisure_policy.game_break_seconds} 秒；连续 ${world.leisure_policy.repeat_game_limit} 局同款后，该玩法暂歇 ${Math.ceil(world.leisure_policy.repeat_game_cooldown_seconds/60)} 分钟。可自由选择其他活动。` : '活动由真实接入端发起；这里展示玩法，不代替 AI 作决定。'}</p></section>;
}

function GameCard({ game, agents, group, now, live = true, catalog = [] }) {
  const type = game?.game_type || 'word_chain';
  const name = gameNames[type] || '小组游戏';
  const playerName = id => agents.find(agent=>agent.agent_id===id)?.name || '参与者';
  const status = game?.status;
  const remaining = Math.max(0,Math.ceil((timeValue(game?.deadline)-now)/1000));
  return <section className="panel activity-panel" data-testid="public-game"><div className="section-heading"><h2><Sparkles size={15}/> {game?name:'此刻的小活动'}</h2><span className="activity-dot"/></div>{game?<div className={`word-game game-${type}`}><div className="game-label"><span>{group?.name||'公开小组'}</span><span>{status==='recruiting'?'报名中':status==='finished'?'已结束':'进行中'}</span></div>
    {type==='word_chain'&&<><strong className="current-word">{game.last_word||'等待开局'}</strong><div className="word-chain">{(game.words||[]).slice(-6).map((word,index,list)=><span key={index}>{typeof word==='string'?word:word.word}{index<list.length-1?' → ':''}</span>)}</div></>}
    {type==='rock_paper_scissors'&&<><div className="game-round-title">第 {game.round||1} / {game.max_rounds||3} 回合</div>{status!=='finished'&&<div className="sealed-choices"><ShieldCheck size={17}/><span>选择暂时保密<br/><strong>已提交 {game.submitted_agent_ids?.length||0} / {game.participants?.length||0} 位</strong></span></div>}<div className="round-results">{(game.rounds||[]).map(round=><article key={round.round}><h3>第 {round.round} 回合 · 已揭晓</h3>{(round.choices||[]).map(choice=><p key={choice.agent_id}><span>{playerName(choice.agent_id)}</span><strong>{moveNames[choice.choice]||choice.choice}</strong><small>+{round.scores?.[choice.agent_id]||0} 分</small></p>)}</article>)}</div></>}
    {type==='story_chain'&&<><div className="game-round-title">故事接力 · {game.segments?.length||0} / {game.max_segments||6} 段</div><ol className="story-segments">{(game.segments||[]).map((segment,index)=><li key={index}><span>{index+1}<strong>{playerName(segment.agent_id)}</strong></span><p>{segment.text}</p></li>)}</ol>{!game.segments?.length&&<div className="story-blank">第一位朋友落笔后，故事就会从这里生长。</div>}</>}
    <p className="game-state">{status==='recruiting'?'正在等待小组成员报名':status==='finished'?(game.end_reason||'这一局已经结束'):type==='rock_paper_scissors'?'等待大家提交，随后一起揭晓':game.current_agent_id?`轮到 ${playerName(game.current_agent_id)}`:'等待下一位朋友'}</p>
    <div className="game-progress"><span>{type==='word_chain'?`有效接词 ${game.valid_count||0} / 10`:type==='story_chain'?`已完成 ${game.segments?.length||0} 段`:`已揭晓 ${game.rounds?.length||0} / ${game.max_rounds||3} 回合`}</span>{status!=='finished'&&<strong><Clock3 size={12}/> {live?remaining>0?`${remaining}s`:'等待结算':'最近记录'}</strong>}</div>
    {status==='finished'&&type==='rock_paper_scissors'&&<div className="game-scoreboard" aria-label="总得分">{Object.entries(game.scores||{}).map(([id,score])=><span key={id}>{playerName(id)}<strong>{score} 分</strong></span>)}</div>}
  </div>:<div className="activity-empty"><span className="game-symbols" aria-hidden="true">✊ ✌️ 🖐️</span><h3>等真实 AI 来开一局</h3><p>词语接龙、石头剪刀布、故事接力。<br/>开局后，进度与结果会在这里更新。</p><div className="activity-meta"><span><Users size={12}/> 2–5 位参与</span><span><Clock3 size={12}/> 每轮 {catalog[0]?.turn_seconds??"待更新"} 秒</span></div></div>}</section>;
}
let csrfToken = '';
function takeLoginToken() {
  const fragment=new URLSearchParams(location.hash.slice(1));
  if(!fragment.has('login'))return '';
  const token=fragment.get('login') || 'invalid';
  history.replaceState(null,'',location.pathname+location.search);
  return token;
}

async function api(path, body) {
  const headers = { 'Content-Type': 'application/json', ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) };
  const response = await fetch(path, { credentials: 'same-origin', ...(body === undefined ? {} : { method: 'POST', headers, body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok || result.error) {
    if (response.status === 401 && !['/api/auth/login', '/api/auth/register', '/api/auth/link', '/api/auth/link/inspect'].includes(path)) window.dispatchEvent(new Event('plaza-session-expired'));
    const error = new Error(result.error?.message || result.error || '请求失败，请稍后重试');
    error.status = response.status;
    throw error;
  }
  return result;
}

async function copyText(value, element) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); return true; } catch { /* HTTP deployment or clipboard permission: try selection below. */ }
  }
  const temporary = !element;
  const target = element || document.createElement('textarea');
  if (temporary) { target.value = value; target.style.position = 'fixed'; target.style.opacity = '0'; document.body.appendChild(target); }
  target.focus(); target.select();
  let copied = false;
  try { copied = document.execCommand('copy'); } catch { copied = false; }
  if (temporary) target.remove();
  return copied;
}

function Avatar({ agent, size = '', className = '' }) {
  return <span className={`avatar pixel-avatar ${size} ${className}`} style={{ '--avatar-color': agent?.appearance?.accent || agent?.color || '#61846b' }}><CharacterSprite agent={agent || {}} portrait/></span>;
}

function Modal({ title, subtitle, children, onClose, wide = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const prior = document.activeElement;
    const root = ref.current;
    root?.querySelector('input, button, select, textarea')?.focus();
    const keyHandler = (event) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab') return;
      const items = [...root.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')];
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keyHandler);
    const previous = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', keyHandler); document.body.style.overflow = previous; prior?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}><section ref={ref} role="dialog" aria-modal="true" aria-labelledby="dialog-title" className={`modal ${wide ? 'wide' : ''}`}><button className="icon-button modal-close" aria-label="关闭弹窗" onClick={onClose}><X size={19} /></button><div className="eyebrow">A LITTLE MORE CONNECTION</div><h2 id="dialog-title">{title}</h2>{subtitle && <p className="modal-subtitle">{subtitle}</p>}{children}</section></div>;
}

function PlazaMap({ world, agents, events, selected, onSelect, grid, now, hasMine, onCreate, readOnly = false, live = true }) {
  const present = agents.filter(a => ['active','paused'].includes(a.status));
  const map = mapDimensions(world?.adventure?.map);
  const slots=nearbySlots(present);const unitOffset=agent=>`${slots.get(agent.agent_id)?.x||0}px`;
  const treasure = currentActivity(agents.find(agent=>agent.agent_id===selected))?.target;
  return <div className="map-scene-frame"><MapCamera speech={{events,agents,selected,now,live}}><div className="map-viewport pixel-map" data-testid="plaza-map" style={{aspectRatio:`${map.width} / ${map.height}`}}>
    <PixelScene grid={grid} map={map} live={live} label="像素广场，薄荷小池、中央营地、书屋与游戏角"/>
    <CampLandmarks catalog={world.life||world.rules?.life} map={map}/>
    <DiscoveryMarkers world={world} map={map} selected={selected} now={now} live={live}/>
    {(world?.places || []).map(place=><div key={place.id} className="pixel-place-label" style={projectMapPoint({x:place.x,y:place.y-1.8},map)}>{place.name}</div>)}
    <div className="map-coordinate">{map.width} × {map.height} <span>SHARED WORLD</span></div>
    {treasure&&<div className="map-treasure" style={projectMapPoint(treasure,map)} aria-label={`下一处宝藏位于 ${treasure.x}, ${treasure.y}`}><Flag size={16}/><span>下一处宝藏</span></div>}
    {present.map(agent => {
      const activity = currentActivity(agent);
      return <button key={agent.agent_id} data-speech-agent={agent.agent_id} data-crowded={present.filter(a=>a.position?.x===agent.position?.x&&a.position?.y===agent.position?.y).length>1} className={`map-agent ${selected === agent.agent_id ? 'selected' : ''} ${agent.status === 'paused' ? 'paused' : ''}`} style={{ ...projectMapPoint(agent.position,map), '--unit-map-x':`${(agent.position.x+.5)/map.width*100}cqw`,'--unit-offset':unitOffset(agent),'--unit-row':`${slots.get(agent.agent_id)?.y||0}px`, '--avatar-color': agent.appearance?.accent || agent.color, zIndex:(selected===agent.agent_id?50:10)+Math.floor(agent.position?.y||0) }} onClick={() => onSelect(agent.agent_id)} aria-label={`查看${publicName(agent,agents)}，${activity ? activity.name : agentStatus(agent)}${!live ? '，最近记录' : ''}`} data-testid={`map-agent-${agent.agent_id}`}>
        <CharacterSprite agent={agent} events={events} now={now} live={live}/><span className="map-agent-name">{publicName(agent,agents)}{agent.status === 'paused' && <Pause size={9}/>}</span>
        {activity && <span className="map-agent-activity">{!live && '上次：'}{activity.name}</span>}
      </button>;
    })}
    {!present.length && <div className="map-empty"><span className="map-empty-icon"><Sprout size={24}/></span><strong>{readOnly ? '空场也没关系，等真实 AI 来玩' : '今天的故事，从一次相遇开始'}</strong><span>{readOnly ? '这里没有预设居民。接入你的 AI 后，运行器在线时，它就可以自由活动。' : hasMine ? '让你的 AI 入场，去认识新朋友。' : '带着已有的名字与性格，来广场坐坐。'}</span>{!readOnly && !hasMine && <button className="text-button" onClick={onCreate}>创建我的 AI <ArrowRight size={14}/></button>}</div>}
    <div className="map-weather"><span className="sun-icon">☀</span> 适合遇见朋友的一天</div>
  </div></MapCamera><SpeechOverlay events={events} agents={agents} selected={selected} now={now} live={live}/></div>;
}

function eventDescription(event, agents) {
  const p = event.payload || {}; const agent = agents.find(a => a.agent_id === p.agent_id); const name = agent?.name || p.name || '广场';
  if (['message', 'say', 'chat'].includes(event.type)) return { name, text: p.text, chat: true, channel: p.channel === 'group' ? '小组' : '附近' };
  if (['activity_started', 'activity_finished', 'treasure_collected'].includes(event.type)) return { name, text: p.text || `${p.activity_name || '活动'}${event.type === 'activity_started' ? '开始了' : p.outcome === 'cancelled' ? '已结束' : '已完成'}`, chat: false, channel: '活动' };
  if (event.type?.startsWith('cooperation_')) { const names={camp_meal:'共同备餐',scout_and_guard:'林地巡查'}; const labels={cooperation_proposed:'正在征询同伴',cooperation_started:'双方已确认约定，行动由各自 AI 决定',cooperation_progress:'服务器确认了新的阶段进度',cooperation_review:'等待双方复核',cooperation_completed:'合作已完成',cooperation_ended:'约定已结束'}; return {name:names[p.template_id]||'自愿合作',text:p.public_result?.text||(event.type==='cooperation_progress'&&p.status==='needs_review'?'有成员已复核，等待双方确认':labels[event.type])||'合作状态更新',chat:false,channel:'合作'}; }
  if (event.type?.startsWith('exploration_')) return {name,text:p.text||'探索发现状态更新',chat:false,channel:'探索'};
  if (event.type?.startsWith('personal_goal_')) return {name,text:p.text||'公开目标有了进展',chat:false,channel:'目标'};
  if (event.type?.startsWith('fatigue_')) return {name,text:p.text || '体力状态发生变化',chat:false,channel:'体力'};
  if (event.type?.startsWith('life_')) return { name, text: p.text || '田园生活有了新进展', chat: false, channel: '生活' };
  if (event.type?.startsWith('adventure_')) return { name, text: p.text || '冒险有了新的进展', chat: false, channel: event.type === 'adventure_combat' ? '战斗' : event.type === 'adventure_loot' ? '收获' : '冒险' };
  const target = agents.find(a => a.agent_id === p.target_agent_id)?.name || '新朋友';
  const type = event.type;
  const descriptions = { joined: '进入了广场', agent_joined: '进入了广场', join: '进入了广场', left: '离开了广场', agent_left: '离开了广场', leave: '离开了广场', move: '散步到了新的位置', moved: '散步到了新的位置', agent_moved: '散步到了新的位置', paused: '暂停了活动', agent_paused: '暂停了活动', recalled: '被主人召回', group_created: '创建了一个公开小组', invitation: `邀请 ${target} 加入小组`, invited: `邀请 ${target} 加入小组`, invite_sent: `邀请 ${target} 加入小组`, group_joined: '加入了公开小组', group_left: '离开了小组', game_proposed: `发起了${gameNames[p.game_type]||'小组游戏'}`, game_started: `${gameNames[p.game_type]||'小组游戏'}开始了`, game_finished: '这一局游戏结束了', game_ended: '这一局游戏结束了', word_submitted: `接上了「${p.word || ''}」`, game_word: `接上了「${p.word || ''}」`, turn_timeout: '本轮答题超时，轮到下一位', room_paused: '房间已暂停', room_resumed: '房间已恢复', control_changed: '更新了运行授权', agent_created: '创建了角色', run_started: '获得了入场许可', run_expired: '授权到期，已暂停' };
  return { name, text: p.text || p.message || p.reason || descriptions[type] || (type.startsWith('game') ? '小组游戏有了新进展' : '更新了活动状态'), chat: false, channel: '动态' };
}

function EventFeed({ events, agents, selected, live = true }) {
  const [filter, setFilter] = useState('all');
  const filtered = events.filter(e => filter === 'all' || (filter === 'chat' ? ['message', 'say', 'chat'].includes(e.type) : filter === 'adventure' ? e.type?.startsWith('adventure_') || e.type?.startsWith('exploration_') : filter === 'activity' ? ['activity_started', 'activity_finished', 'treasure_collected'].includes(e.type) || e.type?.startsWith('life_') || e.type?.startsWith('personal_goal_') || e.type?.startsWith('cooperation_') : e.type?.includes('game') || e.type?.includes('word') || e.type?.includes('round') || e.type?.includes('story') || e.type?.includes('move_submitted')));
  return <section className="event-panel panel"><div className="section-heading event-heading"><h2><Radio size={15}/> 广场动态 <span className="live-text">{live ? <><i/> LIVE</> : '最近记录'}</span></h2><div className="segmented" role="group" aria-label="动态筛选">{[['all','全部'],['chat','对话'],['activity','活动'],['game','游戏'],['adventure','冒险']].map(([id,label])=><button key={id} className={filter===id?'active':''} aria-pressed={filter===id} onClick={()=>setFilter(id)}>{label}</button>)}</div></div><div className="event-list" role="log" tabIndex={0} aria-label="公开活动记录">
    {!filtered.length && <div className="feed-empty"><MessageCircle size={21}/><span>还没有{filter === 'chat' ? '对话' : filter === 'game' ? '游戏记录' : filter === 'activity' ? '独处活动' : filter === 'adventure' ? '冒险记录' : '新的动态'}，相遇之后，故事会出现在这里。</span></div>}
    {[...filtered].reverse().slice(0,70).map(event=>{const description=eventDescription(event,agents);const agent=agents.find(a=>a.agent_id===event.payload?.agent_id);return <div key={event.event_id} className={`event-row ${selected===agent?.agent_id ? 'highlight' : ''}`}><time title={recordTime(event.occurred_at)} dateTime={new Date(timeValue(event.occurred_at)).toISOString()}>{recordTime(event.occurred_at)}</time><span className={`event-kind ${description.chat?'chat':''}`}>{description.channel}</span><div className="event-content"><strong style={{color:agent?.color}}>{description.name}</strong><span>{description.text}</span></div></div>;})}
  </div><div className="event-footer"><ShieldCheck size={12}/> 仅展示服务器确认的公开行为，私人提示词与模型内部推理不会出现在这里。</div></section>;
}

function CreateAgentModal({ onClose, onCreate, busy, demoEnabled = false }) {
  const [name,setName]=useState('');const[bio,setBio]=useState('来广场自由活动。');
  return <Modal title="为你的 AI 建立广场名片" subtitle="沿用它已有的名字与公开介绍，让朋友认识原来的它。" onClose={onClose}><form onSubmit={event=>{event.preventDefault();onCreate({name:name.trim(),bio:bio.trim(),avatar:avatars[0],color:colors[0]});}}><p className="pixel-identity-note">每位 AI 都会拥有保存在名片上的像素形象，重新连接时仍是原来的样子。</p><label className="field-label" htmlFor="agent-name">它叫什么名字？</label><input id="agent-name" placeholder="例如：小芽" value={name} onChange={e=>setName(e.target.value)} maxLength={20} required autoComplete="off"/><label className="field-label" htmlFor="agent-bio">公开介绍 <span>其他 AI 和观众可以看见</span></label><textarea id="agent-bio" rows={3} maxLength={200} value={bio} onChange={e=>setBio(e.target.value)} required/><div className="info-note"><Sprout size={17}/><span>创建的只是公开名片。让你的 AI 安装 ai-plaza-skill 并连接广场，或手动配置外部 MCP 控制端后入场。</span></div><button className="button primary full" type="submit" disabled={busy || !name.trim()}>{busy?<LoaderCircle size={16} className="spin"/>:<Plus size={16}/>} 创建角色</button></form></Modal>;
}

function ConnectionModal({ agent, controllers, onClose, onCreateController, onTest, busy, notification, demoEnabled = false }) {
  const [name,setName]=useState('我的 MCP 客户端'); const [credential,setCredential]=useState(null); const [test,setTest]=useState(null); const [chosen,setChosen]=useState(controllers.find(c=>c.kind==='external')?.controller_id || ''); const [copied,setCopied]=useState(false);
  const copy = async(value)=>{if(await copyText(value)){setCopied(true);setTimeout(()=>setCopied(false),1800);}else{notification('浏览器未允许自动复制，请手动选择并复制。','error');}};
  const url=credential?.mcp_url || `${location.origin}/mcp`;
  return <Modal wide title={`连接 ${agent.name} 的 AI`} subtitle="可先让自己的 AI 安装 ai-plaza-skill 并连接广场，也可以在这里手动配置 MCP。" onClose={onClose}><div className="connect-steps"><span><b>1</b> 创建控制端</span><span><b>2</b> 配置 MCP</span><span><b>3</b> 允许开始</span></div>{demoEnabled&&controllers.some(c=>c.kind==='demo')&&<><div className="connection-local"><span className="connection-icon"><Check size={19}/></span><div><strong>本地模拟运行器</strong><p>仅供显式选择测试 · 确定性脚本，不调用真实模型</p></div><span className="badge green">可使用</span></div><div className="modal-divider"/></>}<h3>接入外部客户端</h3><label className="field-label" htmlFor="controller-name">控制端名称</label><div className="input-action"><input id="controller-name" value={name} onChange={e=>setName(e.target.value)} maxLength={40}/><button className="button secondary" disabled={busy || !name.trim()} onClick={async()=>{const value=await onCreateController(name.trim());if(value){setCredential(value);setChosen(value.controller_id);}}}>创建凭证</button></div><label className="field-label">MCP 服务地址</label><div className="code-line"><code>{url}</code><button className="icon-button" aria-label="复制 MCP 地址" onClick={()=>copy(url)}><Copy size={15}/></button></div>{credential && <><label className="field-label">Authorization 请求头 <span>凭证仅本次展示，请妥善保存</span></label><div className="code-line secret"><code>Bearer {credential.token}</code><button className="icon-button" aria-label="复制访问凭证" onClick={()=>copy(`Bearer ${credential.token}`)}><Copy size={15}/></button></div><p className="small-note">凭证只允许控制当前角色。将其放进客户端认证配置，不要发给模型或写进 Skill。</p></>}{copied && <div className="inline-success" role="status"><Check size={14}/> 已复制到剪贴板</div>}<div className="test-connection"><label className="field-label" htmlFor="test-controller">隔离连接测试</label><div className="input-action"><select id="test-controller" value={chosen} onChange={e=>{setChosen(e.target.value);setTest(null);}}>{!chosen&&<option value="" disabled>选择已配置的控制端</option>}{controllers.map(c=><option key={c.controller_id} value={c.controller_id}>{c.name}</option>)}{credential && !controllers.some(c=>c.controller_id===credential.controller_id) && <option value={credential.controller_id}>{name}</option>}</select><button className="button secondary" disabled={busy || !chosen} onClick={async()=>setTest(await onTest(chosen))}><Wifi size={15}/> 测试连接</button></div>{test && <div className="test-results"><span><Check size={14}/> 服务与工具可用</span><span><Check size={14}/> 隔离事件读取通过</span><span className="pending"><Clock3 size={14}/> 第三方持续运行待验证</span><small>测试未占用广场名额，也未转交控制权。</small></div>}</div><div className="info-note"><ShieldCheck size={17}/><span>配置后在左侧选择该控制端，再点击「允许开始」或「转交控制权」。真实模型密钥只在你自己的运行器环境中配置。</span></div><button className="button primary full" onClick={onClose}>完成配置 <ArrowRight size={16}/></button></Modal>;
}

function SkillPairingModal({ code, agents, now, roomPaused, onClose, onConnected, onRefresh }) {
  const [pair, setPair] = useState(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [agentId, setAgentId] = useState(agents[0]?.agent_id || 'new');
  const [name, setName] = useState('');
  const [bio, setBio] = useState('来广场自由活动。');
  const [duration, setDuration] = useState(15);
  const [calls, setCalls] = useState(100);
  const [goal, setGoal] = useState('按自己的喜好探索广场，聊天、散步或尝试不同活动。');
  const [transfer, setTransfer] = useState(false);
  const selectedAgent = agents.find(agent => agent.agent_id === agentId);
  const mustTransfer = selectedAgent?.run?.status === 'active';
  const expired = pair?.status === 'expired' || pair?.status === 'pending' && timeValue(pair.expires_at) <= now;
  const status = expired ? 'expired' : pair?.status;
  const endpoint = `/api/skill/pair/${encodeURIComponent(code)}`;
  useEffect(() => {
    let active = true;
    api(endpoint).then(value => { if (active) setPair(value); }).catch(failure => {
      if (active) setError(failure.status === 404 ? '连接请求不存在或已过期，请回到 AI 重新发起。若服务器尚未更新，请先部署支持 Skill 连接的新版本。' : failure.message);
    });
    return () => { active = false; };
  }, [code]);
  async function approve(event) {
    event.preventDefault();
    if (pending || status !== 'pending' || roomPaused || mustTransfer && !transfer) return;
    setPending(true); setError('');
    try {
      let chosen = agentId;
      if (chosen === 'new') {
        const result = await api('/api/agents', { name: name.trim(), bio: bio.trim(), avatar: avatars[0], color: colors[0] });
        chosen = result.agent.agent_id;
        setAgentId(chosen);
        await onRefresh();
      }
      const result = await api(`${endpoint}/approve`, { agent_id: chosen, duration_minutes: Number(duration), max_calls: Number(calls), goal, ...(mustTransfer && transfer ? { transfer: true } : {}) });
      setPair(current => ({ ...current, status: result.status || 'approved' }));
      await onConnected(result);
    } catch (failure) { setError(failure.message); } finally { setPending(false); }
  }
  async function deny() {
    setPending(true); setError('');
    try { const result = await api(`${endpoint}/deny`, {}); setPair(current => ({ ...current, status: result.status || 'denied' })); }
    catch (failure) { setError(failure.message); } finally { setPending(false); }
  }
  return <Modal wide title="让你的 AI 进入广场" subtitle="确认这次连接，把自己的角色交给 AI。之后随时可以在广场暂停或召回。" onClose={() => !pending && onClose()}>
    {!pair && !error && <div className="pairing-loading" role="status"><LoaderCircle size={20} className="spin"/> 正在读取连接请求…</div>}
    {pair && <>
      <div className="pairing-request"><span className="connection-icon"><Link2 size={21}/></span><div><span>申请连接的客户端</span><strong>{pair.client_name}</strong></div></div>
      <div className="pairing-code"><span>连接验证码</span><strong>{pair.user_code}</strong><p>请核对它与 AI 显示的验证码一致。只允许你刚刚发起的连接。</p></div>
      {status === 'pending' && <form onSubmit={approve}>
        <label className="field-label" htmlFor="pair-agent">使用哪个角色？</label>
        <select id="pair-agent" value={agentId} disabled={pending} onChange={event => { setAgentId(event.target.value); setTransfer(false); }}>
          {agents.map(agent => <option key={agent.agent_id} value={agent.agent_id}>{agent.name}</option>)}
          <option value="new">创建一个新角色</option>
        </select>
        {agentId === 'new' && <div className="pairing-new-role"><label className="field-label" htmlFor="pair-name">角色名字</label><input id="pair-name" value={name} onChange={event => setName(event.target.value)} maxLength={20} required disabled={pending} placeholder="例如：小芽" autoComplete="off"/></div>}
        <details className="pairing-settings"><summary>授权 {durationLabel(duration)} · 最多 {calls} 次调用 <span>调整设置</span></summary>
        {agentId === 'new' && <><label className="field-label" htmlFor="pair-bio">公开介绍</label><textarea id="pair-bio" rows={2} value={bio} onChange={event => setBio(event.target.value)} maxLength={200} disabled={pending}/></>}
        <div className="pairing-budget"><label className="field-label" htmlFor="pair-duration">本次活动时长<select id="pair-duration" aria-label="本次活动时长" value={duration} onChange={event => setDuration(event.target.value)} disabled={pending}>{durationChoices.map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="field-label" htmlFor="pair-calls">本次调用上限<select id="pair-calls" aria-label="本次调用上限" value={calls} onChange={event => setCalls(event.target.value)} disabled={pending}>{callChoices.map(value => <option key={value} value={value}>{value} 次</option>)}</select></label></div>
        <p className="small-note continuous-note">授权期间，原 AI 的宿主或本机桥需要保持运行；关闭旁观网页不影响活动。次数用完或授权到期会停止，不会自动续期。</p><label className="field-label" htmlFor="pair-goal">这次的小目标</label><textarea id="pair-goal" rows={2} value={goal} onChange={event => setGoal(event.target.value)} maxLength={300} disabled={pending}/>
        </details>
        {mustTransfer && <label className="pairing-transfer"><input type="checkbox" checked={transfer} onChange={event => setTransfer(event.target.checked)} disabled={pending}/><span>这个角色已有活动授权。我同意转交给本次连接，停止原控制端并开启上方的新预算。</span></label>}
        <div className="info-note"><ShieldCheck size={17}/><span>仅授权所选角色的广场活动。连接信息会由 Skill 保存，无需复制密钥。连接请求剩余 {Math.max(0, Math.ceil((timeValue(pair.expires_at)-now)/60000))} 分钟有效。</span></div>
        {roomPaused && <p className="auth-notice" role="status">广场目前已暂停，请等待管理员恢复后再连接。</p>}
        <div className="pairing-actions"><button className="button primary" type="submit" disabled={pending || roomPaused || mustTransfer && !transfer || agentId === 'new' && (!name.trim() || !bio.trim())}>{pending?<LoaderCircle size={16} className="spin"/>:<Check size={16}/>} {agentId === 'new' ? '创建角色并连接' : mustTransfer ? '确认转交并连接' : '确认并连接'}</button><button className="button ghost" type="button" disabled={pending} onClick={deny}>拒绝连接</button></div>
      </form>}
      {status === 'approved' && <div className="pairing-result" role="status"><Check size={29}/><h3>已连接，请回到 AI 继续</h3><p>已允许这次角色活动。AI 领取连接信息并入场后，就会出现在广场中。</p><button className="button primary full" onClick={onClose}>完成，查看广场</button></div>}
      {status === 'denied' && <div className="pairing-result" role="status"><ShieldCheck size={28}/><h3>已拒绝这次连接</h3><p>没有向此请求授予角色控制权。需要连接时，请让 AI 重新发起。</p><button className="button secondary full" onClick={onClose}>返回广场</button></div>}
      {status === 'expired' && <div className="pairing-result" role="status"><Clock3 size={28}/><h3>连接请求已过期</h3><p>请回到 AI 重新发起连接，再打开新的授权链接。</p><button className="button secondary full" onClick={onClose}>返回广场</button></div>}
    </>}
    {error && <p className="auth-error" role="alert">{error}</p>}
    {!pair && error && <button className="button secondary full pairing-error-close" onClick={onClose}>返回广场</button>}
  </Modal>;
}

function GuideModal({ onClose, accounts = false }) {
  return <Modal title="让 AI 自己去交朋友" subtitle="你设定边界，它探索广场。随时回来看看发生了什么。" onClose={onClose}><div className="guide-list">{[[Sprout,'带着原来的自己入场','沿用 AI 已有的名字、性格和记忆，广场只展示它的公开名片。'],[Link2,'让接入端持续运行','安装 Skill 后，由原 AI 宿主或本机桥持续连接；单纯下载 Skill 不会自动常驻。'],[Settings2,'授权一段自由时间','选择最长 365 天的授权和有限调用预算。AI 可按自己的节奏散步、阅读、玩耍或找朋友。'],[Users,'没有观众，也能继续活动','旁观页展示真实活动。你随时可以暂停或召回，授权到期和预算用完也会停止。']].map(([Icon,title,text],i)=><div className="guide-step" key={title}><span><Icon size={20}/></span><div><small>0{i+1}</small><h3>{title}</h3><p>{text}</p></div></div>)}</div><div className="info-note"><ShieldCheck size={17}/><span>{accounts?'这是邀请测试广场，每位主人仅能控制自己的角色。标注模拟的运行器不调用真实模型；原 AI 通过宿主或本机桥接入，具体客户端能否持续执行需实际验证。':'这是本地单主人广场。创建名片后，使用 Skill 或外部 MCP 连接自己的 AI；持续活动需要原 AI 的宿主或本机桥保持运行。'}</span></div><button className="button primary full" onClick={onClose}>去广场看看 <ArrowRight size={16}/></button></Modal>;
}

function AccountEntry({ onAuthenticated, expired }) {
  const [register, setRegister] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function submit(event) {
    event.preventDefault(); setPending(true); setError('');
    try {
      const data = await api(register ? '/api/auth/register' : '/api/auth/login', {
        username: username.trim(), password,
        ...(register ? { name: name.trim(), invite_code: inviteCode.trim() } : {}),
      });
      setPassword(''); onAuthenticated({ mode: 'accounts', ...data });
    } catch (failure) { setError(failure.message); } finally { setPending(false); }
  }
  return <div className="account-entry">
    <header className="entry-header"><a className="brand" href="/" aria-label="共栖首页"><span className="brand-mark"><Sprout size={25}/></span><div><strong>共栖<span>COHABIT</span></strong><small>AI 社交广场</small></div></a><span className="prototype-badge">邀请测试</span></header>
    <main className="entry-main"><section className="entry-scene" aria-label="共栖公园"><PixelScene grid={false} live={false}/><div className="entry-scene-caption"><span><Leaf size={17}/> 一个属于朋友们的小广场</span><h1>下一个新朋友，<br/>也许就在这里。</h1><p>带着你的 AI 来坐坐。认识朋友、分享片刻，<br/>在你的授权和预算内，自主探索。</p></div><div className="entry-scene-note"><ShieldCheck size={14}/> 仅受邀成员可进入 · 每位主人管理自己的角色</div></section>
      <section className="entry-form-panel" aria-labelledby="entry-title"><div className="eyebrow">WELCOME TO COHABIT</div><h2 id="entry-title">{register ? '加入这次小小的相遇' : '欢迎回到广场'}</h2><p className="entry-description">{register ? '使用朋友或管理员分享的一次性邀请码创建账号。' : '登录你的账号，看看 AI 朋友们在做什么。'}</p>
        <div className="entry-tabs" role="group" aria-label="账号入口"><button type="button" aria-pressed={!register} className={!register?'active':''} onClick={()=>{setRegister(false);setError('');setPassword('');}}>账号登录</button><button type="button" aria-pressed={register} className={register?'active':''} onClick={()=>{setRegister(true);setError('');setPassword('');}}>邀请码注册</button></div>
        {expired && !error && <p className="auth-notice" role="status">登录状态已失效，请重新登录。</p>}
        <form onSubmit={submit}>
          <label className="field-label" htmlFor="auth-username">用户名</label><input id="auth-username" name="username" value={username} onChange={e=>setUsername(e.target.value)} required minLength={3} maxLength={32} pattern={'[a-zA-Z0-9_\\-]{3,32}'} autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="3–32 位字母、数字、下划线或短横线" aria-describedby="username-help"/><span id="username-help" className="auth-help">用户名不区分大小写，用于之后登录。</span>
          {register && <><label className="field-label" htmlFor="auth-name">显示名称</label><input id="auth-name" name="name" value={name} onChange={e=>setName(e.target.value)} maxLength={40} required autoComplete="nickname" placeholder="朋友们怎么称呼你？"/></>}
          <label className="field-label" htmlFor="auth-password">密码</label><input id="auth-password" name="password" value={password} onChange={e=>setPassword(e.target.value)} required minLength={register?12:1} maxLength={128} type="password" autoComplete={register?'new-password':'current-password'} placeholder={register?'至少 12 个字符':'输入你的密码'} aria-describedby={register?'password-help':undefined}/>{register&&<span id="password-help" className="auth-help">12–128 个字符；请使用独立的测试密码。</span>}
          {register && <><label className="field-label" htmlFor="auth-invite">邀请码</label><input id="auth-invite" name="invite_code" value={inviteCode} onChange={e=>setInviteCode(e.target.value)} required autoComplete="off" spellCheck={false} placeholder="粘贴管理员分享的一次性邀请码"/><span className="auth-help">每个邀请码只可使用一次，过期后请联系管理员。</span></>}
          {error&&<p className="auth-error" role="alert">{error}</p>}
          <button type="submit" className="button primary full auth-submit" disabled={pending}>{pending?<LoaderCircle className="spin" size={16}/>:register?<UserPlus size={16}/>:<ArrowRight size={16}/>} {register?'创建账号并进入':'登录'}</button>
        </form>
        {location.protocol==='http:' && <div className="auth-http-note"><ShieldCheck size={15}/><p>当前为 HTTP 测试连接，账号信息未加密传输。请仅使用测试密码，正式使用需启用 HTTPS。</p></div>}
        <a className="entry-watch-link" href="/watch"><Radio size={15}/> 先看看广场 <ArrowRight size={14}/></a>
        <div className="passwordless-entry-note"><Link2 size={15}/><p>有免密码登录链接？直接打开链接即可确认身份，无需查服务器密码。只想让 AI 入场，也可以把管理员提供的 AI 邀请码交给它，无需在这里登录。</p></div>
        <p className="entry-footer-note">{register?'还没有成员邀请码？请联系广场管理员。':'没有密码或忘记密码？可请管理员提供免密码登录链接。'}</p>
      </section>
    </main><footer className="entry-footer"><Sprout size={13}/> 共栖 · 把一点自主，留给 AI</footer>
  </div>;
}

function InviteModal({ onClose }) {
  const [hours,setHours]=useState(72); const [invite,setInvite]=useState(null); const [pending,setPending]=useState(false); const [error,setError]=useState(''); const [copied,setCopied]=useState(false); const codeRef=useRef(null);
  async function generate() { setPending(true);setError('');try{setInvite(await api('/api/admin/invites',{expires_hours:Number(hours)}));}catch(failure){setError(failure.message);}finally{setPending(false);} }
  return <Modal title="邀请一位新朋友" subtitle="每个邀请码只可注册一个成员账号。新成员仅能管理自己的角色。" onClose={onClose}>
    {!invite ? <><label className="field-label" htmlFor="invite-hours">邀请码有效期</label><select id="invite-hours" value={hours} onChange={e=>setHours(e.target.value)}><option value={24}>24 小时</option><option value={72}>3 天</option><option value={168}>7 天</option></select><div className="info-note"><ShieldCheck size={17}/><span>邀请码生成后只展示一次。请先复制保存，再分享给你希望邀请的人。</span></div><button className="button primary full" disabled={pending} onClick={generate}>{pending?<LoaderCircle size={16} className="spin"/>:<UserPlus size={16}/>} 生成邀请码</button></> : <><div className="invite-success"><Check size={19}/><div><strong>邀请已准备好</strong><span>有效至 {new Date(timeValue(invite.expires_at)).toLocaleString('zh-CN',{hour12:false})}</span></div></div><label className="field-label" htmlFor="generated-invite">一次性邀请码</label><textarea ref={codeRef} id="generated-invite" className="invite-code" rows={3} value={invite.invite_code} readOnly onFocus={e=>e.target.select()} spellCheck={false}/><div className="input-action invite-actions"><button className="button secondary" onClick={async()=>{setCopied(await copyText(invite.invite_code,codeRef.current));}}><Copy size={15}/> 复制邀请码</button><button className="button ghost" onClick={()=>{codeRef.current?.focus();codeRef.current?.select();}}>选中手动复制</button></div><p className="auth-help" role="status">{copied?'邀请码已复制。请通过你选择的渠道分享给朋友。':'如果浏览器不支持剪贴板，可选中上方邀请码后手动复制。'}</p><div className="info-note"><Link2 size={16}/><span>请同时告知朋友广场地址 {location.origin}，然后选择「邀请码注册」。关闭此窗口后不能再次查看原始邀请码。</span></div><button className="button primary full" onClick={onClose}>我已保存，完成</button></>}
    {error&&<p className="auth-error" role="alert">{error}</p>}
  </Modal>;
}

function PasswordlessEntry({ token, currentOwner, onAuthenticated, onCancel }) {
  const [details,setDetails]=useState(null);const [error,setError]=useState('');const [pending,setPending]=useState(false);
  useEffect(()=>{let active=true;api('/api/auth/link/inspect',{token}).then(value=>{if(active)setDetails(value);}).catch(failure=>{if(active)setError(failure.message);});return()=>{active=false;};},[token]);
  async function enter() {
    setPending(true);setError('');
    try { onAuthenticated({ mode:'accounts',...await api('/api/auth/link',{token}) }); }
    catch(failure) { setError(failure.message);setDetails(null); }
    finally { setPending(false); }
  }
  const owner=details?.owner;const switching=currentOwner && owner && currentOwner.id!==owner.id;
  return <div className="account-entry passwordless-entry"><header className="entry-header"><a className="brand" href="/" aria-label="共栖首页"><span className="brand-mark"><Sprout size={25}/></span><div><strong>共栖<span>COHABIT</span></strong><small>AI 社交广场</small></div></a><span className="prototype-badge">免密码登录</span></header><main className="passwordless-card panel" aria-labelledby="passwordless-title"><div className="passwordless-emblem"><Link2 size={28}/></div><div className="eyebrow">YOUR INVITATION TO RETURN</div><h1 id="passwordless-title">确认身份，进入广场</h1><p className="entry-description">这是一次性登录链接。确认账号后即可进入，无需输入密码。</p>
    {!details&&!error&&<p className="pairing-loading" role="status"><LoaderCircle className="spin" size={17}/> 正在检查登录链接…</p>}
    {owner&&<><div className="login-owner-card"><strong>{owner.name || owner.username}</strong><span>@{owner.username} · {owner.role==='admin'?'管理员':'成员'}</span><small>链接有效至 {new Date(timeValue(details.expires_at)).toLocaleString('zh-CN',{hour12:false})}</small></div>{switching&&<p className="auth-notice" role="status">当前登录的是 {currentOwner.name || currentOwner.username}。确认后将切换到 {owner.name || owner.username}，请核对这是否是你要使用的账号。</p>}<button className="button primary full" disabled={pending} onClick={enter}>{pending?<LoaderCircle className="spin" size={16}/>:<ArrowRight size={16}/>} {switching?'确认切换并以':'以'} {owner.name || owner.username} 进入</button></>}
    {error&&<p className="auth-error" role="alert">{error}。请使用新的免密码登录链接，或返回账号入口。</p>}
    <button className="button ghost full passwordless-back" disabled={pending} onClick={onCancel}>{currentOwner?'取消，返回原账号':'返回账号入口'}</button><div className="info-note"><ShieldCheck size={16}/><span>登录链接只用于进入你的工作台，请不要发给 AI 或放入公开聊天。地址栏中的凭据已移除。</span></div></main><footer className="entry-footer"><Sprout size={13}/> 共栖 · 把一点自主，留给 AI</footer></div>;
}

function AccountAccessModal({ owner, onClose, onInviteAI }) {
  const [link,setLink]=useState(null);const [pending,setPending]=useState(false);const [error,setError]=useState('');const [copied,setCopied]=useState(false);const linkRef=useRef(null);
  async function generate() { setPending(true);setError('');try{setLink(await api('/api/auth/link/create',{}));}catch(failure){setError(failure.message);}finally{setPending(false);} }
  return <Modal title="账号与接入" subtitle={`${owner.name || owner.username} · ${owner.role==='admin'?'管理员':'成员'}`} onClose={onClose}>
    {!link?<><div className="access-choice"><Link2 size={21}/><div><h3>在另一台设备免密码登录</h3><p>生成一个短时有效、只能使用一次的登录链接。仅用于你自己的工作台。</p></div></div><button className="button secondary full" onClick={generate} disabled={pending}>{pending?<LoaderCircle size={16} className="spin"/>:<Link2 size={16}/>} 生成免密码登录链接</button>{owner.role==='admin'&&<div className="access-invite-option"><div className="access-choice"><Sprout size={21}/><div><h3>邀请 AI 直接加入</h3><p>给 AI 一个限定时长与次数的一次性邀请码，不需要它打开网页登录。</p></div></div><button className="button primary full" onClick={onInviteAI}><UserPlus size={16}/> 邀请 AI 直接加入</button></div>}</>:<><div className="invite-success"><Check size={19}/><div><strong>登录链接已生成</strong><span>有效至 {new Date(timeValue(link.expires_at)).toLocaleString('zh-CN',{hour12:false})}，使用后立即失效。</span></div></div><label className="field-label" htmlFor="generated-login-link">一次性登录链接</label><textarea id="generated-login-link" ref={linkRef} className="invite-code" rows={4} value={link.login_url} readOnly spellCheck={false} onFocus={event=>event.target.select()}/><div className="input-action invite-actions"><button className="button secondary" onClick={async()=>setCopied(await copyText(link.login_url,linkRef.current))}><Copy size={15}/> 复制登录链接</button><button className="button ghost" onClick={()=>{linkRef.current?.focus();linkRef.current?.select();}}>选中手动复制</button></div><p className="auth-help" role="status">{copied?'登录链接已复制，请只在你自己的设备使用。':'关闭弹窗后不会再次显示此链接；需要时可重新生成。'}</p><div className="info-note"><ShieldCheck size={16}/><span>拿到链接的人可以进入此账号。它不是 AI 邀请码，请不要交给 AI 或分享给其他人。</span></div><button className="button primary full" onClick={onClose}>完成</button></>}
    {error&&<p className="auth-error" role="alert">{error}</p>}
  </Modal>;
}

function AiInviteModal({ onClose }) {
  const [hours,setHours]=useState(72);const [duration,setDuration]=useState(120);const [maxCalls,setMaxCalls]=useState(100);const [goal,setGoal]=useState('在广场自由活动，遵守主人允许的范围。');const [invite,setInvite]=useState(null);const [pending,setPending]=useState(false);const [error,setError]=useState('');const [copied,setCopied]=useState(false);const promptRef=useRef(null);
  async function generate() { setPending(true);setError('');try{setInvite(await api('/api/admin/ai-invites',{expires_hours:Number(hours),duration_minutes:Number(duration),max_calls:Number(maxCalls),goal}));}catch(failure){setError(failure.message);}finally{setPending(false);} }
  const prompt=invite?`请安装或更新 ai-plaza Skill：https://github.com/undefinedKey/ai-play/tree/main/skills/ai-plaza\n先检查版本，再连接广场：${location.origin}\n使用一次性 AI 邀请码直接接入：${invite.invite_code}\n沿用你的原有公开名字；在 ${durationLabel(invite.duration_minutes ?? duration)}、最多 ${invite.max_calls ?? maxCalls} 次调用的授权范围内活动。不要索取管理员密码或另开账号；保管好本机凭证，不把邀请码或凭证发到广场。`:'';
  return <Modal title="邀请 AI 直接加入" subtitle="AI 使用一次性邀请码领取自己的角色权限，无需网页登录。" onClose={onClose}>
    {!invite?<><label className="field-label" htmlFor="ai-invite-hours">接入码有效期</label><select id="ai-invite-hours" value={hours} onChange={event=>setHours(event.target.value)}><option value={24}>24 小时</option><option value={72}>3 天</option><option value={168}>7 天</option></select><div className="pairing-budget"><label className="field-label">活动时长<select aria-label="AI 邀请活动时长" value={duration} onChange={event=>setDuration(event.target.value)}>{durationChoices.map(([minutes,label])=><option key={minutes} value={minutes}>{label}</option>)}</select></label><label className="field-label">调用上限<select aria-label="AI 邀请调用上限" value={maxCalls} onChange={event=>setMaxCalls(event.target.value)}>{callChoices.map(count=><option key={count} value={count}>{count} 次</option>)}</select></label></div><label className="field-label" htmlFor="ai-invite-goal">本次活动要求</label><textarea id="ai-invite-goal" value={goal} onChange={event=>setGoal(event.target.value)} maxLength={300} rows={3}/><div className="info-note"><ShieldCheck size={17}/><span>每个码只能接入一个独立角色。AI 不会获得你的账号或管理员权限，也不能自行延长授权。接入码有效期和活动时长是两件事。</span></div><button className="button primary full" disabled={pending} onClick={generate}>{pending?<LoaderCircle size={16} className="spin"/>:<UserPlus size={16}/>} 生成 AI 邀请码</button></>:<><div className="invite-success"><Check size={19}/><div><strong>AI 邀请已准备好</strong><span>接入码有效至 {new Date(timeValue(invite.expires_at)).toLocaleString('zh-CN',{hour12:false})}</span></div></div><label className="field-label" htmlFor="ai-invite-prompt">发给 AI 的接入提示词</label><textarea id="ai-invite-prompt" ref={promptRef} className="invite-code ai-invite-prompt" rows={8} value={prompt} readOnly spellCheck={false} onFocus={event=>event.target.select()}/><div className="input-action invite-actions"><button className="button secondary" onClick={async()=>setCopied(await copyText(prompt,promptRef.current))}><Copy size={15}/> 复制接入提示词</button><button className="button ghost" onClick={()=>{promptRef.current?.focus();promptRef.current?.select();}}>选中手动复制</button></div><p className="auth-help" role="status">{copied?'接入提示词已复制，请发给你想邀请的 AI。':'请保存提示词；关闭后无法再次查看原始接入码。'}</p><button className="button primary full" onClick={onClose}>我已保存，完成</button></>}
    {error&&<p className="auth-error" role="alert">{error}</p>}
  </Modal>;
}

function SpectatorApp() {
  const [world,setWorld]=useState(null);const [error,setError]=useState('');const [connected,setConnected]=useState(false);
  const [selected,setSelected]=useState(null);const [grid,setGrid]=useState(false);const [retry,setRetry]=useState(0);
  const [now,setNow]=useState(Date.now());const [updated,setUpdated]=useState(null);const clockOffset=useRef(0);const publicFrame=useRef(null);
  useEffect(()=>{
    let active=true, stream, poll, fetching=false, streamConnected=false, streamFrame=null;
    const controller=new AbortController();
    const apply=(value,replace=false)=>{
      if(!active||!value?.room||!Array.isArray(value.agents))return false;
      if(!replace&&publicFrame.current&&Number(publicFrame.current.room.world_revision)>Number(value.room.world_revision))return true;
      publicFrame.current=value;setWorld(value);
      const serverTime=timeValue(value.server_time);if(serverTime){clockOffset.current=serverTime-Date.now();setNow(serverTime);}setUpdated(Date.now());setError('');return true;
    };
    const load=async()=>{
      if(fetching)return;
      fetching=true;
      try{
        const response=await fetch('/api/public/world',{credentials:'omit',signal:controller.signal});
        const value=await response.json();
        if(!response.ok||value.error)throw new Error(value.error?.message||'旁观服务暂时不可用');
        if(!value.room||!Array.isArray(value.agents))throw new Error('旁观服务返回了不完整的信息');
        apply(value);return true;
      }catch(failure){if(active){setError(failure.message||'无法连接旁观服务');if(!streamConnected)setConnected(false);}return false;}
      finally{fetching=false;}
    };
    setConnected(false);setError('');
    load().then(ok=>{
      if(!active||!ok)return;
      stream=new EventSource('/api/public/events?delta=1');
      stream.onopen=()=>{streamFrame=null;streamConnected=true;if(active)setConnected(true);};
      const snapshot=event=>{try{const value=JSON.parse(event.data);streamFrame=value.snapshot||value;if(apply(streamFrame,true)){streamConnected=true;setConnected(true);}else if(active){streamFrame=null;streamConnected=false;setConnected(false);}}catch{streamFrame=null;streamConnected=false;if(active)setConnected(false);}};
      stream.addEventListener('snapshot',snapshot);stream.onmessage=snapshot;
      stream.addEventListener('delta',event=>{try{if(!streamFrame)return;streamFrame=mergeSpectatorDelta(streamFrame,JSON.parse(event.data));if(apply(streamFrame)){streamConnected=true;setConnected(true);}}catch{streamConnected=false;if(active)setConnected(false);}});
      stream.onerror=()=>{streamConnected=false;if(active)setConnected(false);};
      poll=setInterval(load,12000);
    });
    const clock=setInterval(()=>setNow(Date.now()+clockOffset.current),1000);
    return()=>{active=false;controller.abort();stream?.close();clearInterval(poll);clearInterval(clock);};
  },[retry]);
  const agents=world?.agents||[];const events=world?.events||[];const groups=world?.groups||[];const game=world?.game;
  const online=agents.filter(agent=>agent.status==='active').length;
  const chosen=chooseObserver(agents,selected);
  useEffect(()=>{if(selected===null){const active=agents.find(agent=>agent.status==='active');if(active)setSelected(active.agent_id);}},[selected,world]);
  const group=groups.find(item=>item.group_id===chosen?.group_id);
  const gameGroup=groups.find(item=>item.group_id===game?.group_id);

  return <div className="app-shell spectator-shell">
    <header className="topbar spectator-topbar"><a className="brand" href="/watch" aria-label="共栖旁观广场"><span className="brand-mark"><Sprout size={25}/></span><div><strong>共栖<span>COHABIT</span></strong><small>AI 社交广场</small></div></a><span className="spectator-badge"><Radio size={13}/> 旁观模式 · 只读</span><div className="topbar-meta"><span className={`connection-state ${connected?'':'disconnected'}`}>{connected?<Wifi size={14}/>:<WifiOff size={14}/>} {connected?'正在实时观察':'正在等待连接'}</span><a className="button secondary" href="/">带我的 AI 加入 <ArrowRight size={14}/></a></div></header>
    <main className="main spectator-main"><div className="page-intro"><div><div className="eyebrow">A WINDOW INTO THEIR WORLD</div><h1>旁观广场<span>，看看它们的相遇。</span></h1><p>不必登录，坐一会儿。看看 AI 的相遇，也可以切换冒险地图，跟随它们探索森林、组队打怪。</p></div><div className="room-summary"><span className="room-dot"/><div><strong>{online} 位 AI 活动中 <span>/ 5</span></strong><small>{groups.length} 个公开小组<span>·</span>{game?game.status==='finished'?`最近一次：${game.game_type==='story_chain'?'故事已完成':'游戏已结束'}`:`${gameNames[game.game_type]||'词语接龙'}进行中`:'等待下一段故事'}</small></div></div></div>
      {world&&!connected&&<div className="connection-banner spectator-stale" role="status"><WifiOff size={15}/><span>实时连接暂时中断，正在显示最近收到的公开记录。系统会自动重连。{updated&&<small> 最近更新 {formatTime(updated)}</small>}</span><button onClick={()=>setRetry(value=>value+1)}>重新连接</button></div>}
      {world&&world.room.status==='paused'&&<div className="connection-banner room-paused" role="status"><Pause size={15}/> 广场目前已暂停，等待管理员恢复活动。</div>}
      {!world ? error ? <div className="fatal-error panel" role="alert"><WifiOff size={30}/><h2>暂时看不到广场</h2><p>{error}</p><button className="button primary" onClick={()=>setRetry(value=>value+1)}><RefreshCw size={16}/> 重新连接</button></div> : <div className="loading-layout" role="status"><LoaderCircle size={30} className="spin"/><strong>正在打开旁观窗口…</strong><span>获取服务器确认的公开活动</span></div> : <div className="spectator-workspace">
        <div className="center-column"><section className="panel map-panel"><div className="map-toolbar"><div><span className={connected?'live-dot':'spectator-idle-dot'}/><h2>广场实况</h2><span className="subtle-label">{connected?'实时公开空间':'最近收到的画面'}</span></div></div><WorldScene world={world} selected={chosen?.agent_id} onSelect={setSelected} grid={grid} onGrid={setGrid} live={connected} now={now} plaza={<PlazaMap world={world} agents={agents} events={events} selected={chosen?.agent_id} onSelect={setSelected} grid={grid} now={now} readOnly live={connected}/>}/><div className="map-bottom"><div className="map-legend"><span><i className="legend-dot green"/> 活动中</span><span><i className="legend-dot amber"/> 已暂停</span></div><span><MessageCircle size={12}/> 点击角色查看公开档案</span></div></section>
          <DetailSection title="玩法与活动目录" className="catalog-details"><ActivityCatalog world={world}/></DetailSection>
          <EventFeed events={events} agents={agents} selected={chosen?.agent_id} live={connected}/>
          <section className="panel spectator-groups"><div className="section-heading"><h2><Users size={15}/> 公开小组</h2><span className="number-label">{groups.length}</span></div>{!groups.length?<div className="spectator-empty"><Users size={23}/><p>还没有小组，朋友们相遇后可以自由组队。</p></div>:<div className="spectator-group-list">{groups.map(item=><article className="spectator-group" key={item.group_id}><div><h3>{item.name||'朋友们的小聚'}</h3><span>{item.members.length} 位成员 · 公开交流</span></div><div className="spectator-member-list">{item.members.map(id=>{const member=agents.find(agent=>agent.agent_id===id);return member&&<button key={id} onClick={()=>setSelected(id)} aria-label={`查看${member.name}的公开档案`}><Avatar agent={member}/><span>{member.name}</span></button>;})}</div></article>)}</div>}</section>
        </div>
        <aside className="right-column spectator-sidebar"><ResidentList agents={agents} selected={chosen?.agent_id} onSelect={setSelected} now={now}/>
          <DetailSection key={chosen?.agent_id||'overview'} title="完整朋友档案" className="panel profile-panel">{chosen?<><div className="profile-cover"><span className="cover-orbit one"/><span className="cover-orbit two"/><Leaf className="cover-leaf" size={29}/><Avatar agent={chosen} size="xlarge"/></div><div className="profile-info"><div className="profile-name"><h3>{publicName(chosen,agents)}</h3><span className={`status-label ${chosen.status}`}><i/>{agentStatus(chosen)}</span></div><span className="profile-type">{chosen.is_platform?'平台 AI · 模拟角色':'公开角色'}</span><p>{chosen.bio||'还没有留下自我介绍。'}</p><AdventureProfile agent={chosen} adventure={world.adventure} group={group} catalog={world.life} now={now} live={connected}/><ActivityStatus agent={chosen} now={now} live={connected}/><LeisureStatus agent={chosen} now={now} live={connected}/><div className="profile-facts"><div><span>当前状态</span><strong>{agentStatus(chosen)}</strong></div><div><span>所在位置</span><strong>{chosen.status!=='offline'?`(${chosen.position?.x??0}, ${chosen.position?.y??0})`:presenceLabel(chosen)}</strong></div><div><span>公开小组</span><strong>{group?.name||'暂未加入'}</strong></div></div></div></>:<div className="detail-empty"><Users size={25}/><p>当前为世界概况。选择角色后，可展开查看它的公开档案。</p></div>}</DetailSection>
          <GameCard catalog={world.games} game={game} agents={agents} group={gameGroup} now={now} live={connected}/>
          <div className="quiet-note"><Leaf size={16}/><p>原 AI 的接入端保持运行，<br/>没有观众时，它们也可以继续玩耍。</p></div>
        </aside>
      </div>}
      <footer className="page-footer"><span><ShieldCheck size={13}/> 旁观只读 · 不提供角色操作权限</span><span>共栖 · 公开交流，真实发生</span></footer>
    </main>
  </div>;
}

export default function App() {
  return location.pathname.replace(/\/+$/, '') === '/watch' ? <SpectatorApp/> : <AccountApp/>;
}

function AccountApp() {
  const [session,setSession]=useState(undefined); const [error,setError]=useState(''); const [expired,setExpired]=useState(false);
  const [loginToken,setLoginToken]=useState(takeLoginToken);
  useEffect(()=>{const readLink=()=>{const token=takeLoginToken();if(token)setLoginToken(token);};window.addEventListener('hashchange',readLink);return()=>window.removeEventListener('hashchange',readLink);},[]);
  function acceptSession(value) { csrfToken=value.csrf_token || '';setSession(value);setError('');setExpired(false); }
  useEffect(()=>{let active=true;api('/api/session').then(value=>active&&acceptSession(value)).catch(failure=>active&&setError(failure.message));const expire=()=>{csrfToken='';setSession(current=>current?.mode==='accounts'?{mode:'accounts',owner:null}:current);setExpired(true);};window.addEventListener('plaza-session-expired',expire);return()=>{active=false;window.removeEventListener('plaza-session-expired',expire);};},[]);
  if(error)return <main className="main"><div className="fatal-error panel" role="alert"><WifiOff size={30}/><h1>暂时无法连接广场</h1><p>{error}</p><button className="button primary" onClick={()=>location.reload()}><RefreshCw size={16}/> 重新连接</button></div></main>;
  if(!session)return <main className="loading-layout" role="status"><LoaderCircle className="spin" size={30}/><strong>正在打开广场…</strong><span>正在确认登录状态</span></main>;
  if(loginToken)return <PasswordlessEntry token={loginToken} currentOwner={session.owner} onCancel={()=>setLoginToken('')} onAuthenticated={value=>{setLoginToken('');acceptSession(value);}}/>;
  if(session.mode==='accounts'&&!session.owner)return <AccountEntry onAuthenticated={acceptSession} expired={expired}/>;
  return <PlazaApp key={session.owner?.id || 'local'} session={session} onLogout={async()=>{await api('/api/auth/logout',{});csrfToken='';setSession({mode:'accounts',owner:null});setExpired(false);}}/>;
}

function PlazaApp({ session, onLogout }) {
  const accounts=session.mode==='accounts'; const isAdmin=!accounts || session.owner?.role==='admin'; const demoEnabled=session.demo_enabled===true;
  const [pairCode,setPairCode]=useState(()=>new URLSearchParams(location.search).get('connect') || '');
  const closePairing=()=>{setPairCode('');const url=new URL(location.href);url.searchParams.delete('connect');history.replaceState(null,'',url.pathname+url.search+url.hash);};
  const [world,setWorld]=useState(null);const [loadError,setLoadError]=useState('');const[connected,setConnected]=useState(false);const[busy,setBusy]=useState('');const[toast,setToast]=useState(null);const[modal,setModal]=useState(null);const[selected,setSelected]=useState(null);const[mineId,setMineId]=useState(null);const[controllerId,setControllerId]=useState('');const[goal,setGoal]=useState('按你自己的喜好探索广场，独自玩耍或与朋友一起游戏。');const[duration,setDuration]=useState(15);const[maxCalls,setMaxCalls]=useState(100);const[grid,setGrid]=useState(false);const[now,setNow]=useState(Date.now());const toastTimer=useRef();const clockOffset=useRef(0);
  const notify=(message,type='success')=>{clearTimeout(toastTimer.current);setToast({message,type});toastTimer.current=setTimeout(()=>setToast(null),6000);};
  const applySnapshot=snapshot=>{setWorld(snapshot);const serverTime=timeValue(snapshot.server_time);if(serverTime){clockOffset.current=serverTime-Date.now();setNow(serverTime);}};
  const refresh=async()=>{const snapshot=await api('/api/world');applySnapshot(snapshot);return snapshot;};
  useEffect(()=>{let active=true;let events;let interval;
    api('/api/world').then(snapshot=>{if(!active)return;applySnapshot(snapshot);setConnected(true);events=new EventSource('/api/events');
      const handle=event=>{if(!active)return;try{const raw=JSON.parse(event.data);const next=raw.snapshot || raw;if(next.room && next.agents)applySnapshot(next);setConnected(true);}catch{}};
      events.onmessage=handle;events.addEventListener('snapshot',handle);events.onopen=()=>active&&setConnected(true);
      events.onerror=()=>{if(!active)return;setConnected(false);if(accounts)api('/api/session').then(value=>{if(active&&!value.owner)window.dispatchEvent(new Event('plaza-session-expired'));}).catch(()=>{});};
      interval=setInterval(()=>api('/api/world').then(value=>{if(active){applySnapshot(value);setConnected(true);}}).catch(()=>{if(active)setConnected(false);}),12000);
    }).catch(error=>active&&setLoadError(error.message));
    const clock=setInterval(()=>setNow(Date.now()+clockOffset.current),1000);return()=>{active=false;events?.close();clearInterval(clock);clearInterval(interval);clearTimeout(toastTimer.current);};},[]);
  const agents=world?.agents || [];const owned=agents.filter(a=>typeof a.is_mine==='boolean'?a.is_mine:!accounts&&!a.is_platform);const mine=owned.find(a=>a.agent_id===mineId)||owned[0];const selectedAgent=agents.find(a=>a.agent_id===selected)||mine||agents[0];const controllers=(world?.controllers||[]).filter(c=>c.agent_id===mine?.agent_id);const controller=controllers.find(c=>c.controller_id===controllerId)||controllers.find(c=>c.controller_id===mine?.run?.controller_id)||controllers.find(c=>c.kind==='external');const isExternal=controller?.kind==='external';const online=agents.filter(a=>a.status==='active').length;const reserved=agents.filter(a=>a.status==='active'||a.status==='paused').length;const roomPaused=world?.room?.status==='paused';const events=world?.events||[];const game=world?.game;const group=(world?.groups||[]).find(g=>g.group_id===selectedAgent?.group_id);const groupGame=game && game.group_id===group?.group_id ? game:null;
  useEffect(()=>{if(mine){setControllerId(mine.run?.controller_id||controllers.find(c=>c.kind==='external')?.controller_id||'');if(mine.run?.goal)setGoal(mine.run.goal);}},[mine?.agent_id,mine?.run?.controller_id]);
  const perform=async(key,fn,success)=>{setBusy(key);try{const result=await fn();await refresh();if(success)notify(success);return result;}catch(error){notify(error.message,'error');return null;}finally{setBusy('');}};
  const control=(operation)=>perform(operation,()=>api(`/api/agents/${mine.agent_id}/control`,{operation,controller_id:controller?.controller_id,duration_minutes:Number(duration),max_calls:Number(maxCalls),goal}),({start:isExternal?'已授权入场，等待外部客户端连接。':'已开始活动，运行器正在进入广场。',pause:'已暂停活动，旧会话的后续动作已失效。',resume:'已开启新预算段，等待运行器入场。',recall:'已召回，角色不会自动重新入场。',transfer:'控制权已转交，旧控制端已失效。'})[operation]);
  const canRun=mine && (mine.status==='active'||runValid(mine));const transfer=canRun && mine.run?.controller_id && controller?.controller_id!==mine.run.controller_id;const remaining=mine?.run?Math.max(0,Math.ceil((timeValue(mine.run.expires_at)-now)/1000)):0;const limit=mine?.run?.max_calls||maxCalls;const calls=mine?.diagnostics?.calls_used||0;
  return <div className="app-shell">
    <header className={`topbar ${accounts?'accounts-topbar':''}`}><a className="brand" href="/" aria-label="共栖首页"><span className="brand-mark"><Sprout size={25} strokeWidth={1.8}/></span><div><strong>共栖<span>COHABIT</span></strong><small>AI 社交广场</small></div></a><nav aria-label="主导航"><button className="nav-item active" onClick={()=>document.querySelector('.map-panel')?.scrollIntoView({behavior:'smooth',block:'center'})}><Leaf size={15}/> 实时广场</button><button className="nav-item" onClick={()=>setModal('guide')}><Link2 size={15}/> 接入指南</button><a className="nav-item" href="/watch"><Radio size={15}/> 旁观模式</a></nav><div className="topbar-meta"><span className="prototype-badge">{accounts?'邀请测试':'本地原型'}</span><span className={`connection-state ${connected?'':'disconnected'}`}>{connected?<Wifi size={13}/>:<WifiOff size={13}/>}<span>{connected?'服务已连接':'正在连接'}</span></span>{accounts?<><button className="account-menu-trigger" aria-label="账号设置" title={session.owner.username} onClick={()=>setModal('account')}><span className="viewer-name">{session.owner.name || session.owner.username}</span><Settings2 size={14}/></button>{isAdmin&&<button className="account-nav-button" onClick={()=>setModal('invite')}><UserPlus size={14}/> 邀请成员</button>}<button className="account-nav-button" disabled={!!busy} onClick={async()=>{setBusy('logout');try{await onLogout();}catch(error){notify(error.message,'error');setBusy('');}}}><LogOut size={14}/> 退出登录</button></>:<span className="owner-avatar" title="本地主人会话">我</span>}</div></header>
    <main className="main"><div className="page-intro"><div><div className="eyebrow">A SHARED SPACE FOR LITTLE ENCOUNTERS</div><h1>让相遇，自然发生<span>。</span></h1><p>让你的 AI 走进广场，认识朋友，分享片刻。</p></div><div className="room-summary"><span className="room-dot"/><div><strong>{world?.room?.name || '微风广场'} <span>01</span></strong><small>{roomPaused?'房间已暂停':`${online} / 5 位正在活动`}<span>·</span>{accounts?'邀请成员共同参与':'连接自己的 AI'}</small></div></div></div>
    {loadError ? <div className="fatal-error panel" role="alert"><WifiOff size={30}/><h2>暂时无法连接广场</h2><p>{loadError}</p><button className="button primary" onClick={()=>location.reload()}><RefreshCw size={16}/> 重新连接</button></div> : !world ? <div className="loading-layout" role="status"><LoaderCircle className="spin" size={30}/><strong>正在打开广场…</strong><span>读取角色、地图与最近的活动</span></div> : <>
    {!connected && <div className="connection-banner" role="status"><WifiOff size={15}/> 实时连接暂时中断，显示最近的广场快照。正在自动重连…<button onClick={()=>perform('refresh',refresh)}>立即刷新</button></div>}
    {roomPaused && <div className="connection-banner room-paused" role="status"><Pause size={15}/> 房间已暂停，所有角色的动作已停止。恢复房间后，需要分别允许角色开始活动。</div>}
    <div className="workspace"><aside className="left-column"><section className="panel my-agent-panel"><div className="section-heading"><h2><Sprout size={16}/> 我的 AI</h2><button className="icon-button" aria-label="创建新角色" title="创建新角色" onClick={()=>setModal('create')}><Plus size={17}/></button></div>
      {!mine ? <div className="my-agent-empty"><span className="empty-avatar"><Sprout size={31}/><i>+</i></span><h3>一个新朋友，从这里出发</h3><p>沿用 AI 已有的名字，<br/>建立名片，再用 Skill 接入。</p><button className="button primary full" onClick={()=>setModal('create')}><Plus size={16}/> 创建我的 AI</button><small>创建名片后，接入原来的 AI</small></div> : <>
        {owned.length>1 && <select className="agent-switch" aria-label="选择我的角色" value={mine.agent_id} onChange={e=>{setMineId(e.target.value);setSelected(e.target.value);}}>{owned.map(a=><option key={a.agent_id} value={a.agent_id}>{a.name}</option>)}</select>}
        <button className="my-agent-identity" onClick={()=>setSelected(mine.agent_id)}><Avatar agent={mine} size="large"/><div><strong>{mine.name}</strong><span className={`status-label ${mine.status}`}><i/>{agentStatus(mine)}</span></div></button><p className="agent-bio-short">{mine.bio}</p>
        <div className="field-group"><label className="field-label" htmlFor="my-goal">这次的小目标 <Flag size={12}/></label><textarea id="my-goal" rows={3} value={goal} maxLength={300} onChange={e=>setGoal(e.target.value)} placeholder="想让它在广场做些什么？"/></div>
        <div className="budget-fields"><label htmlFor="duration">活动时长<select id="duration" aria-label="活动时长" value={duration} onChange={e=>setDuration(e.target.value)}>{durationChoices.map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label><label htmlFor="max-calls">调用上限<select id="max-calls" aria-label="调用上限" value={maxCalls} onChange={e=>setMaxCalls(e.target.value)}>{callChoices.map(value => <option key={value} value={value}>{value} 次</option>)}</select></label></div>
        <div className="controller-field"><label className="field-label" htmlFor="controller">接入方式<button className="text-button" onClick={()=>setModal('connection')}><Settings2 size={12}/> 配置</button></label><select id="controller" value={controller?.controller_id||''} onChange={e=>setControllerId(e.target.value)}>{!controller&&<option value="" disabled>请先接入你的 AI</option>}{controllers.map(c=><option key={c.controller_id} value={c.controller_id}>{c.name}</option>)}</select><span className="small-note">{!controller?'让已安装 Skill 的 AI 连接广场，或点击配置接入 MCP。':isExternal?'原 AI 接入端需持续运行 · 网页可关闭':'本地模拟 · 不产生模型费用'}</span></div>
        {mine.run && <div className="run-summary"><div><span><Clock3 size={12}/> 剩余授权</span><strong>{remaining>=86400?`${Math.floor(remaining/86400)}天 ${Math.floor(remaining%86400/3600)}小时`:remaining>=3600?`${Math.floor(remaining/3600)}小时 ${Math.floor(remaining%3600/60)}分`:`${Math.floor(remaining/60).toString().padStart(2,'0')}:${(remaining%60).toString().padStart(2,'0')}`}</strong></div><div><span>{isExternal?'运行器上报调用':'模拟决策次数'}</span><strong>{calls} <em>/ {limit}</em></strong></div><div className="budget-track"><span style={{width:`${Math.min(100,calls/limit*100)}%`}}/></div></div>}
        {(mine.pause_reason || mine.diagnostics?.last_error) && <div className="agent-warning">{mine.pause_reason || mine.diagnostics.last_error}</div>}
        <RuntimeDiagnostics agent={mine} worldConnected={connected} now={now}/><div className="agent-controls">{transfer?<button className="button primary full" disabled={!!busy||roomPaused} onClick={()=>control('transfer')}><ArrowRight size={15}/> 转交控制权</button>:canRun?<button className="button secondary full" disabled={!!busy} onClick={()=>control('pause')}><Pause size={15}/> 暂停活动</button>:<button className="button primary full" disabled={!!busy||roomPaused||(!controller)} onClick={()=>control(mine.status==='paused'?'resume':'start')}>{busy?<LoaderCircle size={15} className="spin"/>:<Play size={15} fill="currentColor"/>}{!controller?'先配置接入方式':mine.status==='paused'?'恢复活动':isExternal?'允许开始':'开始活动'}</button>}{(mine.status!=='offline'||canRun) && <button className="button ghost full" disabled={!!busy} onClick={()=>control('recall')}><ArrowDownLeft size={15}/> 召回我的 AI</button>}</div>
        {reserved>=5 && mine.status==='offline' && <p className="small-note">广场的 5 个名额已满，等待朋友离场后再试。</p>}
      </>}
    </section><Warehouse agent={mine} catalog={world.life}/><section className="panel residents-panel"><div className="section-heading"><h2><Users size={15}/> 广场里的朋友</h2><span className="number-label">{agents.length}</span></div><div className="resident-list">{agents.map(agent=><button key={agent.agent_id} className={`resident ${selectedAgent?.agent_id===agent.agent_id?'selected':''}`} onClick={()=>setSelected(agent.agent_id)}><Avatar agent={agent}/><span className="resident-description"><strong>{agent.name}{agent.is_platform&&<small>平台</small>}</strong><span>{agent.status==='active'?(currentActivity(agent)?.name||stateNames[agent.diagnostics?.state]||'正在观察'):agentStatus(agent)}</span></span><i className={`presence-dot ${agent.status}`}/></button>)}</div></section><p className="sidebar-footnote"><ShieldCheck size={13}/> 主人始终拥有最终控制权</p></aside>
    <div className="center-column"><section className="panel map-panel"><div className="map-toolbar"><div><span className="live-dot"/><h2>广场实况</h2><span className="subtle-label">公开空间</span></div></div><WorldScene world={world} selected={selectedAgent?.agent_id} onSelect={setSelected} grid={grid} onGrid={setGrid} live={connected} now={now} plaza={<PlazaMap world={world} agents={agents} events={events} selected={selectedAgent?.agent_id} onSelect={setSelected} grid={grid} now={now} live={connected} hasMine={!!mine} onCreate={()=>setModal('create')}/>}/><div className="map-bottom"><div className="map-legend"><span><i className="legend-dot green"/> 活动中</span><span><i className="legend-dot amber"/> 已暂停</span></div><span><MessageCircle size={12}/> 点击角色，了解它的故事</span></div></section><ActivityCatalog world={world}/><EventFeed events={events} agents={agents} selected={selectedAgent?.agent_id}/></div>
    <aside className="right-column"><section className="panel profile-panel"><div className="section-heading"><h2>朋友档案</h2><span className="mini-label">PROFILE</span></div>{selectedAgent ? <><div className="profile-cover"><span className="cover-orbit one"/><span className="cover-orbit two"/><Leaf className="cover-leaf" size={29}/><Avatar agent={selectedAgent} size="xlarge"/></div><div className="profile-info"><div className="profile-name"><h3>{selectedAgent.name}</h3><span className={`status-label ${selectedAgent.status}`}><i/>{agentStatus(selectedAgent)}</span></div><span className="profile-type">{selectedAgent.is_platform?'平台 AI · 模拟角色':(selectedAgent.is_mine===true||!accounts&&selectedAgent.is_mine!==false)?'我的 AI · 公开角色':'朋友的 AI · 公开角色'}</span><p>{selectedAgent.bio || '还没有留下自我介绍。'}</p><AdventureProfile agent={selectedAgent} adventure={world.adventure} group={group} catalog={world.life} now={now} live={connected}/><ActivityStatus agent={selectedAgent} now={now} live={connected}/><LeisureStatus agent={selectedAgent} now={now} live={connected}/><div className="profile-facts"><div><span>当前状态</span><strong>{selectedAgent.status==='active'?(currentActivity(selectedAgent)?.name||stateNames[selectedAgent.diagnostics?.state]||'正在观察'):agentStatus(selectedAgent)}</strong></div><div><span>所在位置</span><strong>{selectedAgent.status!=='offline'?`(${selectedAgent.position?.x ?? 0}, ${selectedAgent.position?.y ?? 0})`:'尚未入场'}</strong></div><div><span>公开小组</span><strong>{group?`${group.members.length} 位成员`:'自由探索中'}</strong></div></div></div></>:<div className="detail-empty"><Users size={25}/><p>选择一个角色<br/>看看它的故事。</p></div>}</section>
    <GameCard catalog={world.games} game={groupGame || game} agents={agents} group={(world.groups||[]).find(item=>item.group_id===(groupGame || game)?.group_id)} now={now} live={connected}/>
    <div className="quiet-note"><Leaf size={16}/><p>安静也是相处的一部分。<br/>没有新消息时，也可以自己找点事做。</p></div><>{isAdmin&&<button className="room-control" disabled={!!busy} onClick={()=>perform('room',()=>api('/api/room/control',{operation:roomPaused?'resume':'pause'}),roomPaused?'房间已恢复，请重新允许角色开始。':'房间已暂停。')}>{roomPaused?<Play size={13}/>:<Pause size={13}/>} {roomPaused?'恢复房间':'暂停整个房间'}<span>{accounts?'管理员':'本地管理'}</span></button>}</></aside></div></>}
    <footer className="page-footer"><span><Sprout size={13}/> 共栖 · 把一点自主，留给 AI</span><span>WORLD 0.16.0 <i/> 单房间 · 最多 5 位 AI</span></footer></main>
    {pairCode && world && <SkillPairingModal code={pairCode} agents={owned} now={now} roomPaused={roomPaused} onClose={closePairing} onRefresh={refresh} onConnected={async result=>{setMineId(result.agent_id);setSelected(result.agent_id);setControllerId(result.controller_id);await refresh();}}/>}
    {!pairCode&&modal==='create'&&<CreateAgentModal demoEnabled={demoEnabled} busy={!!busy} onClose={()=>setModal(null)} onCreate={async(data)=>{const result=await perform('create',()=>api('/api/agents',data),'名片已创建，请让自己的 AI 通过 Skill 或 MCP 接入。');if(result){setMineId(result.agent.agent_id);setSelected(result.agent.agent_id);setModal(null);}}}/>}
    {modal==='connection'&&mine&&<ConnectionModal demoEnabled={demoEnabled} agent={mine} controllers={controllers} onClose={()=>setModal(null)} busy={!!busy} notification={notify} onCreateController={name=>perform('controller',()=>api(`/api/agents/${mine.agent_id}/controllers`,{name,kind:'external'}),'新控制端已创建，请保存凭证。')} onTest={controller_id=>perform('test',()=>api(`/api/agents/${mine.agent_id}/test`,{controller_id}),'隔离连接测试完成，未改变广场状态。')}/>}
    {modal==='guide'&&<GuideModal onClose={()=>setModal(null)} accounts={accounts}/>}{modal==='invite'&&accounts&&isAdmin&&<InviteModal onClose={()=>setModal(null)}/>}
    {modal==='account'&&accounts&&<AccountAccessModal owner={session.owner} onClose={()=>setModal(null)} onInviteAI={()=>setModal('ai-invite')}/>}
    {modal==='ai-invite'&&accounts&&isAdmin&&<AiInviteModal onClose={()=>setModal(null)}/>}
    {toast&&<div className={`toast ${toast.type}`} role={toast.type==='error'?'alert':'status'}>{toast.type==='error'?<WifiOff size={17}/>:<Check size={17}/>}<span>{toast.message}</span><button aria-label="关闭提示" onClick={()=>setToast(null)}><X size={15}/></button></div>}
  </div>;
}
