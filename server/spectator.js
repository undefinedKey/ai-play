import { SCENE_IDS, SCENES, publicMovement, publicPath } from './spatial.js';
import { randomBytes } from 'node:crypto';
import jsonPatch from 'fast-json-patch';
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
  agent_moved: ['agent_id', 'text', 'position', 'path'],
  scene_changed: ['agent_id', 'text', 'from_scene_id', 'position', 'from_position', 'reason'],
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
  if (SCENE_IDS.includes(raw.scene_id)) payload.scene_id = raw.scene_id;
  for (const key of fields) {
    if (key === 'path') { const path = publicPath(raw.scene_id, raw.path); if (path) payload.path = path; continue; }
    if (key === 'from_scene_id') { if (SCENE_IDS.includes(raw[key])) payload[key] = raw[key]; continue; }
    if (key === 'public_result') { payload[key] = publicExplorationResult(raw[key]); continue; }
    if (key === 'choices' && event.type.startsWith('exploration_')) { payload[key] = structuredClone(EXPLORATION_RULES.templates.find(t => t.template_id === raw.template_id)?.choices || []); continue; }
    const value = ['position', 'from_position'].includes(key) ? position(raw[key]) : key === 'scores' ? scores(raw[key], agentIds) : key === 'choices' ? publicChoices(raw[key], agentIds) : key === 'result' ? activityResult(raw[key]) : key === 'outcome' ? (['completed', 'cancelled'].includes(raw[key]) ? raw[key] : undefined) : ['found_at', 'expires_at', 'resolved_at', 'created_at', 'updated_at', 'target_count', 'progress', 'deadline', 'valid_count', 'started_at', 'ends_at', 'round', 'segment_count', 'collected', 'total', 'quantity', 'total_price', 'damage', 'hp', 'xp', 'gold', 'decision_until', 'energy', 'fatigue', 'level', 'durability', 'max_durability'].includes(key) ? number(raw[key]) : string(raw[key]);
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
    agents: Object.values(agents).map(agent => ({ agent_id: string(agent.agent_id), name: string(agent.name), bio: string(agent.bio), avatar: string(agent.avatar), color: string(agent.color), is_platform: agent.is_platform === true, scene_id: SCENE_IDS.includes(agent.scene_id) ? agent.scene_id : undefined, position: position(agent.position), movement: publicMovement(agent), status: string(agent.status), group_id: string(agent.group_id) || null, activity: activity(agent.activity), leisure: publicLeisure(agent, world.now()), adventure: publicFighter(agent), personal_goal: publicPersonalGoal(agent), life: publicLife(agent, world.now()), appearance: publicAppearance(agent), fatigue: publicFatigue(agent), presence: publicPresence(agent) })),
    scenes: structuredClone(SCENES), leisure_policy: { ...catalog.leisure_policy }, adventure: publicAdventure(world.state), life: catalog.life, fatigue: catalog.fatigue,
    places: catalog.places.map(place => ({ id: string(place.id), scene_id: SCENE_IDS.includes(place.scene_id) ? place.scene_id : undefined, name: string(place.name), x: number(place.x), y: number(place.y), radius: number(place.radius) })),
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

/** Scope only an already-public snapshot; subscriptions never change AI perception. */
export function scopeSpectatorSnapshot(snapshot, scene = null) {
  return { ...snapshot, scope: { scene_id: scene, events: scene ? 'scene' : 'world', roster: 'world' },
    ...(scene ? { events: snapshot.events.filter(event => event.payload.scene_id === scene
      || (event.type === 'scene_changed' && event.payload.from_scene_id === scene)
      || (scene === 'plaza' && cooperationEvents.has(event.type) && event.payload.template_id === 'camp_meal')),
      ...(scene === 'plaza' ? { adventure: { ...snapshot.adventure, monsters: [] } } : {}) } : {}) };
}

export function attachSpectator(app, world, { maxStreams = 150, maxPerIp = 30, heartbeatMs = 15000,
  maxBufferBytes = 262144, broadcastMs = 50 } = {}) {
  const streams = new Map();
  const stats = { snapshot_builds: 0, scope_projections: 0, snapshot_encodes: 0, delta_encodes: 0, v2_delta_encodes: 0,
    encoded_bytes: 0, frames_written: 0, delta_frames_written: 0, bytes_enqueued: 0, broadcasts: 0,
    rejected_streams: 0, slow_disconnects: 0, write_errors: 0, peak_streams: 0, peak_buffer_bytes: 0 };
  let broadcastTimer, closed = false, current = null;
  const projected = new WeakMap(), fullFrames = new WeakMap(), patchFrames = new WeakMap(), patchBodies = new WeakMap(), frameIds = new WeakMap();
  const framePrefix = randomBytes(8).toString('hex'); let frameSequence = 0;
  const frameId = snapshot => {
    if (!frameIds.has(snapshot)) frameIds.set(snapshot, `${framePrefix}:${++frameSequence}`);
    return frameIds.get(snapshot);
  };
  const patchBody = snapshot => {
    if (!patchBodies.has(snapshot)) {
      const { events, ...body } = snapshot;
      // Normalize exactly like the JSON wire snapshot, including omitted undefined
      // fields. Never compare raw world/owner state or include the event ring here.
      patchBodies.set(snapshot, JSON.parse(JSON.stringify(body)));
    }
    return patchBodies.get(snapshot);
  };
  const end = (res, destroy = false) => {
    streams.delete(res);
    if (destroy) res.destroy(); else if (!res.writableEnded) res.end();
  };
  const write = (res, frame, kind = 'heartbeat') => {
    const info = streams.get(res);
    if (!info || res.destroyed || res.writableEnded) { end(res); return false; }
    const buffered = res.writableLength || 0;
    // No per-client application queue. A client that has not drained by its next
    // update reconnects with a full snapshot instead of retaining unbounded deltas.
    if (info.blocked || buffered + frame.bytes > maxBufferBytes) {
      stats.slow_disconnects++; end(res, true); return false;
    }
    try {
      info.blocked = !res.write(frame.text);
      stats.peak_buffer_bytes = Math.max(stats.peak_buffer_bytes, res.writableLength || 0);
      stats.bytes_enqueued += frame.bytes;
      if (kind !== 'heartbeat') stats.frames_written++;
      if (kind === 'delta') stats.delta_frames_written++;
      return true;
    } catch { stats.write_errors++; end(res, true); return false; }
  };
  const sceneQuery = (req, res) => {
    const scene = req.query.scene;
    if (scene === undefined && !Object.keys(req.query).some(key => key.startsWith('scene['))) return null;
    if (typeof scene === 'string' && SCENE_IDS.includes(scene)) return scene;
    res.status(400).json({ error: { code: 'INVALID_SCENE', message: '旁观场景应为 plaza 或 adventure，省略时观察全世界' } });
    return false;
  };
  const baseSnapshot = () => {
    // Movement ticks do not always increment room.world_revision, so every world
    // change invalidates the cache. The sequence check also covers explicit events.
    if (!current || current.sequence !== world.state.sequence || world.now() - current.snapshot.server_time >= 1000) {
      current = { sequence: world.state.sequence, snapshot: spectatorSnapshot(world) };
      stats.snapshot_builds++;
    }
    return current.snapshot;
  };
  const scoped = (base, scene) => {
    let variants = projected.get(base);
    if (!variants) { variants = new Map(); projected.set(base, variants); }
    if (!variants.has(scene)) { variants.set(scene, scopeSpectatorSnapshot(base, scene)); stats.scope_projections++; }
    return variants.get(scene);
  };
  const encode = (kind, data) => {
    const json = JSON.stringify(data), text = `event: ${kind}\ndata: ${json}\n\n`;
    const frame = { json, text, bytes: Buffer.byteLength(text) };
    stats[`${kind}_encodes`]++; stats.encoded_bytes += frame.bytes;
    return frame;
  };
  const fullFrame = (snapshot, protocol = 0) => {
    const cache = protocol === 2 ? patchFrames : fullFrames;
    if (!cache.has(snapshot)) cache.set(snapshot, encode('snapshot', protocol === 2 ? { ...snapshot, stream_frame_id: frameId(snapshot) } : snapshot));
    return cache.get(snapshot);
  };
  const patchDelta = (previous, snapshot) => {
    const eventDelta = snapshotDelta({ events: previous.events }, { events: snapshot.events });
    delete eventDelta.server_time;
    stats.v2_delta_encodes++;
    return { protocol: 2, base_frame_id: frameId(previous), frame_id: frameId(snapshot),
      patch: jsonPatch.compare(patchBody(previous), patchBody(snapshot)), ...eventDelta };
  };
  app.get('/api/public/world', (req, res) => {
    const scene = sceneQuery(req, res); if (scene === false) return;
    res.type('application/json').send(fullFrame(scoped(baseSnapshot(), scene)).json);
  });
  app.get('/api/public/history', (req, res) => res.json(world.historyPage(req.query)));
  app.get('/api/public/events', (req, res) => {
    const scene = sceneQuery(req, res); if (scene === false) return;
    const ip = req.socket.remoteAddress;
    if (streams.size >= maxStreams || [...streams.values()].filter(value => value.ip === ip).length >= maxPerIp) {
      stats.rejected_streams++;
      return res.status(429).set('Retry-After', '15').json({ error: { code: 'RATE_LIMITED', message: '旁观连接已达上限，请稍后重试' } });
    }
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const snapshot = scoped(baseSnapshot(), scene);
    const protocol = req.query.delta === '2' ? 2 : req.query.delta === '1' ? 1 : 0;
    streams.set(res, { ip, scene, delta: protocol, last: snapshot, blocked: false });
    stats.peak_streams = Math.max(stats.peak_streams, streams.size);
    res.on('drain', () => { const info = streams.get(res); if (info) info.blocked = false; });
    res.on('close', () => streams.delete(res));
    write(res, fullFrame(snapshot, protocol), 'snapshot');
  });
  const changed = () => {
    current = null;
    if (closed || !streams.size || broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      if (closed || !streams.size) return;
      const base = baseSnapshot(), deltas = new Map();
      stats.broadcasts++;
      for (const [res, info] of streams) {
        const snapshot = scoped(base, info.scene);
        if (info.delta) {
          // Baseline identity includes scope. Reuse only identical baselines, never
          // send a newly connected client a delta computed from another generation.
          if (!deltas.has(info.delta)) deltas.set(info.delta, new Map());
          const protocolFrames = deltas.get(info.delta);
          if (!protocolFrames.has(info.last)) protocolFrames.set(info.last, encode('delta', info.delta === 2 ? patchDelta(info.last, snapshot) : snapshotDelta(info.last, snapshot)));
          if (write(res, protocolFrames.get(info.last), 'delta')) info.last = snapshot;
        } else if (write(res, fullFrame(snapshot), 'snapshot')) info.last = snapshot;
      }
    }, broadcastMs);
    broadcastTimer.unref();
  };
  const heartbeatFrame = { text: ': heartbeat\n\n', bytes: 13 };
  const heartbeat = setInterval(() => { for (const res of streams.keys()) write(res, heartbeatFrame); }, heartbeatMs);
  heartbeat.unref(); world.on('change', changed);
  return {
    get count() { return streams.size; },
    // Local instrumentation only: never included in public HTTP responses.
    get stats() { return { ...stats, active_streams: streams.size }; },
    close() {
      closed = true; clearTimeout(broadcastTimer); clearInterval(heartbeat); world.off('change', changed);
      for (const res of streams.keys()) end(res);
    },
  };
}
