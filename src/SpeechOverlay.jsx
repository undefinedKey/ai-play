import React, { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, MessageCircle, X } from 'lucide-react';
import { publicSpeechHistory, speechEventKey, speechPreview, SPEECH_LIFETIME_MS } from './speech-state.js';
import {publicName,recordTime} from './observer-state.js';

const SpeechContext = createContext(null);
function useSpeechControls() {
  const [dismissedIds, setDismissedIds] = useState(() => new Set());
  const [reading, setReading] = useState(null);
  const [seen,setSeen]=useState(()=>new Set()),[filter,setFilter]=useState('all'),[currentKey,setCurrentKey]=useState(null);
  return { dismissedIds, setDismissedIds, reading, setReading,seen,setSeen,filter,setFilter,currentKey,setCurrentKey };
}

// This scope survives the adventure/plaza view switch, but never crosses pages
// or accounts. Closing a receipt in one view also closes it in the other.
export function SpeechOverlayScope({ children, selected }) {
  const controls = useSpeechControls();
  useEffect(() => { controls.setReading(null); }, [selected]);
  return <SpeechContext.Provider value={controls}>{children}</SpeechContext.Provider>;
}

export default function SpeechOverlay({ events = [], agents = [], selected, now = Date.now(), live = true }) {
  const local = useSpeechControls(), shared = useContext(SpeechContext);
  const { dismissedIds, setDismissedIds, reading, setReading,seen,setSeen,filter,setFilter,currentKey,setCurrentKey } = shared || local;
  const root = useRef(null), textId = useId();
  const actualFilter=selected&&(filter!=='group'||agents.find(a=>a.agent_id===selected)?.group_id)?filter:'all';
  const history=publicSpeechHistory({events,agents,selected,filter:actualFilter,now});
  const candidates=history.filter(message=>agents.some(a=>a.agent_id===message.agentId&&a.status==='active')&&now-message.occurredAt<SPEECH_LIFETIME_MS&&!dismissedIds.has(message.key));
  const readingAgent = reading && agents.find(agent => agent.agent_id === reading.agentId && agent.status === 'active');
  const message = readingAgent&&history.some(m=>m.key===reading.key) ? { ...reading, name: readingAgent.name } : candidates.find(m=>m.key===currentKey)||candidates.find(m=>m.agentId===selected)||candidates[0]||null;
  useEffect(()=>{if(message){setCurrentKey(message.key);setSeen(previous=>previous.has(message.key)?previous:new Set([...previous,message.key].slice(-512)));}},[message?.key]);
  const expanded = !!message && reading?.key === message.key && !!readingAgent;
  const preview = message && speechPreview(message.text);
  const returnFocus = () => {
    const panel = root.current?.closest('.map-panel');
    (panel?.querySelector('.map-agent.selected,.adventure-agent.selected') || panel?.querySelector('select[aria-label="观察对象"]') || panel?.querySelector('.map-grid-toggle'))?.focus();
  };
  const close = () => {
    returnFocus();
    // Dismiss the current snapshot, so an older queued line does not immediately
    // replace a deliberately closed window. A new event can open it again.
    setDismissedIds(previous => new Set([...previous, ...events.map(speechEventKey), message?.key].filter(Boolean).slice(-512)));
    setReading(null);
  };
  const unread=history.filter(m=>!seen.has(m.key)).length;
  const markHistory=()=>setSeen(previous=>new Set([...previous,...history.map(m=>m.key)].slice(-512)));
  return <><div className="public-message-tray" data-testid="public-message-tray"><label>公开消息<select aria-label="公开消息范围" value={actualFilter} onChange={event=>{setFilter(event.target.value);setReading(null);setCurrentKey(null);}}><option value="all">所有角色</option><option value="selected" disabled={!selected}>所选角色</option><option value="group" disabled={!selected||!agents.find(a=>a.agent_id===selected)?.group_id}>所选角色的小组</option></select></label><details onToggle={event=>{if(event.currentTarget.open)markHistory();}}><summary>消息记录 <span data-testid="speech-unread">{unread?`${unread} 条未读`:history.length?`${history.length} 条记录`:'暂无发言'}</span></summary><ul className="public-message-history" aria-label="公开发言历史">{history.map(m=><li key={m.key}><details><summary><strong>{publicName(agents.find(a=>a.agent_id===m.agentId)||{name:m.name},agents)}</strong> · {m.channel==='group'?'公开小组':'公开附近'}<time>{recordTime(m.occurredAt,now)}</time><span>{speechPreview(m.text,64).text}</span></summary><p>{m.text}</p></details></li>)}</ul>{!history.length&&<p>这个范围还没有公开发言。</p>}</details></div>{message&&<section ref={root} className={`speech-window ${expanded ? 'expanded' : ''} ${live ? '' : 'recorded'}`} data-testid="speech-window" data-event-id={message.eventId || message.key} data-agent-id={message.agentId} aria-label="公开发言小窗口" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}>
    <div className="speech-window-content" role="status" aria-live="polite" aria-atomic="true">
      <div className="speech-window-heading"><MessageCircle size={14} aria-hidden="true"/><strong>{publicName(agents.find(a=>a.agent_id===message.agentId)||{name:message.name},agents)}</strong><span>{message.channel === 'group' ? '公开小组' : '公开附近'}</span></div>
      {!live && <p className="speech-window-recorded">最近收到的发言 · 非实时</p>}
      <p id={textId} className="speech-window-text" tabIndex={expanded ? 0 : undefined} aria-label={expanded ? `${message.name}的完整公开发言` : undefined}>{expanded ? message.text : preview.text}</p>
    </div>
    <div className="speech-window-actions">
      {preview.truncated && <button type="button" aria-expanded={expanded} aria-controls={textId} onClick={() => { if (expanded) { if (now - message.occurredAt >= SPEECH_LIFETIME_MS) returnFocus(); setReading(null); } else setReading(message); }}>{expanded ? <ChevronUp size={14} aria-hidden="true"/> : <ChevronDown size={14} aria-hidden="true"/>}{expanded ? '收起发言' : '展开全文'}</button>}
      {expanded && <span>正在阅读</span>}
      {candidates.length>1&&<button type="button" onClick={()=>{setDismissedIds(previous=>new Set([...previous,message.key]));setReading(null);setCurrentKey(null);}}>下一条 · {candidates.length-1} 条待看</button>}
      <button type="button" className="speech-window-close" onClick={close} aria-label="关闭发言窗口"><X size={14} aria-hidden="true"/>关闭</button>
    </div>
  </section>}</>;
}
