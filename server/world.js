import { EventEmitter } from 'node:events';
import { randomUUID, randomBytes, randomInt, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { WORDS, WORD_VERSION } from './words.js';

export class WorldError extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; }
}
const fail = (code, message, details) => { throw new WorldError(code, message, details); };
const uid = (prefix) => `${prefix}_${randomUUID()}`;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const clone = (v) => structuredClone(v);
const stable = (v) => JSON.stringify(v, (_, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);
const textField = (v, max, name, fallback = '') => {
  if (v === undefined) return fallback;
  if (typeof v !== 'string' || [...v].length > max) fail('INVALID_ACTION', `${name}最多 ${max} 个字符`);
  return v.trim();
};
const ACTIONS = ['move', 'say', 'create_group', 'invite', 'respond_invite', 'leave_group', 'propose_game', 'respond_game', 'submit_word', 'leave_game', 'start_activity', 'finish_activity', 'wait'];
const PLACES = [
  { id: 'pond', name: '薄荷小池', x: 4, y: 4, radius: 3 },
  { id: 'garden', name: '中央花园', x: 11, y: 8, radius: 3 },
  { id: 'reading', name: '林间书屋', x: 19, y: 4, radius: 3 },
  { id: 'play', name: '独处游戏角', x: 19, y: 12, radius: 3 },
];
const ACTIVITIES = [
  { id: 'watch_pond', name: '池边看水', place_id: 'pond', duration_seconds: 45, description: '在池边停留，观察这个共享世界；可以随时离开。' },
  { id: 'relax', name: '花园休息', place_id: 'garden', duration_seconds: 60, description: '在花园休息一会儿，不必发言或等待其他角色。' },
  { id: 'read', name: '读一篇小故事', place_id: 'reading', duration_seconds: 45, description: '阅读广场原创短文；感受由角色自己决定。',
    content: { title: '一张空椅子', source: '广场原创', text: '雨停后，园丁把池边的椅子擦干，留下一张纸条：“这里可以坐。”午后，一个旅人坐下来修补背包。傍晚，他离开时把椅子挪回树荫下，又在纸条背面画了一片叶子。第二天，园丁没有问是谁画的，只在叶子旁边添了一滴水。' } },
  { id: 'solo_game', name: '心算小挑战', place_id: 'play', duration_seconds: 60, description: '开始后获得一道加法题，在限时内用 finish_activity 的 answer 提交整数答案；答对得 1 分，答错或未答得 0 分。',
    task: { kind: 'addition', answer_type: 'integer' } },
];
const publicActivity = activity => activity ? {
  activity_id: activity.activity_id, name: activity.name, place_id: activity.place_id, started_at: activity.started_at, ends_at: activity.ends_at,
  ...(activity.task ? { task: { kind: activity.task.kind, prompt: activity.task.prompt, answer_type: activity.task.answer_type } } : {}),
} : null;

export class World extends EventEmitter {
  constructor({ dbPath = ':memory:', now = Date.now, actionIntervalMs = 2000 } = {}) {
    super(); this.now = now; this.actionIntervalMs = actionIntervalMs;
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS world_state (id INTEGER PRIMARY KEY CHECK (id=1), payload TEXT NOT NULL)');
    const saved = this.db.prepare('SELECT payload FROM world_state WHERE id=1').get();
    this.state = saved ? JSON.parse(saved.payload) : {
      room: { id: 'plaza', name: '林间广场', status: 'active', capacity: 5, width: 24, height: 16, world_revision: 0 },
      agents: {}, controllers: {}, groups: {}, invitations: {}, game: null, events: [], receipts: {}, controlReceipts: {}, sequence: 0,
    };
    if (saved) {
      for (const a of Object.values(this.state.agents)) {
        this.finishActivity(a, { cancelled: true });
        a.session_epoch++; a.status = 'offline'; a.group_id = null; a.last_contact_at = null; a.reserved_until = null; a.next_action_id = null;
        a.diagnostics = { state: 'waiting', calls_used: a.diagnostics?.calls_used || 0, last_error: null };
      }
      this.state.groups = {}; this.state.invitations = {};
      if (this.state.game && this.state.game.status !== 'finished') this.finishGame('服务重启，活动已中断');
      this.event('server_restarted', { text: '服务已恢复，等待控制端重新连接' }, []);
    }
    this.save();
  }
  save() { this.db.prepare('INSERT INTO world_state(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify(this.state)); }
  commit() { this.save(); this.emit('change'); }
  close() { this.save(); this.db.close(); }
  event(type, payload, recipients = []) {
    const revision = ++this.state.room.world_revision;
    const cursor = String(++this.state.sequence);
    const event = { event_id: `evt_${cursor}`, type, occurred_at: this.now(), world_revision: revision, cursor, payload, recipients: [...new Set(recipients)] };
    this.state.events.push(event); return event;
  }
  agent(id) { const a = this.state.agents[id]; if (!a) fail('NOT_FOUND', '角色不存在'); return a; }
  ownerOf(id) { return this.agent(id).owner_id || 'local-owner'; }
  claimLegacyOwner(ownerId) {
    let changed = false;
    for (const a of Object.values(this.state.agents)) if (!a.is_platform && (!a.owner_id || a.owner_id === 'local-owner')) { a.owner_id = ownerId; changed = true; }
    if (changed) this.commit();
  }
  snapshotFor(owner) {
    const snapshot = this.ownerSnapshot();
    const ownIds = new Set(Object.values(this.state.agents).filter(a => !a.is_platform && this.ownerOf(a.agent_id) === owner.id).map(a => a.agent_id));
    snapshot.agents = snapshot.agents.map(a => ownIds.has(a.agent_id) ? { ...a, is_mine: true } : { ...this.publicAgent(this.agent(a.agent_id)), is_mine: false });
    snapshot.controllers = snapshot.controllers.filter(c => ownIds.has(c.agent_id));
    snapshot.viewer = owner;
    return snapshot;
  }
  auth(auth) {
    const c = this.state.controllers[auth?.controller_id];
    if (!c || c.revoked || c.agent_id !== auth?.agent_id) fail('NOT_AUTHORIZED', '控制端授权无效');
    return { a: this.agent(c.agent_id), c };
  }
  createAgent(input = {}) {
    const name = textField(input.name, 20, '名字'); if (!name) fail('INVALID_ACTION', '请填写角色名字');
    const a = { agent_id: uid('agent'), owner_id: input.owner_id || 'local-owner', name, bio: textField(input.bio, 200, '介绍'), avatar: textField(input.avatar, 20, '头像', '🌱'),
      color: /^#[0-9a-f]{6}$/i.test(input.color || '') ? input.color : '#609279', is_platform: input.is_platform === true,
      position: { x: 9 + (Object.keys(this.state.agents).length % 3), y: 7 + (Object.keys(this.state.agents).length % 2) },
      status: 'offline', session_epoch: 0, group_id: null, activity: null, run: null, goal: '', diagnostics: { state: 'waiting', calls_used: 0, last_error: null },
      pause_reason: null, next_action_id: null, last_contact_at: null, last_action_at: null, reserved_until: null };
    this.state.agents[a.agent_id] = a; this.commit(); return this.publicAgent(a);
  }
  createController(agentId, { name = '参考运行器', kind = 'external' } = {}) {
    this.agent(agentId);
    if (!['demo', 'external'].includes(kind)) fail('INVALID_ACTION', '控制端类型无效');
    const token = randomBytes(32).toString('base64url');
    const c = { controller_id: uid('controller'), agent_id: agentId, name: textField(name, 40, '控制端名称'), kind, token_hash: hash(token), revoked: false };
    this.state.controllers[c.controller_id] = c; this.commit();
    return { controller_id: c.controller_id, agent_id: agentId, name: c.name, kind, token };
  }
  authenticate(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) fail('NOT_AUTHORIZED', '请提供有效的控制端令牌');
    const digest = hash(token); const c = Object.values(this.state.controllers).find(c => !c.revoked && c.token_hash === digest);
    if (!c) fail('NOT_AUTHORIZED', '控制端令牌无效或已撤销');
    return { agent_id: c.agent_id, controller_id: c.controller_id };
  }
  ownerControl(id, operation, options = {}) {
    this.tick(); const a = this.agent(id);
    if (['start', 'resume', 'transfer'].includes(operation)) {
      if (this.state.room.status === 'paused') fail('ROOM_PAUSED', '房间已暂停，请先恢复房间');
      const controllerId = options.controller_id || a.run?.controller_id || Object.values(this.state.controllers).find(c => c.agent_id === id && !c.revoked)?.controller_id;
      const c = this.state.controllers[controllerId];
      if (!c || c.agent_id !== id || c.revoked) fail('NOT_AUTHORIZED', '请选择此角色的有效控制端');
      const minutes = Number(options.duration_minutes ?? 15); const calls = Number(options.max_calls ?? 100);
      if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 10080 || !Number.isInteger(calls) || calls < 1 || calls > 10000) fail('INVALID_ACTION', '运行期限须在 0–10080 分钟（最长 7 天），调用上限须为 1–10000 次');
      if (operation !== 'transfer' && a.run?.status === 'active') fail('CONTROLLER_BUSY', '已有有效授权，请暂停后恢复或明确转交控制权');
      const goal = textField(options.goal, 300, '活动目标', a.goal || '认识一位新朋友，尝试词语接龙');
      const hadSlot = a.status === 'active' || (a.reserved_until || 0) > this.now();
      this.detach(a); a.session_epoch++; a.status = 'offline'; a.pause_reason = null; a.goal = goal;
      a.reserved_until = hadSlot ? this.now() + 120000 : null;
      a.run = { run_id: uid('run'), controller_id: controllerId, status: 'active', expires_at: this.now() + minutes * 60000, max_calls: calls, goal, has_joined: false };
      a.diagnostics = { state: 'waiting', calls_used: 0, last_error: null }; a.last_action_at = null; a.next_action_id = null;
      this.event(operation === 'transfer' ? 'control_transferred' : 'run_authorized', { agent_id: id, text: `${a.name}已获准活动，等待控制端入场` }, [id]);
    } else if (operation === 'pause') this.pause(a, '主人暂停');
    else if (operation === 'recall') this.recall(a, '主人召回');
    else fail('INVALID_ACTION', '未知主人控制操作');
    this.commit(); return this.controlState(a);
  }
  ownerRoom(operation) {
    if (!['pause', 'resume'].includes(operation)) fail('INVALID_ACTION', '房间操作无效');
    this.state.room.status = operation === 'pause' ? 'paused' : 'active';
    if (operation === 'pause') {
      if (this.state.game && this.state.game.status !== 'finished') this.finishGame('房间暂停');
      for (const a of Object.values(this.state.agents)) if (a.run?.status === 'active') this.pause(a, '房间暂停');
    }
    this.event('room_state', { text: operation === 'pause' ? '房间已暂停' : '房间已恢复，角色需要主人重新允许开始', status: this.state.room.status }, []);
    this.commit(); return clone(this.state.room);
  }
  pause(a, reason) {
    if (a.status === 'paused' && a.run?.status === 'paused') return;
    const occupied = a.status === 'active'; this.detach(a); a.session_epoch++; a.status = 'paused'; a.pause_reason = reason;
    if (a.run) a.run.status = 'paused'; a.reserved_until = occupied ? this.now() + 120000 : null; a.next_action_id = null;
    a.diagnostics.state = 'paused';
    this.event('agent_paused', { agent_id: a.agent_id, text: `${a.name}已暂停：${reason}`, reason }, [a.agent_id]);
  }
  recall(a, reason) {
    if (a.status === 'offline' && a.run?.status === 'closed') return;
    this.detach(a); a.session_epoch++; a.status = 'offline'; a.pause_reason = reason; a.reserved_until = null; a.next_action_id = null;
    if (a.run) a.run.status = 'closed'; a.diagnostics.state = 'offline';
    this.event('agent_left', { agent_id: a.agent_id, text: `${a.name}离开了广场`, reason }, this.activeIds());
  }
  detach(a) {
    this.finishActivity(a, { cancelled: true });
    this.removeFromGame(a.agent_id);
    if (a.group_id) {
      const group = this.state.groups[a.group_id];
      if (group) { group.members = group.members.filter(id => id !== a.agent_id); if (!group.members.length) delete this.state.groups[group.group_id]; }
      a.group_id = null;
    }
    for (const i of Object.values(this.state.invitations)) if (i.status === 'pending' && (i.target_agent_id === a.agent_id || i.from_agent_id === a.agent_id)) i.status = 'cancelled';
  }
  activeIds() { return Object.values(this.state.agents).filter(a => a.status === 'active').map(a => a.agent_id); }
  controlState(a) { return clone({ agent_id: a.agent_id, controller_id: a.run?.controller_id || null, session_epoch: a.session_epoch, status: a.status, run: a.run, reason: a.pause_reason, diagnostics: a.diagnostics }); }
  publicAgent(a) { return clone({ agent_id: a.agent_id, name: a.name, bio: a.bio, avatar: a.avatar, color: a.color, is_platform: a.is_platform, position: a.position, status: a.status, group_id: a.group_id, activity: publicActivity(a.activity), session_epoch: a.session_epoch }); }
  publicSnapshot() {
    return clone({ room: this.state.room, agents: Object.values(this.state.agents).map(a => this.publicAgent(a)), groups: Object.values(this.state.groups), game: this.state.game,
      places: PLACES, activities: ACTIVITIES, events: this.state.events.slice(-150).map(({ recipients, ...event }) => event), server_time: this.now() });
  }
  ownerSnapshot() {
    const snap = this.publicSnapshot();
    snap.agents = Object.values(this.state.agents).map(a => ({ ...this.publicAgent(a), run: clone(a.run), goal: a.goal, diagnostics: clone(a.diagnostics), pause_reason: a.pause_reason }));
    snap.controllers = Object.values(this.state.controllers).filter(c => !c.revoked).map(({ token_hash, revoked, ...c }) => clone(c));
    return snap;
  }
  getRules() {
    return { world_api_version: '0.2', skill_version: '0.1.0', rules_version: '0.5-activities', room: { capacity: 5, width: 24, height: 16 },
      places: clone(PLACES), activities: clone(ACTIVITIES), max_duration_minutes: 10080,
      visible_radius: 6, speech_radius: 4, max_move: 3, max_text_length: 200, action_interval_ms: this.actionIntervalMs,
      invitation_seconds: 30, invitation_cooldown_seconds: 60, lease_seconds: 45, event_window_seconds: 600,
      game: { type: 'word_chain', word_version: WORD_VERSION, words: WORDS, registration_seconds: 30, turn_seconds: 30, max_valid_words: 10 },
      words: WORDS, word_version: WORD_VERSION, allowed_actions: ACTIONS, notice: '这是公开广场；其他参与者可能使用模型处理你的公开发言。模拟运行器不调用模型。' };
  }
  validateSession(a, c, args, { touch = false } = {}) {
    if (!a.run || a.run.controller_id !== c.controller_id) fail('CONTROLLER_BUSY', '当前控制权属于其他控制端或尚未授权');
    if (args.run_id !== a.run.run_id || args.session_epoch !== a.session_epoch) fail('STALE_SESSION', '会话已失效，请读取控制状态');
    if (a.run.expires_at <= this.now()) fail('RUN_EXPIRED', '本次授权已到期，需要主人重新恢复');
    if (a.status !== 'active' || a.run.status !== 'active') fail('STALE_SESSION', '角色当前未活动');
    if (this.state.room.status !== 'active') fail('ROOM_PAUSED', '房间已暂停');
    if (touch) { a.last_contact_at = this.now(); this.save(); }
  }
  observation(a) {
    const group = a.group_id ? this.state.groups[a.group_id] : null;
    return clone({ world_api_version: '0.2', run_id: a.run.run_id, session_epoch: a.session_epoch, expires_at: a.run.expires_at,
      self: this.publicAgent(a), nearby_agents: Object.values(this.state.agents).filter(b => b.agent_id !== a.agent_id && b.status === 'active' && distance(a.position, b.position) <= 6).map(b => this.publicAgent(b)),
      group, game: group && this.state.game?.group_id === group.group_id ? this.state.game : null,
      invitations: Object.values(this.state.invitations).filter(i => i.target_agent_id === a.agent_id && i.status === 'pending' && i.expires_at > this.now()),
      places: PLACES, activities: ACTIVITIES, server_time: this.now(), cursor: String(this.state.sequence), world_revision: this.state.room.world_revision, next_action_id: a.next_action_id, allowed_actions: ACTIONS });
  }
  join(a, c, args) {
    if (this.state.room.status !== 'active') fail('ROOM_PAUSED', '房间暂停中');
    if (!a.run || a.run.controller_id !== c.controller_id) fail('CONTROLLER_BUSY', '请主人授权此控制端入场');
    if (args.run_id && args.run_id !== a.run.run_id) fail('STALE_SESSION', '恢复的预算段已经失效');
    if (a.run.expires_at <= this.now()) fail('RUN_EXPIRED', '活动许可已到期');
    if (a.run.status !== 'active') fail('NOT_AUTHORIZED', '活动许可已关闭，请主人重新允许开始');
    if (a.status === 'active') { a.last_contact_at = this.now(); this.save(); return this.observation(a); }
    const occupied = Object.values(this.state.agents).filter(b => b.agent_id !== a.agent_id && (b.status === 'active' || (b.reserved_until || 0) > this.now()));
    if (occupied.length >= 5) fail('ROOM_FULL', '广场已满，最多允许 5 个 AI 同时活动');
    a.status = 'active'; a.run.has_joined = true; a.last_contact_at = this.now(); a.reserved_until = null; a.next_action_id = uid('act'); a.pause_reason = null;
    this.event('agent_joined', { agent_id: a.agent_id, name: a.name, text: `${a.name}来到了广场` }, Object.values(this.state.agents).filter(b => b.status === 'active' && distance(a.position, b.position) <= 6).map(b => b.agent_id));
    this.commit(); return this.observation(a);
  }
  callTool(auth, name, args = {}) {
    this.tick(); const { a, c } = this.auth(auth);
    if (name === 'get_rules') return this.getRules();
    if (name === 'test_connection') return { ok: true, isolated: true, step: args.step || 'all', world_api_version: '0.2', skill_version: '0.1.0',
      observation: { self: { agent_id: 'test-agent', position: { x: 0, y: 0 } }, nearby_agents: [] }, events: [{ event_id: 'test-event', type: 'test', payload: { text: '隔离测试事件' } }], action: { status: 'validated', applied: false }, continuous: false };
    if (name === 'get_control_state') return { ...this.controlState(a), auth_controller_id: c.controller_id };
    if (name === 'join_world') return this.join(a, c, args);
    if (name === 'get_action_result') {
      const receipt = this.state.receipts[`${a.agent_id}:${args.action_id}`];
      if (!receipt) return { status: 'not_found', action_id: args.action_id };
      if (receipt.controller_id !== c.controller_id) fail('NOT_AUTHORIZED', '不能读取其他控制端的动作结果');
      return clone(receipt.result);
    }
    if (name === 'act') return this.act(a, c, args);
    if (name === 'pause_self' || name === 'leave_world') {
      const key = `${a.agent_id}:${c.controller_id}:${args.run_id}:${args.session_epoch}:${name}`; const old = this.state.controlReceipts[key];
      const digest = stable(args);
      if (old) { if (old.digest !== digest) fail('IDEMPOTENCY_CONFLICT', '控制请求参数与第一次不一致'); return clone(old.result); }
      this.validateSession(a, c, args);
      const reason = textField(args.reason, 200, '原因', name === 'pause_self' ? '运行器主动暂停' : '任务完成');
      if (name === 'pause_self') this.pause(a, reason); else this.recall(a, reason);
      const result = this.controlState(a); this.state.controlReceipts[key] = { digest, result, at: this.now() }; this.commit(); return result;
    }
    if (name === 'observe') { this.validateSession(a, c, args, { touch: true }); return this.observation(a); }
    if (name === 'get_events') {
      this.validateSession(a, c, args, { touch: true });
      return this.peekEvents(auth, args);
    }
    if (name === 'report_status') {
      this.validateSession(a, c, args);
      const state = args.state ?? args.status ?? 'waiting';
      if (!['waiting', 'thinking', 'error', 'paused', 'acting', 'idle'].includes(state)) fail('INVALID_ACTION', '执行状态无效');
      const count = Number(args.calls_used ?? args.call_count ?? a.diagnostics.calls_used);
      if (!Number.isSafeInteger(count) || count < a.diagnostics.calls_used) fail('INVALID_ACTION', '调用计数必须单调递增');
      a.diagnostics = { state, calls_used: count, last_error: args.last_error == null ? null : textField(args.last_error, 300, '最近错误'), reported_at: this.now(), last_cycle_at: args.last_cycle_at ?? this.now() };
      this.commit(); return { ok: true, control_state: this.controlState(a) };
    }
    fail('INVALID_ACTION', '未知工具');
  }
  peekEvents(auth, args = {}) {
    const { a, c } = this.auth(auth);
    if (a.run?.controller_id !== c.controller_id || a.run?.run_id !== args.run_id || a.session_epoch !== args.session_epoch || a.status !== 'active') {
      return { events: [], next_cursor: String(this.state.sequence), control_state: this.controlState(a), server_time: this.now() };
    }
    const cursor = args.cursor === undefined ? this.state.sequence : Number(args.cursor);
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > this.state.sequence) fail('INVALID_ACTION', '事件游标无效');
    const recent = this.state.events.filter(e => e.occurred_at >= this.now() - 600000);
    const earliestRetained = this.state.events.length ? Number(this.state.events[0].cursor) : this.state.sequence + 1;
    const expired = cursor < earliestRetained - 1 || this.state.events.some(e => Number(e.cursor) > cursor && e.occurred_at < this.now() - 600000);
    return { events: expired ? [] : clone(recent.filter(e => Number(e.cursor) > cursor && e.recipients.includes(a.agent_id))), next_cursor: String(this.state.sequence),
      control_state: this.controlState(a), server_time: this.now(), ...(expired ? { cursor_expired: true, snapshot: this.observation(a) } : {}) };
  }
  act(a, c, args) {
    const key = `${a.agent_id}:${args.action_id}`; const digest = stable(args); const old = this.state.receipts[key];
    if (old) {
      if (old.controller_id !== c.controller_id) fail('NOT_AUTHORIZED', '不能读取其他控制端的动作结果');
      if (old.digest !== digest) fail('IDEMPOTENCY_CONFLICT', '同一动作 ID 不能更改内容');
      return clone(old.result);
    }
    this.validateSession(a, c, args, { touch: true });
    if (!args.action_id || args.action_id !== a.next_action_id) fail('STALE_SESSION', '请使用服务器发放的 next_action_id');
    if (a.last_action_at !== null && this.now() - a.last_action_at < this.actionIntervalMs) fail('RATE_LIMITED', '动作太快，请稍后使用同一动作 ID 重试', { retry_after_ms: this.actionIntervalMs - (this.now() - a.last_action_at) });
    const backup = clone(this.state); const previousCursor = this.state.sequence;
    let outcome; let error;
    try { outcome = this.perform(a, args.type, args.payload || {}); }
    catch (e) { if (!(e instanceof WorldError)) throw e; this.state = backup; a = this.state.agents[a.agent_id]; error = { code: e.code, message: e.message, ...e.details }; }
    a.next_action_id = uid('act'); a.last_action_at = this.now();
    const result = { action_id: args.action_id, status: error ? 'rejected' : 'applied', ...(error ? { error } : outcome), world_revision: this.state.room.world_revision,
      event_ids: this.state.events.filter(e => Number(e.cursor) > previousCursor).map(e => e.event_id), next_action_id: a.next_action_id };
    this.state.receipts[key] = { controller_id: c.controller_id, digest, result, at: this.now() }; this.commit(); return clone(result);
  }
  groupOf(a, id) { const group = this.state.groups[id]; if (!group || a.group_id !== id || !group.members.includes(a.agent_id)) fail('NOT_IN_GROUP', '你不在此小组'); return group; }
  finishActivity(a, { cancelled = false, answer } = {}) {
    if (!a.activity) { delete a.activity_answer; return null; }
    const activity = publicActivity(a.activity);
    let result;
    if (!cancelled) {
      if (activity.activity_id === 'solo_game') {
        const score = Number.isSafeInteger(answer) && answer === a.activity_answer ? 1 : 0;
        result = { summary: answer === undefined ? '心算挑战结束，未提交答案：0 / 1 分。' : `心算挑战${score ? '答对了' : '答错了'}：${score} / 1 分。`, score, max_score: 1 };
      } else result = { summary: activity.activity_id === 'read' ? '本次阅读时段已结束。' : `${activity.name}时段已结束。` };
    }
    a.activity = null; delete a.activity_answer;
    const outcome = cancelled ? 'cancelled' : 'completed';
    this.event('activity_finished', { agent_id: a.agent_id, name: a.name, activity_id: activity.activity_id, activity_name: activity.name,
      place_id: activity.place_id, started_at: activity.started_at, ends_at: activity.ends_at, outcome, ...(result ? { result } : {}),
      text: `${a.name}${cancelled ? '结束了' : '完成了'}「${activity.name}」${result ? `：${result.summary}` : ''}` },
    this.activeIds().filter(id => id === a.agent_id || distance(this.agent(id).position, a.position) <= 6));
    return { activity: null, outcome, ...(result ? { result } : {}) };
  }
  perform(a, type, p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) fail('INVALID_ACTION', '动作参数必须为对象');
    if (type === 'wait') return {};
    if (type === 'start_activity') {
      if (Object.keys(p).some(key => key !== 'activity_id') || typeof p.activity_id !== 'string') fail('INVALID_ACTION', '开始活动只接受 activity_id');
      const activity = ACTIVITIES.find(item => item.id === p.activity_id);
      if (!activity) fail('INVALID_ACTION', '请选择活动目录中的活动');
      if (a.activity) fail('ACTIVITY_BUSY', '已有进行中的活动，请先结束或离开');
      const game = this.state.game;
      if (game && game.status !== 'finished' && game.participants.includes(a.agent_id)) fail('GAME_BUSY', '参加接龙期间不能开始独处活动');
      const place = PLACES.find(item => item.id === activity.place_id);
      if (distance(a.position, place) > place.radius) fail('INVALID_ACTION', `请先走到${place.name}附近 ${place.radius} 格内`);
      a.activity = { activity_id: activity.id, name: activity.name, place_id: activity.place_id, started_at: this.now(), ends_at: this.now() + activity.duration_seconds * 1000 };
      if (activity.id === 'solo_game') {
        const left = randomInt(1, 21), right = randomInt(1, 21);
        a.activity.task = { kind: 'addition', prompt: `${left} + ${right} = ?`, answer_type: 'integer' };
        a.activity_answer = left + right;
      }
      this.event('activity_started', { agent_id: a.agent_id, name: a.name, activity_id: activity.id, activity_name: activity.name, place_id: activity.place_id,
        started_at: a.activity.started_at, ends_at: a.activity.ends_at, text: `${a.name}开始了「${activity.name}」` },
      this.activeIds().filter(id => distance(this.agent(id).position, a.position) <= 6));
      return { activity: publicActivity(a.activity), ...(activity.content ? { content: clone(activity.content) } : {}) };
    }
    if (type === 'finish_activity') {
      if (Object.keys(p).some(key => key !== 'answer') || p.answer !== undefined && !Number.isSafeInteger(p.answer)) fail('INVALID_ACTION', '结束活动只接受可选的整数 answer');
      if (!a.activity) fail('INVALID_ACTION', '没有进行中的独处活动');
      if (p.answer !== undefined && a.activity.activity_id !== 'solo_game') fail('INVALID_ACTION', '只有心算挑战接受 answer');
      return this.finishActivity(a, { cancelled: p.answer === undefined, answer: p.answer });
    }
    if (type === 'move') {
      if (!Number.isInteger(p.x) || !Number.isInteger(p.y) || p.x < 0 || p.x >= 24 || p.y < 0 || p.y >= 16 || distance(a.position, p) > 3) fail('INVALID_ACTION', '目标须在 24×16 地图内，每次最多移动 3 格');
      this.finishActivity(a, { cancelled: true });
      a.position = { x: p.x, y: p.y };
      this.event('agent_moved', { agent_id: a.agent_id, position: a.position, text: `${a.name}走到了 (${p.x}, ${p.y})` }, this.activeIds().filter(id => distance(this.agent(id).position, a.position) <= 6)); return { position: a.position };
    }
    if (type === 'say') {
      const text = textField(p.text, 200, '发言'); if (!text) fail('INVALID_ACTION', '发言不能为空');
      if (!['nearby', 'group'].includes(p.channel)) fail('INVALID_ACTION', '发言频道必须是 nearby 或 group');
      const recipients = p.channel === 'group' ? this.groupOf(a, p.group_id).members : this.activeIds().filter(id => distance(this.agent(id).position, a.position) <= 4);
      this.event('message', { agent_id: a.agent_id, name: a.name, text, channel: p.channel, ...(p.channel === 'group' ? { group_id: p.group_id } : {}) }, recipients); return {};
    }
    if (type === 'create_group') {
      if (a.group_id) fail('INVALID_ACTION', '每个角色同时只能加入一个小组');
      const group = { group_id: uid('group'), name: `${a.name}的小聚`, members: [a.agent_id], created_at: this.now() };
      this.state.groups[group.group_id] = group; a.group_id = group.group_id;
      this.event('group_created', { agent_id: a.agent_id, group_id: group.group_id, text: `${a.name}发起了一个公开小组` }, this.activeIds().filter(id => distance(this.agent(id).position, a.position) <= 6)); return { group_id: group.group_id };
    }
    if (type === 'invite') {
      const group = this.groupOf(a, p.group_id); const target = this.state.agents[p.target_agent_id];
      if (!target || target.agent_id === a.agent_id || target.status !== 'active' || distance(a.position, target.position) > 4) fail('INVALID_ACTION', '只能邀请 4 格内正在活动的其他角色');
      if (target.group_id || group.members.length >= 5) fail('INVALID_ACTION', '对方已有小组或此小组已满');
      if (Object.values(this.state.invitations).some(i => i.from_agent_id === a.agent_id && i.target_agent_id === target.agent_id && this.now() - i.created_at < 60000)) fail('INVITE_COOLDOWN', '同对象邀请间隔至少 60 秒');
      const invitation = { invite_id: uid('invite'), group_id: group.group_id, from_agent_id: a.agent_id, target_agent_id: target.agent_id, expires_at: this.now() + 30000, created_at: this.now(), status: 'pending' };
      this.state.invitations[invitation.invite_id] = invitation;
      this.event('invitation', { ...invitation, agent_id: a.agent_id, text: `${a.name}邀请${target.name}加入小组` }, [a.agent_id, target.agent_id]); return { invite_id: invitation.invite_id, expires_at: invitation.expires_at };
    }
    if (type === 'respond_invite') {
      const i = this.state.invitations[p.invite_id];
      if (!i || i.target_agent_id !== a.agent_id) fail('NOT_AUTHORIZED', '邀请不属于此角色');
      if (i.status !== 'pending' || i.expires_at <= this.now()) fail('INVITE_EXPIRED', '邀请已失效');
      if (typeof p.accept !== 'boolean') fail('INVALID_ACTION', 'accept 必须为布尔值');
      const group = this.state.groups[i.group_id];
      if (!group || (p.accept && (a.group_id || group.members.length >= 5))) fail('INVALID_ACTION', '已加入其他小组，或目标小组不可用');
      i.status = p.accept ? 'accepted' : 'declined';
      if (p.accept) { group.members.push(a.agent_id); a.group_id = group.group_id; }
      this.event(p.accept ? 'group_joined' : 'invitation_declined', { agent_id: a.agent_id, group_id: group.group_id, text: `${a.name}${p.accept ? '加入了' : '婉拒了'}${group.name}` }, [...group.members, i.from_agent_id]); return { group_id: p.accept ? group.group_id : null };
    }
    if (type === 'leave_group') {
      const group = this.groupOf(a, p.group_id); const recipients = [...group.members]; this.detach(a);
      this.event('group_left', { agent_id: a.agent_id, group_id: p.group_id, text: `${a.name}离开了小组` }, recipients); return {};
    }
    if (type === 'propose_game') {
      const group = this.groupOf(a, p.group_id);
      if (p.game_type && p.game_type !== 'word_chain') fail('INVALID_ACTION', '首版只支持 word_chain 词语接龙');
      if (this.state.game && this.state.game.status !== 'finished') fail('GAME_BUSY', '房间同时只能进行一局游戏');
      this.state.game = { game_id: uid('game'), group_id: group.group_id, status: 'recruiting', participants: [a.agent_id], responses: { [a.agent_id]: true }, current_agent_id: null,
        turn_id: null, deadline: this.now() + 30000, last_word: null, words: [], scores: {}, end_reason: null, valid_count: 0, timeouts: {}, consecutive_skips: 0, word_version: WORD_VERSION };
      this.event('game_proposed', { agent_id: a.agent_id, game_id: this.state.game.game_id, group_id: group.group_id, text: `${a.name}发起词语接龙，30 秒内可报名` }, group.members); return { game_id: this.state.game.game_id };
    }
    if (type === 'respond_game') {
      const game = this.state.game;
      if (!game || game.game_id !== p.game_id || game.status !== 'recruiting' || game.deadline <= this.now()) fail('STALE_TURN', '游戏报名已结束');
      this.groupOf(a, game.group_id);
      if (typeof p.accept !== 'boolean') fail('INVALID_ACTION', 'accept 必须为布尔值');
      game.responses[a.agent_id] = p.accept;
      game.participants = game.participants.filter(id => id !== a.agent_id); if (p.accept) game.participants.push(a.agent_id);
      this.event('game_registered', { agent_id: a.agent_id, game_id: game.game_id, text: `${a.name}${p.accept ? '报名参加' : '选择围观'}词语接龙` }, this.state.groups[game.group_id].members); return { participants: game.participants };
    }
    if (type === 'submit_word') {
      const game = this.state.game;
      if (!game || game.game_id !== p.game_id || game.status !== 'active' || game.turn_id !== p.turn_id || game.current_agent_id !== a.agent_id || game.deadline <= this.now()) fail('STALE_TURN', '不是你的有效回合，请重新观察');
      if (!WORDS.includes(p.word) || p.word[0] !== game.last_word.at(-1) || game.words.includes(p.word)) fail('INVALID_WORD', '答案须在词库中、首尾相接且本局未使用');
      game.words.push(p.word); game.last_word = p.word; game.valid_count++; game.scores[a.agent_id] = (game.scores[a.agent_id] || 0) + 1; game.timeouts[a.agent_id] = 0; game.consecutive_skips = 0;
      this.event('word_submitted', { agent_id: a.agent_id, game_id: game.game_id, word: p.word, text: `${a.name}接上「${p.word}」`, valid_count: game.valid_count }, this.state.groups[game.group_id]?.members || game.participants);
      if (game.valid_count >= 10) this.finishGame('完成 10 次有效接词');
      else if (!WORDS.some(w => w[0] === p.word.at(-1) && !game.words.includes(w))) this.finishGame('词库没有未使用的后继词');
      else this.nextTurn(); return { game: clone(game) };
    }
    if (type === 'leave_game') {
      const game = this.state.game; if (!game || game.game_id !== p.game_id || !game.participants.includes(a.agent_id)) fail('INVALID_ACTION', '你没有参加此游戏');
      this.removeFromGame(a.agent_id); return {};
    }
    fail('INVALID_ACTION', '动作类型不支持');
  }
  startGame() {
    const game = this.state.game;
    game.participants = game.participants.filter(id => this.state.agents[id]?.status === 'active' && this.state.agents[id].group_id === game.group_id);
    if (game.participants.length < 2) { this.finishGame('报名人数不足 2 人'); return; }
    for (const id of game.participants) this.finishActivity(this.agent(id), { cancelled: true });
    game.status = 'active'; game.last_word = '天气'; game.words = ['天气']; game.current_agent_id = game.participants[0]; game.turn_id = uid('turn'); game.deadline = this.now() + 30000;
    this.event('game_started', { game_id: game.game_id, group_id: game.group_id, word: '天气', text: '词语接龙开始！从「天气」接起' }, this.state.groups[game.group_id]?.members || game.participants);
    this.turnEvent();
  }
  turnEvent() { const g = this.state.game; this.event('game_turn', { game_id: g.game_id, turn_id: g.turn_id, agent_id: g.current_agent_id, deadline: g.deadline, last_word: g.last_word, text: `轮到${this.agent(g.current_agent_id).name}接词` }, this.state.groups[g.group_id]?.members || g.participants); }
  nextTurn(nextId) {
    const g = this.state.game;
    if (g.participants.length < 2) { this.finishGame('剩余参与者不足 2 人'); return; }
    g.current_agent_id = nextId || g.participants[(g.participants.indexOf(g.current_agent_id) + 1) % g.participants.length];
    g.turn_id = uid('turn'); g.deadline = this.now() + 30000; this.turnEvent();
  }
  finishGame(reason) {
    const g = this.state.game; if (!g || g.status === 'finished') return;
    g.status = 'finished'; g.end_reason = reason; g.current_agent_id = null; g.deadline = null;
    this.event('game_finished', { game_id: g.game_id, group_id: g.group_id, valid_count: g.valid_count, scores: g.scores, text: `接龙结束：${reason}`, reason }, this.state.groups[g.group_id]?.members || g.participants);
  }
  removeFromGame(agentId) {
    const g = this.state.game; if (!g || g.status === 'finished' || !g.participants.includes(agentId)) return;
    const wasCurrent = g.current_agent_id === agentId; const nextId = g.participants[(g.participants.indexOf(agentId) + 1) % g.participants.length];
    g.participants = g.participants.filter(id => id !== agentId);
    if (g.status === 'active') { if (g.participants.length < 2) this.finishGame('剩余参与者不足 2 人'); else if (wasCurrent) this.nextTurn(nextId); }
  }
  tick() {
    let changed = false; const now = this.now();
    for (const a of Object.values(this.state.agents)) {
      if (a.run?.status === 'active' && a.run.expires_at <= now) { this.pause(a, '授权时间已到'); changed = true; }
      else if (a.status === 'active' && a.last_contact_at !== null && now - a.last_contact_at >= 45000) {
        this.detach(a); a.session_epoch++; a.status = 'offline'; a.next_action_id = null; a.reserved_until = null; a.diagnostics.state = 'offline';
        this.event('agent_offline', { agent_id: a.agent_id, text: `${a.name}的控制端已离线` }, this.activeIds()); changed = true;
      }
      if (a.status === 'active' && a.activity?.ends_at <= now) { this.finishActivity(a); changed = true; }
      if (a.reserved_until && a.reserved_until <= now) { a.reserved_until = null; changed = true; }
      if (a.diagnostics.state === 'thinking' && now - a.diagnostics.reported_at > 10000) { a.diagnostics.state = 'stale'; changed = true; }
    }
    for (const i of Object.values(this.state.invitations)) if (i.status === 'pending' && i.expires_at <= now) { i.status = 'expired'; changed = true; }
    const game = this.state.game;
    if (game?.status === 'recruiting' && game.deadline <= now) { this.startGame(); changed = true; }
    else if (game?.status === 'active' && game.deadline <= now) {
      const id = game.current_agent_id; game.timeouts[id] = (game.timeouts[id] || 0) + 1; game.consecutive_skips++;
      this.event('game_timeout', { agent_id: id, game_id: game.game_id, text: `${this.agent(id).name}本轮超时` }, this.state.groups[game.group_id]?.members || game.participants);
      if (game.consecutive_skips >= game.participants.length) this.finishGame('一整轮参与者均超时');
      else if (game.timeouts[id] >= 2) this.removeFromGame(id); else this.nextTurn(); changed = true;
    }
    const cutoff = now - 7 * 24 * 3600000;
    if (this.state.events[0]?.occurred_at < cutoff) { this.state.events = this.state.events.filter(e => e.occurred_at >= cutoff); changed = true; }
    for (const collection of [this.state.receipts, this.state.controlReceipts]) for (const [key, receipt] of Object.entries(collection)) if (receipt.at < cutoff) { delete collection[key]; changed = true; }
    if (changed) this.commit();
  }
}
