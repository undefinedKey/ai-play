import { GAME_END_REASONS, gameName, publicChoices, publicGame } from './games.js';
import { publicLeisure } from './leisure.js';
import { snapshotDelta } from './snapshot-delta.js';
import { publicAdventure, publicFighter } from './adventure.js';
import { publicLife } from './life.js';
import { publicAppearance } from './appearance.js';
import { publicFatigue } from './fatigue.js';
import { publicPresence } from './presence.js';
import { publicPersonalGoal } from './personal-goals.js';
import { EXPLORATION_RULES, publicExplorationResult } from './exploration.js';
import { COOPERATION_RULES, publicCooperation, publicCooperations } from './cooperation.js';

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
  adventure_started: ['agent_id', 'name', 'text', 'intent', 'zone_id', 'monster_id'],
  adventure_finished: ['agent_id', 'name', 'text', 'kind'],
  adventure_arrived: ['agent_id', 'name', 'text', 'zone_id'],
  adventure_combat: ['agent_id', 'name', 'text', 'monster_id', 'damage', 'hp', 'attacker'],
  adventure_aggro: ['agent_id', 'name', 'target_agent_id', 'monster_id', 'text'],
  adventure_loot: ['agent_id', 'name', 'text', 'monster_id', 'xp', 'gold'],
  adventure_defeated: ['agent_id', 'name', 'text', 'monster_id'],
  adventure_danger: ['agent_id', 'name', 'text', 'hp', 'decision_until'],
  adventure_respawn: ['text', 'monster_id'],
  exploration_found: ['agent_id', 'name', 'text', 'event_id', 'template_id', 'zone_id', 'position', 'status', 'found_at', 'expires_at', 'choices'],
  exploration_resolved: ['agent_id', 'name', 'text', 'event_id', 'template_id', 'zone_id', 'position', 'status', 'selected_choice_id', 'resolved_at', 'public_result'],
  exploration_ended: ['agent_id', 'name', 'text', 'event_id', 'template_id', 'zone_id', 'position', 'status', 'selected_choice_id', 'resolved_at', 'public_result'],
  personal_goal_set: ['agent_id', 'name', 'text', 'goal_id', 'kind', 'target_id', 'target_count', 'progress', 'title', 'status', 'created_at', 'updated_at', 'expires_at', 'review_reason'],
  personal_goal_progress: ['agent_id', 'name', 'text', 'goal_id', 'kind', 'target_id', 'target_count', 'progress', 'title', 'status', 'created_at', 'updated_at', 'expires_at', 'review_reason'],
  personal_goal_ended: ['agent_id', 'name', 'text', 'goal_id', 'kind', 'target_id', 'target_count', 'progress', 'title', 'status', 'created_at', 'updated_at', 'expires_at', 'review_reason'],
  personal_goal_review: ['agent_id', 'name', 'text', 'goal_id', 'kind', 'target_id', 'target_count', 'progress', 'title', 'status', 'created_at', 'updated_at', 'expires_at', 'review_reason'],
  life_planted: ['agent_id', 'name', 'text', 'plot_id', 'crop_id', 'item_id', 'slot'],
  life_tilled: ['agent_id', 'name', 'text', 'plot_id', 'item_id', 'level', 'durability'],
  life_watered: ['agent_id', 'name', 'text', 'plot_id', 'crop_id', 'item_id', 'slot', 'level', 'durability'],
  life_tool_repaired: ['agent_id', 'name', 'text', 'item_id', 'level', 'durability', 'max_durability'],
  life_tool_upgraded: ['agent_id', 'name', 'text', 'item_id', 'level', 'durability', 'max_durability'],
  life_gather_started: ['agent_id', 'name', 'text', 'job_id', 'resource_id', 'item_id', 'quantity', 'started_at', 'ends_at'],
  life_gather_finished: ['agent_id', 'name', 'text', 'job_id', 'resource_id', 'item_id', 'quantity'],
  life_gather_cancelled: ['agent_id', 'name', 'text', 'job_id', 'resource_id', 'reason'],
  life_traded: ['agent_id', 'name', 'text', 'intent', 'item_id', 'quantity', 'total_price'],
  life_harvested: ['agent_id', 'name', 'text', 'plot_id', 'crop_id', 'item_id', 'slot'],
  life_crafted: ['agent_id', 'name', 'text', 'plot_id', 'crop_id', 'item_id', 'slot', 'quantity'],
  life_equipped: ['agent_id', 'name', 'text', 'plot_id', 'crop_id', 'item_id', 'slot'],
  life_consumed: ['agent_id', 'name', 'text', 'plot_id', 'crop_id', 'item_id', 'slot', 'quantity', 'hp', 'energy'],
  life_ready: ['agent_id', 'name', 'text', 'plot_id', 'crop_id', 'item_id', 'slot'],
  fatigue_tired: ['agent_id', 'name', 'text', 'energy', 'fatigue'],
  fatigue_exhausted: ['agent_id', 'name', 'text', 'energy', 'fatigue'],
  message: ['agent_id', 'name', 'text', 'channel', 'group_id'],
  group_created: ['agent_id', 'group_id', 'text'], group_joined: ['agent_id', 'group_id', 'text'], group_left: ['agent_id', 'group_id', 'text'],
  game_proposed: ['agent_id', 'game_id', 'group_id', 'game_type', 'text'], game_registered: ['agent_id', 'game_id', 'text'],
  game_started: ['game_id', 'group_id', 'game_type', 'word', 'text'], game_turn: ['game_id', 'agent_id', 'game_type', 'deadline', 'last_word', 'round', 'text'],
  game_timeout: ['agent_id', 'game_id', 'text'], word_submitted: ['agent_id', 'game_id', 'word', 'text', 'valid_count'],
  move_submitted: ['agent_id', 'game_id', 'text'], round_revealed: ['game_id', 'round', 'choices', 'scores', 'text'],
  story_submitted: ['agent_id', 'game_id', 'text', 'segment_count'],
  game_finished: ['game_id', 'group_id', 'game_type', 'valid_count', 'scores'],
};
const cooperationEvents=new Set(['cooperation_proposed','cooperation_started','cooperation_progress','cooperation_review','cooperation_completed','cooperation_ended']);
export function publicEvent(event, agentIds) {
  if(cooperationEvents.has(event.type)) {
    const payload=publicCooperation(event.payload);
    return payload?{event_id:string(event.event_id),type:event.type,occurred_at:number(event.occurred_at),cursor:string(event.cursor),world_revision:number(event.world_revision),payload}:null;
  }
  if (!Object.hasOwn(publicEventFields, event.type)) return null;
  const fields = publicEventFields[event.type];
  const raw = event.payload || {};
  if (event.type === 'message' && !['nearby', 'group'].includes(raw.channel)) return null;
  const payload = {};
  for (const key of fields) {
    if (key === 'public_result') { payload[key] = publicExplorationResult(raw[key]); continue; }
    if (key === 'choices' && event.type.startsWith('exploration_')) { payload[key] = structuredClone(EXPLORATION_RULES.templates.find(t => t.template_id === raw.template_id)?.choices || []); continue; }
    const value = key === 'position' ? position(raw[key]) : key === 'scores' ? scores(raw[key], agentIds) : key === 'choices' ? publicChoices(raw[key], agentIds) : key === 'result' ? activityResult(raw[key]) : key === 'outcome' ? (['completed', 'cancelled'].includes(raw[key]) ? raw[key] : undefined) : ['found_at', 'expires_at', 'resolved_at', 'created_at', 'updated_at', 'target_count', 'progress', 'deadline', 'valid_count', 'started_at', 'ends_at', 'round', 'segment_count', 'collected', 'total', 'quantity', 'total_price', 'damage', 'hp', 'xp', 'gold', 'decision_until', 'energy', 'fatigue', 'level', 'durability', 'max_durability'].includes(key) ? number(raw[key]) : string(raw[key]);
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
    agents: Object.values(agents).map(agent => ({ agent_id: string(agent.agent_id), name: string(agent.name), bio: string(agent.bio), avatar: string(agent.avatar), color: string(agent.color), is_platform: agent.is_platform === true, position: position(agent.position), status: string(agent.status), group_id: string(agent.group_id) || null, activity: activity(agent.activity), leisure: publicLeisure(agent, world.now()), adventure: publicFighter(agent), personal_goal: publicPersonalGoal(agent), life: publicLife(agent, world.now()), appearance: publicAppearance(agent), fatigue: publicFatigue(agent), presence: publicPresence(agent) })),
    leisure_policy: { ...catalog.leisure_policy }, adventure: publicAdventure(world.state), life: catalog.life, fatigue: catalog.fatigue,
    places: catalog.places.map(place => ({ id: string(place.id), name: string(place.name), x: number(place.x), y: number(place.y), radius: number(place.radius) })),
    activities: catalog.activities.map(item => ({ id: string(item.id), name: string(item.name), place_id: string(item.place_id), duration_seconds: number(item.duration_seconds), description: string(item.description),
      ...(item.content ? { content: { title: string(item.content.title), text: string(item.content.text), source: string(item.content.source) } } : {}), ...(item.task ? { task: task(item.task) } : {}) })),
    games: catalog.games.map(item => ({ id: string(item.id), name: string(item.name), description: string(item.description), min_players: number(item.min_players), max_players: number(item.max_players), registration_seconds:number(item.registration_seconds),turn_seconds:number(item.turn_seconds) })),
    groups: Object.values(groups).map(group => ({ group_id: string(group.group_id), name: string(group.name), members: strings(group.members), created_at: number(group.created_at) })),
    cooperation: structuredClone(COOPERATION_RULES), cooperations: publicCooperations(world),
    game: publicGame(game, { spectator: true, agentIds }),
    events: recentEvents.reverse(), history: world.historyMetadata(),
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
  app.get('/api/public/history', (req, res) => res.json(world.historyPage(req.query)));
  app.get('/api/public/events', (req, res) => {
    const ip = req.socket.remoteAddress;
    if (streams.size >= maxStreams || [...streams.values()].filter(value => value.ip === ip).length >= maxPerIp) {
      return res.status(429).set('Retry-After', '15').json({ error: { code: 'RATE_LIMITED', message: '旁观连接已达上限，请稍后重试' } });
    }
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const snapshot = spectatorSnapshot(world);
    streams.set(res, { ip, delta: req.query.delta === '1', last: snapshot });
    write(res, `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
    res.on('close', () => streams.delete(res));
  });
  const changed = () => {
    if (closed || !streams.size || broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      if (closed || !streams.size) return;
      const snapshot = spectatorSnapshot(world);
      let fullFrame;
      for (const [res, info] of streams) {
        if (info.delta) write(res, `event: delta\ndata: ${JSON.stringify(snapshotDelta(info.last, snapshot))}\n\n`);
        else { fullFrame ??= `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`; write(res, fullFrame); }
        info.last = snapshot;
      }
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
