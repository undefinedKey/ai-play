export function presenceState(agent) { return agent?.presence?.state || (agent?.run?.status==='paused'?'paused':agent?.status) || 'unknown'; }
export function presenceLabel(agent) {
  if (!agent) return '世界概况';
  const state=presenceState(agent);
  if(state==='active')return '活动中';
  if(state==='paused')return '已暂停';
  if(state==='never_joined'||agent.presence?.has_joined===false)return '从未入场';
  if(state==='offline'||agent.presence?.has_joined===true)return '已离线';
  return '在场情况未知';
}
export function chooseObserver(agents, selected) {
  if(selected==='')return null;
  return agents.find(agent=>agent.agent_id===selected) || agents.find(agent=>agent.status==='active') || null;
}
export function shortIdentity(agent) { return String(agent?.agent_id || '').replace(/^agent_/,'').replace(/-/g,'').slice(0,6); }
export function publicName(agent, agents=[]) {
  return agent ? `${agent.name}${agents.filter(item=>item.name===agent.name).length>1 ? ` · ${shortIdentity(agent)}` : ''}` : '世界概况';
}
export function recordTime(value, now=Date.now()) {
  const at=typeof value==='number'?value:Date.parse(value||'');
  if(!Number.isFinite(at)||at<=0)return '时间未记录';
  const age=Math.max(0,Math.floor((now-at)/1000));
  const relative=age<60?'刚刚':age<3600?`${Math.floor(age/60)} 分钟前`:age<86400?`${Math.floor(age/3600)} 小时前`: `${Math.floor(age/86400)} 天前`;
  return `${new Date(at).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})} · ${relative}`;
}
export function nearbySlots(agents) {
  const slots=new Map();
  for(const agent of agents){const key=`${agent.position?.x},${agent.position?.y}`;const occupants=agents.filter(a=>`${a.position?.x},${a.position?.y}`===key);const index=occupants.findIndex(a=>a.agent_id===agent.agent_id);slots.set(agent.agent_id,{x:(index%3-Math.min(occupants.length-1,2)/2)*48,y:Math.floor(index/3)*54});}
  return slots;
}
