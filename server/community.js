import { randomUUID } from 'node:crypto';
import { COMMUNITY_RULES, COMMUNITY_STATUSES, COMMUNITY_END_REASONS, validCommunity } from '../shared/community.js';
import { findWorldPath, recordMovement, stopMovement, MOVEMENT_RULES } from './spatial.js';
import { pathLength } from '../shared/motion.js';
import { foodUseAvailable, performLife } from './life.js';
import { economyBalance, recordEconomyDelta } from './economy.js';

export { COMMUNITY_RULES };
const copy = value => structuredClone(value);
const text = (value,max=160) => typeof value==='string' ? [...value].slice(0,max).join('') : '';
const time = value => Number.isSafeInteger(value)&&value>=0;
const distance = (a,b) => Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
const failLocal = (code,message) => { throw Object.assign(new Error(message),{code}); };
const venues = COMMUNITY_RULES.venues;
const venueFor = id => venues.find(v=>v.id===id);
const seatFor = id => venues.flatMap(v=>v.seats.map(s=>({...s,venue_id:v.id}))).find(s=>s.id===id);
const records = world => Object.values(world.state.community?.events || {});
const ongoing = event => ['open','active'].includes(event.status);
const permitted = (world,a) => world.state.room.status==='active' && a?.status==='active' && a.run?.status==='active' && a.run.expires_at>world.now()
  && Number.isFinite(a.last_contact_at) && a.last_contact_at+45000>world.now() && world.state.controllers[a.run.controller_id] && !world.state.controllers[a.run.controller_id].revoked;
const binding = a => ({run_id:a.run.run_id,session_epoch:a.session_epoch});
const bound = (world,id,b) => {const a=world.state.agents[id];return permitted(world,a)&&b?.run_id===a.run.run_id&&b.session_epoch===a.session_epoch;};
const near = (a,v,radius=2) => a.scene_id===v.scene_id && !a.home_presence && !a.home_travel && distance(a.position,v.interaction_position)<=radius+1e-8;
const live = (world,event) => ongoing(event)&&event.expires_at>world.now()&&bound(world,event.host_agent_id,event.host_binding);
const publicMemberIds = e => (Array.isArray(e.member_agent_ids)?e.member_agent_ids:[]).filter(id=>typeof id==='string').slice(0,COMMUNITY_RULES.max_participants);

export function publicCommunityEvent(e) {
  if(!e||!COMMUNITY_STATUSES.includes(e.status)||!venueFor(e.venue_id)||e.venue_id==='board'||typeof e.event_id!=='string') return null;
  const members=publicMemberIds(e);
  return {event_id:text(e.event_id),revision:e.revision===1?1:0,venue_id:e.venue_id,title:text(e.title,40),text:text(e.text,200),host_agent_id:text(e.host_agent_id),host_name:text(e.host_name,20),
    status:e.status,member_agent_ids:members,joined_count:members.length,created_at:time(e.created_at)?e.created_at:0,started_at:time(e.started_at)?e.started_at:null,
    expires_at:time(e.expires_at)?e.expires_at:0,ended_at:time(e.ended_at)?e.ended_at:null,end_reason:COMMUNITY_END_REASONS.includes(e.end_reason)?e.end_reason:null};
}
export function communityJob(a) { return a.community_job||null; }
export function publicCommunityJob(a) {
  const j=a.community_job;
  if(!j||!venueFor(j.venue_id)||!['approaching','using'].includes(j.phase)||!['approach','use'].includes(j.kind)) return null;
  return {job_id:text(j.job_id),kind:j.kind,venue_id:j.venue_id,seat_id:seatFor(j.seat_id)?.id||null,scene_id:'plaza',phase:j.phase,activity:['sit','eat','listen','perform'].includes(j.activity)?j.activity:null,
    interaction_position:copy(seatFor(j.seat_id)?.position||venueFor(j.venue_id).interaction_position),started_at:time(j.started_at)?j.started_at:0,use_started_at:time(j.use_started_at)?j.use_started_at:null,ends_at:time(j.ends_at)?j.ends_at:null,expires_at:time(j.expires_at)?j.expires_at:0,
    ...(j.phase==='using'&&j.activity==='eat'?{item_id:j.item_id}:{}),...(j.phase==='using'&&j.activity==='perform'?{title:text(j.title,40),text:text(j.text,400)}:{})};
}
export function publicCommunity(world) {
  return {version:1,venues:venues.map(v=>({...copy(v),seats:v.seats.map(s=>({...copy(s),occupied_by:Object.values(world.state.agents).find(a=>a.community_job?.seat_id===s.id)?.agent_id||null}))})),
    events:records(world).map(publicCommunityEvent).filter(Boolean).sort((a,b)=>Number(ongoing(b))-Number(ongoing(a))||b.created_at-a.created_at||a.event_id.localeCompare(b.event_id))};
}
function announceEvent(world,event,change,actor=null) {
  const names={posted:'发布了活动公告',joined:'报名了活动',left:'离开了活动报名',started:'明确开始了活动',ended:'结束了活动',cancelled:'撤回了活动公告',expired:'活动时间已到',interrupted:'活动因主持许可中断而结束'};
  const who=actor?.name||event.host_name;
  world.event('community_event_changed',{scene_id:'plaza',change,event:publicCommunityEvent(event),agent_id:actor?.agent_id||event.host_agent_id,name:who,text:`${who}：${names[change]}`},world.activeIds());
}
function announceUse(world,a,type,job,extra={}) {
  const publicJob=publicCommunityJob({community_job:job});
  world.event(type,{agent_id:a.agent_id,name:a.name,scene_id:'plaza',...publicJob,...extra},[...new Set([a.agent_id,...world.activeIds()])]);
}
function prune(world) {
  const ended=records(world).filter(e=>!ongoing(e)).sort((a,b)=>b.ended_at-a.ended_at||b.event_id.localeCompare(a.event_id));
  for(const e of ended.slice(COMMUNITY_RULES.max_terminal)) delete world.state.community.events[e.event_id];
}
function finishEvent(world,event,status,reason=status) {
  if(!ongoing(event)) return false;
  event.status=status;event.end_reason=reason;event.ended_at=world.now();announceEvent(world,event,status);prune(world);return true;
}
export function cancelCommunityUse(world,a,reason='cancelled') {
  const j=a.community_job;if(!j)return false;
  if(a.movement?.movement_id===j.movement_id)stopMovement(a,world.now());
  a.community_job=null;
  announceUse(world,a,'community_use_cancelled',j,{reason,text:`${a.name}中断了本次场地活动，下一步由本人决定`});return true;
}
export function endCommunity(world,a,reason='authorization_ended') {
  let changed=cancelCommunityUse(world,a,reason);
  for(const e of records(world)) if(ongoing(e)) {
    if(e.host_agent_id===a.agent_id)changed=finishEvent(world,e,'interrupted',reason==='restarted'?'restarted':'authorization_ended')||changed;
    else if(e.member_agent_ids.includes(a.agent_id)) {
      e.member_agent_ids=e.member_agent_ids.filter(id=>id!==a.agent_id);delete e.member_bindings[a.agent_id];announceEvent(world,e,'left',a);changed=true;
    }
  }
  return changed;
}
export const detachCommunity=endCommunity;
export function initializeCommunity(world,{restore=false}={}) {
  const old=world.state.community;
  if(old!==undefined&&(!old||old.version!==1||!old.events||typeof old.events!=='object'||Array.isArray(old.events)))throw new Error('Invalid community state; preserve database for recovery');
  world.state.community=old||{version:1,events:{}};
  for(const [id,e] of Object.entries(world.state.community.events)) {
    if(!e||e.event_id!==id||e.revision!==1||!COMMUNITY_STATUSES.includes(e.status)||!['picnic','table','stage'].includes(e.venue_id)||!world.state.agents[e.host_agent_id]
      ||!validCommunity({intent:'post',venue_id:e.venue_id,title:e.title,text:e.text,duration_seconds:60})||!time(e.created_at)||!time(e.expires_at)||e.expires_at<=e.created_at||e.expires_at>e.created_at+1800000
      ||!Array.isArray(e.member_agent_ids)||e.member_agent_ids.length>5||!e.member_agent_ids.includes(e.host_agent_id)||new Set(e.member_agent_ids).size!==e.member_agent_ids.length||e.member_agent_ids.some(id=>!world.state.agents[id])
      ||!e.member_bindings||typeof e.member_bindings!=='object'||Array.isArray(e.member_bindings)||Object.keys(e.member_bindings).some(id=>!e.member_agent_ids.includes(id))
      ||e.member_agent_ids.some(id=>!e.member_bindings[id]||typeof e.member_bindings[id].run_id!=='string'||!time(e.member_bindings[id].session_epoch))
      ||!e.host_binding||typeof e.host_binding.run_id!=='string'||!time(e.host_binding.session_epoch)
      ||e.status==='open'&&(e.started_at!==null||e.ended_at!==null||e.end_reason!==null)
      ||e.status==='active'&&(!time(e.started_at)||e.started_at<e.created_at||e.started_at>=e.expires_at||e.ended_at!==null||e.end_reason!==null)
      ||!ongoing(e)&&(!time(e.ended_at)||e.ended_at<e.created_at||!COMMUNITY_END_REASONS.includes(e.end_reason))
      ||e.started_at!==null&&(!time(e.started_at)||e.started_at<e.created_at||e.started_at>=e.expires_at))
      throw new Error('Invalid community event; preserve database for recovery');
  }
  for(const a of Object.values(world.state.agents)) {
    a.community_page=Number.isSafeInteger(a.community_page)&&a.community_page>=0&&a.community_page<10?a.community_page:0;
    if(restore)cancelCommunityUse(world,a,'restarted');else a.community_job??=null;
  }
  if(restore)for(const e of records(world))if(ongoing(e))finishEvent(world,e,'interrupted','restarted');
  prune(world);
}
function idle(world,a,fail) {
  if(!permitted(world,a))fail('STALE_SESSION','当前活动授权不可用');
  if(a.scene_id!=='plaza'||a.home_presence||a.home_travel)fail('SCENE_REQUIRED','公共场地在生活广场，请自行经过入口前往');
  if(a.community_job||a.movement||a.activity||a.fishing||a.ruins_job||a.life?.gathering||a.adventure?.plan||a.survival?.travel||a.adventure?.encounter?.status==='pending'
    ||world.state.game?.status!=='finished'&&world.state.game?.participants?.includes(a.agent_id))fail('ACTIVITY_BUSY','须先自行结束当前行程或活动');
}
function seatAvailable(world,a,seat,fail) {
  if(Object.values(world.state.agents).some(b=>b.agent_id!==a.agent_id&&(b.community_job?.seat_id===seat.id||b.scene_id==='plaza'&&!b.home_presence&&b.status==='active'&&distance(b.position,seat.position)<.1)))fail('COMMUNITY_OCCUPIED','这个座位已有角色或预约，请自行选择其他位置');
}
function shareHeardPerformance(world,actor) {
  const using = (a,activity) => {
    const j=a.community_job;
    return j?.phase==='using' && j.activity===activity && j.venue_id==='stage' && j.ends_at>world.now() && j.expires_at>world.now()
      && bound(world,a.agent_id,j) && a.scene_id==='plaza' && !a.home_presence && !a.movement && distance(a.position,j.interaction_position)<1e-8;
  };
  const actors=Object.values(world.state.agents);
  const performers=using(actor,'perform')?[actor]:using(actor,'listen')?actors.filter(a=>using(a,'perform')):[];
  const listeners=using(actor,'listen')?[actor]:using(actor,'perform')?actors.filter(a=>using(a,'listen')):[];
  // Deliver the actual public work at the two real overlap onsets. This is a
  // targeted world event, not an actor memory, automatic reaction or polling job.
  for(const performer of performers)for(const listener of listeners) {
    const j=performer.community_job;
    world.event('community_heard',{agent_id:listener.agent_id,name:listener.name,performer_agent_id:performer.agent_id,performer_name:performer.name,
      performance_job_id:j.job_id,venue_id:'stage',title:j.title,text:j.text},[listener.agent_id]);
  }
}
function beginUse(world,a,{audit=true}={}) {
  const j=a.community_job;
  if(!j||distance(a.position,j.interaction_position)>1e-8||a.movement)return cancelCommunityUse(world,a,'stopped');
  if(j.kind==='approach') {
    a.community_job=null;announceUse(world,a,'community_arrived',j,{text:`${a.name}已到达${venueFor(j.venue_id).name}，是否使用场地由本人决定`});return true;
  }
  if(world.now()+j.duration_seconds*1000>j.expires_at)return cancelCommunityUse(world,a,'insufficient_time');
  try {
    seatAvailable(world,a,seatFor(j.seat_id),failLocal);
    if(j.activity==='eat') {
      const before=economyBalance(a);performLife(world,a,'inventory',{intent:'use',item_id:j.item_id},failLocal);
      if(audit)recordEconomyDelta(a,before,{source_id:`${j.job_id}:meal`,reason:'community_meal',at:world.now(),world,countProgress:false});
    }
  } catch(error) {return cancelCommunityUse(world,a,error.code||'unavailable');}
  j.phase='using';j.use_started_at=world.now();j.ends_at=world.now()+j.duration_seconds*1000;j.movement_id=null;
  const center=venueFor(j.venue_id).position;
  a.facing=j.activity==='perform'?'south':center.x<a.position.x?'west':center.x>a.position.x?'east':center.y<a.position.y?'north':'south';
  announceUse(world,a,'community_use_started',j,{text:j.activity==='perform'?j.text:`${a.name}在${venueFor(j.venue_id).name}${({sit:'坐下',eat:'吃自己带来的食物',listen:'停留聆听'})[j.activity]}`});shareHeardPerformance(world,a);return true;
}
function queueUse(world,a,p,fail) {
  idle(world,a,fail);
  const seat=p.intent==='use'?seatFor(p.seat_id):null,v=venueFor(seat?.venue_id||p.venue_id),position=seat?.position||v.interaction_position;
  if(seat)seatAvailable(world,a,seat,fail);
  if(p.activity==='eat')foodUseAvailable(a,p.item_id,fail);
  const mode=p.mode||'walk';if(mode==='run'&&a.fatigue.energy<=0)fail('FATIGUE_EXHAUSTED','体力不足以奔跑');
  const path=findWorldPath(world,'plaza',a.position,position);if(!path)fail('UNREACHABLE','场地的实际站位暂时不可达');
  const now=world.now(),duration=p.intent==='use'?(p.duration_seconds||COMMUNITY_RULES.default_use_seconds[p.activity]):0,expires=Math.min(now+COMMUNITY_RULES.max_job_seconds*1000,a.run.expires_at);
  if(now+Math.ceil(pathLength(path)/MOVEMENT_RULES.modes[mode].speed*1000)+duration*1000>expires)fail('INSUFFICIENT_TIME','现有许可不足以走到并完成这次活动，请选择更短时间或其他行动');
  recordMovement(a,path,now,mode);
  const j={job_id:`community_job_${randomUUID()}`,kind:p.intent,venue_id:v.id,seat_id:seat?.id||null,scene_id:'plaza',phase:'approaching',activity:p.activity||null,interaction_position:copy(position),
    started_at:now,use_started_at:null,ends_at:null,expires_at:expires,duration_seconds:duration,movement_id:a.movement?.movement_id||null,run_id:a.run.run_id,session_epoch:a.session_epoch,hp_at_start:a.adventure.hp,hurt_id_at_start:a.hurt?.action_id||null,
    ...(p.item_id?{item_id:p.item_id}:{}),...(p.activity==='perform'?{title:p.title.trim(),text:p.text.trim()}:{})};
  a.community_job=j;announceUse(world,a,'community_approaching',j,{text:`${a.name}选择前往${v.name}`});
  if(!a.movement)beginUse(world,a,{audit:false});
}
function requireEvent(world,p,fail) {
  const e=world.state.community.events[p.event_id];
  if(!e||!live(world,e))fail('COMMUNITY_UNAVAILABLE','这场活动已结束或主持许可不可用');
  if(p.revision!==undefined&&p.revision!==e.revision)fail('COMMUNITY_STALE','活动公告版本已改变，请先重新观察');
  return e;
}
export function performCommunity(world,a,p,fail,actionId) {
  if(!validCommunity(p))fail('INVALID_ACTION','公共场地动作字段无效，请按当前 community 规则明确选择');
  if(!permitted(world,a))fail('STALE_SESSION','当前活动授权不可用');
  if(p.intent==='browse') {
    const pages=Math.max(1,Math.ceil(records(world).filter(ongoing).length/2));if(p.page>=pages)fail('COMMUNITY_PAGE','这一页没有活动公告');a.community_page=p.page;
  } else if(['approach','use'].includes(p.intent))queueUse(world,a,p,fail);
  else if(p.intent==='cancel_use') {if(!a.community_job)fail('NO_COMMUNITY_USE','当前没有场地活动');cancelCommunityUse(world,a);}
  else if(p.intent==='post') {
    idle(world,a,fail);if(!near(a,venueFor('board'),1))fail('NOT_AT_BOARD','须亲自走到活动公告板旁发布');
    if(records(world).some(e=>ongoing(e)&&(e.host_agent_id===a.agent_id||e.venue_id===p.venue_id))||records(world).filter(ongoing).length>=COMMUNITY_RULES.max_active)fail('COMMUNITY_LIMIT','每人和每处场地同时最多一场公告，请自行选择其他场地或等待');
    const now=world.now(),expires=Math.min(now+p.duration_seconds*1000,a.run.expires_at);if(expires-now<60000)fail('INSUFFICIENT_TIME','主持许可剩余不足60秒');
    const e={event_id:`gathering_${randomUUID()}`,revision:1,venue_id:p.venue_id,title:p.title.trim(),text:p.text.trim(),host_agent_id:a.agent_id,host_name:a.name,host_binding:binding(a),member_agent_ids:[a.agent_id],member_bindings:{[a.agent_id]:binding(a)},
      status:'open',created_at:now,started_at:null,expires_at:expires,ended_at:null,end_reason:null};
    world.state.community.events[e.event_id]=e;announceEvent(world,e,'posted',a);
  } else {
    const e=requireEvent(world,p,fail),host=e.host_agent_id===a.agent_id;
    if(p.intent==='join') {
      if(e.member_agent_ids.includes(a.agent_id))fail('COMMUNITY_ALREADY_JOINED','已报名，不会重复参加或自动前往');
      if(e.member_agent_ids.length>=COMMUNITY_RULES.max_participants)fail('COMMUNITY_FULL','活动名额已满');
      e.member_agent_ids.push(a.agent_id);e.member_bindings[a.agent_id]=binding(a);announceEvent(world,e,'joined',a);
    } else if(p.intent==='leave') {
      if(host)fail('COMMUNITY_HOST','主持者可自行 end 或 cancel');
      if(!e.member_agent_ids.includes(a.agent_id))fail('COMMUNITY_NOT_JOINED','本人没有报名这场活动');
      e.member_agent_ids=e.member_agent_ids.filter(id=>id!==a.agent_id);delete e.member_bindings[a.agent_id];announceEvent(world,e,'left',a);
    } else {
      if(!host)fail('COMMUNITY_HOST','只有主持者能开始或结束自己的活动');
      if(p.intent==='start') {
        if(e.status!=='open')fail('COMMUNITY_STARTED','这场活动已经开始');
        if(!near(a,venueFor(e.venue_id),3)||a.movement)fail('NOT_AT_VENUE','主持者须实际到达场地并停下，开始不会替其他角色移动');
        e.status='active';e.started_at=world.now();announceEvent(world,e,'started',a);
      } else if(p.intent==='end') {
        if(e.status!=='active')fail('COMMUNITY_NOT_STARTED','尚未开始的公告可以 cancel');finishEvent(world,e,'ended');
      } else {
        if(e.status!=='open')fail('COMMUNITY_STARTED','已开始的活动可 end');finishEvent(world,e,'cancelled');
      }
    }
  }
  return {community:communityObservation(world,a)};
}
export function tickCommunity(world,survivalFrames=new Map()) {
  let changed=false;const now=world.now();
  for(const e of records(world))if(ongoing(e)) {
    if(e.expires_at<=now)changed=finishEvent(world,e,'expired')||changed;
    else if(!bound(world,e.host_agent_id,e.host_binding))changed=finishEvent(world,e,'interrupted','authorization_ended')||changed;
    else for(const id of [...e.member_agent_ids])if(id!==e.host_agent_id&&!bound(world,id,e.member_bindings[id])) {
      e.member_agent_ids=e.member_agent_ids.filter(member=>member!==id);delete e.member_bindings[id];announceEvent(world,e,'left',world.state.agents[id]);changed=true;
    }
  }
  for(const a of Object.values(world.state.agents)) {
    const j=a.community_job;if(!j)continue;
    const reason=!permitted(world,a)||j.run_id!==a.run?.run_id||j.session_epoch!==a.session_epoch?'permission_ended'
      :a.scene_id!=='plaza'||a.home_presence?'moved'
      :a.adventure.hp<j.hp_at_start||a.hurt&&a.hurt.action_id!==j.hurt_id_at_start||(survivalFrames.get(a.agent_id)?.stop_at??Infinity)<=now?'hurt'
      :a.movement&&a.movement.movement_id!==j.movement_id?'replaced':null;
    if(reason){changed=cancelCommunityUse(world,a,reason)||changed;continue;}
    if(j.phase==='using'&&now>=j.ends_at&&j.ends_at<=j.expires_at) {
      if(distance(a.position,j.interaction_position)>1e-8||a.movement){changed=cancelCommunityUse(world,a,'moved')||changed;continue;}
      a.community_job=null;announceUse(world,a,'community_use_finished',j,{text:j.activity==='perform'?j.text:`${a.name}完成了本次${({sit:'坐下',eat:'用餐',listen:'聆听'})[j.activity]}，下一步由本人决定`});changed=true;
    } else if(now>=j.expires_at)changed=cancelCommunityUse(world,a,'expired')||changed;
    else if(j.phase==='approaching'&&!a.movement)changed=beginUse(world,a)||changed;
  }
  return changed;
}
export function communityObservation(world,a) {
  const publicWorld=publicCommunity(world),events=publicWorld.events.filter(ongoing),pages=Math.max(1,Math.ceil(events.length/2)),page=Math.max(0,Math.min(pages-1,a.community_page||0));
  const own=events.find(e=>e.host_agent_id===a.agent_id)||null,joined=events.filter(e=>e.member_agent_ids.includes(a.agent_id)),opportunities=[];
  const add=p=>opportunities.push({type:'community',payload:p});
  if(permitted(world,a)) {
    for(let n=0;n<pages;n++)add({intent:'browse',page:n});
    if(a.community_job)add({intent:'cancel_use'});
    else try {idle(world,a,failLocal);for(const v of venues)add({intent:'approach',venue_id:v.id});}catch{/* No involuntary travel or replacing current work. */}
    for(const e of events.slice(page*2,page*2+2)) {
      if(e.host_agent_id===a.agent_id) {
        if(e.status==='open'&&near(a,venueFor(e.venue_id),3)&&!a.movement)add({intent:'start',event_id:e.event_id,revision:1});
        add({intent:e.status==='open'?'cancel':'end',event_id:e.event_id});
      } else if(e.member_agent_ids.includes(a.agent_id))add({intent:'leave',event_id:e.event_id});
      else if(e.joined_count<COMMUNITY_RULES.max_participants)add({intent:'join',event_id:e.event_id,revision:1});
    }
  }
  return {version:1,venues:publicWorld.venues,page,total_pages:pages,total_open:events.length,events:events.slice(page*2,page*2+2),own_event:own,joined_events:joined,at_board:near(a,venueFor('board'),1),job:publicCommunityJob(a),opportunities};
}
