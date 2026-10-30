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
    .map(event=>({key:speechEventKey(event),eventId:event.event_id,agentId:event.payload.agent_id,groupId:event.payload.group_id,name:agents.find(a=>a.agent_id===event.payload.agent_id)?.name||'历史角色',channel:event.payload.channel,text:event.payload.text,occurredAt:at(event.occurred_at)})).reverse().sort((a,b)=>b.occurredAt-a.occurredAt).slice(0,70);
}
