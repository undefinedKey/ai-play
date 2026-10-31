import {useEffect,useRef,useState} from 'react';

export function newSoundEvents(events,seen,now,sceneId){
  const next=new Set(),fresh=[];
  for(const event of events||[]){
    const key=event.event_id||`${event.type}:${event.occurred_at}`;next.add(key);
    const at=typeof event.occurred_at==='number'?event.occurred_at:Date.parse(event.occurred_at);
    if(!seen||seen.has(key)||now-at<0||now-at>500||(event.payload?.scene_id??event.scene_id)!==sceneId)continue;
    if(event.type==='adventure_combat'&&event.payload?.damage>0)fresh.push('hit');
    else if(['life_tilled','life_watered','life_harvested','life_crafted','life_tool_repaired'].includes(event.type))fresh.push('work');
  }
  return {seen:next,sounds:fresh.slice(-3)};
}

export function useWorldAudio(world,sceneId,live){
  const[enabled,setEnabled]=useState(false),[unavailable,setUnavailable]=useState(false);
  const context=useRef(null),seen=useRef(null),lastScope=useRef(''),lastTone=useRef(0);
  const tone=kind=>{
    const ctx=context.current;if(!ctx||ctx.state!=='running'||document.hidden)return;
    const now=ctx.currentTime;if(now-lastTone.current<.07)return;lastTone.current=now;
    const oscillator=ctx.createOscillator(),gain=ctx.createGain();
    oscillator.type=kind==='hit'?'triangle':'sine';oscillator.frequency.setValueAtTime(kind==='hit'?170:440,now);oscillator.frequency.exponentialRampToValueAtTime(kind==='hit'?70:280,now+.09);
    gain.gain.setValueAtTime(0,now);gain.gain.linearRampToValueAtTime(.045,now+.008);gain.gain.exponentialRampToValueAtTime(.0001,now+.11);
    oscillator.connect(gain);gain.connect(ctx.destination);oscillator.start(now);oscillator.stop(now+.12);oscillator.onended=()=>{oscillator.disconnect();gain.disconnect();};
  };
  useEffect(()=>{
    const scope=`${sceneId}:${live}:${enabled}`;
    const next=newSoundEvents(world.events,lastScope.current===scope?seen.current:null,Number(world.server_time)||Date.now(),sceneId);
    lastScope.current=scope;seen.current=next.seen;
    if(enabled&&live)next.sounds.forEach(tone);
  },[world.events,world.server_time,sceneId,live,enabled]);
  useEffect(()=>()=>{context.current?.close().catch(()=>{});context.current=null;},[]);
  async function toggle(){
    if(enabled){setEnabled(false);context.current?.suspend().catch(()=>{});return;}
    try{const Audio=window.AudioContext||window.webkitAudioContext;if(!Audio)throw Error('unsupported');context.current??=new Audio();await context.current.resume();seen.current=null;lastScope.current='';setEnabled(true);setUnavailable(false);}catch{setUnavailable(true);setEnabled(false);}
  }
  return {enabled,toggle,unavailable};
}
