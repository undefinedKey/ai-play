export const SPEECH_LIFETIME_MS = 18_000;
const at = value => typeof value === 'number' ? value : Date.parse(value || '');

export function speechEventKey(event) {
  if (event?.event_id != null) return `event:${event.event_id}`;
  const p = event?.payload || {};
  return JSON.stringify([event?.type, event?.occurred_at, p.agent_id, p.channel, p.text]);
}

/** Only confirmed, public speech is eligible. System text is never dialogue. */
export function selectPublicSpeech({ events = [], agents = [], selected, now = Date.now(), dismissedIds = new Set() }) {
  const active = new Map(agents.filter(agent => agent.status === 'active').map(agent => [agent.agent_id, agent]));
  const messages = [];
  for (const event of events) {
    const p = event?.payload;
    if (!['message', 'say', 'chat'].includes(event?.type) || !['nearby', 'group'].includes(p?.channel) || typeof p?.text !== 'string' || !p.text.trim()) continue;
    const agent = active.get(p.agent_id), occurredAt = at(event.occurred_at), key = speechEventKey(event);
    if (!agent || !Number.isFinite(occurredAt) || occurredAt > now || now - occurredAt >= SPEECH_LIFETIME_MS || dismissedIds.has(key)) continue;
    messages.push({ key, eventId: event.event_id, agentId: agent.agent_id, name: agent.name, channel: p.channel, text: p.text, occurredAt });
  }
  // Stable sort retains event order; reversing first makes equal timestamps pick
  // the latest receipt, as the server can deliver several events in one tick.
  messages.reverse().sort((a, b) => b.occurredAt - a.occurredAt);
  return messages.find(message => message.agentId === selected) || messages[0] || null;
}

export function speechPreview(text, limit = 92) {
  const compact = text.trim().replace(/\s+/gu, ' '), points = Array.from(compact);
  return { text: points.length > limit ? `${points.slice(0, limit).join('')}…` : compact, truncated: points.length > limit || text.split('\n').length > 3 };
}

export function publicSpeechHistory({events=[],agents=[],selected,filter='all',now=Date.now()}) {
  const chosen=agents.find(a=>a.agent_id===selected);
  return events.filter(event=>['message','say','chat'].includes(event?.type)&&['nearby','group'].includes(event.payload?.channel)&&typeof event.payload?.text==='string'&&event.payload.text.trim()&&Number.isFinite(at(event.occurred_at))&&at(event.occurred_at)<=now)
    .filter(event=>filter==='selected'?event.payload.agent_id===selected:filter==='group'?chosen?.group_id&&event.payload.channel==='group'&&event.payload.group_id===chosen.group_id:true)
    .map(event=>({key:speechEventKey(event),eventId:event.event_id,agentId:event.payload.agent_id,sceneId:event.payload.scene_id??event.scene_id,groupId:event.payload.group_id,name:agents.find(a=>a.agent_id===event.payload.agent_id)?.name||'历史角色',channel:event.payload.channel,text:event.payload.text,occurredAt:at(event.occurred_at)})).reverse().sort((a,b)=>b.occurredAt-a.occurredAt).slice(0,70);
}

/** Newest receipt per active actor; reading history never enters this selector. */
export function activeSpeeches({events=[],agents=[],now=Date.now(),dismissedIds=new Set(),reading={},sceneId}) {
  const active=new Map(agents.filter(a=>(a.presence?.state||a.status)==='active').map(a=>[a.agent_id,a]));
  const latest=new Map();
  for(const message of publicSpeechHistory({events,agents,now}))if(active.has(message.agentId)&&(!sceneId||(message.sceneId===sceneId&&active.get(message.agentId).scene_id===sceneId))&&!latest.has(message.agentId))latest.set(message.agentId,message);
  return [...latest.values()].flatMap(message=>{
    const held=reading[message.agentId];
    if(held&&(!sceneId||held.sceneId===sceneId)&&!dismissedIds.has(held.key))return [{...held,name:active.get(message.agentId).name,expanded:true,newer:held.key!==message.key}];
    return now-message.occurredAt<SPEECH_LIFETIME_MS&&!dismissedIds.has(message.key)?[message]:[];
  });
}

/** Bounded screen-space placement. The tail still ends at the measured head. */
export function placeSpeechClouds(items,width,height) {
  const margin=6,gap=5,placed=[];
  const overlap=(a,b)=>Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));
  for(const item of items){
    const w=Math.min(item.w,width-margin*2),h=Math.min(item.h,height-margin*2);
    const bound=(x,y)=>({x:Math.max(margin,Math.min(width-w-margin,x)),y:Math.max(margin,Math.min(height-h-margin,y)),w,h});
    const dense=items.length>2&&!items.some(p=>p.expanded);
    const options=dense?[]:[bound(item.headX-w/2,item.headY-h-13)];
    if(dense){for(let x=margin;x<=width-w-margin+1;x+=w+gap)for(const y of [item.headY-h-13,margin,height-h-margin,...items.map(p=>p.headY+36)])options.push(bound(x,y));}
    else for(let row=0;row<4;row++)for(const side of [0,-1,1])options.push(bound(item.headX-w/2+side*(w+gap),item.headY-h-13-row*(h+gap)));
    // Crowded corners can use available space below the heads, with a visible leader.
    for(let y=margin;y<=height-h-margin+1;y+=h+gap)for(let x=margin;x<=width-w-margin+1;x+=w+gap)options.push(bound(x,y));
    const score=p=>placed.reduce((sum,q)=>sum+overlap(p,{...q,x:q.x-gap,y:q.y-gap,w:q.w+gap*2,h:q.h+gap*2})*1000,0)+items.reduce((sum,q)=>sum+overlap(p,{x:q.headX-17,y:q.headY-4,w:34,h:34})*2000,0)+Math.abs(p.x+w/2-item.headX)+Math.abs(p.y+h-item.headY)*1.2;
    options.sort((a,b)=>score(a)-score(b));
    placed.push({...item,...options[0]});
  }
  if(items.length>2&&!items.some(item=>item.expanded)&&placed.some((p,i)=>placed.slice(i+1).some(q=>overlap(p,q)>0))){
    const cellW=Math.max(...placed.map(p=>p.w)),cellH=Math.max(...placed.map(p=>p.h));
    const columns=Math.max(1,Math.floor((width-margin*2+gap)/(cellW+gap))),rows=Math.ceil(items.length/columns);
    if(rows*(cellH+gap)-gap<=height-margin*2){
      const top=Math.max(margin,Math.min(height-margin-rows*(cellH+gap)+gap,items.reduce((sum,p)=>sum+p.headY,0)/items.length-rows*(cellH+gap)));
      return placed.map((p,i)=>({...p,x:margin+(i%columns)*(cellW+gap),y:top+Math.floor(i/columns)*(cellH+gap)}));
    }
  }
  return placed;
}
