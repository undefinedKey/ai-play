import { GAME_END_REASONS, gameName, publicChoices, publicGame } from './games.js';

const string = value => typeof value === 'string' ? value : undefined;
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
const position = value => value && typeof value === 'object' ? { x: number(value.x), y: number(value.y) } : null;
const scores = (value, agentIds) => Object.fromEntries(Object.entries(value || {}).filter(([id, score]) => agentIds.has(id) && typeof score === 'number' && Number.isFinite(score)));
const task = value => value ? { kind: string(value.kind), prompt: string(value.prompt), answer_type: string(value.answer_type) } : undefined;
const activity = value => value ? { activity_id: string(value.activity_id), name: string(value.name), place_id: string(value.place_id), started_at: number(value.started_at), ends_at: number(value.ends_at), ...(value.task ? { task: task(value.task) } : {}), ...(value.target ? { target: position(value.target) } : {}), ...(value.progress ? { progress: { collected: number(value.progress.collected), total: number(value.progress.total) } } : {}) } : null;
const activityResult = value => value ? { summary: string(value.summary), ...(number(value.score) !== undefined ? { score: number(value.score) } : {}), ...(number(value.max_score) !== undefined ? { max_score: number(value.max_score) } : {}) } : undefined;
const publicEventFields = {
  server_restarted: ['text'], room_state: ['text', 'status'],
  agent_joined: ['agent_id', 'name', 'text'], agent_left: ['agent_id', 'text'], agent_offline: ['agent_id', 'text'],
  agent_moved: ['agent_id', 'text', 'position'],
  activity_started: ['agent_id', 'name', 'activity_id', 'activity_name', 'place_id', 'started_at', 'ends_at', 'text'],
  activity_finished: ['agent_id', 'name', 'activity_id', 'activity_name', 'place_id', 'started_at', 'ends_at', 'text', 'outcome', 'result'],
  treasure_collected: ['agent_id', 'name', 'collected', 'total', 'text'],
  message: ['agent_id', 'name', 'text', 'channel', 'group_id'],
  group_created: ['agent_id', 'group_id', 'text'], group_joined: ['agent_id', 'group_id', 'text'], group_left: ['agent_id', 'group_id', 'text'],
  game_proposed: ['agent_id', 'game_id', 'group_id', 'game_type', 'text'], game_registered: ['agent_id', 'game_id', 'text'],
  game_started: ['game_id', 'group_id', 'game_type', 'word', 'text'], game_turn: ['game_id', 'agent_id', 'game_type', 'deadline', 'last_word', 'round', 'text'],
  game_timeout: ['agent_id', 'game_id', 'text'], word_submitted: ['agent_id', 'game_id', 'word', 'text', 'valid_count'],
  move_submitted: ['agent_id', 'game_id', 'text'], round_revealed: ['game_id', 'round', 'choices', 'scores', 'text'],
  story_submitted: ['agent_id', 'game_id', 'text', 'segment_count'],
  game_finished: ['game_id', 'group_id', 'game_type', 'valid_count', 'scores'],
};
function publicEvent(event, agentIds) {
  if (!Object.hasOwn(publicEventFields, event.type)) return null;
  const fields = publicEventFields[event.type];
  const raw = event.payload || {};
  if (event.type === 'message' && !['nearby', 'group'].includes(raw.channel)) return null;
  const payload = {};
  for (const key of fields) {
    const value = key === 'position' ? position(raw[key]) : key === 'scores' ? scores(raw[key], agentIds) : key === 'choices' ? publicChoices(raw[key], agentIds) : key === 'result' ? activityResult(raw[key]) : key === 'outcome' ? (['completed', 'cancelled'].includes(raw[key]) ? raw[key] : undefined) : ['deadline', 'valid_count', 'started_at', 'ends_at', 'round', 'segment_count', 'collected', 'total'].includes(key) ? number(raw[key]) : string(raw[key]);
    if (value !== undefined) payload[key] = value;
  }
  if (event.type === 'game_finished') {
    if (GAME_END_REASONS.has(raw.reason)) payload.reason = raw.reason;
    payload.text = payload.reason ? `${gameName(raw.game_type)}结束：${payload.reason}` : `${gameName(raw.game_type)}已结束`;
  }
  return { event_id: string(event.event_id), type: event.type, occurred_at: number(event.occurred_at), cursor: string(event.cursor), world_revision: number(event.world_revision), payload };
}

/** Never reuse owner/publicSnapshot here: their events include control and invitation metadata. */
export function spectatorSnapshot(world) {
  const { room, agents, groups, game, events } = world.state;
  const catalog = world.getRules();
  const agentIds = new Set(Object.keys(agents));
  const recentEvents = [];
  for (let i = events.length - 1; i >= 0 && recentEvents.length < 150; i--) {
    const event = publicEvent(events[i], agentIds);
    if (event) recentEvents.push(event);
  }
  return {
    room: { id: string(room.id), name: string(room.name), status: string(room.status), capacity: number(room.capacity), width: number(room.width), height: number(room.height), world_revision: number(room.world_revision) },
    agents: Object.values(agents).map(agent => ({ agent_id: string(agent.agent_id), name: string(agent.name), bio: string(agent.bio), avatar: string(agent.avatar), color: string(agent.color), is_platform: agent.is_platform === true, position: position(agent.position), status: string(agent.status), group_id: string(agent.group_id) || null, activity: activity(agent.activity) })),
    places: catalog.places.map(place => ({ id: string(place.id), name: string(place.name), x: number(place.x), y: number(place.y), radius: number(place.radius) })),
    activities: catalog.activities.map(item => ({ id: string(item.id), name: string(item.name), place_id: string(item.place_id), duration_seconds: number(item.duration_seconds), description: string(item.description),
      ...(item.content ? { content: { title: string(item.content.title), text: string(item.content.text), source: string(item.content.source) } } : {}), ...(item.task ? { task: task(item.task) } : {}) })),
    games: catalog.games.map(item => ({ id: string(item.id), name: string(item.name), description: string(item.description), min_players: number(item.min_players), max_players: number(item.max_players) })),
    groups: Object.values(groups).map(group => ({ group_id: string(group.group_id), name: string(group.name), members: strings(group.members), created_at: number(group.created_at) })),
    game: publicGame(game, { spectator: true, agentIds }),
    events: recentEvents.reverse(),
    server_time: world.now(),
  };
}

export function attachSpectator(app, world, { maxStreams = 50, maxPerIp = 30, heartbeatMs = 15000 } = {}) {
  const streams = new Map();
  let broadcastTimer, closed = false;
  const end = res => { streams.delete(res); res.end(); };
  const write = (res, value) => {
    if (res.destroyed || res.writableEnded || res.writableLength > 256000) { end(res); return; }
    res.write(value);
  };
  app.get('/api/public/world', (_req, res) => res.json(spectatorSnapshot(world)));
  app.get('/api/public/events', (req, res) => {
    const ip = req.socket.remoteAddress;
    if (streams.size >= maxStreams || [...streams.values()].filter(value => value === ip).length >= maxPerIp) {
      return res.status(429).set('Retry-After', '15').json({ error: { code: 'RATE_LIMITED', message: '旁观连接已达上限，请稍后重试' } });
    }
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    streams.set(res, ip);
    write(res, `event: snapshot\ndata: ${JSON.stringify(spectatorSnapshot(world))}\n\n`);
    res.on('close', () => streams.delete(res));
  });
  const changed = () => {
    if (closed || !streams.size || broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      if (closed || !streams.size) return;
      const frame = `event: snapshot\ndata: ${JSON.stringify(spectatorSnapshot(world))}\n\n`;
      for (const res of streams.keys()) write(res, frame);
    }, 50);
    broadcastTimer.unref();
  };
  const heartbeat = setInterval(() => { for (const res of streams.keys()) write(res, ': heartbeat\n\n'); }, heartbeatMs);
  heartbeat.unref(); world.on('change', changed);
  return {
    get count() { return streams.size; },
    close() {
      closed = true; clearTimeout(broadcastTimer); clearInterval(heartbeat); world.off('change', changed);
      for (const res of streams.keys()) end(res);
    },
  };
}
