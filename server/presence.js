const time = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

export function initializePresence(agent, { legacy = false, events = [] } = {}) {
  if (agent.presence_record?.version === 1) return;
  // Retained events are not a complete history: absence is never evidence that
  // an old resident has never visited, nor that the oldest retained join is first.
  const joined = agent.run?.has_joined === true || agent.status === 'active' || time(agent.last_contact_at) !== null || events.some(event => event.type === 'agent_joined' && event.payload?.agent_id === agent.agent_id);
  agent.presence_record = { version: 1, has_joined: legacy ? (joined ? true : null) : false,
    first_joined_at: null, last_seen_at: time(agent.last_contact_at), last_departed_at: null };
}

export function seenPresence(agent, now, { joined = false } = {}) {
  initializePresence(agent, { legacy: true });
  if (joined) {
    if (agent.presence_record.has_joined === false) agent.presence_record.first_joined_at = now;
    agent.presence_record.has_joined = true;
  }
  agent.presence_record.last_seen_at = now;
}

export function departPresence(agent, now) {
  if (agent.status === 'active') {
    initializePresence(agent, { legacy: true });
    agent.presence_record.last_departed_at = now;
  }
}

export function publicPresence(agent) {
  const record = agent.presence_record || {};
  const joined = typeof record.has_joined === 'boolean' ? record.has_joined : null;
  return { state: agent.status === 'active' ? 'active' : agent.run?.status === 'paused' || agent.status === 'paused' ? 'paused' : joined === false ? 'never_joined' : joined === true ? 'offline' : 'unknown',
    has_joined: joined, first_joined_at: time(record.first_joined_at), last_seen_at: time(record.last_seen_at), last_departed_at: time(record.last_departed_at) };
}
