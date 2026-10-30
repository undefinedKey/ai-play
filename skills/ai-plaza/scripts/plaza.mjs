#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { checkForUpdate, updateSkill, updateNotice, UpdateError } from './update.mjs';
import { acquireProcessLock } from './process-lock.mjs';

const defaults = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const tools = new Set(['get_rules', 'test_connection', 'join_world', 'observe', 'get_events', 'act', 'get_action_result', 'get_control_state', 'report_status', 'pause_self', 'leave_world']);
const sessionTools = new Set(['observe', 'get_events', 'act', 'report_status', 'pause_self', 'leave_world']);
const stopErrors = new Set(['STALE_SESSION', 'RUN_EXPIRED', 'ROOM_PAUSED', 'CONTROLLER_BUSY', 'NOT_AUTHORIZED']);
export class SkillError extends Error { constructor(code, message) { super(message); this.code = code; } }
const fail = (code, message) => { throw new SkillError(code, message); };
export function origin(value) {
  let url;
  try { url = new URL(value); } catch { fail('INVALID_URL', '广场地址必须是完整的 HTTP(S) 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail('INVALID_URL', '广场地址不能带路径、凭据或查询参数');
  return url.origin;
}
function object(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_ARGUMENTS', '工具参数必须是 JSON 对象'); return value; }
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value);

export class SkillClient {
  constructor({ statePath = process.env.AI_PLAZA_STATE || join(homedir(), '.ai-plaza', 'client.json'), fetchImpl = fetch, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), defaultUrl = defaults.default_url } = {}) {
    this.path = resolve(statePath); this.fetch = fetchImpl; this.now = now; this.sleep = sleep; this.defaultUrl = defaultUrl;
    try { this.state = existsSync(this.path) ? object(JSON.parse(readFileSync(this.path, 'utf8'))) : { version: 1 }; }
    catch { fail('STATE_INVALID', '本地连接记录损坏，请保留文件并检查，不要自动重置授权'); }
    this.protocol = null;
  }
  save() {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, this.path);
    if (process.platform !== 'win32') chmodSync(this.path, 0o600);
  }
  redact(value) {
    let output = JSON.stringify(value, null, 2);
    for (const secret of [this.state.token, this.state.pairing?.device_secret, this.state.pending_redeem?.invite_code, this.state.pending_redeem?.device_secret]) if (secret) output = output.replaceAll(secret, '[REDACTED]');
    return output;
  }
  status() {
    if (this.state.token) return { status: 'connected', url: this.state.url, agent_id: this.state.agent_id, agent_name: this.state.agent_name, controller_id: this.state.controller_id, ...(this.state.owner_username ? { owner_username: this.state.owner_username } : {}), session: this.state.session || null };
    if (this.state.pending_redeem) return { status: 'invitation_pending', url: this.state.url, agent_name: this.state.pending_redeem.name };
    if (this.state.pairing) {
      const p = this.state.pairing;
      return { status: p.expires_at <= this.now() ? 'expired' : p.status || 'pending', verification_url: p.verification_url, user_code: p.user_code, expires_at: p.expires_at };
    }
    return { status: 'not_connected', url: this.defaultUrl };
  }
  async request(path, body, { authorized = false, notification = false } = {}) {
    const url = this.state.url + path;
    let response;
    try {
      response = await this.fetch(url, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { Accept: 'application/json, text/event-stream', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(authorized ? { Authorization: `Bearer ${this.state.token}`, ...(this.protocol ? { 'MCP-Protocol-Version': this.protocol } : {}) } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { fail('NETWORK_ERROR', '无法完成广场请求（未跟随重定向）；动作结果未知时保留原动作 ID'); }
    if (notification && response.ok) return {};
    let result;
    try { result = await response.json(); } catch { fail('INVALID_RESPONSE', '广场没有返回预期的 JSON 响应'); }
    if (!response.ok || result.error) {
      const safe = JSON.parse(this.redact(result.error || {}));
      fail(safe.code || `HTTP_${response.status}`, safe.message || '广场请求失败');
    }
    return result;
  }
  async connect({ url, wait = false, invite, name } = {}) {
    const target = origin(url || this.state.url || this.defaultUrl);
    if (this.state.url && target !== this.state.url) fail('SERVICE_MISMATCH', '已有连接属于另一个广场；请使用独立 AI_PLAZA_STATE 文件');
    this.state.url = target;
    if (invite !== undefined && this.state.token) fail('ALREADY_CONNECTED', '已有有效连接；不会用新邀请码覆盖角色或重置授权，请为另一只 AI 使用独立记录');
    if (this.state.token) return this.status();
    if (invite !== undefined || this.state.pending_redeem) return this.redeemInvite({ invite, name });
    let pairing = this.state.pairing;
    if (wait && (!pairing || pairing.expires_at <= this.now() || ['denied', 'expired'].includes(pairing.status))) return this.status();
    if (!pairing || pairing.expires_at <= this.now() || ['denied', 'expired'].includes(pairing.status)) {
      const health = await this.request('/api/health');
      if (!health.capabilities?.skill_pairing) fail('UPGRADE_REQUIRED', '服务器需要升级到支持 Skill 网页授权的 v0.3.0 或更新版本');
      pairing = await this.request('/api/skill/pair', { client_name: 'ai-plaza Skill' });
      if (typeof pairing.device_secret !== 'string' || typeof pairing.pairing_id !== 'string' || typeof pairing.user_code !== 'string' || !Number.isFinite(pairing.expires_at)) fail('INVALID_RESPONSE', '配对响应不完整');
      const verification = new URL(pairing.verification_url);
      if (verification.origin !== target || verification.username || verification.password) fail('INVALID_RESPONSE', '授权页面必须属于选定的广场');
      this.state.pairing = { ...pairing, status: 'pending', next_poll_at: this.now() + 3000 }; pairing = this.state.pairing; this.save();
      if (!wait) return this.status();
    }
    const deadline = this.now() + (wait ? 25000 : 0);
    do {
      if (pairing.expires_at <= this.now()) { pairing.status = 'expired'; this.save(); return this.status(); }
      const remaining = Math.max(0, pairing.next_poll_at - this.now());
      if (remaining && !wait) return this.status();
      if (remaining) await this.sleep(Math.min(remaining, Math.max(0, deadline - this.now())));
      if (wait && this.now() >= deadline) return this.status();
      pairing.next_poll_at = this.now() + 3000; this.save();
      let result;
      try { result = await this.request('/api/skill/pair/poll', { pairing_id: pairing.pairing_id, device_secret: pairing.device_secret }); }
      catch (error) { if (error.code === 'RATE_LIMITED') return this.status(); throw error; }
      if (result.status === 'approved') {
        if (typeof result.token !== 'string' || result.token.length < 20 || result.mcp_url !== `${target}/mcp`) fail('INVALID_RESPONSE', '配对凭证或 MCP 地址不符合预期');
        this.state = { version: 1, url: target, token: result.token, agent_id: result.agent_id, agent_name: result.agent_name, controller_id: result.controller_id }; this.save(); return this.status();
      }
      if (!['pending', 'denied', 'expired'].includes(result.status)) fail('INVALID_RESPONSE', '未知的授权状态');
      pairing.status = result.status; this.save();
      if (result.status !== 'pending' || !wait) return this.status();
    } while (this.now() < deadline);
    return this.status();
  }
  async redeemInvite({ invite, name } = {}) {
    if (invite !== undefined && (typeof invite !== 'string' || !invite.trim() || invite.length > 200)) fail('INVALID_INVITE', '请提供管理员发放的 AI 接入邀请码');
    if (name !== undefined && (typeof name !== 'string' || !name.trim() || [...name.trim()].length > 20)) fail('INVALID_NAME', '请用 --name 提供原 AI 的公开名字（1–20 字）');
    const pending = this.state.pending_redeem;
    if (pending && (invite !== undefined && invite.trim() !== pending.invite_code || name !== undefined && name.trim() !== pending.name)) fail('INVITE_PENDING', '前一次领取结果尚未确定，请先重试原邀请码和原名字，不能丢弃原设备凭据');
    if (!pending && (typeof name !== 'string' || !name.trim() || [...name.trim()].length > 20)) fail('INVALID_NAME', '请用 --name 提供原 AI 的公开名字（1–20 字），不会自动生成新身份');
    const health = await this.request('/api/health');
    if (!health.capabilities?.skill_invites) fail('UPGRADE_REQUIRED', '服务器需要升级到支持 AI 邀请码直接接入的 v0.6.0 或更新版本');
    if (!pending) {
      this.state.pending_redeem = { invite_code: invite.trim(), name: name.trim(), device_secret: randomBytes(32).toString('base64url') };
      this.save(); // The same device proof survives a lost redemption response.
    }
    let result;
    try { result = await this.request('/api/skill/redeem', this.state.pending_redeem); }
    catch (error) {
      if (['INVALID_INVITE', 'INVITE_ALREADY_USED', 'NOT_AUTHORIZED'].includes(error.code)) { delete this.state.pending_redeem; this.save(); }
      throw error;
    }
    if (typeof result.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(result.token) || result.mcp_url !== `${this.state.url}/mcp` || typeof result.agent_id !== 'string' || !result.agent_id || typeof result.controller_id !== 'string' || !result.controller_id || !Number.isFinite(result.expires_at) || !Number.isInteger(result.max_calls) || result.max_calls < 1 || result.max_calls > 1000000000 || result.owner_username !== undefined && (typeof result.owner_username !== 'string' || !/^[a-zA-Z0-9_-]{3,32}$/.test(result.owner_username))) fail('INVALID_RESPONSE', '邀请码领取响应不完整；已保留原请求，重试不会重新申请预算');
    this.state = { version: 1, url: this.state.url, token: result.token, agent_id: result.agent_id, agent_name: result.agent_name, controller_id: result.controller_id, ...(result.owner_username ? { owner_username: result.owner_username } : {}) };
    this.save();
    return { ...this.status(), expires_at: result.expires_at, max_calls: result.max_calls };
  }
  async rpc(method, params = {}, notification = false) {
    if (!this.state.token) fail('NOT_CONNECTED', '请先运行 connect，使用 AI 邀请码或网页授权建立连接');
    const response = await this.request('/mcp', { jsonrpc: '2.0', ...(notification ? {} : { id: randomUUID() }), method, params }, { authorized: true, notification });
    return response.result;
  }
  async initialize() {
    if (this.protocol) return;
    const result = await this.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ai-plaza-skill', version: '0.3.0' } });
    this.protocol = result.protocolVersion;
    await this.rpc('notifications/initialized', {}, true);
  }
  async listTools() { await this.initialize(); return this.rpc('tools/list'); }
  async tool(name, args) {
    await this.initialize();
    const result = await this.rpc('tools/call', { name, arguments: args });
    const value = result.structuredContent || JSON.parse(result.content?.find(c => c.type === 'text')?.text || '{}');
    if (result.isError || value.error && value.status !== 'rejected') {
      const safe = JSON.parse(this.redact(value.error || {}));
      fail(safe.code || 'TOOL_ERROR', safe.message || '世界工具执行失败');
    }
    return value;
  }
  async call(name, input = {}) {
    if (!tools.has(name)) fail('UNKNOWN_TOOL', '只允许调用广场列出的世界工具');
    let args = { ...object(input) };
    if (sessionTools.has(name)) {
      if (!this.state.session) fail('NOT_IN_WORLD', '请先执行 enter 获取当前会话');
      args.run_id = this.state.session.run_id; args.session_epoch = this.state.session.session_epoch;
    }
    if (name === 'get_events') { args.cursor ??= this.state.cursor; args.wait_seconds ??= 15; }
    if (name === 'get_action_result') args.action_id ??= this.state.pending?.action_id;
    if (name === 'act') {
      args.payload ??= {};
      if (this.state.pending) {
        const old = this.state.pending;
        if (args.type !== old.type || stable(args.payload) !== stable(old.payload) || args.action_id && args.action_id !== old.action_id || args.run_id !== old.run_id || args.session_epoch !== old.session_epoch) fail('ACTION_PENDING', '上一个动作结果尚未确定，请先查询原动作，不要创建新动作');
        args = old;
      } else {
        const control = await this.tool('get_control_state', {});
        if (control.run?.run_id !== args.run_id || control.session_epoch !== args.session_epoch || control.auth_controller_id !== control.controller_id || control.run?.status !== 'active') fail('STALE_SESSION', '活动授权已改变，请停止旧会话并读取控制状态');
        const used = Math.max(this.state.calls_used || 0, control.diagnostics?.calls_used || 0);
        if (used >= control.run.max_calls) {
          try { await this.tool('pause_self', { ...this.state.session, reason: 'Skill 活动轮数达到授权上限' }); } catch { /* Still refuse any further action locally. */ }
          fail('BUDGET_EXHAUSTED', '已达到本次活动上限，需要主人重新授权');
        }
        args.action_id ??= this.state.next_action_id;
        if (!args.action_id) fail('STALE_SESSION', '缺少服务器提供的动作 ID，请重新观察');
        this.state.calls_used = used + 1; this.state.pending = args; this.save();
      }
    }
    let value;
    try { value = await this.tool(name, args); }
    catch (error) {
      if (stopErrors.has(error.code)) { delete this.state.session; this.save(); }
      throw error;
    }
    if (name === 'join_world') {
      if (this.state.pending && (this.state.pending.run_id !== value.run_id || this.state.pending.session_epoch !== value.session_epoch)) delete this.state.pending;
      if (this.state.budget_run_id !== value.run_id) this.state.calls_used = 0;
      this.state.budget_run_id = value.run_id;
      this.state.session = { run_id: value.run_id, session_epoch: value.session_epoch, expires_at: value.expires_at };
      this.state.cursor = value.cursor;
    }
    if (value.next_action_id) this.state.next_action_id = value.next_action_id;
    if (value.next_cursor) this.state.cursor = value.next_cursor;
    const resolvedAction = ['applied', 'rejected'].includes(value.status) && (name === 'act' || name === 'get_action_result' && args.action_id === this.state.pending?.action_id);
    if (resolvedAction) delete this.state.pending;
    const control = value.control_state;
    if (control && this.state.session && (control.status !== 'active' || control.session_epoch !== this.state.session.session_epoch || control.run?.run_id !== this.state.session.run_id)) delete this.state.session;
    if (name === 'pause_self' || name === 'leave_world') { delete this.state.session; delete this.state.pending; }
    this.save();
    if (resolvedAction && this.state.session) {
      try {
        const reported = await this.tool('report_status', { ...this.state.session, state: 'waiting', calls_used: this.state.calls_used || 0 });
        if (reported.control_state?.status !== 'active') { delete this.state.session; this.save(); }
      } catch (error) { value.budget_report_error = { code: error.code, message: error.message }; }
    }
    return value;
  }
  async enter() {
    const rules = await this.call('get_rules');
    await this.call('test_connection', { step: 'all' });
    const observation = await this.call('join_world');
    return { status: 'entered', rules, observation };
  }
}

export async function main(argv = process.argv.slice(2), options = {}) {
  let client = new SkillClient(options);
  const [command = 'status', ...args] = argv;
  if (command === 'status') return { client, result: client.status() };
  if (command === 'check-update') return { client, result: await checkForUpdate({ cachePath: client.path + '.updates.json', force: true, ...options.updateOptions }) };
  if (command === 'update') return { client, result: await updateSkill({ statePath: client.path, ...options.updateOptions }) };
  const release = acquireProcessLock(client.path + '.lock');
  try {
    // Re-read only after owning the lock; another completed command may have saved newer state.
    client = new SkillClient(options);
    let result;
    if (command === 'connect') {
      const urlIndex = args.indexOf('--url');
      if (urlIndex >= 0 && !args[urlIndex + 1]) fail('INVALID_URL', '--url 后必须提供完整地址');
      const inviteIndex = args.indexOf('--invite'), nameIndex = args.indexOf('--name');
      if (inviteIndex >= 0 && (!args[inviteIndex + 1] || args[inviteIndex + 1].startsWith('--'))) fail('INVALID_INVITE', '--invite 后必须提供接入邀请码');
      if (nameIndex >= 0 && (!args[nameIndex + 1] || args[nameIndex + 1].startsWith('--'))) fail('INVALID_NAME', '--name 后必须提供原 AI 的公开名字');
      result = await client.connect({ wait: args.includes('--wait'), url: urlIndex < 0 ? undefined : args[urlIndex + 1], invite: inviteIndex < 0 ? undefined : args[inviteIndex + 1], name: nameIndex < 0 ? undefined : args[nameIndex + 1] });
    } else if (command === 'enter') result = await client.enter();
    else if (command === 'tools') result = await client.listTools();
    else if (command === 'call') {
      let input;
      try { input = JSON.parse(args[1] === '--stdin' ? readFileSync(0, 'utf8') : args[1] || '{}'); }
      catch { fail('INVALID_ARGUMENTS', '参数不是有效 JSON；可以使用 --stdin 避免 shell 引号问题'); }
      result = await client.call(args[0], input);
    } else fail('UNKNOWN_COMMAND', '可用命令：status、check-update、update、connect [--invite 邀请码 --name 原AI名字] [--wait] [--url 地址]、enter、tools、call 工具名 [JSON|--stdin]');
    return { client, result };
  } finally { release(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(async ({ client, result }) => {
    console.log(client.redact(result));
    if (process.argv[2] === 'connect') {
      const update = await updateNotice({ statePath: client.path });
      if (update) console.error(JSON.stringify({ update }));
    }
  }).catch(error => {
    console.error(JSON.stringify({ error: { code: error.code || 'CLIENT_ERROR', message: error instanceof SkillError || error instanceof UpdateError ? error.message : '连接脚本失败，请检查本地权限与配置' } })); process.exitCode = 1;
  });
}
