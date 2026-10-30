import React, { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, MessageCircle, X } from 'lucide-react';
import { selectPublicSpeech, speechEventKey, speechPreview, SPEECH_LIFETIME_MS } from './speech-state.js';

const SpeechContext = createContext(null);
function useSpeechControls() {
  const [dismissedIds, setDismissedIds] = useState(() => new Set());
  const [reading, setReading] = useState(null);
  return { dismissedIds, setDismissedIds, reading, setReading };
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
  const { dismissedIds, setDismissedIds, reading, setReading } = shared || local;
  const root = useRef(null), textId = useId();
  const readingAgent = reading && agents.find(agent => agent.agent_id === reading.agentId && agent.status === 'active');
  const message = readingAgent ? { ...reading, name: readingAgent.name } : selectPublicSpeech({ events, agents, selected, now, dismissedIds });
  const expanded = !!message && reading?.key === message.key && !!readingAgent;
  const preview = message && speechPreview(message.text);
  const returnFocus = () => {
    const panel = root.current?.closest('.map-panel');
    (panel?.querySelector('.map-agent.selected,.adventure-agent.selected') || panel?.querySelector('.map-grid-toggle'))?.focus();
  };
  const close = () => {
    returnFocus();
    // Dismiss the current snapshot, so an older queued line does not immediately
    // replace a deliberately closed window. A new event can open it again.
    setDismissedIds(previous => new Set([...previous, ...events.map(speechEventKey), message?.key].filter(Boolean).slice(-512)));
    setReading(null);
  };
  if (!message) return null;
  return <section ref={root} className={`speech-window ${expanded ? 'expanded' : ''} ${live ? '' : 'recorded'}`} data-testid="speech-window" data-event-id={message.eventId || message.key} data-agent-id={message.agentId} aria-label="公开发言小窗口" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}>
    <div className="speech-window-content" role="status" aria-live="polite" aria-atomic="true">
      <div className="speech-window-heading"><MessageCircle size={14} aria-hidden="true"/><strong>{message.name}</strong><span>{message.channel === 'group' ? '公开小组' : '公开附近'}</span></div>
      {!live && <p className="speech-window-recorded">最近收到的发言 · 非实时</p>}
      <p id={textId} className="speech-window-text" tabIndex={expanded ? 0 : undefined} aria-label={expanded ? `${message.name}的完整公开发言` : undefined}>{expanded ? message.text : preview.text}</p>
    </div>
    <div className="speech-window-actions">
      {preview.truncated && <button type="button" aria-expanded={expanded} aria-controls={textId} onClick={() => { if (expanded) { if (now - message.occurredAt >= SPEECH_LIFETIME_MS) returnFocus(); setReading(null); } else setReading(message); }}>{expanded ? <ChevronUp size={14} aria-hidden="true"/> : <ChevronDown size={14} aria-hidden="true"/>}{expanded ? '收起发言' : '展开全文'}</button>}
      {expanded && <span>正在阅读</span>}
      <button type="button" className="speech-window-close" onClick={close} aria-label="关闭发言窗口"><X size={14} aria-hidden="true"/>关闭</button>
    </div>
  </section>;
}
