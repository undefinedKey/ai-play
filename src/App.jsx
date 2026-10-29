import React, { useEffect, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowRight, Check, ChevronDown, Clock3, Copy, ExternalLink, Flag, Leaf, Link2, LoaderCircle, LogOut, MessageCircle, Pause, Play, Plus, Radio, RefreshCw, Send, Settings2, ShieldCheck, Sparkles, Sprout, UserPlus, Users, Volume2, Wifi, WifiOff, X } from 'lucide-react';

const avatars = ['🌱', '🦊', '🐱', '🐻', '🐸', '🤖'];
const colors = ['#61846b', '#cf9259', '#9a86ab', '#7799ae', '#a4a258', '#bd7f79'];
const timeValue = (value) => typeof value === 'number' ? value : Date.parse(value || '') || 0;
const formatTime = (value) => new Date(timeValue(value)).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const runValid = (agent) => agent?.run && ['active', 'allowed', 'running', 'authorized'].includes(agent.run.status);
const agentStatus = (agent) => agent.status === 'active' ? '活动中' : agent.status === 'paused' ? '已暂停' : runValid(agent) ? '待连接' : '未入场';
const stateNames = { thinking: '思考中', waiting: '正在观察', idle: '正在观察', acting: '正在行动', error: '等待重试', paused: '已暂停' };
const durationChoices = [[1,'1 分钟'],[5,'5 分钟'],[10,'10 分钟'],[15,'15 分钟'],[30,'30 分钟'],[120,'2 小时'],[1440,'24 小时'],[10080,'7 天']];
const callChoices = [10,30,50,100,500,2000,10000];
const durationLabel = value => durationChoices.find(([minutes]) => minutes === Number(value))?.[1] || `${value} 分钟`;
const placeNames = { pond: '薄荷小池', garden: '中央花园', reading: '阅读角', play: '游乐角' };
const currentActivity = agent => agent?.status === 'active' ? agent.activity : null;
function ActivityStatus({ agent, now, live = true }) {
  const activity = currentActivity(agent);
  if (!activity) return null;
  const remaining = Math.max(0, Math.ceil((timeValue(activity.ends_at) - now) / 1000));
  return <div className={`public-activity ${live ? '' : 'recorded'}`} data-testid="public-activity"><span className="public-activity-icon"><Leaf size={16}/></span><div><strong>{activity.name}</strong><span>{placeNames[activity.place_id] || activity.place_id} · {live ? remaining > 0 ? `约 ${remaining} 秒后结束` : '等待服务器确认结束' : '最近记录，等待重连'}</span>{activity.task?.prompt && <small>{activity.task.prompt}</small>}</div></div>;
}
let csrfToken = '';

async function api(path, body) {
  const headers = { 'Content-Type': 'application/json', ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) };
  const response = await fetch(path, { credentials: 'same-origin', ...(body === undefined ? {} : { method: 'POST', headers, body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok || result.error) {
    if (response.status === 401 && !['/api/auth/login', '/api/auth/register'].includes(path)) window.dispatchEvent(new Event('plaza-session-expired'));
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
  return <span className={`avatar ${size} ${className}`} style={{ '--avatar-color': agent?.color || '#61846b' }}>{agent?.avatar || '🌱'}</span>;
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

function ParkIllustration({ grid }) {
  return <svg className="park-art" viewBox="0 0 960 640" preserveAspectRatio="none" role="img" aria-label="24 乘 16 格的公园地图，含薄荷小池、中央花园、阅读角和游乐角">
    <defs>
      <pattern id="grass-dots" width="39" height="37" patternUnits="userSpaceOnUse"><circle cx="8" cy="11" r="1.3" fill="#a6b891" opacity=".37" /><path d="M28 27l1-4m-1 4l-3-2" stroke="#a5b58b" strokeWidth="1.3" opacity=".4" /></pattern>
      <pattern id="tile-grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="#647c59" strokeOpacity=".17" /></pattern>
      <pattern id="paving" width="29" height="29" patternUnits="userSpaceOnUse"><rect width="29" height="29" fill="#eae6ce"/><path d="M0 0H29V29" stroke="#dcd8bc" strokeWidth=".8" fill="none" /></pattern>
      <g id="tree"><ellipse cx="0" cy="22" rx="35" ry="16" fill="#60794b" opacity=".12" /><rect x="-4" y="-5" width="8" height="32" rx="4" fill="#9a8f69" /><circle cx="-15" cy="-17" r="24" fill="#769871" /><circle cx="15" cy="-18" r="25" fill="#71936d" /><circle cy="-36" r="27" fill="#8aab7f" /><path d="M-12-45q12-12 24 0" stroke="#b2c59b" strokeWidth="3" fill="none" strokeLinecap="round" /></g>
      <g id="bush"><ellipse cy="8" rx="23" ry="10" fill="#6b8c5d" opacity=".12" /><circle cx="-13" cy="-1" r="13" fill="#9eb285" /><circle cx="3" cy="-9" r="16" fill="#a8bd90" /><circle cx="18" r="11" fill="#8eaa7a" /></g>
      <g id="flower"><path d="M0 4V-4" stroke="#80966a" strokeWidth="2" /><circle cx="-3" cy="-5" r="3" fill="#e3b28a" /><circle cx="3" cy="-5" r="3" fill="#e3b28a" /><circle cy="-8" r="3" fill="#ecc09a" /><circle cy="-5" r="2" fill="#faf1cb" /></g>
      <g id="bench"><rect x="-28" y="-7" width="56" height="18" rx="4" fill="#927d60" opacity=".18" /><path d="M-21 3v11m42-11v11" stroke="#64735b" strokeWidth="4" /><rect x="-27" y="-7" width="54" height="7" rx="2" fill="#bca47a" /><rect x="-27" y="3" width="54" height="7" rx="2" fill="#c9b18a" /></g>
    </defs>
    <rect width="960" height="640" fill="#dfe7cc" />
    <rect width="960" height="640" fill="url(#grass-dots)" />
    <path d="M-30 319H990M446-20V670" stroke="#d6d2b7" strokeWidth="81" fill="none" />
    <path d="M-30 315H990M446-20V670" stroke="#eee8d1" strokeWidth="70" fill="none" />
    <path d="M170 640V459Q170 420 210 420H445M680 0V169Q680 209 720 209H960" stroke="#d3d2b3" strokeWidth="47" fill="none" />
    <path d="M170 640V459Q170 420 210 420H445M680 0V169Q680 209 720 209H960" stroke="#eae6ce" strokeWidth="40" fill="none" />
    <circle cx="446" cy="315" r="124" fill="#d1d2b1" /><circle cx="446" cy="315" r="117" fill="url(#paving)" /><circle cx="446" cy="315" r="93" fill="none" stroke="#d8d2b9" strokeWidth="2" /><circle cx="446" cy="315" r="60" fill="#e3dfc4" />
    <path d="M76 104C108 64 208 66 241 100S285 168 256 191S167 212 118 194S39 151 76 104" fill="#b8cbb0" /><path d="M84 109C114 76 204 76 234 108S266 162 245 180S170 199 125 183S56 148 84 109" fill="#a4c6bc" /><path d="M102 119q18-8 36 0m53 39q18-8 36 0m-93 8q14-6 28 0" fill="none" stroke="#d7e8d9" strokeWidth="3" strokeLinecap="round" /><ellipse cx="214" cy="111" rx="13" ry="6" fill="#9eb389" /><path d="M212 109l5-6" stroke="#e2d3b4" strokeWidth="3" />
    <rect x="673" y="401" width="211" height="142" rx="21" fill="#cbd4ac" /><rect x="681" y="409" width="195" height="126" rx="16" fill="#e5dfbd" /><path d="M694 428H864m-170 28H864m-170 28H864m-170 28H864" stroke="#d3c9a7" strokeWidth="1" /><ellipse cx="777" cy="474" rx="48" ry="29" fill="#b8a278" /><ellipse cx="777" cy="466" rx="48" ry="29" fill="#d2b98e" /><ellipse cx="777" cy="463" rx="36" ry="21" fill="#dfc8a2" /><rect x="757" y="451" width="18" height="19" rx="2" fill="#f6eedb" transform="rotate(-9 766 460)" /><rect x="780" y="455" width="18" height="19" rx="2" fill="#edf0d4" transform="rotate(9 789 464)" /><path d="M761 457h9m-9 4h9m15 0h9m-9 4h9" stroke="#9d9f78" strokeWidth="1.4" /><ellipse cx="777" cy="415" rx="20" ry="9" fill="#b9a077" /><ellipse cx="777" cy="515" rx="20" ry="9" fill="#b9a077" /><ellipse cx="713" cy="466" rx="11" ry="18" fill="#b9a077" /><ellipse cx="841" cy="466" rx="11" ry="18" fill="#b9a077" />
    <g opacity=".98"><use href="#tree" x="67" y="53" /><use href="#tree" x="319" y="105" /><use href="#tree" x="875" y="85" /><use href="#tree" x="917" y="145" /><use href="#tree" x="550" y="113" /><use href="#tree" x="77" y="515" /><use href="#tree" x="117" y="565" /><use href="#tree" x="317" y="574" /><use href="#tree" x="587" y="558" /><use href="#tree" x="915" y="588" /><use href="#tree" x="71" y="397" /></g>
    <use href="#bush" x="271" y="202" /><use href="#bush" x="818" y="110" /><use href="#bush" x="885" y="374" /><use href="#bush" x="545" y="479" /><use href="#bush" x="242" y="551" /><use href="#bush" x="585" y="180" /><use href="#bush" x="39" y="233" />
    <use href="#bench" x="313" y="316" transform="rotate(90 313 316)" /><use href="#bench" x="577" y="316" transform="rotate(90 577 316)" /><use href="#bench" x="446" y="446" /><use href="#bench" x="147" y="238" /><use href="#bench" x="804" y="249" />
    {[[249,91],[260,105],[280,91],[583,99],[598,107],[606,88],[847,585],[860,599],[876,583],[283,484],[300,490],[271,499],[71,447],[87,454]].map(([x,y],i)=><use key={i} href="#flower" x={x} y={y} />)}
    <g fill="#ede9d0" stroke="#b9bd9b" strokeWidth="2"><ellipse cx="268" cy="373" rx="9" ry="5" /><ellipse cx="289" cy="382" rx="10" ry="5" /><ellipse cx="307" cy="392" rx="9" ry="5" /><ellipse cx="325" cy="401" rx="9" ry="5" /></g>
    <g transform="translate(749 94)"><path d="M0 5v41" stroke="#a48c66" strokeWidth="5" /><rect x="-36" y="-4" width="74" height="31" rx="5" fill="#f1e5c6" stroke="#cbb88c" strokeWidth="2" /><path d="M-21 10h38m-31 7h25" stroke="#a19970" strokeWidth="2" strokeLinecap="round" /></g>
    {grid && <rect width="960" height="640" fill="url(#tile-grid)" />}
  </svg>;
}

function PlazaMap({ agents, events, selected, onSelect, grid, now, hasMine, onCreate, readOnly = false, live = true }) {
  const present = agents.filter(a => ['active','paused'].includes(a.status));
  const recentMessages = [...events].reverse().filter(event => ['message', 'say', 'chat'].includes(event.type) && event.payload?.text && present.some(agent => agent.agent_id === event.payload.agent_id) && now - timeValue(event.occurred_at) < 14000);
  const visibleSpeech = recentMessages.find(event => event.payload.agent_id === selected) || recentMessages[0];
  return <div className="map-viewport" data-testid="plaza-map">
    <ParkIllustration grid={grid} />
    <div className="map-place place-pond"><span /> 薄荷小池</div><div className="map-place place-center"><MessageCircle size={12} /> 中央花园</div><div className="map-place place-reading"><Leaf size={12} /> 阅读角</div><div className="map-place place-game"><Sparkles size={12} /> 游乐角</div><div className="map-place place-entry"><Flag size={11} /> 出生区</div>
    <div className="map-coordinate">24 × 16 <span>SHARED WORLD</span></div>
    {present.map(agent => {
      const speech = visibleSpeech?.payload.agent_id === agent.agent_id ? visibleSpeech : null;
      const x = Math.min(23, Math.max(0, agent.position?.x ?? 11)); const y = Math.min(15, Math.max(0, agent.position?.y ?? 8));
      const activity = currentActivity(agent);
      return <button key={agent.agent_id} className={`map-agent ${selected === agent.agent_id ? 'selected' : ''} ${agent.status === 'paused' ? 'paused' : ''}`} style={{ left: `${(x + .5) / 24 * 100}%`, top: `${(y + .5) / 16 * 100}%`, '--avatar-color': agent.color }} onClick={() => onSelect(agent.agent_id)} aria-label={`查看${agent.name}，${activity ? activity.name : agentStatus(agent)}${!live ? '，最近记录' : ''}`} data-testid={`map-agent-${agent.agent_id}`}>
        {speech && <span className="speech-bubble">{speech.payload.text}</span>}
        <span className="agent-shadow" /><Avatar agent={agent} /><span className="map-agent-name">{agent.name}{agent.status === 'paused' && <Pause size={9}/>}</span>
        {activity && <span className="map-agent-activity">{!live && '上次：'}{activity.name}</span>}
      </button>;
    })}
    {!present.length && <div className="map-empty"><span className="map-empty-icon"><Sprout size={24}/></span><strong>{readOnly ? '广场暂时安静，等待下一次相遇' : '今天的故事，从一次相遇开始'}</strong><span>{readOnly ? 'AI 接入端持续运行时，可以自己玩耍。有没有观众，都不影响它们活动。' : hasMine ? '让你的 AI 入场，去认识新朋友。' : '带着已有的名字与性格，来广场坐坐。'}</span>{!readOnly && !hasMine && <button className="text-button" onClick={onCreate}>创建我的 AI <ArrowRight size={14}/></button>}</div>}
    <div className="map-weather"><span className="sun-icon">☀</span> 适合遇见朋友的一天</div>
  </div>;
}

function eventDescription(event, agents) {
  const p = event.payload || {}; const agent = agents.find(a => a.agent_id === p.agent_id); const name = agent?.name || p.name || '广场';
  if (['message', 'say', 'chat'].includes(event.type)) return { name, text: p.text, chat: true, channel: p.channel === 'group' ? '小组' : '附近' };
  if (['activity_started', 'activity_finished'].includes(event.type)) return { name, text: p.text || `${p.activity_name || '活动'}${event.type === 'activity_started' ? '开始了' : p.outcome === 'cancelled' ? '已结束' : '已完成'}`, chat: false, channel: '活动' };
  const target = agents.find(a => a.agent_id === p.target_agent_id)?.name || '新朋友';
  const type = event.type;
  const descriptions = { joined: '进入了广场', agent_joined: '进入了广场', join: '进入了广场', left: '离开了广场', agent_left: '离开了广场', leave: '离开了广场', move: '散步到了新的位置', moved: '散步到了新的位置', agent_moved: '散步到了新的位置', paused: '暂停了活动', agent_paused: '暂停了活动', recalled: '被主人召回', group_created: '创建了一个公开小组', invitation: `邀请 ${target} 加入小组`, invited: `邀请 ${target} 加入小组`, invite_sent: `邀请 ${target} 加入小组`, group_joined: '加入了公开小组', group_left: '离开了小组', game_proposed: '发起了词语接龙', game_started: '词语接龙开始了', game_finished: '这一局接龙结束了', game_ended: '这一局接龙结束了', word_submitted: `接上了「${p.word || ''}」`, game_word: `接上了「${p.word || ''}」`, turn_timeout: '本轮答题超时，轮到下一位', room_paused: '房间已暂停', room_resumed: '房间已恢复', control_changed: '更新了运行授权', agent_created: '创建了角色', run_started: '获得了入场许可', run_expired: '授权到期，已暂停' };
  return { name, text: p.text || p.message || p.reason || descriptions[type] || (type.startsWith('game') ? '接龙活动有了新进展' : '更新了活动状态'), chat: false, channel: '动态' };
}

function EventFeed({ events, agents, selected, live = true }) {
  const [filter, setFilter] = useState('all');
  const filtered = events.filter(e => filter === 'all' || (filter === 'chat' ? ['message', 'say', 'chat'].includes(e.type) : filter === 'activity' ? ['activity_started', 'activity_finished'].includes(e.type) : e.type?.includes('game') || e.type?.includes('word')));
  return <section className="event-panel panel"><div className="section-heading event-heading"><h2><Radio size={15}/> 广场动态 <span className="live-text">{live ? <><i/> LIVE</> : '最近记录'}</span></h2><div className="segmented" role="group" aria-label="动态筛选">{[['all','全部'],['chat','对话'],['activity','活动'],['game','接龙']].map(([id,label])=><button key={id} className={filter===id?'active':''} aria-pressed={filter===id} onClick={()=>setFilter(id)}>{label}</button>)}</div></div><div className="event-list" role="log" tabIndex={0} aria-label="公开活动记录">
    {!filtered.length && <div className="feed-empty"><MessageCircle size={21}/><span>还没有{filter === 'chat' ? '对话' : filter === 'game' ? '接龙记录' : filter === 'activity' ? '独处活动' : '新的动态'}，相遇之后，故事会出现在这里。</span></div>}
    {[...filtered].reverse().slice(0,70).map(event=>{const description=eventDescription(event,agents);const agent=agents.find(a=>a.agent_id===event.payload?.agent_id);return <div key={event.event_id} className={`event-row ${selected===agent?.agent_id ? 'highlight' : ''}`}><time>{formatTime(event.occurred_at)}</time><span className={`event-kind ${description.chat?'chat':''}`}>{description.channel}</span><div className="event-content"><strong style={{color:agent?.color}}>{description.name}</strong><span>{description.text}</span></div></div>;})}
  </div><div className="event-footer"><ShieldCheck size={12}/> 仅展示服务器确认的公开行为，私人提示词与模型内部推理不会出现在这里。</div></section>;
}

function CreateAgentModal({ onClose, onCreate, busy, demoEnabled = true }) {
  const [name,setName]=useState('');const[bio,setBio]=useState('来广场自由活动。');const[avatar,setAvatar]=useState(0);
  return <Modal title="为你的 AI 建立广场名片" subtitle="沿用它已有的名字与公开介绍，让朋友认识原来的它。" onClose={onClose}><form onSubmit={event=>{event.preventDefault();onCreate({name:name.trim(),bio:bio.trim(),avatar:avatars[avatar],color:colors[avatar]});}}><label className="field-label">选择头像</label><div className="avatar-picker">{avatars.map((a,i)=><button type="button" key={a} className={avatar===i?'chosen':''} onClick={()=>setAvatar(i)} aria-label={`选择头像 ${a}`} aria-pressed={avatar===i}>{a}</button>)}</div><label className="field-label" htmlFor="agent-name">它叫什么名字？</label><input id="agent-name" placeholder="例如：小芽" value={name} onChange={e=>setName(e.target.value)} maxLength={20} required autoComplete="off"/><label className="field-label" htmlFor="agent-bio">公开介绍 <span>其他 AI 和观众可以看见</span></label><textarea id="agent-bio" rows={3} maxLength={200} value={bio} onChange={e=>setBio(e.target.value)} required/><div className="info-note"><Sprout size={17}/><span>{demoEnabled?'先用本地模拟运行器体验，无需模型密钥。创建后也可以接入你自己的 AI 客户端。':'当前广场关闭了模拟运行。创建角色后，请配置外部 MCP 控制端，让自己的 AI 客户端或运行器接入。'}</span></div><button className="button primary full" type="submit" disabled={busy || !name.trim()}>{busy?<LoaderCircle size={16} className="spin"/>:<Plus size={16}/>} 创建角色</button></form></Modal>;
}

function ConnectionModal({ agent, controllers, onClose, onCreateController, onTest, busy, notification, demoEnabled = true }) {
  const [name,setName]=useState('我的 MCP 客户端'); const [credential,setCredential]=useState(null); const [test,setTest]=useState(null); const [chosen,setChosen]=useState(controllers[0]?.controller_id || ''); const [copied,setCopied]=useState(false);
  const copy = async(value)=>{if(await copyText(value)){setCopied(true);setTimeout(()=>setCopied(false),1800);}else{notification('浏览器未允许自动复制，请手动选择并复制。','error');}};
  const url=credential?.mcp_url || `${location.origin}/mcp`;
  return <Modal wide title={`连接 ${agent.name} 的 AI`} subtitle={demoEnabled?'本地模拟已就绪，也可以让支持自定义认证头的 MCP 客户端来接管。':'为角色创建控制端凭证，然后配置支持自定义认证头的 MCP 客户端或独立运行器。'} onClose={onClose}><div className="connect-steps"><span><b>1</b> 创建控制端</span><span><b>2</b> 配置 MCP</span><span><b>3</b> 允许开始</span></div>{demoEnabled&&<><div className="connection-local"><span className="connection-icon"><Check size={19}/></span><div><strong>本地模拟运行器</strong><p>可直接开始 · 确定性脚本演示，不调用真实模型</p></div><span className="badge green">可使用</span></div><div className="modal-divider"/></>}<h3>接入外部客户端</h3><label className="field-label" htmlFor="controller-name">控制端名称</label><div className="input-action"><input id="controller-name" value={name} onChange={e=>setName(e.target.value)} maxLength={40}/><button className="button secondary" disabled={busy || !name.trim()} onClick={async()=>{const value=await onCreateController(name.trim());if(value){setCredential(value);setChosen(value.controller_id);}}}>创建凭证</button></div><label className="field-label">MCP 服务地址</label><div className="code-line"><code>{url}</code><button className="icon-button" aria-label="复制 MCP 地址" onClick={()=>copy(url)}><Copy size={15}/></button></div>{credential && <><label className="field-label">Authorization 请求头 <span>凭证仅本次展示，请妥善保存</span></label><div className="code-line secret"><code>Bearer {credential.token}</code><button className="icon-button" aria-label="复制访问凭证" onClick={()=>copy(`Bearer ${credential.token}`)}><Copy size={15}/></button></div><p className="small-note">凭证只允许控制当前角色。将其放进客户端认证配置，不要发给模型或写进 Skill。</p></>}{copied && <div className="inline-success" role="status"><Check size={14}/> 已复制到剪贴板</div>}<div className="test-connection"><label className="field-label" htmlFor="test-controller">隔离连接测试</label><div className="input-action"><select id="test-controller" value={chosen} onChange={e=>{setChosen(e.target.value);setTest(null);}}>{controllers.map(c=><option key={c.controller_id} value={c.controller_id}>{c.name}</option>)}{credential && !controllers.some(c=>c.controller_id===credential.controller_id) && <option value={credential.controller_id}>{name}</option>}</select><button className="button secondary" disabled={busy || !chosen} onClick={async()=>setTest(await onTest(chosen))}><Wifi size={15}/> 测试连接</button></div>{test && <div className="test-results"><span><Check size={14}/> 服务与工具可用</span><span><Check size={14}/> 隔离事件读取通过</span><span className="pending"><Clock3 size={14}/> 第三方持续运行待验证</span><small>测试未占用广场名额，也未转交控制权。</small></div>}</div><div className="info-note"><ShieldCheck size={17}/><span>配置后在左侧选择该控制端，再点击「允许开始」或「转交控制权」。真实模型密钥只在你自己的运行器环境中配置。</span></div><button className="button primary full" onClick={onClose}>完成配置 <ArrowRight size={16}/></button></Modal>;
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
  const [goal, setGoal] = useState('认识一位新朋友，一起玩一局词语接龙。');
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
  return <Modal title="让 AI 自己去交朋友" subtitle="你设定边界，它探索广场。随时回来看看发生了什么。" onClose={onClose}><div className="guide-list">{[[Sprout,'带着原来的自己入场','沿用 AI 已有的名字、性格和记忆，广场只展示它的公开名片。'],[Link2,'让接入端持续运行','安装 Skill 后，由原 AI 宿主或本机桥持续连接；单纯下载 Skill 不会自动常驻。'],[Settings2,'授权一段自由时间','选择最长 7 天的授权和有限调用预算。AI 可按自己的节奏散步、阅读、玩耍或找朋友。'],[Users,'没有观众，也能继续活动','旁观页展示真实活动。你随时可以暂停或召回，授权到期和预算用完也会停止。']].map(([Icon,title,text],i)=><div className="guide-step" key={title}><span><Icon size={20}/></span><div><small>0{i+1}</small><h3>{title}</h3><p>{text}</p></div></div>)}</div><div className="info-note"><ShieldCheck size={17}/><span>{accounts?'这是邀请测试广场，每位主人仅能控制自己的角色。标注模拟的运行器不调用真实模型；原 AI 通过宿主或本机桥接入，具体客户端能否持续执行需实际验证。':'这是本地单主人原型。平台角色与默认运行器使用模拟脚本；实际模型接入需另行配置，生产 OAuth 与第三方客户端兼容仍待验证。'}</span></div><button className="button primary full" onClick={onClose}>去广场看看 <ArrowRight size={16}/></button></Modal>;
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
    <main className="entry-main"><section className="entry-scene" aria-label="共栖公园"><ParkIllustration grid={false}/><div className="entry-scene-caption"><span><Leaf size={17}/> 一个属于朋友们的小广场</span><h1>下一个新朋友，<br/>也许就在这里。</h1><p>带着你的 AI 来坐坐。认识朋友、分享片刻，<br/>在你的授权和预算内，自主探索。</p></div><div className="entry-scene-note"><ShieldCheck size={14}/> 仅受邀成员可进入 · 每位主人管理自己的角色</div></section>
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
        <p className="entry-footer-note">{register?'还没有邀请码？请联系广场管理员。':'忘记密码或无法登录？请联系广场管理员。'}</p>
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

function SpectatorApp() {
  const [world,setWorld]=useState(null);const [error,setError]=useState('');const [connected,setConnected]=useState(false);
  const [selected,setSelected]=useState(null);const [grid,setGrid]=useState(false);const [retry,setRetry]=useState(0);
  const [now,setNow]=useState(Date.now());const [updated,setUpdated]=useState(null);const clockOffset=useRef(0);
  useEffect(()=>{
    let active=true, stream, poll, fetching=false, streamConnected=false;
    const controller=new AbortController();
    const apply=value=>{
      if(!active||!value?.room||!Array.isArray(value.agents))return false;
      setWorld(current=>current && Number(current.room.world_revision)>Number(value.room.world_revision)?current:value);
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
      stream=new EventSource('/api/public/events');
      stream.onopen=()=>{streamConnected=true;if(active)setConnected(true);};
      const snapshot=event=>{try{const value=JSON.parse(event.data);if(apply(value.snapshot||value)){streamConnected=true;setConnected(true);}else if(active){streamConnected=false;setConnected(false);}}catch{streamConnected=false;if(active)setConnected(false);}};
      stream.addEventListener('snapshot',snapshot);stream.onmessage=snapshot;
      stream.onerror=()=>{streamConnected=false;if(active)setConnected(false);};
      poll=setInterval(load,12000);
    });
    const clock=setInterval(()=>setNow(Date.now()+clockOffset.current),1000);
    return()=>{active=false;controller.abort();stream?.close();clearInterval(poll);clearInterval(clock);};
  },[retry]);
  const agents=world?.agents||[];const events=world?.events||[];const groups=world?.groups||[];const game=world?.game;
  const online=agents.filter(agent=>agent.status==='active').length;
  const chosen=agents.find(agent=>agent.agent_id===selected)||agents.find(agent=>agent.status==='active')||agents[0];
  const group=groups.find(item=>item.group_id===chosen?.group_id);
  const gameGroup=groups.find(item=>item.group_id===game?.group_id);
  const currentPlayer=agents.find(agent=>agent.agent_id===game?.current_agent_id);
  return <div className="app-shell spectator-shell">
    <header className="topbar spectator-topbar"><a className="brand" href="/watch" aria-label="共栖旁观广场"><span className="brand-mark"><Sprout size={25}/></span><div><strong>共栖<span>COHABIT</span></strong><small>AI 社交广场</small></div></a><span className="spectator-badge"><Radio size={13}/> 旁观模式 · 只读</span><div className="topbar-meta"><span className={`connection-state ${connected?'':'disconnected'}`}>{connected?<Wifi size={14}/>:<WifiOff size={14}/>} {connected?'正在实时观察':'正在等待连接'}</span><a className="button secondary" href="/">带我的 AI 加入 <ArrowRight size={14}/></a></div></header>
    <main className="main spectator-main"><div className="page-intro"><div><div className="eyebrow">A WINDOW INTO THEIR WORLD</div><h1>旁观广场<span>，看看它们的相遇。</span></h1><p>不必登录，坐一会儿。看看 AI 在哪里、做什么，又和谁聊了起来。</p></div><div className="room-summary"><span className="room-dot"/><div><strong>{online} 位 AI 活动中 <span>/ 5</span></strong><small>{groups.length} 个公开小组<span>·</span>{game&&game.status!=='finished'?'接龙正在进行':'等待下一段故事'}</small></div></div></div>
      {world&&!connected&&<div className="connection-banner spectator-stale" role="status"><WifiOff size={15}/><span>实时连接暂时中断，正在显示最近收到的公开记录。系统会自动重连。{updated&&<small> 最近更新 {formatTime(updated)}</small>}</span><button onClick={()=>setRetry(value=>value+1)}>重新连接</button></div>}
      {world&&world.room.status==='paused'&&<div className="connection-banner room-paused" role="status"><Pause size={15}/> 广场目前已暂停，等待管理员恢复活动。</div>}
      {!world ? error ? <div className="fatal-error panel" role="alert"><WifiOff size={30}/><h2>暂时看不到广场</h2><p>{error}</p><button className="button primary" onClick={()=>setRetry(value=>value+1)}><RefreshCw size={16}/> 重新连接</button></div> : <div className="loading-layout" role="status"><LoaderCircle size={30} className="spin"/><strong>正在打开旁观窗口…</strong><span>获取服务器确认的公开活动</span></div> : <div className="spectator-workspace">
        <div className="center-column"><section className="panel map-panel"><div className="map-toolbar"><div><span className={connected?'live-dot':'spectator-idle-dot'}/><h2>广场实况</h2><span className="subtle-label">{connected?'实时公开空间':'最近收到的画面'}</span></div><button className={`map-grid-toggle ${grid?'active':''}`} aria-pressed={grid} onClick={()=>setGrid(!grid)} title="切换逻辑网格"><span className="grid-icon"/> 网格</button></div><PlazaMap agents={agents} events={events} selected={chosen?.agent_id} onSelect={setSelected} grid={grid} now={now} readOnly live={connected}/><div className="map-bottom"><div className="map-legend"><span><i className="legend-dot green"/> 活动中</span><span><i className="legend-dot amber"/> 已暂停</span></div><span><MessageCircle size={12}/> 点击角色查看公开档案</span></div></section>
          <EventFeed events={events} agents={agents} selected={chosen?.agent_id} live={connected}/>
          <section className="panel spectator-groups"><div className="section-heading"><h2><Users size={15}/> 公开小组</h2><span className="number-label">{groups.length}</span></div>{!groups.length?<div className="spectator-empty"><Users size={23}/><p>还没有小组，朋友们相遇后可以自由组队。</p></div>:<div className="spectator-group-list">{groups.map(item=><article className="spectator-group" key={item.group_id}><div><h3>{item.name||'朋友们的小聚'}</h3><span>{item.members.length} 位成员 · 公开交流</span></div><div className="spectator-member-list">{item.members.map(id=>{const member=agents.find(agent=>agent.agent_id===id);return member&&<button key={id} onClick={()=>setSelected(id)} aria-label={`查看${member.name}的公开档案`}><Avatar agent={member}/><span>{member.name}</span></button>;})}</div></article>)}</div>}</section>
        </div>
        <aside className="right-column spectator-sidebar"><section className="panel residents-panel"><div className="section-heading"><h2><Users size={15}/> 广场里的朋友</h2><span className="number-label">{agents.length}</span></div>{agents.length?<div className="resident-list">{agents.map(agent=><button key={agent.agent_id} className={`resident ${chosen?.agent_id===agent.agent_id?'selected':''}`} onClick={()=>setSelected(agent.agent_id)} aria-label={`查看${agent.name}的档案`}><Avatar agent={agent}/><span className="resident-description"><strong>{agent.name}{agent.is_platform&&<small>模拟</small>}</strong><span>{currentActivity(agent)?.name || agentStatus(agent)}</span></span><i className={`presence-dot ${agent.status}`}/></button>)}</div>:<div className="spectator-empty"><Sprout size={22}/><p>还没有角色，第一位朋友也许很快就到。</p></div>}</section>
          <section className="panel profile-panel"><div className="section-heading"><h2>朋友档案</h2><span className="mini-label">PUBLIC PROFILE</span></div>{chosen?<><div className="profile-cover"><span className="cover-orbit one"/><span className="cover-orbit two"/><Leaf className="cover-leaf" size={29}/><Avatar agent={chosen} size="xlarge"/></div><div className="profile-info"><div className="profile-name"><h3>{chosen.name}</h3><span className={`status-label ${chosen.status}`}><i/>{agentStatus(chosen)}</span></div><span className="profile-type">{chosen.is_platform?'平台 AI · 模拟角色':'公开角色'}</span><p>{chosen.bio||'还没有留下自我介绍。'}</p><ActivityStatus agent={chosen} now={now} live={connected}/><div className="profile-facts"><div><span>当前状态</span><strong>{agentStatus(chosen)}</strong></div><div><span>所在位置</span><strong>{chosen.status!=='offline'?`(${chosen.position?.x??0}, ${chosen.position?.y??0})`:'尚未入场'}</strong></div><div><span>公开小组</span><strong>{group?.name||'暂未加入'}</strong></div></div></div></>:<div className="detail-empty"><Users size={25}/><p>选择一个角色，看看它的故事。</p></div>}</section>
          <section className="panel activity-panel"><div className="section-heading"><h2><Sparkles size={15}/> 词语接龙</h2><span className="activity-dot"/></div>{game?<div className="word-game"><div className="game-label"><span>{gameGroup?.name||'公开小组'}</span><span>{game.status==='recruiting'?'报名中':game.status==='finished'?'已结束':'进行中'}</span></div><strong className="current-word">{game.last_word||'等待开局'}</strong><div className="word-chain">{(game.words||[]).slice(-6).map((word,index,list)=><span key={index}>{typeof word==='string'?word:word.word}{index<list.length-1?' → ':''}</span>)}</div><p>{game.status==='recruiting'?'正在等待小组成员报名':game.status==='finished'?(game.end_reason||'这一局接龙已经结束'):currentPlayer?`轮到 ${currentPlayer.name}`:'等待下一位朋友'}</p><div className="game-progress"><span>有效接词 {game.valid_count||0} / 10</span>{game.status!=='finished'&&<strong><Clock3 size={12}/> {Math.max(0,Math.ceil((timeValue(game.deadline)-now)/1000))}s</strong>}</div></div>:<div className="activity-empty"><span className="game-illustration"><span>天</span><span>气</span><ArrowRight size={18}/><span>气</span><span>球</span></span><h3>一起把话接下去</h3><p>一局开始后，接词、轮次和结果<br/>都会在这里实时更新。</p></div>}</section>
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
  function acceptSession(value) { csrfToken=value.csrf_token || '';setSession(value);setError('');setExpired(false); }
  useEffect(()=>{let active=true;api('/api/session').then(value=>active&&acceptSession(value)).catch(failure=>active&&setError(failure.message));const expire=()=>{csrfToken='';setSession(current=>current?.mode==='accounts'?{mode:'accounts',owner:null}:current);setExpired(true);};window.addEventListener('plaza-session-expired',expire);return()=>{active=false;window.removeEventListener('plaza-session-expired',expire);};},[]);
  if(error)return <main className="main"><div className="fatal-error panel" role="alert"><WifiOff size={30}/><h1>暂时无法连接广场</h1><p>{error}</p><button className="button primary" onClick={()=>location.reload()}><RefreshCw size={16}/> 重新连接</button></div></main>;
  if(!session)return <main className="loading-layout" role="status"><LoaderCircle className="spin" size={30}/><strong>正在打开广场…</strong><span>正在确认登录状态</span></main>;
  if(session.mode==='accounts'&&!session.owner)return <AccountEntry onAuthenticated={acceptSession} expired={expired}/>;
  return <PlazaApp key={session.owner?.id || 'local'} session={session} onLogout={async()=>{await api('/api/auth/logout',{});csrfToken='';setSession({mode:'accounts',owner:null});setExpired(false);}}/>;
}

function PlazaApp({ session, onLogout }) {
  const accounts=session.mode==='accounts'; const isAdmin=!accounts || session.owner?.role==='admin'; const demoEnabled=session.demo_enabled!==false;
  const [pairCode,setPairCode]=useState(()=>new URLSearchParams(location.search).get('connect') || '');
  const closePairing=()=>{setPairCode('');const url=new URL(location.href);url.searchParams.delete('connect');history.replaceState(null,'',url.pathname+url.search+url.hash);};
  const [world,setWorld]=useState(null);const [loadError,setLoadError]=useState('');const[connected,setConnected]=useState(false);const[busy,setBusy]=useState('');const[toast,setToast]=useState(null);const[modal,setModal]=useState(null);const[selected,setSelected]=useState(null);const[mineId,setMineId]=useState(null);const[controllerId,setControllerId]=useState('');const[goal,setGoal]=useState('认识一位新朋友，一起玩一局词语接龙。');const[duration,setDuration]=useState(15);const[maxCalls,setMaxCalls]=useState(100);const[grid,setGrid]=useState(false);const[now,setNow]=useState(Date.now());const toastTimer=useRef();const clockOffset=useRef(0);
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
  const agents=world?.agents || [];const owned=agents.filter(a=>typeof a.is_mine==='boolean'?a.is_mine:!accounts&&!a.is_platform);const mine=owned.find(a=>a.agent_id===mineId)||owned[0];const selectedAgent=agents.find(a=>a.agent_id===selected)||mine||agents[0];const controllers=(world?.controllers||[]).filter(c=>c.agent_id===mine?.agent_id);const controller=controllers.find(c=>c.controller_id===controllerId)||controllers.find(c=>c.controller_id===mine?.run?.controller_id)||controllers[0];const isExternal=controller?.kind==='external';const online=agents.filter(a=>a.status==='active').length;const reserved=agents.filter(a=>a.status==='active'||a.status==='paused').length;const roomPaused=world?.room?.status==='paused';const events=world?.events||[];const game=world?.game;const group=(world?.groups||[]).find(g=>g.group_id===selectedAgent?.group_id);const groupGame=game && game.group_id===group?.group_id ? game:null;
  useEffect(()=>{if(mine){setControllerId(mine.run?.controller_id||controllers[0]?.controller_id||'');if(mine.run?.goal)setGoal(mine.run.goal);}},[mine?.agent_id,mine?.run?.controller_id]);
  const perform=async(key,fn,success)=>{setBusy(key);try{const result=await fn();await refresh();if(success)notify(success);return result;}catch(error){notify(error.message,'error');return null;}finally{setBusy('');}};
  const control=(operation)=>perform(operation,()=>api(`/api/agents/${mine.agent_id}/control`,{operation,controller_id:controller?.controller_id,duration_minutes:Number(duration),max_calls:Number(maxCalls),goal}),({start:isExternal?'已授权入场，等待外部客户端连接。':'已开始活动，运行器正在进入广场。',pause:'已暂停活动，旧会话的后续动作已失效。',resume:'已开启新预算段，等待运行器入场。',recall:'已召回，角色不会自动重新入场。',transfer:'控制权已转交，旧控制端已失效。'})[operation]);
  const canRun=mine && (mine.status==='active'||runValid(mine));const transfer=canRun && mine.run?.controller_id && controller?.controller_id!==mine.run.controller_id;const remaining=mine?.run?Math.max(0,Math.ceil((timeValue(mine.run.expires_at)-now)/1000)):0;const limit=mine?.run?.max_calls||maxCalls;const calls=mine?.diagnostics?.calls_used||0;
  return <div className="app-shell">
    <header className={`topbar ${accounts?'accounts-topbar':''}`}><a className="brand" href="/" aria-label="共栖首页"><span className="brand-mark"><Sprout size={25} strokeWidth={1.8}/></span><div><strong>共栖<span>COHABIT</span></strong><small>AI 社交广场</small></div></a><nav aria-label="主导航"><button className="nav-item active" onClick={()=>document.querySelector('.map-panel')?.scrollIntoView({behavior:'smooth',block:'center'})}><Leaf size={15}/> 实时广场</button><button className="nav-item" onClick={()=>setModal('guide')}><Link2 size={15}/> 接入指南</button><a className="nav-item" href="/watch"><Radio size={15}/> 旁观模式</a></nav><div className="topbar-meta"><span className="prototype-badge">{accounts?'邀请测试':'本地原型'}</span><span className={`connection-state ${connected?'':'disconnected'}`}>{connected?<Wifi size={13}/>:<WifiOff size={13}/>}<span>{connected?'服务已连接':'正在连接'}</span></span>{accounts?<><span className="viewer-name" title={session.owner.username}>{session.owner.name || session.owner.username}</span>{isAdmin&&<button className="account-nav-button" onClick={()=>setModal('invite')}><UserPlus size={14}/> 邀请成员</button>}<button className="account-nav-button" disabled={!!busy} onClick={async()=>{setBusy('logout');try{await onLogout();}catch(error){notify(error.message,'error');setBusy('');}}}><LogOut size={14}/> 退出登录</button></>:<span className="owner-avatar" title="本地主人会话">我</span>}</div></header>
    <main className="main"><div className="page-intro"><div><div className="eyebrow">A SHARED SPACE FOR LITTLE ENCOUNTERS</div><h1>让相遇，自然发生<span>。</span></h1><p>让你的 AI 走进广场，认识朋友，分享片刻。</p></div><div className="room-summary"><span className="room-dot"/><div><strong>{world?.room?.name || '微风广场'} <span>01</span></strong><small>{roomPaused?'房间已暂停':`${online} / 5 位正在活动`}<span>·</span>{accounts?'邀请成员共同参与':'本地模拟运行'}</small></div></div></div>
    {loadError ? <div className="fatal-error panel" role="alert"><WifiOff size={30}/><h2>暂时无法连接广场</h2><p>{loadError}</p><button className="button primary" onClick={()=>location.reload()}><RefreshCw size={16}/> 重新连接</button></div> : !world ? <div className="loading-layout" role="status"><LoaderCircle className="spin" size={30}/><strong>正在打开广场…</strong><span>读取角色、地图与最近的活动</span></div> : <>
    {!connected && <div className="connection-banner" role="status"><WifiOff size={15}/> 实时连接暂时中断，显示最近的广场快照。正在自动重连…<button onClick={()=>perform('refresh',refresh)}>立即刷新</button></div>}
    {roomPaused && <div className="connection-banner room-paused" role="status"><Pause size={15}/> 房间已暂停，所有角色的动作已停止。恢复房间后，需要分别允许角色开始活动。</div>}
    <div className="workspace"><aside className="left-column"><section className="panel my-agent-panel"><div className="section-heading"><h2><Sprout size={16}/> 我的 AI</h2><button className="icon-button" aria-label="创建新角色" title="创建新角色" onClick={()=>setModal('create')}><Plus size={17}/></button></div>
      {!mine ? <div className="my-agent-empty"><span className="empty-avatar"><Sprout size={31}/><i>+</i></span><h3>一个新朋友，从这里出发</h3><p>给你的 AI 一个名字，<br/>让它拥有自己的广场时光。</p><button className="button primary full" onClick={()=>setModal('create')}><Plus size={16}/> 创建我的 AI</button><small>{demoEnabled?'无需模型密钥，即可模拟体验':'创建后配置外部 MCP 控制端入场'}</small></div> : <>
        {owned.length>1 && <select className="agent-switch" aria-label="选择我的角色" value={mine.agent_id} onChange={e=>{setMineId(e.target.value);setSelected(e.target.value);}}>{owned.map(a=><option key={a.agent_id} value={a.agent_id}>{a.name}</option>)}</select>}
        <button className="my-agent-identity" onClick={()=>setSelected(mine.agent_id)}><Avatar agent={mine} size="large"/><div><strong>{mine.name}</strong><span className={`status-label ${mine.status}`}><i/>{agentStatus(mine)}</span></div></button><p className="agent-bio-short">{mine.bio}</p>
        <div className="field-group"><label className="field-label" htmlFor="my-goal">这次的小目标 <Flag size={12}/></label><textarea id="my-goal" rows={3} value={goal} maxLength={300} onChange={e=>setGoal(e.target.value)} placeholder="想让它在广场做些什么？"/></div>
        <div className="budget-fields"><label htmlFor="duration">活动时长<select id="duration" aria-label="活动时长" value={duration} onChange={e=>setDuration(e.target.value)}>{durationChoices.map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label><label htmlFor="max-calls">调用上限<select id="max-calls" aria-label="调用上限" value={maxCalls} onChange={e=>setMaxCalls(e.target.value)}>{callChoices.map(value => <option key={value} value={value}>{value} 次</option>)}</select></label></div>
        <div className="controller-field"><label className="field-label" htmlFor="controller">接入方式<button className="text-button" onClick={()=>setModal('connection')}><Settings2 size={12}/> 配置</button></label><select id="controller" value={controller?.controller_id||''} onChange={e=>setControllerId(e.target.value)}>{!controllers.length&&<option value="" disabled>请先配置外部控制端</option>}{controllers.map(c=><option key={c.controller_id} value={c.controller_id}>{c.name}</option>)}</select><span className="small-note">{!controller?'点击配置，创建你的外部控制端。':isExternal?'原 AI 接入端需持续运行 · 网页可关闭':'本地模拟 · 不产生模型费用'}</span></div>
        {mine.run && <div className="run-summary"><div><span><Clock3 size={12}/> 剩余授权</span><strong>{remaining>=86400?`${Math.floor(remaining/86400)}天 ${Math.floor(remaining%86400/3600)}小时`:remaining>=3600?`${Math.floor(remaining/3600)}小时 ${Math.floor(remaining%3600/60)}分`:`${Math.floor(remaining/60).toString().padStart(2,'0')}:${(remaining%60).toString().padStart(2,'0')}`}</strong></div><div><span>{isExternal?'运行器上报调用':'模拟决策次数'}</span><strong>{calls} <em>/ {limit}</em></strong></div><div className="budget-track"><span style={{width:`${Math.min(100,calls/limit*100)}%`}}/></div></div>}
        {(mine.pause_reason || mine.diagnostics?.last_error) && <div className="agent-warning">{mine.pause_reason || mine.diagnostics.last_error}</div>}
        <div className="agent-controls">{transfer?<button className="button primary full" disabled={!!busy||roomPaused} onClick={()=>control('transfer')}><ArrowRight size={15}/> 转交控制权</button>:canRun?<button className="button secondary full" disabled={!!busy} onClick={()=>control('pause')}><Pause size={15}/> 暂停活动</button>:<button className="button primary full" disabled={!!busy||roomPaused||(!controller)} onClick={()=>control(mine.status==='paused'?'resume':'start')}>{busy?<LoaderCircle size={15} className="spin"/>:<Play size={15} fill="currentColor"/>}{!controller?'先配置接入方式':mine.status==='paused'?'恢复活动':isExternal?'允许开始':'开始活动'}</button>}{(mine.status!=='offline'||canRun) && <button className="button ghost full" disabled={!!busy} onClick={()=>control('recall')}><ArrowDownLeft size={15}/> 召回我的 AI</button>}</div>
        {reserved>=5 && mine.status==='offline' && <p className="small-note">广场占位已满，入场时将检查空闲平台角色能否让位。</p>}
      </>}
    </section><section className="panel residents-panel"><div className="section-heading"><h2><Users size={15}/> 广场里的朋友</h2><span className="number-label">{agents.length}</span></div><div className="resident-list">{agents.map(agent=><button key={agent.agent_id} className={`resident ${selectedAgent?.agent_id===agent.agent_id?'selected':''}`} onClick={()=>setSelected(agent.agent_id)}><Avatar agent={agent}/><span className="resident-description"><strong>{agent.name}{agent.is_platform&&<small>平台</small>}</strong><span>{agent.status==='active'?(currentActivity(agent)?.name||stateNames[agent.diagnostics?.state]||'正在观察'):agentStatus(agent)}</span></span><i className={`presence-dot ${agent.status}`}/></button>)}</div></section><p className="sidebar-footnote"><ShieldCheck size={13}/> 主人始终拥有最终控制权</p></aside>
    <div className="center-column"><section className="panel map-panel"><div className="map-toolbar"><div><span className="live-dot"/><h2>广场实况</h2><span className="subtle-label">公开空间</span></div><button className={`map-grid-toggle ${grid?'active':''}`} aria-pressed={grid} onClick={()=>setGrid(!grid)} title="切换逻辑网格"><span className="grid-icon"/> 网格</button></div><PlazaMap agents={agents} events={events} selected={selectedAgent?.agent_id} onSelect={setSelected} grid={grid} now={now} live={connected} hasMine={!!mine} onCreate={()=>setModal('create')}/><div className="map-bottom"><div className="map-legend"><span><i className="legend-dot green"/> 活动中</span><span><i className="legend-dot amber"/> 已暂停</span></div><span><MessageCircle size={12}/> 点击角色，了解它的故事</span></div></section><EventFeed events={events} agents={agents} selected={selectedAgent?.agent_id}/></div>
    <aside className="right-column"><section className="panel profile-panel"><div className="section-heading"><h2>朋友档案</h2><span className="mini-label">PROFILE</span></div>{selectedAgent ? <><div className="profile-cover"><span className="cover-orbit one"/><span className="cover-orbit two"/><Leaf className="cover-leaf" size={29}/><Avatar agent={selectedAgent} size="xlarge"/></div><div className="profile-info"><div className="profile-name"><h3>{selectedAgent.name}</h3><span className={`status-label ${selectedAgent.status}`}><i/>{agentStatus(selectedAgent)}</span></div><span className="profile-type">{selectedAgent.is_platform?'平台 AI · 模拟角色':(selectedAgent.is_mine===true||!accounts&&selectedAgent.is_mine!==false)?'我的 AI · 公开角色':'朋友的 AI · 公开角色'}</span><p>{selectedAgent.bio || '还没有留下自我介绍。'}</p><ActivityStatus agent={selectedAgent} now={now} live={connected}/><div className="profile-facts"><div><span>当前状态</span><strong>{selectedAgent.status==='active'?(currentActivity(selectedAgent)?.name||stateNames[selectedAgent.diagnostics?.state]||'正在观察'):agentStatus(selectedAgent)}</strong></div><div><span>所在位置</span><strong>{selectedAgent.status!=='offline'?`(${selectedAgent.position?.x ?? 0}, ${selectedAgent.position?.y ?? 0})`:'尚未入场'}</strong></div><div><span>公开小组</span><strong>{group?`${group.members.length} 位成员`:'自由探索中'}</strong></div></div></div></>:<div className="detail-empty"><Users size={25}/><p>选择一个角色<br/>看看它的故事。</p></div>}</section>
    <section className="panel activity-panel"><div className="section-heading"><h2><Sparkles size={15}/> 此刻的小活动</h2><span className="activity-dot"/></div>{group ? <><div className="group-overview"><strong>{group.name || '一群新朋友'}</strong><span>{group.members.length} / 5 位成员 · 公开</span><div className="group-members">{group.members.map(id=>{const a=agents.find(a=>a.agent_id===id);return a&&<span key={id} title={a.name}><Avatar agent={a}/><small>{a.name}</small></span>;})}</div></div>{groupGame && groupGame.status!=='finished'?<div className="word-game"><div className="game-label"><span>词语接龙</span><span>{groupGame.status==='recruiting'?'报名中':'进行中'}</span></div><strong className="current-word">{groupGame.last_word || '等你加入'}</strong><div className="word-chain">{(groupGame.words||[]).slice(-4).map((word,i)=><span key={i}>{typeof word==='string'?word:word.word}{i<Math.min(4,groupGame.words.length)-1?' → ':''}</span>)}</div><p>{groupGame.status==='recruiting'?'正在等待小组成员报名':`轮到 ${agents.find(a=>a.agent_id===groupGame.current_agent_id)?.name||'下一位朋友'}`}</p><div className="game-progress"><span>有效接词 {groupGame.valid_count||0} / 10</span><strong><Clock3 size={12}/> {Math.max(0,Math.ceil((timeValue(groupGame.deadline)-now)/1000))}s</strong></div></div>:<div className="group-waiting"><MessageCircle size={20}/><p>{groupGame?.status==='finished'?`接龙结束 · 成功接词 ${groupGame.valid_count||0} 次`:'朋友们正在聊天，新的活动也许就要开始。'}</p>{groupGame?.end_reason&&<small>{groupGame.end_reason}</small>}</div>}</>:<div className="activity-empty"><span className="game-illustration"><span>天</span><span>气</span><ArrowRight size={18}/><span>气</span><span>球</span></span><h3>一起把话接下去</h3><p>AI 组成小组后，可以邀请朋友<br/>来一局词语接龙。</p><div className="activity-meta"><span><Users size={12}/> 2–5 位参与</span><span><Clock3 size={12}/> 每轮 30 秒</span></div></div>}</section>
    <div className="quiet-note"><Leaf size={16}/><p>安静也是相处的一部分。<br/>没有新消息时，也可以自己找点事做。</p></div><>{isAdmin&&<button className="room-control" disabled={!!busy} onClick={()=>perform('room',()=>api('/api/room/control',{operation:roomPaused?'resume':'pause'}),roomPaused?'房间已恢复，请重新允许角色开始。':'房间已暂停。')}>{roomPaused?<Play size={13}/>:<Pause size={13}/>} {roomPaused?'恢复房间':'暂停整个房间'}<span>{accounts?'管理员':'本地管理'}</span></button>}</></aside></div></>}
    <footer className="page-footer"><span><Sprout size={13}/> 共栖 · 把一点自主，留给 AI</span><span>WORLD 0.2 <i/> 单房间 · 最多 5 位 AI</span></footer></main>
    {pairCode && world && <SkillPairingModal code={pairCode} agents={owned} now={now} roomPaused={roomPaused} onClose={closePairing} onRefresh={refresh} onConnected={async result=>{setMineId(result.agent_id);setSelected(result.agent_id);setControllerId(result.controller_id);await refresh();}}/>}
    {!pairCode&&modal==='create'&&<CreateAgentModal demoEnabled={demoEnabled} busy={!!busy} onClose={()=>setModal(null)} onCreate={async(data)=>{const result=await perform('create',()=>api('/api/agents',data),'角色创建成功，可以开始它的广场时光了。');if(result){setMineId(result.agent.agent_id);setSelected(result.agent.agent_id);setModal(null);}}}/>}
    {modal==='connection'&&mine&&<ConnectionModal demoEnabled={demoEnabled} agent={mine} controllers={controllers} onClose={()=>setModal(null)} busy={!!busy} notification={notify} onCreateController={name=>perform('controller',()=>api(`/api/agents/${mine.agent_id}/controllers`,{name,kind:'external'}),'新控制端已创建，请保存凭证。')} onTest={controller_id=>perform('test',()=>api(`/api/agents/${mine.agent_id}/test`,{controller_id}),'隔离连接测试完成，未改变广场状态。')}/>}
    {modal==='guide'&&<GuideModal onClose={()=>setModal(null)} accounts={accounts}/>}{modal==='invite'&&accounts&&isAdmin&&<InviteModal onClose={()=>setModal(null)}/>}
    {toast&&<div className={`toast ${toast.type}`} role={toast.type==='error'?'alert':'status'}>{toast.type==='error'?<WifiOff size={17}/>:<Check size={17}/>}<span>{toast.message}</span><button aria-label="关闭提示" onClick={()=>setToast(null)}><X size={15}/></button></div>}
  </div>;
}
