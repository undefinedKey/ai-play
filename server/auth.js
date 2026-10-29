import { randomBytes, randomUUID, scrypt, createHash, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export class AuthError extends Error {
  constructor(code, message) { super(message); this.name = 'AuthError'; this.code = code; }
}

export const PASSWORD_POLICY = Object.freeze({ min: 12, max: 128, N: 131072, r: 8, p: 1, keylen: 64, maxmem: 192 * 1024 * 1024 });
const SESSION_MS = 24 * 60 * 60 * 1000;
const digest = value => createHash('sha256').update(value).digest('hex');
const csrfFor = token => digest(`ai-plaza-csrf-v1:${token}`);
const invalidCredentials = () => new AuthError('INVALID_CREDENTIALS', '用户名或密码不正确');
const publicOwner = row => row ? { id: row.id, username: row.username, name: row.name, role: row.role } : null;
const fakeSalt = randomBytes(16).toString('hex');
const fakeHash = randomBytes(PASSWORD_POLICY.keylen);

// At most two 128 MiB scrypt operations run at once across AccountStore instances.
let activeHashes = 0;
const waitingHashes = [];
async function derive(password, salt) {
  if (activeHashes >= 2) await new Promise(resolve => waitingHashes.push(resolve));
  else activeHashes++;
  try {
    return await new Promise((resolve, reject) => scrypt(password, salt, PASSWORD_POLICY.keylen, {
      N: PASSWORD_POLICY.N, r: PASSWORD_POLICY.r, p: PASSWORD_POLICY.p, maxmem: PASSWORD_POLICY.maxmem,
    }, (error, value) => error ? reject(error) : resolve(value)));
  } finally {
    const next = waitingHashes.shift();
    if (next) next(); else activeHashes--;
  }
}

function usernameInput(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{3,32}$/.test(value.trim())) {
    throw new AuthError('INVALID_USERNAME', '用户名须为 3–32 位英文字母、数字、下划线或连字符');
  }
  return value.trim().toLowerCase();
}
function passwordInput(value) {
  if (typeof value !== 'string' || [...value].length < PASSWORD_POLICY.min || [...value].length > PASSWORD_POLICY.max) {
    throw new AuthError('INVALID_PASSWORD', '密码须为 12–128 个字符');
  }
  return value;
}
function nameInput(value, fallback) {
  if (value === undefined || value === '') return fallback;
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > 40) throw new AuthError('INVALID_NAME', '显示名称须为 1–40 个字符');
  return value.trim();
}
function invitationInput(value) {
  if (typeof value !== 'string' || !/^plaza_[A-Za-z0-9_-]{32}$/.test(value.trim())) throw new AuthError('INVALID_INVITE', '邀请码无效、已使用或已过期');
  return value.trim();
}

export class AccountStore {
  constructor({ dbPath = ':memory:', now = Date.now } = {}) {
    this.now = now;
    try {
      if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
      this.db = new DatabaseSync(dbPath);
      if (dbPath !== ':memory:') chmodSync(dbPath, 0o600);
      this.db.exec(`
        PRAGMA foreign_keys=ON;
        PRAGMA journal_mode=WAL;
        PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS owners (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('admin','member')),
          password_hash TEXT NOT NULL,
          password_salt TEXT NOT NULL,
          password_params TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL REFERENCES owners(id),
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
        CREATE TABLE IF NOT EXISTS invitations (
          id TEXT PRIMARY KEY,
          code_hash TEXT NOT NULL UNIQUE,
          created_by TEXT NOT NULL REFERENCES owners(id),
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          used_at INTEGER,
          used_by TEXT REFERENCES owners(id)
        );
      `);
    } catch {
      try { this.db?.close(); } catch { /* Preserve the original failure without leaking SQL or paths. */ }
      throw new AuthError('AUTH_STORAGE_ERROR', '无法打开账号数据库，请检查数据目录权限与数据库文件');
    }
  }

  storage(work) {
    try { return work(); }
    catch (error) {
      if (error instanceof AuthError) throw error;
      if (error?.errcode === 2067 && /owners\.username/.test(error.message || '')) throw new AuthError('USERNAME_TAKEN', '此用户名已被使用');
      throw new AuthError('AUTH_STORAGE_ERROR', '账号存储暂时不可用，请重试');
    }
  }
  transaction(work) {
    return this.storage(() => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = work();
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch { /* Do not replace the actionable error. */ }
        throw error;
      }
    });
  }
  async hashPassword(password) {
    const salt = randomBytes(16).toString('hex');
    try { return { salt, hash: (await derive(password, salt)).toString('hex') }; }
    catch { throw new AuthError('AUTH_UNAVAILABLE', '密码验证暂时不可用，请稍后重试'); }
  }
  insertOwner({ username, name, role, salt, hash }) {
    const owner = { id: `owner_${randomUUID()}`, username, name, role };
    this.db.prepare('INSERT INTO owners(id,username,name,role,password_hash,password_salt,password_params,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(owner.id, username, name, role, hash, salt, JSON.stringify({ algorithm: 'scrypt', N: PASSWORD_POLICY.N, r: PASSWORD_POLICY.r, p: PASSWORD_POLICY.p, keylen: PASSWORD_POLICY.keylen }), this.now());
    return owner;
  }
  issueSession(owner) {
    const token = randomBytes(32).toString('base64url');
    const issuedAt = this.now(); const expires_at = issuedAt + SESSION_MS;
    this.db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(issuedAt);
    this.db.prepare('INSERT INTO sessions(token_hash,owner_id,created_at,expires_at) VALUES(?,?,?,?)').run(digest(token), owner.id, issuedAt, expires_at);
    return { owner, token, csrf_token: csrfFor(token), expires_at };
  }

  async createAdmin({ username, password, name } = {}) {
    username = usernameInput(username); password = passwordInput(password); name = nameInput(name, username);
    if (this.storage(() => this.db.prepare('SELECT id FROM owners WHERE username=?').get(username))) throw new AuthError('USERNAME_TAKEN', '此用户名已被使用');
    const credentials = await this.hashPassword(password);
    return this.transaction(() => this.insertOwner({ username, name, role: 'admin', ...credentials }));
  }

  async login({ username, password } = {}) {
    try { username = usernameInput(username); password = passwordInput(password); } catch { throw invalidCredentials(); }
    const row = this.storage(() => this.db.prepare('SELECT * FROM owners WHERE username=?').get(username));
    let supplied;
    try { supplied = await derive(password, row?.password_salt || fakeSalt); }
    catch { throw new AuthError('AUTH_UNAVAILABLE', '密码验证暂时不可用，请稍后重试'); }
    const expected = row && /^[a-f0-9]{128}$/.test(row.password_hash) ? Buffer.from(row.password_hash, 'hex') : fakeHash;
    const matches = timingSafeEqual(supplied, expected);
    supplied.fill(0);
    if (!row || !matches) throw invalidCredentials();
    return this.transaction(() => this.issueSession(publicOwner(row)));
  }

  async register({ username, password, name, invite_code } = {}) {
    username = usernameInput(username); password = passwordInput(password); name = nameInput(name, username); invite_code = invitationInput(invite_code);
    const inviteHash = digest(invite_code);
    const validateInvite = () => {
      const invite = this.db.prepare('SELECT * FROM invitations WHERE code_hash=?').get(inviteHash);
      if (!invite || invite.used_at !== null || invite.expires_at <= this.now()) throw new AuthError('INVALID_INVITE', '邀请码无效、已使用或已过期');
      return invite;
    };
    this.storage(() => {
      validateInvite();
      if (this.db.prepare('SELECT id FROM owners WHERE username=?').get(username)) throw new AuthError('USERNAME_TAKEN', '此用户名已被使用');
    });
    const credentials = await this.hashPassword(password);
    return this.transaction(() => {
      const invite = validateInvite();
      const owner = this.insertOwner({ username, name, role: 'member', ...credentials });
      const consumed = this.db.prepare('UPDATE invitations SET used_at=?,used_by=? WHERE id=? AND used_at IS NULL AND expires_at>?').run(this.now(), owner.id, invite.id, this.now());
      if (consumed.changes !== 1) throw new AuthError('INVALID_INVITE', '邀请码无效、已使用或已过期');
      return this.issueSession(owner);
    });
  }

  session(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return this.storage(() => {
      const row = this.db.prepare('SELECT owners.id,owners.username,owners.name,owners.role,sessions.expires_at FROM sessions JOIN owners ON owners.id=sessions.owner_id WHERE token_hash=?').get(digest(token));
      if (!row) return null;
      if (row.expires_at <= this.now()) { this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token)); return null; }
      return { owner: publicOwner(row), csrf_token: csrfFor(token), expires_at: row.expires_at };
    });
  }
  logout(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    this.storage(() => this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token)));
  }
  requireAdmin(ownerId) {
    const owner = this.getOwner(ownerId);
    if (owner?.role !== 'admin') throw new AuthError('NOT_AUTHORIZED', '只有管理员可以管理邀请码');
    return owner;
  }
  createInvite(ownerId, { expires_hours = 72 } = {}) {
    this.requireAdmin(ownerId);
    if (typeof expires_hours !== 'number' || !Number.isFinite(expires_hours) || expires_hours < 1 || expires_hours > 720) throw new AuthError('INVALID_EXPIRY', '邀请码有效期须为 1–720 小时');
    const invite_code = `plaza_${randomBytes(24).toString('base64url')}`;
    const invite_id = `invite_${randomUUID()}`; const created = this.now(); const expires_at = created + expires_hours * 3600000;
    return this.transaction(() => {
      this.requireAdmin(ownerId);
      this.db.prepare('INSERT INTO invitations(id,code_hash,created_by,created_at,expires_at) VALUES(?,?,?,?,?)').run(invite_id, digest(invite_code), ownerId, created, expires_at);
      return { invite_code, expires_at, invite_id };
    });
  }
  listInvites(ownerId) {
    this.requireAdmin(ownerId);
    return this.storage(() => this.db.prepare('SELECT id AS invite_id,created_by,created_at,expires_at,used_at,used_by FROM invitations ORDER BY created_at DESC,id DESC').all().map(row => ({ ...row })));
  }
  firstAdmin() { return this.storage(() => publicOwner(this.db.prepare("SELECT id,username,name,role FROM owners WHERE role='admin' ORDER BY created_at,id LIMIT 1").get())); }
  getOwner(id) { return typeof id === 'string' ? this.storage(() => publicOwner(this.db.prepare('SELECT id,username,name,role FROM owners WHERE id=?').get(id))) : null; }
  close() { if (this.closed) return; this.storage(() => this.db.close()); this.closed = true; }
}
