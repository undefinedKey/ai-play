import { EventEmitter } from 'node:events';
import { randomUUID, randomBytes, randomInt, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { WORDS, WORD_VERSION } from './words.js';
import { GAMES, GAME_TIMING, GAME_END_REASONS, gameName, publicGame, RIDDLES } from './games.js';
import { LEISURE_POLICY, publicLeisure, recordExperience, gameAvailability } from './leisure.js';
import { ADVENTURE_RULES, initializeAdventure, initializeFighter, publicAdventure, publicFighter, startAdventure, stopAdventure, leaveAdventureField, tickAdventure } from './adventure.js';
import { WORLD_MAP, MAX_MOVE, movementOptions, SCENES, sameScene, initializeScene, findPath, recordMovement, publicMovement } from './spatial.js';
import { LIFE_RULES, initializeLife, publicLife, performLife, tickLife, cancelGather } from './life.js';
import { initializeEconomy, economyBalance, recordEconomyDelta } from './economy.js';
import { opportunitiesFor } from './opportunities.js';
import { FATIGUE_RULES, initializeFatigue, publicFatigue, spendEnergy, captureFatigueRecovery, tickFatigue } from './fatigue.js';
import { initializeAppearance, publicAppearance } from './appearance.js';
import { initializePresence, seenPresence, departPresence, publicPresence } from './presence.js';
import { runtimeReport } from './runtime-health.js';
import { encounterPending, endEncounter, tickEncounter, performAdventureEvent } from './exploration.js';
import { PERSONAL_GOAL_RULES, initializePersonalGoal, publicPersonalGoal, reviewPersonalGoal, tickPersonalGoals, performPersonalGoal, progressPersonalGoal } from './personal-goals.js';
import { COOPERATION_RULES, initializeCooperations, publicCooperations, cooperationObservation, reviewCooperations, endCooperations, tickCooperations, performCooperation } from './cooperation.js';
import { publicEvent } from './spectator.js';
import { initializeHistory, recordHistoryEvent, pruneHistory, historyPage, historyMetadata } from './history.js';

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
const ACTIONS = ['move', 'say', 'create_group', 'invite', 'respond_invite', 'leave_group', 'propose_game', 'respond_game', 'submit_word', 'submit_move', 'submit_story', 'leave_game', 'start_activity', 'finish_activity', 'adventure_plan', 'adventure_event', 'personal_goal', 'cooperation', 'farm', 'inventory', 'gather', 'trade', 'wait'];
const PLACES = [
  { id: 'pond', scene_id: 'plaza', name: '薄荷小池', x: 4, y: 4, radius: 3 },
  { id: 'garden', scene_id: 'plaza', name: '中央花园', x: 11, y: 8, radius: 3 },
  { id: 'reading', scene_id: 'plaza', name: '林间书屋', x: 19, y: 4, radius: 3 },
  { id: 'play', scene_id: 'plaza', name: '独处游戏角', x: 19, y: 12, radius: 3 },
];
const ACTIVITIES = [
  { id: 'watch_pond', name: '池边看水', place_id: 'pond', duration_seconds: 45, description: '在池边停留，观察这个共享世界；可以随时离开。' },
  { id: 'relax', name: '花园休息', place_id: 'garden', duration_seconds: 60, description: '在花园休息一会儿，不必发言或等待其他角色。' },
  { id: 'read', name: '读一篇小故事', place_id: 'reading', duration_seconds: 45, description: '阅读广场原创短文；感受由角色自己决定。',
    content: { title: '一张空椅子', source: '广场原创', text: '雨停后，园丁把池边的椅子擦干，留下一张纸条：“这里可以坐。”午后，一个旅人坐下来修补背包。傍晚，他离开时把椅子挪回树荫下，又在纸条背面画了一片叶子。第二天，园丁没有问是谁画的，只在叶子旁边添了一滴水。' } },
  { id: 'solo_game', name: '心算小挑战', place_id: 'play', duration_seconds: 150, description: '开始后获得一道加法题，在限时内用 finish_activity 的 answer 提交整数答案；答对得 1 分，答错或未答得 0 分。',
    task: { kind: 'addition', answer_type: 'integer' } },
  { id: 'riddle', name: '猜谜小屋', place_id: 'reading', duration_seconds: 150, description: '开始后获得一道谜语，用 finish_activity 的字符串 answer 提交答案；答对得 1 分。', task: { kind: 'riddle', answer_type: 'string' } },
  { id: 'sequence', name: '数列挑战', place_id: 'play', duration_seconds: 150, description: '寻找等差数列规律，用 finish_activity 的整数 answer 填出下一项；答对得 1 分。', task: { kind: 'sequence', answer_type: 'integer' } },
  { id: 'treasure_hunt', name: '地图寻宝', place_id: 'garden', duration_seconds: 900, description: '依次走到距当前位置最多6格的3个随机目标格，再用 finish_activity 空参数收集；移动不会取消寻宝，限时内每找到一个得1分。', task: { kind: 'treasure_hunt', answer_type: 'none' } },
];
const publicActivity = activity => activity ? {
  activity_id: activity.activity_id, name: activity.name, place_id: activity.place_id, started_at: activity.started_at, ends_at: activity.ends_at,
  ...(activity.task ? { task: { kind: activity.task.kind, prompt: activity.task.prompt, answer_type: activity.task.answer_type } } : {}),
  ...(activity.target ? { target: { x: activity.target.x, y: activity.target.y } } : {}),
  ...(activity.progress ? { progress: { collected: activity.progress.collected, total: activity.progress.total } } : {}),
} : null;

export class World extends EventEmitter {
  constructor({ dbPath = ':memory:', now = Date.now, actionIntervalMs = 2000 } = {}) {
    super(); this.now = now; this.actionIntervalMs = actionIntervalMs;
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS world_state (id INTEGER PRIMARY KEY CHECK (id=1), payload TEXT NOT NULL)');
    const saved = this.db.prepare('SELECT payload FROM world_state WHERE id=1').get();
    this.state = saved ? JSON.parse(saved.payload) : {
      room: { id: 'plaza', name: '林间广场', status: 'active', capacity: 5, ...WORLD_MAP, world_revision: 0 },
      agents: {}, controllers: {}, groups: {}, invitations: {}, game: null, events: [], receipts: {}, controlReceipts: {}, sequence: 0,
    };
    Object.assign(this.state.room, WORLD_MAP);
    for (const a of Object.values(this.state.agents)) initializeScene(a, this.now());
    for (const a of Object.values(this.state.agents)) { initializeFatigue(a, this.now(), { restore: !!saved }); initializeAppearance(a, this.state.agents); }
    initializeAdventure(this.state, this.now());
    for (const a of Object.values(this.state.agents)) { initializeLife(a); initializeEconomy(a, this.now()); initializePersonalGoal(a); initializePresence(a, { legacy: true, events: this.state.events }); }
    initializeHistory(this); this.historyMaintenanceAt = this.now() + 60000;
    initializeCooperations(this, { restore: !!saved });
    if (saved) {
      for (const a of Object.values(this.state.agents)) {
        endEncounter(this, a); reviewPersonalGoal(this, a, 'restarted');
        cancelGather(this, a, 'restarted');
        this.finishActivity(a, { cancelled: true, interrupted: true });
        departPresence(a, this.now());
        a.session_epoch++; a.status = 'offline'; a.group_id = null; a.last_contact_at = null; a.reserved_until = null; a.next_action_id = null;
        a.diagnostics = { ...a.diagnostics, state: 'waiting', calls_used: a.diagnostics?.calls_used || 0, last_error: null };
      }
      this.state.groups = {}; this.state.invitations = {};
      if (this.state.game && this.state.game.status !== 'finished') this.finishGame('服务重启，活动已中断');
      this.event('server_restarted', { text: '服务已恢复，等待控制端重新连接' }, []);
    }
    this.save();
  }
  save({ deferred = false } = {}) {
    if (deferred) {
      // Movement and lease heartbeats share one bounded checkpoint. Authorization
      // changes and accepted AI commands still persist synchronously.
      if (!this.saveTimer) {
        this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save(); }, 5000);
        this.saveTimer.unref();
      }
      return;
    }
    clearTimeout(this.saveTimer); this.saveTimer = null;
    this.writeState ??= this.db.prepare('INSERT INTO world_state(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload');
    this.writeState.run(JSON.stringify(this.state));
  }
  commit(options) { this.save(options); this.emit('change'); }
  close() { this.save(); this.db.close(); }
  event(type, payload, recipients = []) {
    const revision = ++this.state.room.world_revision;
    const cursor = String(++this.state.sequence);
    if (this.state.agents[payload?.agent_id]) payload = { ...payload, scene_id: this.state.agents[payload.agent_id].scene_id };
    else if (type.startsWith('game_') || type === 'round_revealed') payload = { ...payload, scene_id: 'plaza' };
    else if (type === 'adventure_respawn') payload = { ...payload, scene_id: 'adventure' };
    const event = { event_id: `evt_${cursor}`, type, occurred_at: this.now(), world_revision: revision, cursor, payload, recipients: [...new Set(recipients)] };
    this.state.events.push(event);
    recordHistoryEvent(this, event);
    if (this.state.events.length > 3000) this.state.events.splice(0, this.state.events.length - 3000);
    return event;
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
    const agentIds = new Set(Object.keys(this.state.agents));
    const events = [];
    for (let i = this.state.events.length - 1; i >= 0 && events.length < 150; i--) {
      const event = this.state.events[i], payload = event.payload || {};
      // Only these private event types have an owner audience. A public event's
      // recipients (for example agent_left) are delivery hints, not permission
      // to expose its raw control metadata to every recipient's owner.
      const ownControl = ['run_authorized', 'control_transferred', 'agent_paused', 'agent_left'].includes(event.type) && ownIds.has(payload.agent_id);
      const ownInvitation = ['invitation', 'cooperation_invitation', 'cooperation_response'].includes(event.type)
        && (ownIds.has(payload.from_agent_id) || ownIds.has(payload.target_agent_id));
      const ownDecline = event.type === 'invitation_declined'
        && (ownIds.has(payload.agent_id) || event.recipients?.some(id => ownIds.has(id)));
      if (ownControl || ownInvitation || ownDecline) {
        const { recipients, ...privateEvent } = event;
        events.push(clone(privateEvent));
      } else {
        const visible = publicEvent(event, agentIds);
        if (visible) events.push(visible);
      }
    }
    snapshot.events = events.reverse();
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
      scene_id: 'plaza', position: { x: 9 + (Object.keys(this.state.agents).length % 3), y: 7 + (Object.keys(this.state.agents).length % 2) },
      status: 'offline', session_epoch: 0, group_id: null, activity: null, run: null, goal: '', diagnostics: { state: 'waiting', calls_used: 0, last_error: null },
      pause_reason: null, next_action_id: null, last_contact_at: null, last_action_at: null, reserved_until: null };
    if (input.invitation_claim !== undefined) {
      const claim = input.invitation_claim;
      if (!claim || typeof claim.invite_id !== 'string' || !/^ai_invite_[0-9a-f-]{36}$/i.test(claim.invite_id) || typeof claim.device_hash !== 'string' || !/^[0-9a-f]{64}$/i.test(claim.device_hash)) fail('INVALID_ACTION', '邀请恢复标记无效');
      a.invitation_claim = { invite_id: claim.invite_id, device_hash: claim.device_hash };
    }
    initializeScene(a, this.now());
    initializeFighter(a);
    initializePersonalGoal(a);
    initializePresence(a);
    initializeLife(a);
    initializeEconomy(a, this.now(), { initial: true });
    initializeFatigue(a, this.now());
    initializeAppearance(a, this.state.agents);
    this.state.agents[a.agent_id] = a; this.commit(); return this.publicAgent(a);
  }
  createController(agentId, { name = '参考运行器', kind = 'external', token: suppliedToken } = {}) {
    this.agent(agentId);
    if (!['demo', 'external'].includes(kind)) fail('INVALID_ACTION', '控制端类型无效');
    if (suppliedToken !== undefined && (typeof suppliedToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(suppliedToken))) fail('INVALID_ACTION', '控制端令牌格式无效');
    const token = suppliedToken ?? randomBytes(32).toString('base64url');
    if (Object.values(this.state.controllers).some(c => c.token_hash === hash(token))) fail('TOKEN_CONFLICT', '控制端凭据已被使用');
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
      if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 525600 || !Number.isInteger(calls) || calls < 1 || calls > 1000000000) fail('INVALID_ACTION', '运行期限须在 0–525600 分钟（最长 365 天），调用上限须为 1–1000000000 次');
      if (operation !== 'transfer' && a.run?.status === 'active') fail('CONTROLLER_BUSY', '已有有效授权，请暂停后恢复或明确转交控制权');
      const goal = textField(options.goal, 300, '活动目标', a.goal || '按自己的喜好探索广场，交流、散步或尝试不同活动。');
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
    this.tick();
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
    if (a.run) a.run.status = 'closed'; a.diagnostics.state = 'offline'; endCooperations(this, a);
    this.event('agent_left', { agent_id: a.agent_id, text: `${a.name}离开了广场`, reason }, this.activeIds());
  }
  detach(a, { leaveField = true } = {}) {
    if (leaveField) reviewCooperations(this, a);
    endEncounter(this, a);
    if (leaveField) reviewPersonalGoal(this, a);
    cancelGather(this, a, 'interrupted');
    departPresence(a, this.now());
    stopAdventure(this, a, 'interrupted', '控制已暂停、转交或离线，冒险计划停止');
    if (leaveField) leaveAdventureField(this, a);
    this.finishActivity(a, { cancelled: true, interrupted: leaveField });
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
  publicAgent(a) { return clone({ agent_id: a.agent_id, name: a.name, bio: a.bio, avatar: a.avatar, color: a.color, is_platform: a.is_platform, scene_id: a.scene_id, position: a.position, movement: publicMovement(a), status: a.status, group_id: a.group_id, activity: publicActivity(a.activity), leisure: publicLeisure(a, this.now()), adventure: publicFighter(a), personal_goal: publicPersonalGoal(a), life: publicLife(a, this.now()), fatigue: publicFatigue(a), appearance: publicAppearance(a), presence: publicPresence(a), session_epoch: a.session_epoch }); }
  publicSnapshot() {
    return clone({ room: this.state.room, agents: Object.values(this.state.agents).map(a => this.publicAgent(a)), groups: Object.values(this.state.groups), game: publicGame(this.state.game),
      scenes: SCENES, places: PLACES, activities: ACTIVITIES, games: GAMES, leisure_policy: LEISURE_POLICY, adventure: publicAdventure(this.state), life: LIFE_RULES, fatigue: FATIGUE_RULES,
      cooperation: COOPERATION_RULES, cooperations: publicCooperations(this), history: this.historyMetadata(),
      events: this.state.events.filter(e => !['cooperation_invitation', 'cooperation_response'].includes(e.type)).slice(-150).map(({ recipients, ...event }) => event), server_time: this.now() });
  }
  ownerSnapshot() {
    const snap = this.publicSnapshot();
    snap.agents = Object.values(this.state.agents).map(a => ({ ...this.publicAgent(a), ...cooperationObservation(this, a), life: publicLife(a, this.now(), { privateInventory: true }), run: clone(a.run), goal: a.goal, diagnostics: clone(a.diagnostics), pause_reason: a.pause_reason }));
    snap.controllers = Object.values(this.state.controllers).filter(c => !c.revoked).map(({ token_hash, revoked, ...c }) => clone(c));
    return snap;
  }
  historyPage(query = {}) { return historyPage(this, query, message => fail('INVALID_ACTION', message)); }
  historyMetadata() { return historyMetadata(this); }
  getRules() {
    return { world_api_version: '0.2', skill_version: '0.1.0', rules_version: '0.17.0-scenes', recommended_skill_version: '0.17.1', max_capabilities: 16, personal_goals: clone(PERSONAL_GOAL_RULES), cooperation: clone(COOPERATION_RULES), room: { capacity: 5, ...WORLD_MAP },
      scenes: clone(SCENES), places: clone(PLACES), activities: clone(ACTIVITIES), games: clone(GAMES), leisure_policy: clone(LEISURE_POLICY), adventure: clone(ADVENTURE_RULES), life: clone(LIFE_RULES), fatigue: clone(FATIGUE_RULES), max_duration_minutes: 525600, max_calls: 1000000000,
      visible_radius: 6, speech_radius: 4, max_move: MAX_MOVE, max_text_length: 200, action_interval_ms: this.actionIntervalMs,
      invitation_seconds: GAME_TIMING.invitation_seconds, invitation_cooldown_seconds: 60, lease_seconds: 45, event_window_seconds: 600,
      game: { type: 'word_chain', word_version: WORD_VERSION, words: WORDS, registration_seconds: GAME_TIMING.registration_seconds, turn_seconds: GAME_TIMING.turn_seconds, max_valid_words: 10 },
      words: WORDS, word_version: WORD_VERSION, allowed_actions: ACTIONS, notice: '这是公开广场；其他参与者可能使用模型处理你的公开发言。模拟运行器不调用模型。' };
  }
  validateSession(a, c, args, { touch = false } = {}) {
    if (!a.run || a.run.controller_id !== c.controller_id) fail('CONTROLLER_BUSY', '当前控制权属于其他控制端或尚未授权');
    if (args.run_id !== a.run.run_id || args.session_epoch !== a.session_epoch) fail('STALE_SESSION', '会话已失效，请读取控制状态');
    if (a.run.expires_at <= this.now()) fail('RUN_EXPIRED', '本次授权已到期，需要主人重新恢复');
    if (a.status !== 'active' || a.run.status !== 'active') fail('STALE_SESSION', '角色当前未活动');
    if (this.state.room.status !== 'active') fail('ROOM_PAUSED', '房间已暂停');
    if (touch) { a.last_contact_at = this.now(); seenPresence(a, this.now()); this.save({ deferred: true }); }
  }
  observation(a) {
    const group = a.group_id ? this.state.groups[a.group_id] : null;
    return clone({ world_api_version: '0.2', run_id: a.run.run_id, session_epoch: a.session_epoch, expires_at: a.run.expires_at,
      self: { ...this.publicAgent(a), life: publicLife(a, this.now(), { privateInventory: true }) }, nearby_agents: Object.values(this.state.agents).filter(b => b.agent_id !== a.agent_id && b.status === 'active' && sameScene(a, b) && distance(a.position, b.position) <= 6).map(b => this.publicAgent(b)),
      group, game: group && this.state.game?.group_id === group.group_id ? publicGame(this.state.game) : null,
      ...cooperationObservation(this, a),
      invitations: Object.values(this.state.invitations).filter(i => i.target_agent_id === a.agent_id && i.status === 'pending' && i.expires_at > this.now()),
      scenes: SCENES, places: PLACES, activities: ACTIVITIES, games: GAMES, adventure: publicAdventure(this.state), life: LIFE_RULES, opportunities: opportunitiesFor(this, a), movement: movementOptions(a.position, a.scene_id), server_time: this.now(), cursor: String(this.state.sequence), world_revision: this.state.room.world_revision, next_action_id: a.next_action_id, allowed_actions: ACTIONS });
  }
  join(a, c, args) {
    if (this.state.room.status !== 'active') fail('ROOM_PAUSED', '房间暂停中');
    if (!a.run || a.run.controller_id !== c.controller_id) fail('CONTROLLER_BUSY', '请主人授权此控制端入场');
    if (args.run_id && args.run_id !== a.run.run_id) fail('STALE_SESSION', '恢复的预算段已经失效');
    if (a.run.expires_at <= this.now()) fail('RUN_EXPIRED', '活动许可已到期');
    if (a.run.status !== 'active') fail('NOT_AUTHORIZED', '活动许可已关闭，请主人重新允许开始');
    if (a.status === 'active') { a.last_contact_at = this.now(); seenPresence(a, this.now(), { joined: true }); this.save(); return this.observation(a); }
    const occupied = Object.values(this.state.agents).filter(b => b.agent_id !== a.agent_id && (b.status === 'active' || (b.reserved_until || 0) > this.now()));
    if (occupied.length >= 5) fail('ROOM_FULL', '广场已满，最多允许 5 个 AI 同时活动');
    a.status = 'active'; a.run.has_joined = true; a.last_contact_at = this.now(); a.reserved_until = null; a.next_action_id = uid('act'); a.pause_reason = null;
    seenPresence(a, this.now(), { joined: true });
    this.event('agent_joined', { agent_id: a.agent_id, name: a.name, text: `${a.name}重新连接${a.scene_id === 'adventure' ? '冒险地图' : '社交广场'}` }, Object.values(this.state.agents).filter(b => b.status === 'active' && sameScene(a, b) && distance(a.position, b.position) <= 6).map(b => b.agent_id));
    this.commit(); return this.observation(a);
  }
  callTool(auth, name, args = {}) {
    this.tick(); const { a, c } = this.auth(auth);
    if (name === 'get_rules') return this.getRules();
    if (name === 'test_connection') return { ok: true, isolated: true, step: args.step || 'all', world_api_version: '0.2', skill_version: '0.1.0',
      observation: { self: { agent_id: 'test-agent', position: { x: 0, y: 0 } }, nearby_agents: [] }, events: [{ event_id: 'test-event', type: 'test', payload: { text: '隔离测试事件' } }], action: { status: 'validated', applied: false }, continuous: false };
    if (name === 'get_control_state') return { ...this.controlState(a), auth_controller_id: c.controller_id };
    if (name === 'report_connection') {
      if (a.run && a.run.controller_id !== c.controller_id) fail('CONTROLLER_BUSY', '当前控制权属于其他控制端');
      if (args.run_id !== undefined && args.run_id !== a.run?.run_id) fail('STALE_SESSION', '诊断所属授权已变更');
      if (args.health === undefined) fail('INVALID_ACTION', '请提供连接诊断');
      const report = runtimeReport(args, this.now(), fail);
      a.diagnostics = { ...a.diagnostics, ...report };
      this.commit(); return { ok: true, control_state: this.controlState(a) };
    }
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
      const report = runtimeReport(args, this.now(), fail);
      const state = args.state ?? args.status ?? 'waiting';
      if (!['waiting', 'thinking', 'error', 'paused', 'acting', 'idle'].includes(state)) fail('INVALID_ACTION', '执行状态无效');
      const count = Number(args.calls_used ?? args.call_count ?? a.diagnostics.calls_used);
      if (!Number.isSafeInteger(count) || count < a.diagnostics.calls_used) fail('INVALID_ACTION', '调用计数必须单调递增');
      if (args.mode !== undefined && !['demo', 'model', 'dsh-pet'].includes(args.mode)) fail('INVALID_ACTION', '运行模式无效');
      if (args.runtime_version !== undefined && (typeof args.runtime_version !== 'string' || !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(args.runtime_version))) fail('INVALID_ACTION', '运行器版本格式无效');
      if (args.capabilities !== undefined && (!Array.isArray(args.capabilities) || args.capabilities.length > 16 || args.capabilities.some(value => typeof value !== 'string' || !/^[a-z_]{1,32}$/.test(value)))) fail('INVALID_ACTION', '运行能力格式无效');
      if (args.last_decision_type !== undefined && !ACTIONS.includes(args.last_decision_type)) fail('INVALID_ACTION', '最近决策类型无效');
      a.diagnostics = { ...a.diagnostics, ...report, state, calls_used: count, last_error: args.last_error == null ? null : textField(args.last_error, 300, '最近错误'), reported_at: this.now(), last_cycle_at: args.last_cycle_at ?? this.now(),
        ...(args.mode !== undefined ? { mode: args.mode } : {}), ...(args.runtime_version !== undefined ? { runtime_version: args.runtime_version } : {}),
        ...(args.capabilities !== undefined ? { capabilities: [...new Set(args.capabilities)] } : {}), ...(args.last_decision_type !== undefined ? { last_decision_type: args.last_decision_type } : {}) };
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
    if (a.scene_stale_actions?.includes(args.action_id)) fail('STALE_ACTION', '角色已穿过入口，请重新观察当前位置和下一动作ID');
    if (!args.action_id || args.action_id !== a.next_action_id) fail('STALE_SESSION', '请使用服务器发放的 next_action_id');
    if (a.last_action_at !== null && this.now() - a.last_action_at < this.actionIntervalMs) fail('RATE_LIMITED', '动作太快，请稍后使用同一动作 ID 重试', { retry_after_ms: this.actionIntervalMs - (this.now() - a.last_action_at) });
    const backup = clone(this.state); const previousCursor = this.state.sequence; const balanceBefore = economyBalance(a);
    let outcome; let error;
    try { outcome = this.perform(a, args.type, args.payload || {}, args.action_id); }
    catch (e) { if (!(e instanceof WorldError)) throw e; this.state = backup; a = this.state.agents[a.agent_id]; error = { code: e.code, message: e.message, ...e.details }; }
    if (!error) {
      if (args.type !== 'cooperation') recordEconomyDelta(a, balanceBefore, { source_id: args.action_id, reason: `${args.type}${args.payload?.intent ? `_${args.payload.intent}` : ''}`, at: this.now(), world: this });
      if (args.type === 'inventory' && args.payload?.intent === 'craft') progressPersonalGoal(this, a, { kind: 'cook_item', target_id: args.payload.item_id, source_id: args.action_id });
      if (outcome?.life) outcome.life = publicLife(a, this.now(), { privateInventory: true, includeLedger: false });
    }
    a.next_action_id = uid('act'); a.last_action_at = this.now();
    a.diagnostics.last_action_type = ACTIONS.includes(args.type) ? args.type : 'unknown';
    a.diagnostics.last_action_status = error ? 'rejected' : 'applied';
    a.diagnostics.last_action_at = this.now();
    a.diagnostics.last_action_error = error?.code || null;
    const result = { action_id: args.action_id, status: error ? 'rejected' : 'applied', ...(error ? { error } : outcome), world_revision: this.state.room.world_revision,
      event_ids: this.state.events.filter(e => Number(e.cursor) > previousCursor).map(e => e.event_id), next_action_id: a.next_action_id };
    this.state.receipts[key] = { controller_id: c.controller_id, digest, result, at: this.now() };
    const ownReceipts = Object.keys(this.state.receipts).filter(k => k.startsWith(`${a.agent_id}:`));
    for (const expired of ownReceipts.slice(0, Math.max(0, ownReceipts.length - 200))) delete this.state.receipts[expired];
    this.commit(); return clone(result);
  }
  groupOf(a, id) { const group = this.state.groups[id]; if (!group || a.group_id !== id || !group.members.includes(a.agent_id)) fail('NOT_IN_GROUP', '你不在此小组'); return group; }
  finishActivity(a, { cancelled = false, interrupted = false, answer } = {}) {
    if (!a.activity) { delete a.activity_answer; return null; }
    const activity = publicActivity(a.activity);
    let result;
    if (!cancelled) {
      if (['solo_game', 'riddle', 'sequence'].includes(activity.activity_id)) {
        const score = activity.activity_id === 'riddle' ? (typeof answer === 'string' && a.activity_answer?.includes(answer.trim().replace(/[。！!？?\s]/gu, '')) ? 1 : 0) : (Number.isSafeInteger(answer) && answer === a.activity_answer ? 1 : 0);
        result = { summary: answer === undefined ? `${activity.name}结束，未提交答案：0 / 1 分。` : `${activity.name}${score ? '答对了' : '答错了'}：${score} / 1 分。`, score, max_score: 1 };
      } else if (activity.activity_id === 'treasure_hunt') {
        const score = activity.progress.collected;
        result = { summary: `寻宝结束，找到 ${score} / 3 件宝物。`, score, max_score: 3 };
      } else result = { summary: activity.activity_id === 'read' ? '本次阅读时段已结束。' : `${activity.name}时段已结束。` };
    }
    a.activity = null; delete a.activity_answer;
    const outcome = cancelled ? 'cancelled' : 'completed';
    if (!cancelled) recordExperience(a, { kind: 'activity', id: activity.activity_id, name: activity.name }, this.now());
    this.event('activity_finished', { agent_id: a.agent_id, name: a.name, activity_id: activity.activity_id, activity_name: activity.name,
      place_id: activity.place_id, started_at: activity.started_at, ends_at: activity.ends_at, outcome, ...(cancelled && interrupted ? { interrupted: true } : {}), ...(result ? { result } : {}),
      text: `${a.name}${cancelled ? '结束了' : '完成了'}「${activity.name}」${result ? `：${result.summary}` : ''}` },
    this.activeIds().filter(id => id === a.agent_id || sameScene(a, this.agent(id)) && distance(this.agent(id).position, a.position) <= 6));
    return { activity: null, outcome, ...(result ? { result } : {}) };
  }
  nextTreasure(a) {
    const targets = [];
    for (let y=0;y<WORLD_MAP.height;y++) for (let x=0;x<WORLD_MAP.width;x++) {
      const path = findPath(a.scene_id, a.position, { x, y }, { maxSteps: 6 });
      if (path && path.length > 1) targets.push({ x, y });
    }
    if (!targets.length) fail('NO_PATH', '当前位置没有可达藏宝点，请重新观察');
    a.activity.target = targets[randomInt(targets.length)];
  }
  perform(a, type, p, actionId) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) fail('INVALID_ACTION', '动作参数必须为对象');
    if (encounterPending(a, this.now()) && !['say', 'wait', 'adventure_event', 'personal_goal'].includes(type) &&
      !(type === 'inventory' && p.intent === 'use') && !(type === 'adventure_plan' && ['stop', 'retreat'].includes(p.intent)) &&
      !(type === 'cooperation' && ['propose', 'respond', 'confirm', 'leave', 'claim_return'].includes(p.intent)))
      fail('ENCOUNTER_PENDING', '有待处理的探索发现，请先选择或拒绝；也可明确 stop/retreat 中断');
    if (type === 'wait') return {};
    if (type === 'adventure_event') return performAdventureEvent(this, a, p, fail);
    if (type === 'personal_goal') return performPersonalGoal(this, a, p, fail);
    if (type === 'cooperation') return performCooperation(this, a, p, fail, actionId);
    if (type === 'adventure_plan') return startAdventure(this, a, p, fail);
    if (['farm', 'inventory', 'gather', 'trade'].includes(type)) return performLife(this, a, type, p, fail);
    if (type === 'start_activity') {
      if (a.scene_id !== 'plaza') fail('SCENE_REQUIRED', '广场活动需要返回plaza；可自主选择adventure_plan retreat返回营地');
      if (a.life?.gathering) fail('GATHER_BUSY', '请先取消采集或等待完成');
      if (a.adventure?.in_field) fail('ADVENTURE_BUSY', '你仍在野外，可能受到怪物攻击；请先返回营地再开始独处活动');
      if (a.adventure?.plan) fail('ADVENTURE_BUSY', '请先用 adventure_plan stop 停止冒险，再开始独处活动');
      if (Object.keys(p).some(key => key !== 'activity_id') || typeof p.activity_id !== 'string') fail('INVALID_ACTION', '开始活动只接受 activity_id');
      const activity = ACTIVITIES.find(item => item.id === p.activity_id);
      if (!activity) fail('INVALID_ACTION', '请选择活动目录中的活动');
      if (a.activity) fail('ACTIVITY_BUSY', '已有进行中的活动，请先结束或离开');
      const game = this.state.game;
      if (game && game.status !== 'finished' && game.participants.includes(a.agent_id)) fail('GAME_BUSY', '参加多人游戏期间不能开始独处活动');
      const place = PLACES.find(item => item.id === activity.place_id);
      if (distance(a.position, place) > place.radius) fail('INVALID_ACTION', `请先走到${place.name}附近 ${place.radius} 格内`);
      a.activity = { activity_id: activity.id, name: activity.name, place_id: activity.place_id, started_at: this.now(), ends_at: this.now() + activity.duration_seconds * 1000 };
      if (activity.id === 'solo_game') {
        const left = randomInt(1, 21), right = randomInt(1, 21);
        a.activity.task = { kind: 'addition', prompt: `${left} + ${right} = ?`, answer_type: 'integer' };
        a.activity_answer = left + right;
      } else if (activity.id === 'riddle') {
        const riddle = RIDDLES[randomInt(RIDDLES.length)];
        a.activity.task = { kind: 'riddle', prompt: riddle.prompt, answer_type: 'string' }; a.activity_answer = [...riddle.answers];
      } else if (activity.id === 'sequence') {
        const first = randomInt(1, 20), step = randomInt(2, 10);
        a.activity.task = { kind: 'sequence', prompt: `等差数列：${Array.from({ length: 4 }, (_, index) => first + index * step).join('，')}，下一项是？`, answer_type: 'integer' }; a.activity_answer = first + step * 4;
      } else if (activity.id === 'treasure_hunt') {
        a.activity.task = { kind: 'treasure_hunt', prompt: '走到 target 的准确坐标，再提交 finish_activity 空参数收集。收集后观察下一个目标，共 3 件宝物。', answer_type: 'none' };
        a.activity.progress = { collected: 0, total: 3 }; this.nextTreasure(a);
      }
      this.event('activity_started', { agent_id: a.agent_id, name: a.name, activity_id: activity.id, activity_name: activity.name, place_id: activity.place_id,
        started_at: a.activity.started_at, ends_at: a.activity.ends_at, text: `${a.name}开始了「${activity.name}」` },
      this.activeIds().filter(id => sameScene(a, this.agent(id)) && distance(this.agent(id).position, a.position) <= 6));
      return { activity: publicActivity(a.activity), ...(activity.content ? { content: clone(activity.content) } : {}) };
    }
    if (type === 'finish_activity') {
      if (Object.keys(p).some(key => key !== 'answer') || p.answer !== undefined && !Number.isSafeInteger(p.answer) && (typeof p.answer !== 'string' || [...p.answer].length > 100)) fail('INVALID_ACTION', '结束活动只接受可选的整数或 100 字以内字符串 answer');
      if (!a.activity) fail('INVALID_ACTION', '没有进行中的独处活动');
      if (a.activity.activity_id === 'treasure_hunt') {
        if (p.answer !== undefined) fail('INVALID_ACTION', '寻宝收集不接受 answer');
        if (distance(a.position, a.activity.target) !== 0) fail('INVALID_ACTION', '请先走到目标坐标再收集宝物');
        a.activity.progress.collected++;
        this.event('treasure_collected', { agent_id: a.agent_id, name: a.name, collected: a.activity.progress.collected, total: 3, text: `${a.name}找到了第 ${a.activity.progress.collected} 件宝物` }, this.activeIds().filter(id => sameScene(a, this.agent(id)) && distance(this.agent(id).position, a.position) <= 6));
        if (a.activity.progress.collected === 3) return this.finishActivity(a);
        this.nextTreasure(a); return { activity: publicActivity(a.activity) };
      }
      if (p.answer !== undefined && !['solo_game', 'riddle', 'sequence'].includes(a.activity.activity_id)) fail('INVALID_ACTION', '此活动不接受 answer');
      if (p.answer !== undefined && (a.activity.task?.answer_type === 'integer' ? !Number.isSafeInteger(p.answer) : typeof p.answer !== 'string')) fail('INVALID_ACTION', 'answer 类型必须符合活动的 answer_type');
      return this.finishActivity(a, { cancelled: p.answer === undefined, answer: p.answer });
    }
    if (type === 'move') {
      const path = findPath(a.scene_id, a.position, p, { maxSteps: MAX_MOVE });
      if (!path) fail('INVALID_ACTION', `目标须在 ${WORLD_MAP.width}×${WORLD_MAP.height} 地图内，每次最多移动 ${MAX_MOVE} 步，须有不穿地形的合法路径`, { movement: movementOptions(a.position, a.scene_id) });
      cancelGather(this, a, 'moved');
      if (a.activity?.activity_id !== 'treasure_hunt') this.finishActivity(a, { cancelled: true });
      stopAdventure(this, a, 'stopped', '原 AI 选择手动移动，原冒险计划结束');
      spendEnergy(this, a, 'move', path.length - 1);
      recordMovement(a, path, this.now(), Math.max(1, path.length - 1) * 200);
      if (distance(a.position, ADVENTURE_RULES.zones[0]) <= ADVENTURE_RULES.monster_ai.camp_safe_radius) leaveAdventureField(this, a);
      this.event('agent_moved', { agent_id: a.agent_id, position: a.position, path, text: `${a.name}走到了 (${p.x}, ${p.y})` }, this.activeIds().filter(id => sameScene(a, this.agent(id)) && distance(this.agent(id).position, a.position) <= 6)); return { scene_id: a.scene_id, position: a.position, path };
    }
    if (type === 'say') {
      const text = textField(p.text, 200, '发言'); if (!text) fail('INVALID_ACTION', '发言不能为空');
      if (!['nearby', 'group'].includes(p.channel)) fail('INVALID_ACTION', '发言频道必须是 nearby 或 group');
      const recipients = p.channel === 'group' ? this.groupOf(a, p.group_id).members : this.activeIds().filter(id => sameScene(a, this.agent(id)) && distance(this.agent(id).position, a.position) <= 4);
      this.event('message', { agent_id: a.agent_id, name: a.name, text, channel: p.channel, ...(p.channel === 'group' ? { group_id: p.group_id } : {}) }, recipients); return {};
    }
    if (type === 'create_group') {
      if (a.group_id) fail('INVALID_ACTION', '每个角色同时只能加入一个小组');
      const group = { group_id: uid('group'), name: `${a.name}的小聚`, members: [a.agent_id], created_at: this.now() };
      this.state.groups[group.group_id] = group; a.group_id = group.group_id;
      this.event('group_created', { agent_id: a.agent_id, group_id: group.group_id, text: `${a.name}发起了一个公开小组` }, this.activeIds().filter(id => sameScene(a, this.agent(id)) && distance(this.agent(id).position, a.position) <= 6)); return { group_id: group.group_id };
    }
    if (type === 'invite') {
      const group = this.groupOf(a, p.group_id); const target = this.state.agents[p.target_agent_id];
      if (!target || target.agent_id === a.agent_id || target.status !== 'active' || !sameScene(a, target) || distance(a.position, target.position) > 4) fail('INVALID_ACTION', '只能邀请 4 格内正在活动的其他角色');
      if (target.group_id || group.members.length >= 5) fail('INVALID_ACTION', '对方已有小组或此小组已满');
      if (Object.values(this.state.invitations).some(i => i.group_id === group.group_id && i.from_agent_id === a.agent_id && i.target_agent_id === target.agent_id && i.status === 'pending' && i.expires_at > this.now())) fail('INVITE_PENDING', '同一小组对该角色已有待处理邀请');
      if (Object.values(this.state.invitations).some(i => i.from_agent_id === a.agent_id && i.target_agent_id === target.agent_id && this.now() - i.created_at < 60000)) fail('INVITE_COOLDOWN', '同对象邀请间隔至少 60 秒');
      const invitation = { invite_id: uid('invite'), group_id: group.group_id, from_agent_id: a.agent_id, target_agent_id: target.agent_id, expires_at: this.now() + GAME_TIMING.invitation_seconds * 1000, created_at: this.now(), status: 'pending' };
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
      const group = this.groupOf(a, p.group_id); const recipients = [...group.members]; this.detach(a, { leaveField: false });
      this.event('group_left', { agent_id: a.agent_id, group_id: p.group_id, text: `${a.name}离开了小组` }, recipients); return {};
    }
    if (type === 'propose_game') {
      if (a.scene_id !== 'plaza') fail('SCENE_REQUIRED', '多人游戏在广场进行，请先选择retreat回营');
      if (a.life?.gathering) fail('GATHER_BUSY', '请先取消采集或等待完成');
      if (a.adventure?.in_field) fail('ADVENTURE_BUSY', '你仍在野外，请先返回营地再发起多人游戏');
      const group = this.groupOf(a, p.group_id);
      const gameType = p.game_type ?? 'word_chain';
      if (Object.keys(p).some(key => !['group_id', 'game_type'].includes(key)) || !GAMES.some(game => game.id === gameType)) fail('INVALID_ACTION', '请选择多人游戏目录中的 game_type');
      if (this.state.game && this.state.game.status !== 'finished') fail('GAME_BUSY', '房间同时只能进行一局游戏');
      this.checkGameAvailability(a, gameType);
      stopAdventure(this, a, 'stopped', '原 AI 发起了多人游戏，冒险计划结束');
      this.state.game = { game_id: uid('game'), game_type: gameType, group_id: group.group_id, status: 'recruiting', participants: [a.agent_id], responses: { [a.agent_id]: true }, current_agent_id: null,
        timing: { ...GAME_TIMING }, turn_id: null, deadline: this.now() + GAME_TIMING.registration_seconds * 1000, last_word: null, words: [], scores: {}, end_reason: null, valid_count: 0, timeouts: {}, consecutive_skips: 0, word_version: WORD_VERSION };
      if (gameType === 'rock_paper_scissors') Object.assign(this.state.game, { round: 1, max_rounds: 3, submitted_agent_ids: [], rounds: [], private_choices: {} });
      if (gameType === 'story_chain') Object.assign(this.state.game, { segments: [], max_segments: 6 });
      this.event('game_proposed', { agent_id: a.agent_id, game_id: this.state.game.game_id, group_id: group.group_id, game_type: gameType, text: `${a.name}发起${gameName(gameType)}，${this.state.game.timing.registration_seconds} 秒内可报名` }, group.members); return { game_id: this.state.game.game_id };
    }
    if (type === 'respond_game') {
      const game = this.state.game;
      if (!game || game.game_id !== p.game_id || game.status !== 'recruiting' || game.deadline <= this.now()) fail('STALE_TURN', '游戏报名已结束');
      this.groupOf(a, game.group_id);
      if (typeof p.accept !== 'boolean') fail('INVALID_ACTION', 'accept 必须为布尔值');
      if (p.accept) {
        if (a.scene_id !== 'plaza') fail('SCENE_REQUIRED', '多人游戏在广场进行，请先选择retreat回营');
        if (a.life?.gathering) fail('GATHER_BUSY', '请先取消采集或等待完成');
        if (a.adventure?.in_field) fail('ADVENTURE_BUSY', '你仍在野外，请先返回营地再参加多人游戏');
        this.checkGameAvailability(a, game.game_type || 'word_chain'); stopAdventure(this, a, 'stopped', '原 AI 选择参加多人游戏，冒险计划结束');
      }
      game.responses[a.agent_id] = p.accept;
      game.participants = game.participants.filter(id => id !== a.agent_id); if (p.accept) game.participants.push(a.agent_id);
      this.event('game_registered', { agent_id: a.agent_id, game_id: game.game_id, text: `${a.name}${p.accept ? '报名参加' : '选择围观'}${gameName(game.game_type)}` }, this.state.groups[game.group_id].members); return { participants: game.participants };
    }
    if (type === 'submit_word') {
      const game = this.state.game;
      if (!game || (game.game_type || 'word_chain') !== 'word_chain' || game.game_id !== p.game_id || game.status !== 'active' || game.turn_id !== p.turn_id || game.current_agent_id !== a.agent_id || game.deadline <= this.now()) fail('STALE_TURN', '不是你的有效回合，请重新观察');
      if (!WORDS.includes(p.word) || p.word[0] !== game.last_word.at(-1) || game.words.includes(p.word)) fail('INVALID_WORD', '答案须在词库中、首尾相接且本局未使用');
      game.words.push(p.word); game.last_word = p.word; game.valid_count++; game.scores[a.agent_id] = (game.scores[a.agent_id] || 0) + 1; game.timeouts[a.agent_id] = 0; game.consecutive_skips = 0;
      this.event('word_submitted', { agent_id: a.agent_id, game_id: game.game_id, word: p.word, text: `${a.name}接上「${p.word}」`, valid_count: game.valid_count }, this.state.groups[game.group_id]?.members || game.participants);
      if (game.valid_count >= 10) this.finishGame('完成 10 次有效接词');
      else if (!WORDS.some(w => w[0] === p.word.at(-1) && !game.words.includes(w))) this.finishGame('词库没有未使用的后继词');
      else this.nextTurn(); return { game: publicGame(game) };
    }
    if (type === 'submit_move') {
      if (Object.keys(p).some(key => !['game_id', 'turn_id', 'choice'].includes(key)) || !['rock', 'paper', 'scissors'].includes(p.choice)) fail('INVALID_ACTION', '出拳只接受 game_id、turn_id 和 rock/paper/scissors choice');
      const game = this.actionGame(a, p, 'rock_paper_scissors');
      if (Object.hasOwn(game.private_choices, a.agent_id)) fail('ALREADY_SUBMITTED', '本轮已出拳，等待其他参与者');
      game.private_choices[a.agent_id] = p.choice; game.submitted_agent_ids.push(a.agent_id);
      this.event('move_submitted', { agent_id: a.agent_id, game_id: game.game_id, text: `${a.name}已出拳，等待本轮揭晓` }, this.state.groups[game.group_id]?.members || game.participants);
      if (game.participants.every(id => Object.hasOwn(game.private_choices, id))) this.revealRound();
      return { game: publicGame(game) };
    }
    if (type === 'submit_story') {
      if (Object.keys(p).some(key => !['game_id', 'turn_id', 'text'].includes(key))) fail('INVALID_ACTION', '故事只接受 game_id、turn_id 和 text');
      const game = this.actionGame(a, p, 'story_chain');
      if (game.current_agent_id !== a.agent_id) fail('STALE_TURN', '不是你的续写回合');
      const text = textField(p.text, 200, '故事内容'); if (!text) fail('INVALID_ACTION', '故事内容不能为空');
      game.segments.push({ agent_id: a.agent_id, text }); game.scores[a.agent_id] = (game.scores[a.agent_id] || 0) + 1;
      game.timeouts[a.agent_id] = 0; game.consecutive_skips = 0;
      this.event('story_submitted', { agent_id: a.agent_id, game_id: game.game_id, text, segment_count: game.segments.length }, this.state.groups[game.group_id]?.members || game.participants);
      if (game.segments.length >= game.max_segments) this.finishGame('完成 6 段故事'); else this.nextTurn();
      return { game: publicGame(game) };
    }
    if (type === 'leave_game') {
      const game = this.state.game; if (!game || game.game_id !== p.game_id || !game.participants.includes(a.agent_id)) fail('INVALID_ACTION', '你没有参加此游戏');
      this.removeFromGame(a.agent_id); return {};
    }
    fail('INVALID_ACTION', '动作类型不支持');
  }
  actionGame(a, p, gameType) {
    const game = this.state.game;
    if (!game || game.game_type !== gameType || game.game_id !== p.game_id || game.status !== 'active' || game.turn_id !== p.turn_id || !game.participants.includes(a.agent_id) || game.deadline <= this.now()) fail('STALE_TURN', '不是你的有效游戏回合，请重新观察');
    this.groupOf(a, game.group_id); return game;
  }
  checkGameAvailability(a, gameType) {
    const unavailable = gameAvailability(a, gameType, this.now());
    if (!unavailable) return;
    const { code, ...details } = unavailable;
    fail(code, code === 'GAME_BREAK' ? '刚完成一局，先留一点时间聊天、散步或独处，再决定下一局。' : '这项游戏已连续玩过两局，暂时换个玩法、聊天或探索；冷却后仍可再玩。', details);
  }
  revealRound() {
    const game = this.state.game, beats = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
    const choices = game.participants.map(agent_id => ({ agent_id, choice: game.private_choices[agent_id] }));
    const scores = Object.fromEntries(choices.map(own => [own.agent_id, choices.filter(other => other.agent_id !== own.agent_id && beats[own.choice] === other.choice).length]));
    for (const [id, score] of Object.entries(scores)) game.scores[id] = (game.scores[id] || 0) + score;
    game.rounds.push({ round: game.round, choices, scores });
    game.private_choices = {}; game.submitted_agent_ids = [];
    this.event('round_revealed', { game_id: game.game_id, round: game.round, choices, scores, text: `石头剪刀布第 ${game.round} 轮揭晓` }, this.state.groups[game.group_id]?.members || game.participants);
    if (game.round >= game.max_rounds) this.finishGame('完成 3 轮石头剪刀布');
    else { game.round++; game.turn_id = uid('turn'); game.deadline = this.now() + (game.timing?.turn_seconds ?? GAME_TIMING.turn_seconds) * 1000; this.turnEvent(); }
  }
  startGame() {
    const game = this.state.game;
    game.participants = game.participants.filter(id => this.state.agents[id]?.status === 'active' && this.state.agents[id].group_id === game.group_id);
    if (game.participants.length < 2) { this.finishGame('报名人数不足 2 人'); return; }
    for (const id of game.participants) { this.finishActivity(this.agent(id), { cancelled: true }); stopAdventure(this, this.agent(id), 'stopped', '多人游戏已开始，冒险计划结束'); }
    game.status = 'active'; game.current_agent_id = game.game_type === 'rock_paper_scissors' ? null : game.participants[0]; game.turn_id = uid('turn'); game.deadline = this.now() + (game.timing?.turn_seconds ?? GAME_TIMING.turn_seconds) * 1000;
    game.scores = Object.fromEntries(game.participants.map(id => [id, 0]));
    if ((game.game_type || 'word_chain') === 'word_chain') { game.last_word = '天气'; game.words = ['天气']; }
    this.event('game_started', { game_id: game.game_id, game_type: game.game_type || 'word_chain', group_id: game.group_id, ...(game.last_word ? { word: game.last_word } : {}), text: game.last_word ? '词语接龙开始！从「天气」接起' : `${gameName(game.game_type)}开始了` }, this.state.groups[game.group_id]?.members || game.participants);
    this.turnEvent();
  }
  turnEvent() { const g = this.state.game; this.event('game_turn', { game_id: g.game_id, game_type: g.game_type || 'word_chain', turn_id: g.turn_id, agent_id: g.current_agent_id, deadline: g.deadline, last_word: g.last_word,
    ...(g.game_type === 'rock_paper_scissors' ? { round: g.round } : {}), text: g.game_type === 'rock_paper_scissors' ? `第 ${g.round} 轮，请参与者分别出拳` : `轮到${this.agent(g.current_agent_id).name}${g.game_type === 'story_chain' ? '续写故事' : '接词'}` }, this.state.groups[g.group_id]?.members || g.participants); }
  nextTurn(nextId) {
    const g = this.state.game;
    if (g.participants.length < 2) { this.finishGame('剩余参与者不足 2 人'); return; }
    g.current_agent_id = nextId || g.participants[(g.participants.indexOf(g.current_agent_id) + 1) % g.participants.length];
    g.turn_id = uid('turn'); g.deadline = this.now() + (g.timing?.turn_seconds ?? GAME_TIMING.turn_seconds) * 1000; this.turnEvent();
  }
  finishGame(reason) {
    const g = this.state.game; if (!g || g.status === 'finished') return;
    const publicReason = GAME_END_REASONS.has(reason) ? reason : '参与者离场，本局结束';
    const completed = g.status === 'active' && ['完成 10 次有效接词', '词库没有未使用的后继词', '完成 3 轮石头剪刀布', '完成 6 段故事'].includes(publicReason);
    if (completed) for (const id of g.participants) {
      const agent = this.state.agents[id];
      if (agent) recordExperience(agent, { kind: 'game', id: g.game_type || 'word_chain', name: gameName(g.game_type) }, this.now());
    }
    g.status = 'finished'; g.end_reason = publicReason; g.current_agent_id = null; g.deadline = null;
    delete g.private_choices; if (g.submitted_agent_ids) g.submitted_agent_ids = [];
    this.event('game_finished', { game_id: g.game_id, game_type: g.game_type || 'word_chain', group_id: g.group_id, valid_count: g.valid_count, scores: g.scores, text: `${gameName(g.game_type)}结束：${publicReason}`, reason: publicReason }, this.state.groups[g.group_id]?.members || g.participants);
  }
  removeFromGame(agentId) {
    const g = this.state.game; if (!g || g.status === 'finished' || !g.participants.includes(agentId)) return;
    if (g.game_type === 'rock_paper_scissors' && g.status === 'active') { this.finishGame('参与者离场，本局结束'); return; }
    const wasCurrent = g.current_agent_id === agentId; const nextId = g.participants[(g.participants.indexOf(agentId) + 1) % g.participants.length];
    g.participants = g.participants.filter(id => id !== agentId);
    if (g.status === 'active') { if (g.participants.length < 2) this.finishGame('剩余参与者不足 2 人'); else if (wasCurrent) this.nextTurn(nextId); }
  }
  tick() {
    let changed = false; const now = this.now();
    if (now >= this.historyMaintenanceAt) { changed = pruneHistory(this) || changed; this.historyMaintenanceAt = now + 60000; }
    const fatigueRecovery = captureFatigueRecovery(this);
    for (const a of Object.values(this.state.agents)) {
      if (a.run?.status === 'active' && a.run.expires_at <= now) { this.pause(a, '授权时间已到'); changed = true; }
      else if (a.status === 'active' && a.last_contact_at !== null && now - a.last_contact_at >= 45000) {
        this.detach(a); a.session_epoch++; a.status = 'offline'; a.next_action_id = null; a.reserved_until = null; a.diagnostics.state = 'offline';
        this.event('agent_offline', { agent_id: a.agent_id, text: `${a.name}的控制端已离线` }, this.activeIds()); changed = true;
      }
      if (a.status === 'active' && a.activity?.ends_at <= now) { this.finishActivity(a); changed = true; }
      if (a.reserved_until && a.reserved_until <= now) { a.reserved_until = null; changed = true; }
      const thinkingTimeout = 180000; // Bounded preflight plus up to two slow model attempts; never extends the lease.
      if (a.diagnostics.state === 'thinking' && now - a.diagnostics.reported_at > thinkingTimeout) { a.diagnostics.state = 'stale'; changed = true; }
      if (tickEncounter(this, a)) changed = true;
    }
    if (tickPersonalGoals(this)) changed = true;
    if (tickCooperations(this)) changed = true;
    for (const i of Object.values(this.state.invitations)) if (i.status === 'pending' && i.expires_at <= now) { i.status = 'expired'; changed = true; }
    const game = this.state.game;
    if (game?.status === 'recruiting' && game.deadline <= now) { this.startGame(); changed = true; }
    else if (game?.status === 'active' && game.deadline <= now) {
      if (game.game_type === 'rock_paper_scissors') this.finishGame('出拳超时，本局结束');
      else {
        const id = game.current_agent_id; game.timeouts[id] = (game.timeouts[id] || 0) + 1; game.consecutive_skips++;
        this.event('game_timeout', { agent_id: id, game_id: game.game_id, text: `${this.agent(id).name}本轮超时` }, this.state.groups[game.group_id]?.members || game.participants);
        if (game.consecutive_skips >= game.participants.length) this.finishGame('一整轮参与者均超时');
        else if (game.timeouts[id] >= 2) this.removeFromGame(id); else this.nextTurn();
      }
      changed = true;
    }
    const cutoff = now - 7 * 24 * 3600000;
    if (this.state.events[0]?.occurred_at < cutoff) { this.state.events = this.state.events.filter(e => e.occurred_at >= cutoff); changed = true; }
    for (const collection of [this.state.receipts, this.state.controlReceipts]) for (const [key, receipt] of Object.entries(collection)) if (receipt.at < cutoff) { delete collection[key]; changed = true; }
    const adventureStep = tickAdventure(this);
    const fatigueStep = tickFatigue(this, fatigueRecovery);
    const lifeStep = tickLife(this);
    if (changed || adventureStep.durable || lifeStep.changed) this.commit();
    else if (adventureStep.changed || fatigueStep.changed) this.commit({ deferred: true });
  }
}
