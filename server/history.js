import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { publicEvent } from './spectator.js';
import { publicGame } from './games.js';
import { publicCooperation } from './cooperation.js';

export const HISTORY_RETENTION = Object.freeze({ days: 30, max_entries: 4096, max_general: 3584, max_cooperation: 512 });
const categories = new Set(['speech', 'activity', 'game', 'exploration', 'life', 'goal', 'cooperation']);
const outcomes = new Set(['recorded', 'completed', 'cancelled', 'interrupted', 'expired', 'ended']);
const types = new Map([
  ['message', 'speech'], ['activity_finished', 'activity'], ['game_finished', 'game'],
  ['exploration_resolved', 'exploration'], ['exploration_ended', 'exploration'], ['personal_goal_ended', 'goal'],
  ...['life_gather_finished', 'life_traded', 'life_harvested', 'life_crafted', 'life_equipped', 'life_tool_upgraded', 'life_tool_repaired', 'life_consumed'].map(type => [type, 'life']),
  ['cooperation_completed', 'cooperation'], ['cooperation_ended', 'cooperation'],
]);
const time = n => Number.isSafeInteger(n) && n >= 0;
const string = (value, max = 200) => typeof value === 'string' ? [...value].slice(0, max).join('') : null;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_:-]{1,160}$/.test(value) ? value : null;
const actor = value => value && identifier(value.agent_id) ? { agent_id: value.agent_id, name: string(value.name, 20) || '未知角色' } : null;
const finished = new Set(['完成 10 次有效接词', '词库没有未使用的后继词', '完成 3 轮石头剪刀布', '完成 6 段故事']);

function gameSnapshot(game, known) {
  if (!game || typeof game !== 'object' || game.status !== 'finished') return null;
  // publicGame is shared with the live map; normalize nested containers before
  // using it so a malformed historical value cannot crash a public read.
  const value = publicGame({ ...game,
    rounds: (Array.isArray(game.rounds) ? game.rounds : []).filter(r => r && typeof r === 'object').slice(0, 3),
    segments: (Array.isArray(game.segments) ? game.segments : []).filter(s => s && typeof s === 'object').slice(0, 6),
  }, { spectator: true, agentIds: known });
  value.participants = value.participants.filter(id => known.has(id)).slice(0, 5);
  value.current_agent_id = null; value.deadline = null;
  if (value.words) value.words = value.words.map(word => string(word, 20)).slice(0, 11);
  if (value.segments) value.segments = value.segments.filter(s => known.has(s.agent_id)).map(s => ({ agent_id: s.agent_id, text: string(s.text, 200) }));
  if (value.rounds) value.rounds = value.rounds.map(r => ({ round: time(r.round) ? r.round : 0, choices: r.choices.slice(0, 5), scores: r.scores }));
  if (value.submitted_agent_ids) value.submitted_agent_ids = [];
  return value;
}

function projectDetails(type, raw, known) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (types.get(type) === 'cooperation') {
    const cooperation = publicCooperation(raw.cooperation || raw);
    if (!cooperation || !['completed', 'ended'].includes(cooperation.status) || cooperation.started_at === null || cooperation.members.length !== 2 ||
      cooperation.members.some(m => !known.has(m.agent_id)) || new Set(cooperation.members.map(m => m.agent_id)).size !== 2) return null;
    return { cooperation };
  }
  const projected = publicEvent({ type, payload: raw }, known);
  if (!projected) return null;
  const details = projected.payload;
  if (type === 'activity_finished' && raw.interrupted === true && details.outcome === 'cancelled') details.interrupted = true;
  if (type === 'message') {
    if (!known.has(details.agent_id) || !details.text) return null;
    details.text = string(details.text, 200);
  }
  // These quantities are already public action results, never warehouse balances.
  if (['life_harvested', 'life_crafted'].includes(type) && time(raw.quantity)) details.quantity = raw.quantity;
  if (type === 'game_finished') {
    if (!identifier(details.game_id)) return null;
    const game = raw.game?.game_id === details.game_id ? gameSnapshot(raw.game, known) : null;
    if (game) details.game = game;
  }
  return details;
}

function outcomeFor(type, d) {
  if (type === 'message') return 'recorded';
  if (type === 'activity_finished') return d.outcome === 'cancelled' ? d.interrupted === true ? 'interrupted' : 'cancelled' : d.outcome === 'completed' ? 'completed' : 'ended';
  if (type === 'game_finished') return finished.has(d.reason) ? 'completed' : /超时/.test(d.reason || '') ? 'expired' : ['服务重启，活动已中断', '房间暂停', '参与者离场，本局结束'].includes(d.reason) ? 'interrupted' : 'ended';
  if (types.get(type) === 'cooperation') {
    const p = d.cooperation;
    return p.status === 'completed' ? 'completed' : p.end_reason === 'expired' ? 'expired' : p.end_reason === 'withdrawn' ? 'cancelled' : ['member_left', 'authorization_ended'].includes(p.end_reason) ? 'interrupted' : 'ended';
  }
  if (types.get(type) === 'exploration') return ({ resolved: 'completed', declined: 'cancelled', expired: 'expired', interrupted: 'interrupted' })[d.status] || 'ended';
  if (type === 'personal_goal_ended') return ['completed', 'cancelled', 'expired'].includes(d.status) ? d.status : 'ended';
  return 'completed';
}

function summaryFor(type, d, outcome) {
  if (types.get(type) === 'cooperation') {
    const p = d.cooperation;
    if (outcome === 'completed') return p.public_result?.text || '合作已完成';
    return `共同约定${({ cancelled: '已退出', interrupted: '已中断', expired: '已到期', ended: '已结束' })[outcome] || '已结束'}`;
  }
  return string(d.text, 400) || string(d.result?.summary, 400) || `${({ activity: '活动', game: '游戏', exploration: '探索', life: '生活行动', goal: '公开目标' })[types.get(type)] || '公开记录'}已记录`;
}

/** Re-project stored entries at every public boundary; never spread private raw data. */
export function publicHistoryEntry(entry) {
  if (!entry || !types.has(entry.type) || entry.category !== types.get(entry.type) || !time(entry.sequence) || entry.sequence < 1 ||
    entry.entry_id !== `history_${entry.sequence}` || !time(entry.occurred_at) || !outcomes.has(entry.outcome)) return null;
  const actors = (Array.isArray(entry.actors) ? entry.actors : []).map(actor).filter(Boolean).slice(0, 5);
  const known = new Set(actors.map(a => a.agent_id));
  if (!known.size || known.size !== actors.length) return null;
  const source = entry.source;
  if (!source || !['event', 'legacy_cooperation'].includes(source.kind) || !identifier(source.id)) return null;
  if (source.kind === 'event' && (source.event_id !== source.id || !/^evt_\d+$/.test(source.id))) return null;
  if (source.kind === 'legacy_cooperation' && entry.category !== 'cooperation') return null;
  const details = projectDetails(entry.type, entry.details, known);
  if (!details) return null;
  if (source.kind === 'legacy_cooperation' && source.id !== details.cooperation.cooperation_id) return null;
  const outcome = outcomeFor(entry.type, details);
  return { entry_id: entry.entry_id, sequence: entry.sequence, occurred_at: entry.occurred_at, category: entry.category, type: entry.type,
    actors, source: { kind: source.kind, id: source.id, ...(source.kind === 'event' ? { event_id: source.event_id } : {}) },
    summary: summaryFor(entry.type, details, outcome), outcome, details };
}

function fromEvent(world, event) {
  if (!event || !types.has(event.type) || !/^evt_\d+$/.test(event.event_id || '') || !time(event.occurred_at)) return null;
  const allIds = new Set(Object.keys(world.state.agents));
  let raw = event.payload || {};
  if (event.type === 'game_finished' && world.state.game?.game_id === raw.game_id && world.state.game.status === 'finished') raw = { ...raw, game: world.state.game };
  const details = projectDetails(event.type, raw, allIds);
  if (!details) return null;
  let ids = [details.agent_id];
  if (types.get(event.type) === 'cooperation') ids = details.cooperation.members.map(m => m.agent_id);
  if (event.type === 'game_finished') {
    const g = details.game;
    ids = [...(g?.participants || []), ...Object.keys(details.scores || {}), ...Object.keys(g?.scores || {}),
      ...(g?.segments || []).map(s => s.agent_id), ...(g?.rounds || []).flatMap(r => r.choices.map(c => c.agent_id))];
  }
  ids = [...new Set(ids.filter(id => allIds.has(id)))].slice(0, 5);
  if (!ids.length) return null;
  return { occurred_at: event.occurred_at, category: types.get(event.type), type: event.type,
    actors: ids.map(id => ({ agent_id: id, name: string(details.agent_id === id ? details.name : null, 20) || string(world.state.agents[id]?.name, 20) || '未知角色' })),
    source: { kind: 'event', id: event.event_id, event_id: event.event_id }, details };
}

function append(world, candidate) {
  const h = world.state.history;
  if (!candidate || h.entries.some(e => e.source.kind === candidate.source.kind && e.source.id === candidate.source.id)) return false;
  // Both source forms describe the same terminal project; import it only once.
  if (candidate.category === 'cooperation' && h.entries.some(e => e.category === 'cooperation' && e.details.cooperation.cooperation_id === candidate.details.cooperation.cooperation_id)) return false;
  if (h.next_sequence >= Number.MAX_SAFE_INTEGER || h.revision >= Number.MAX_SAFE_INTEGER) throw new Error('History sequence exhausted');
  const sequence = h.next_sequence;
  const outcome = outcomeFor(candidate.type, candidate.details);
  const entry = publicHistoryEntry({ ...candidate, entry_id: `history_${sequence}`, sequence, outcome });
  if (!entry) return false;
  h.next_sequence++; h.revision++; h.entries.push(entry); return true;
}

export function pruneHistory(world) {
  const h = world.state.history, cutoff = Math.max(0, world.now() - HISTORY_RETENTION.days * 86400000);
  let general = 0, cooperation = 0;
  const retained = [];
  for (let i = h.entries.length - 1; i >= 0; i--) {
    const entry = h.entries[i];
    if (entry.occurred_at < cutoff) continue;
    if (entry.category === 'cooperation' ? ++cooperation <= HISTORY_RETENTION.max_cooperation : ++general <= HISTORY_RETENTION.max_general) retained.push(entry);
  }
  if (retained.length === h.entries.length) return false;
  h.entries = retained.reverse(); h.revision++; return true;
}

export function initializeHistory(world) {
  if (world.state.history !== undefined) {
    const h = world.state.history;
    if (!h || h.version !== 1 || typeof h.archive_id !== 'string' || !/^archive_[0-9a-f-]{36}$/.test(h.archive_id) ||
      !time(h.started_at) || !time(h.next_sequence) || h.next_sequence < 1 || !time(h.revision) || h.revision < h.next_sequence - 1 || !time(h.imported_count) || h.imported_count >= h.next_sequence ||
      !Array.isArray(h.entries) || h.entries.length > HISTORY_RETENTION.max_entries ||
      Object.keys(h).some(k => !['version', 'archive_id', 'started_at', 'next_sequence', 'revision', 'imported_count', 'entries'].includes(k))) throw new Error('Invalid persisted public history; preserve database for recovery');
    const sources = new Set(), projects = new Set(); let previous = 0;
    for (const entry of h.entries) {
      if (!isDeepStrictEqual(publicHistoryEntry(entry), entry) || entry.sequence <= previous || entry.sequence >= h.next_sequence) throw new Error('Invalid persisted history entry; preserve database for recovery');
      const key = `${entry.source.kind}:${entry.source.id}`;
      if (sources.has(key)) throw new Error('Duplicate persisted history source'); sources.add(key); previous = entry.sequence;
      if (entry.category === 'cooperation') {
        const id = entry.details.cooperation.cooperation_id;
        if (projects.has(id)) throw new Error('Duplicate persisted cooperation history'); projects.add(id);
      }
    }
    if (h.entries.filter(e => e.category === 'cooperation').length > HISTORY_RETENTION.max_cooperation || h.entries.filter(e => e.category !== 'cooperation').length > HISTORY_RETENTION.max_general) throw new Error('Invalid persisted history quota');
    pruneHistory(world); return;
  }
  world.state.history = { version: 1, archive_id: `archive_${randomUUID()}`, started_at: world.now(), next_sequence: 1, revision: 0, imported_count: 0, entries: [] };
  const candidates = world.state.events.map(e => fromEvent(world, e)).filter(Boolean);
  const importedProjects = new Set(candidates.filter(e => e.category === 'cooperation').map(e => e.details.cooperation.cooperation_id));
  for (const p of Object.values(world.state.cooperations || {})) {
    if (!['completed', 'ended'].includes(p.status) || !time(p.ended_at) || importedProjects.has(p.cooperation_id)) continue;
    const details = projectDetails(p.status === 'completed' ? 'cooperation_completed' : 'cooperation_ended', p, new Set(Object.keys(world.state.agents)));
    if (!details) continue;
    candidates.push({ occurred_at: p.ended_at, category: 'cooperation', type: p.status === 'completed' ? 'cooperation_completed' : 'cooperation_ended',
      actors: details.cooperation.members.map(m => ({ agent_id: m.agent_id, name: world.state.agents[m.agent_id]?.name || '未知角色' })),
      source: { kind: 'legacy_cooperation', id: p.cooperation_id }, details });
  }
  candidates.sort((a, b) => a.occurred_at - b.occurred_at || Number(a.source.event_id?.slice(4) || 0) - Number(b.source.event_id?.slice(4) || 0));
  for (const candidate of candidates) if (append(world, candidate)) world.state.history.imported_count++;
  pruneHistory(world);
}

export function recordHistoryEvent(world, event) {
  if (!world.state.history) return;
  if (append(world, fromEvent(world, event))) pruneHistory(world);
}

export function historyMetadata(world) {
  const h = world.state.history;
  const times = h.entries.map(e => e.occurred_at).filter(time);
  return { version: 1, archive_id: identifier(h.archive_id), archive_started_at: time(h.started_at) ? h.started_at : null,
    earliest_record_at: times.length ? Math.min(...times) : null,
    history_revision: time(h.revision) ? h.revision : 0, retention: { ...HISTORY_RETENTION }, imported_count: time(h.imported_count) ? h.imported_count : 0 };
}

export function historyPage(world, query = {}, fail = message => { throw new Error(message); }) {
  const keys = ['agent_id', 'category', 'from', 'to', 'before', 'limit'];
  if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).some(key => !keys.includes(key) || typeof query[key] !== 'string')) return fail('经历查询只接受已知的字符串参数');
  const parse = (key, fallback) => {
    if (query[key] === undefined) return fallback;
    if (!/^\d{1,16}$/.test(query[key]) || !time(Number(query[key]))) return fail(`${key}必须是安全非负整数`);
    return Number(query[key]);
  };
  const limit = parse('limit', 20), from = parse('from', 0), to = parse('to', Number.MAX_SAFE_INTEGER);
  if (limit < 1 || limit > 50 || from > to) return fail('经历查询时间范围或页大小无效');
  if (query.agent_id !== undefined && !Object.hasOwn(world.state.agents, query.agent_id)) return fail('经历查询角色不存在');
  if (query.category !== undefined && !categories.has(query.category)) return fail('经历类别无效');
  const h = world.state.history; let before = h.next_sequence;
  if (query.before !== undefined) {
    try {
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(query.before)) throw new Error();
      const decoded = JSON.parse(Buffer.from(query.before, 'base64url').toString('utf8'));
      if (!Array.isArray(decoded) || decoded.length !== 2 || decoded[0] !== h.archive_id || !time(decoded[1]) || decoded[1] < 1 || decoded[1] > h.next_sequence || Buffer.from(JSON.stringify(decoded)).toString('base64url') !== query.before) throw new Error();
      before = decoded[1];
    } catch { return fail('经历分页游标无效或属于其他档案'); }
  }
  const found = [];
  for (let i = h.entries.length - 1; i >= 0 && found.length <= limit; i--) {
    const raw = h.entries[i];
    if (raw.sequence >= before || raw.occurred_at < from || raw.occurred_at > to || query.category && raw.category !== query.category ||
      query.agent_id && !raw.actors?.some(a => a.agent_id === query.agent_id)) continue;
    const entry = publicHistoryEntry(raw); if (entry) found.push(entry);
  }
  const has_more = found.length > limit, items = found.slice(0, limit), metadata = historyMetadata(world);
  return { items, next_cursor: has_more ? Buffer.from(JSON.stringify([h.archive_id, items.at(-1).sequence])).toString('base64url') : null,
    has_more, server_time: world.now(), retention: metadata.retention, archive_id: metadata.archive_id, archive_started_at: metadata.archive_started_at,
    earliest_record_at: metadata.earliest_record_at, history_revision: metadata.history_revision, imported_count: metadata.imported_count };
}
