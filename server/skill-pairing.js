import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const TTL = 10 * 60 * 1000;
const POLL_INTERVAL = 3000;
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const digest = value => createHash('sha256').update(value).digest();
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));

/** Short-lived device pairing; only the requesting client knows the polling secret. */
export class SkillPairingStore {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.records = new Map();
    this.codes = new Map();
    this.attempts = new Map();
  }

  sweep() {
    const now = this.now();
    for (const [id, record] of this.records) {
      if (now >= record.expires_at) {
        record.status = 'expired';
        delete record.grant;
      }
      // A brief tombstone lets the genuine client distinguish expiry from bad credentials.
      if (now >= record.expires_at + 60000) {
        this.records.delete(id); this.codes.delete(record.user_code);
      }
    }
    for (const [key, attempt] of this.attempts) if (now >= attempt.until) this.attempts.delete(key);
  }

  create(input, ip, publicOrigin) {
    this.sweep();
    if (!exactKeys(input, ['client_name'])) fail('INVALID_REQUEST', '连接请求格式不正确');
    const name = input.client_name === undefined ? 'AI Plaza Skill' : input.client_name;
    if (typeof name !== 'string' || !name.trim() || [...name].length > 40 || /[\u0000-\u001f\u007f]/u.test(name)) fail('INVALID_REQUEST', '客户端名称须为 1–40 个字符');
    const attempt = this.attempts.get(ip) || { count: 0, until: this.now() + TTL };
    if (attempt.count >= 10 || this.records.size >= 1000 || (!this.attempts.has(ip) && this.attempts.size >= 10000)) fail('RATE_LIMITED', '连接请求过多，请稍后重试');
    attempt.count++; this.attempts.set(ip, attempt);
    let code;
    do {
      const chars = [...randomBytes(8)].map(byte => alphabet[byte & 31]).join('');
      code = `${chars.slice(0, 4)}-${chars.slice(4)}`;
    } while (this.codes.has(code));
    const secret = randomBytes(32).toString('base64url');
    const record = {
      pairing_id: randomBytes(16).toString('base64url'), user_code: code,
      device_hash: digest(secret), client_name: name.trim(), status: 'pending',
      expires_at: this.now() + TTL, last_poll_at: null,
    };
    this.records.set(record.pairing_id, record); this.codes.set(code, record);
    return {
      pairing_id: record.pairing_id, device_secret: secret, user_code: code,
      verification_url: `${publicOrigin}/?connect=${code}`,
      expires_at: record.expires_at, poll_interval_seconds: POLL_INTERVAL / 1000,
    };
  }

  poll(input) {
    this.sweep();
    if (!exactKeys(input, ['pairing_id', 'device_secret']) || typeof input.pairing_id !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(input.pairing_id) || typeof input.device_secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.device_secret)) fail('NOT_AUTHORIZED', '连接请求凭证无效');
    const record = this.records.get(input.pairing_id);
    const supplied = digest(input.device_secret);
    if (!record || !timingSafeEqual(record.device_hash, supplied)) fail('NOT_AUTHORIZED', '连接请求凭证无效');
    const now = this.now();
    if (record.last_poll_at !== null && now - record.last_poll_at < POLL_INTERVAL) fail('RATE_LIMITED', '请间隔至少 3 秒检查连接状态');
    record.last_poll_at = now;
    return { status: record.status, expires_at: record.expires_at, ...(record.status === 'approved' ? record.grant : {}) };
  }

  find(code) {
    this.sweep();
    if (typeof code !== 'string' || !/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/i.test(code)) fail('PAIRING_NOT_FOUND', '连接请求不存在或已过期');
    const record = this.codes.get(code.toUpperCase());
    if (!record) fail('PAIRING_NOT_FOUND', '连接请求不存在或已过期');
    return record;
  }

  describe(code) {
    const record = this.find(code);
    return { user_code: record.user_code, client_name: record.client_name, status: record.status, expires_at: record.expires_at };
  }

  approve(code, ownerId, agentId, createGrant) {
    const record = this.find(code);
    if (record.status === 'approved') {
      if (record.owner_id !== ownerId || record.grant.agent_id !== agentId) fail('NOT_AUTHORIZED', '此连接请求已由其他身份完成');
    } else {
      if (record.status !== 'pending') fail('PAIRING_CLOSED', '连接请求已结束，请重新连接');
      const grant = createGrant(record.client_name);
      record.grant = grant; record.owner_id = ownerId; record.status = 'approved';
    }
    return { ok: true, status: 'approved', agent_id: record.grant.agent_id, controller_id: record.grant.controller_id };
  }

  deny(code, ownerId) {
    const record = this.find(code);
    if (record.status === 'denied' && record.owner_id === ownerId) return { ok: true, status: 'denied' };
    if (record.status !== 'pending') fail('PAIRING_CLOSED', '连接请求已结束');
    record.status = 'denied'; record.owner_id = ownerId;
    return { ok: true, status: 'denied' };
  }

  close() { this.records.clear(); this.codes.clear(); this.attempts.clear(); }
}

export function approvalOptions(input) {
  if (!exactKeys(input, ['agent_id', 'duration_minutes', 'max_calls', 'goal', 'transfer']) || typeof input.agent_id !== 'string' || !input.agent_id || input.agent_id.length > 100) fail('INVALID_REQUEST', '请选择自己的角色');
  const duration = input.duration_minutes ?? 15;
  const calls = input.max_calls ?? 100;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || duration > 525600 || !Number.isInteger(calls) || calls < 1 || calls > 1000000000) fail('INVALID_ACTION', '运行期限须在 0–525600 分钟（365 天），调用上限须为 1–1000000000 次');
  if (input.goal !== undefined && (typeof input.goal !== 'string' || [...input.goal].length > 300)) fail('INVALID_ACTION', '活动目标最多 300 个字符');
  if (input.transfer !== undefined && typeof input.transfer !== 'boolean') fail('INVALID_REQUEST', '转交控制权须明确确认');
  return { agent_id: input.agent_id, duration_minutes: duration, max_calls: calls, goal: input.goal, transfer: input.transfer === true };
}
