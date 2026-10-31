import React,{createContext,useContext,useEffect,useId,useRef,useState} from 'react';
import {ChevronDown,ChevronUp,X} from 'lucide-react';
import {activeSpeeches,placeSpeechClouds,publicSpeechHistory,speechPreview} from './speech-state.js';
import {publicName,recordTime,shortIdentity} from './observer-state.js';

const SpeechContext=createContext(null);
function useSpeechControls(){
  const[dismissedIds,setDismissedIds]=useState(()=>new Set()),[reading,setReading]=useState({});
  const[seen,setSeen]=useState(()=>new Set()),[filter,setFilter]=useState('all');
  return{dismissedIds,setDismissedIds,reading,setReading,seen,setSeen,filter,setFilter};
}
// Scope persists across map switches. History never replays a live receipt.
export function SpeechOverlayScope({children}){const value=useSpeechControls();return <SpeechContext.Provider value={value}>{children}</SpeechContext.Provider>;}
function useControls(){const local=useSpeechControls();return useContext(SpeechContext)||local;}

export function SpeechBubbles({events=[],agents=[],selected,now=Date.now(),live=true,sceneId}){
  const{dismissedIds,setDismissedIds,reading,setReading,setSeen}=useControls();
  const layer=useRef(null),[layout,setLayout]=useState([]),id=useId();
  const messages=activeSpeeches({events,agents,now,dismissedIds,reading,sceneId});
  const signature=messages.map(m=>`${m.key}:${m.expanded}:${m.newer}`).join('|');
  const state=useRef();state.current={messages,selected};
  useEffect(()=>{
    const root=layer.current,frame=root?.parentElement;
    if(!frame||!messages.length){setLayout(previous=>previous.length?[]:previous);return;}
    let handle=0,stopped=false,last='',previousAt=0;
    const measure=at=>{
      if(stopped||document.hidden)return;
      // Actual rectangles include camera zoom, CSS movement, sprite scale and slots.
      if(at-previousAt>=30){
        previousAt=at;
        const bounds=frame.getBoundingClientRect(),items=[];
        for(const message of state.current.messages){
          const actor=[...frame.querySelectorAll('[data-speech-agent]')].find(el=>el.dataset.speechAgent===message.agentId);
          const anchor=actor?.querySelector('.pixel-character'),cloud=[...root.querySelectorAll('[data-cloud-key]')].find(el=>el.dataset.cloudKey===message.key);
          if(!anchor||!cloud)continue;
          const rect=anchor.getBoundingClientRect();
          const headX=rect.x+rect.width/2-bounds.x,headY=rect.y-bounds.y+Math.min(10,rect.height*.12);
          if(headX<0||headX>bounds.width||rect.bottom<=bounds.top||rect.top>=bounds.bottom)continue;
          const w=Math.min(message.expanded?330:messages.length>2?Math.min(142,(bounds.width-22)/3):180,bounds.width-12);
          if(cloud.style.width!==`${w}px`)cloud.style.width=`${w}px`;
          items.push({key:message.key,headX,headY:Math.max(3,Math.min(bounds.height-3,headY)),w,h:cloud.getBoundingClientRect().height,expanded:message.expanded,selected:message.agentId===state.current.selected});
        }
        items.sort((a,b)=>Number(b.expanded)-Number(a.expanded)||Number(b.selected)-Number(a.selected)||a.headX-b.headX||a.key.localeCompare(b.key));
        const next=placeSpeechClouds(items,bounds.width,bounds.height).map(p=>({...p,x:Math.round(p.x),y:Math.round(p.y),headX:Math.round(p.headX),headY:Math.round(p.headY)}));
        const key=JSON.stringify(next);if(key!==last){last=key;setLayout(next);}
      }
      handle=requestAnimationFrame(measure);
    };
    const resume=()=>{cancelAnimationFrame(handle);if(!document.hidden)handle=requestAnimationFrame(measure);};
    const observer=new ResizeObserver(resume);observer.observe(frame);
    document.addEventListener('visibilitychange',resume);resume();
    return()=>{stopped=true;cancelAnimationFrame(handle);observer.disconnect();document.removeEventListener('visibilitychange',resume);};
  },[signature]);
  const mark=message=>setSeen(previous=>previous.has(message.key)?previous:new Set([...previous,message.key].slice(-512)));
  const returnFocus=agentId=>{
    const frame=layer.current?.parentElement;
    const actor=[...(frame?.querySelectorAll('[data-speech-agent]')||[])].find(el=>el.dataset.speechAgent===agentId);
    (actor?.matches('button')?actor:frame?.closest('.map-panel')?.querySelector('select[aria-label="观察对象"], [data-testid="observer-selection"]'))?.focus();
  };
  const close=message=>{returnFocus(message.agentId);setDismissedIds(previous=>new Set([...previous,message.key].slice(-512)));setReading(previous=>{const next={...previous};delete next[message.agentId];return next;});mark(message);};
  return <div ref={layer} className="head-speech-layer" data-testid="head-speech-layer">
    <svg className="speech-leaders" aria-hidden="true">{layout.map(p=><g key={p.key}><path d={`M ${Math.max(p.x+10,Math.min(p.x+p.w-10,p.headX))-3} ${p.headY>p.y+p.h/2?p.y+p.h-3:p.y+3} L ${p.headX} ${p.headY} L ${Math.max(p.x+10,Math.min(p.x+p.w-10,p.headX))+3} ${p.headY>p.y+p.h/2?p.y+p.h-3:p.y+3} Z`} /><circle cx={p.headX} cy={p.headY} r="2.5"/></g>)}</svg>
    {messages.map(message=>{
      const point=layout.find(p=>p.key===message.key),preview=speechPreview(message.text,messages.length>2?8:18),expanded=!!message.expanded,textId=`${id}-${message.agentId}`;
      return <section key={message.agentId} className={`head-speech-cloud ${messages.length>2?"crowded":""} ${expanded?'expanded':''} ${live?'':'recorded'}`} data-testid="speech-cloud" data-cloud-key={message.key} data-event-id={message.eventId||message.key} data-agent-id={message.agentId} data-head-x={point?.headX} data-head-y={point?.headY} style={{left:point?.x||0,top:point?.y||0,width:point?.w||180,visibility:point?'visible':'hidden',zIndex:expanded?4:2}} aria-label={`${publicName(agents.find(a=>a.agent_id===message.agentId),agents)}的公开${message.channel==='group'?'小组':'附近'}发言`} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(message);}}}>
        <div className="cloud-heading"><strong title={publicName(agents.find(a=>a.agent_id===message.agentId),agents)}>{message.name}</strong>{agents.filter(a=>a.name===message.name).length>1&&<small className="cloud-short-id">{shortIdentity({agent_id:message.agentId})}</small>}<button aria-label={`关闭${message.name}的发言气泡`} onClick={()=>close(message)}><X size={13}/></button></div>
        {!live&&<span className="cloud-recorded">最近收到 · 非实时</span>}
        {!expanded&&messages.length>2?<button className="cloud-preview" aria-label={`展开${message.name}的完整公开发言`} aria-expanded={false} aria-controls={textId} onClick={()=>{mark(message);setReading(previous=>({...previous,[message.agentId]:message}));}}><span id={textId} className="cloud-text">{preview.text}</span><ChevronDown size={12}/></button>:<p id={textId} className="cloud-text" tabIndex={expanded?0:undefined}>{expanded?message.text:preview.text}</p>}
        <div className="cloud-footer"><span>{message.channel==='group'?'公开小组':'公开附近'}</span>{preview.truncated&&<button aria-controls={textId} aria-expanded={expanded} onClick={()=>{mark(message);setReading(previous=>{const next={...previous};if(expanded)delete next[message.agentId];else next[message.agentId]=message;return next;});}}>{expanded?<ChevronUp size={12}/>:<ChevronDown size={12}/>} {expanded?'收起':'展开'}</button>}</div>
        {expanded&&message.newer&&<span className="cloud-newer">该角色又有新发言，收起后可读</span>}
      </section>;
    })}
  </div>;
}

export default function SpeechOverlay({events=[],agents=[],selected,now=Date.now()}){
  const{seen,setSeen,filter,setFilter}=useControls();
  const actualFilter=selected&&(filter!=='group'||agents.find(a=>a.agent_id===selected)?.group_id)?filter:'all';
  const history=publicSpeechHistory({events,agents,selected,filter:actualFilter,now});
  const unread=history.filter(m=>!seen.has(m.key)).length;
  const markHistory=()=>setSeen(previous=>new Set([...previous,...history.map(m=>m.key)].slice(-512)));
  return <div className="public-message-tray" data-testid="public-message-tray"><label>公开消息<select aria-label="公开消息范围" value={actualFilter} onChange={event=>setFilter(event.target.value)}><option value="all">所有角色</option><option value="selected" disabled={!selected}>所选角色</option><option value="group" disabled={!selected||!agents.find(a=>a.agent_id===selected)?.group_id}>所选角色的小组</option></select></label><details onToggle={event=>{if(event.currentTarget.open)markHistory();}}><summary>消息记录 <span data-testid="speech-unread">{unread?`${unread} 条未读`:history.length?`${history.length} 条记录`:'暂无发言'}</span></summary><ul className="public-message-history" aria-label="公开发言历史">{history.map(m=><li key={m.key}><details><summary><strong>{publicName(agents.find(a=>a.agent_id===m.agentId)||{name:m.name},agents)}</strong> · {m.channel==='group'?'公开小组':'公开附近'}<time>{recordTime(m.occurredAt,now)}</time><span>{speechPreview(m.text,64).text}</span></summary><p>{m.text}</p></details></li>)}</ul>{!history.length&&<p>这个范围还没有公开发言。</p>}</details></div>;
}
