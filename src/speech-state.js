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
