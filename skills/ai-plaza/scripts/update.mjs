import { createHash, randomUUID } from 'node:crypto';
import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OFFICIAL_SOURCE = 'https://github.com/undefinedKey/ai-play/tree/main/skills/ai-plaza';
const API = 'https://api.github.com/repos/undefinedKey/ai-play';
const PREFIX = 'skills/ai-plaza/';
const SHA = /^[a-f0-9]{40}$/;
const FILE_LIMIT = 256 * 1024;
const TOTAL_LIMIT = 2 * 1024 * 1024;
const DAY = 86400000;
const defaultRoot = fileURLToPath(new URL('..', import.meta.url));
export class UpdateError extends Error { constructor(code, message) { super(message); this.code = code; } }
const fail = (code, message) => { throw new UpdateError(code, message); };

export function versionFromSkill(source) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1] || '';
  const version = /^\s+version:\s*["']?(\d+\.\d+\.\d+)["']?\s*$/m.exec(frontmatter)?.[1];
  if (!version) fail('UPDATE_VERSION', 'Skill 缺少有效的稳定版本号，未执行升级');
  return version;
}
export function compareVersions(left, right) {
  for (const value of [left, right]) if (!/^\d+\.\d+\.\d+$/.test(value) || value.split('.').some(part => !Number.isSafeInteger(Number(part)))) fail('UPDATE_VERSION', '版本号格式无效');
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}
export const blobHash = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

function safePath(path) {
  if (typeof path !== 'string' || path.length > 240 || path.split('/').some(part => !part || part === '.' || part === '..' ||
      !/^[\p{L}\p{N}_.-]+$/u.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    fail('UPDATE_PATH', '更新包包含不安全路径，未执行升级');
  }
  return path;
}
function inRoot(root, path) {
  const target = resolve(root, path);
  if (!target.startsWith(root + sep)) fail('UPDATE_PATH', '更新目标超出 Skill 文件夹');
  return target;
}
function updater(fetchImpl, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  let requests = 0;
  const request = async path => {
    if (++requests > 68) fail('UPDATE_SIZE', '更新请求超出限制');
    let response;
    try { response = await fetchImpl(API + path, { redirect: 'error', signal, headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } }); }
    catch { fail('UPDATE_UNAVAILABLE', '暂时无法检查 GitHub 更新；现有连接仍可继续使用'); }
    if (!response.ok) fail('UPDATE_UNAVAILABLE', `GitHub 更新检查暂不可用（HTTP ${response.status}）`);
    let value;
    try {
      // Stream-bound actual bytes rather than trusting Content-Length alone.
      if (response.body?.getReader) {
        const reader = response.body.getReader(); const chunks = []; let size = 0;
        for (;;) {
          const { value: chunk, done } = await reader.read(); if (done) break;
          size += chunk.byteLength;
          if (size > TOTAL_LIMIT) { await reader.cancel(); fail('UPDATE_SIZE', '更新响应超过大小限制'); }
          chunks.push(Buffer.from(chunk));
        }
        value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } else {
        const body = await response.text();
        if (Buffer.byteLength(body) > TOTAL_LIMIT) fail('UPDATE_SIZE', '更新响应超过大小限制');
        value = JSON.parse(body);
      }
    } catch (error) { if (error instanceof UpdateError) throw error; fail('UPDATE_RESPONSE', 'GitHub 返回的更新信息无效'); }
    return value;
  };
  const blob = async entry => {
    const result = await request(`/git/blobs/${entry.sha}`);
    if (result.sha !== entry.sha || result.encoding !== 'base64' || typeof result.content !== 'string' || !Number.isSafeInteger(result.size) || result.size < 0 || result.size > FILE_LIMIT) fail('UPDATE_BLOB', '更新文件元数据无效');
    const base64 = result.content.replace(/\s/g, '');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) fail('UPDATE_BLOB', '更新文件编码无效');
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length !== result.size || bytes.length !== entry.size || blobHash(bytes) !== entry.sha) fail('UPDATE_INTEGRITY', '更新文件校验不符，未执行升级');
    return bytes;
  };
  return { request, blob };
}

async function releaseInfo(fetchImpl, timeoutMs) {
  const remote = updater(fetchImpl, timeoutMs);
  const commit = await remote.request('/commits/main');
  if (!SHA.test(commit.sha || '') || !SHA.test(commit.commit?.tree?.sha || '')) fail('UPDATE_RESPONSE', 'GitHub 提交信息无效');
  const result = await remote.request(`/git/trees/${commit.commit.tree.sha}?recursive=1`);
  if (result.truncated || !Array.isArray(result.tree) || result.sha !== commit.commit.tree.sha) fail('UPDATE_TREE', '更新文件树不完整');
  const files = [], paths = new Set(); let total = 0;
  for (const entry of result.tree) {
    if (typeof entry.path !== 'string' || !entry.path.startsWith(PREFIX)) continue;
    const path = safePath(entry.path.slice(PREFIX.length));
    if (entry.type === 'tree' && entry.mode === '040000') continue;
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode) || !SHA.test(entry.sha || '') || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > FILE_LIMIT) fail('UPDATE_TREE', '更新包包含不支持的文件类型或大小');
    if (paths.has(path)) fail('UPDATE_TREE', '更新包路径重复');
    paths.add(path); files.push({ path, sha: entry.sha, size: entry.size }); total += entry.size;
    if (files.length > 64 || total > TOTAL_LIMIT) fail('UPDATE_SIZE', '更新包超过文件数量或大小限制');
  }
  for (const required of ['SKILL.md', 'config.json', 'scripts/plaza.mjs', 'scripts/update.mjs']) if (!paths.has(required)) fail('UPDATE_TREE', '更新包缺少必要文件');
  // Reject a file that is also a parent of another file (case-insensitively for Windows).
  const normalized = [...paths].map(path => path.toLowerCase());
  if (new Set(normalized).size !== normalized.length || normalized.some(path => normalized.some(other => other.startsWith(path + '/')))) fail('UPDATE_PATH', '更新包路径发生冲突');
  const skill = files.find(file => file.path === 'SKILL.md');
  const skillBytes = await remote.blob(skill);
  const version = versionFromSkill(skillBytes.toString('utf8'));
  if (compareVersions(version, '0.8.2') >= 0 && ['scripts/runtime.mjs', 'scripts/dsh-pet.mjs', 'scripts/bridge.mjs', 'scripts/movement.mjs'].some(path => !paths.has(path))) {
    fail('UPDATE_TREE', '更新包缺少共享运行器或移动模块，未执行升级');
  }
  return { commit: commit.sha, version, files, remote, skillBytes };
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}
export async function checkForUpdate({ skillRoot = defaultRoot, cachePath, fetchImpl = fetch, now = Date.now, force = false, timeoutMs = 8000 } = {}) {
  const local = versionFromSkill(readFileSync(join(skillRoot, 'SKILL.md'), 'utf8'));
  let cache;
  try { cache = cachePath && JSON.parse(readFileSync(cachePath, 'utf8')); } catch { /* A corrupt cache never changes install or authorization. */ }
  if (!force && cache?.source === OFFICIAL_SOURCE && cache.local_version === local && Number.isFinite(cache.checked_at) && now() >= cache.checked_at && now() - cache.checked_at < (cache.status === 'unavailable' ? 3600000 : DAY)) {
    return { ...cache, cached: true };
  }
  let result;
  try {
    const latest = await releaseInfo(fetchImpl, timeoutMs);
    const comparison = compareVersions(latest.version, local);
    result = { source: OFFICIAL_SOURCE, local_version: local, latest_version: latest.version, commit: latest.commit,
      status: comparison > 0 ? 'update_available' : comparison < 0 ? 'local_newer' : 'up_to_date', checked_at: now(),
      ...(cache?.notified_version ? { notified_version: cache.notified_version } : {}) };
  } catch (error) {
    result = { source: OFFICIAL_SOURCE, local_version: local, status: 'unavailable', checked_at: now(),
      error: { code: error instanceof UpdateError ? error.code : 'UPDATE_UNAVAILABLE', message: error instanceof UpdateError ? error.message : '更新检查暂不可用；现有连接仍可继续使用' } };
  }
  if (cachePath) { try { writeJson(cachePath, result); } catch { /* Read-only install/cache must not block normal use. */ } }
  return result;
}

export async function updateNotice({ statePath, ...options }) {
  const cachePath = statePath + '.updates.json';
  try {
    const result = await checkForUpdate({ ...options, cachePath, timeoutMs: 1500 });
    if (result.status !== 'update_available' || result.notified_version === result.latest_version) return null;
    try { writeJson(cachePath, { ...result, notified_version: result.latest_version }); } catch { return null; }
    return { local_version: result.local_version, latest_version: result.latest_version, source: OFFICIAL_SOURCE,
      message: `ai-plaza ${result.latest_version} 可用；停止接入桥后运行 node scripts/plaza.mjs update 更新，原授权记录会保留。` };
  } catch { return null; }
}

function gitAncestor(root) {
  for (let current = root; ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) return current;
    if (dirname(current) === current) return null;
  }
}
function checkLocalTree(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name), info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory()) fail('UPDATE_LOCAL_PATH', '本地 Skill 包含链接或特殊文件，请手动更新并保留原文件');
    if (info.isDirectory()) checkLocalTree(path);
  }
}

/** Explicit installation only. No server response or chat message can choose the source. */
async function installUpdate({ skillRoot = defaultRoot, statePath, fetchImpl = fetch, now = Date.now, timeoutMs = 30000, renameImpl = renameSync } = {}) {
  const root = resolve(skillRoot), parent = dirname(root);
  if (root === parent || realpathSync(root) !== root || !lstatSync(root).isDirectory()) fail('UPDATE_LOCAL_PATH', '请使用实际 Skill 文件夹路径，不使用链接或根目录');
  if (statePath && (relative(root, resolve(statePath)) === '' || resolve(statePath).startsWith(root + sep))) fail('CLIENT_BUSY', '凭据记录必须位于 Skill 文件夹之外，未执行升级');
  const repository = gitAncestor(root);
  if (repository) return { status: 'git_checkout', source: OFFICIAL_SOURCE, repository, message: '这是 Git 工作区中的 Skill，请先停止接入桥，再在仓库执行 git pull --ff-only；更新器不会覆盖 Git 工作树。' };
  const local = versionFromSkill(readFileSync(join(root, 'SKILL.md'), 'utf8'));
  const lockPath = join(parent, `.${basename(root)}.update.lock`);
  let lock;
  try { lock = openSync(lockPath, 'wx', 0o600); writeFileSync(lock, String(process.pid)); }
  catch { fail('UPDATE_BUSY', '已有 Skill 更新操作或残留更新锁，请确认原进程已结束'); }
  let staging, backup;
  try {
    const latest = await releaseInfo(fetchImpl, timeoutMs);
    if (compareVersions(latest.version, local) <= 0) return { status: 'up_to_date', local_version: local, latest_version: latest.version, source: OFFICIAL_SOURCE };
    const downloaded = new Map([['SKILL.md', latest.skillBytes]]);
    for (const entry of latest.files) if (entry.path !== 'SKILL.md') downloaded.set(entry.path, await latest.remote.blob(entry));
    checkLocalTree(root);
    staging = mkdtempSync(join(parent, '.ai-plaza-update-'));
    // Start with the installed tree so local notes and custom files survive upgrades.
    cpSync(root, staging, { recursive: true, errorOnExist: false, force: true });
    for (const [path, bytes] of downloaded) {
      const target = inRoot(staging, path);
      mkdirSync(dirname(target), { recursive: true });
      let contents = bytes;
      if (path === 'config.json' && existsSync(join(root, path))) {
        try {
          const previous = JSON.parse(readFileSync(join(root, path), 'utf8')), next = JSON.parse(bytes.toString('utf8'));
          if (!previous || !next || Array.isArray(previous) || Array.isArray(next) || typeof previous !== 'object' || typeof next !== 'object') throw new Error();
          contents = Buffer.from(JSON.stringify({ ...next, ...previous }, null, 2) + '\n');
        } catch { fail('UPDATE_CONFIG', '本地或新版 config.json 无效；保留原安装，未执行替换'); }
      }
      writeFileSync(target, contents, { mode: 0o600 });
    }
    writeJson(join(staging, '.ai-plaza-installed.json'), { source: OFFICIAL_SOURCE, version: latest.version, commit: latest.commit, files: latest.files.map(file => file.path) });
    backup = join(parent, `${basename(root)}.backup-${now()}-${randomUUID()}`);
    if (!backup.startsWith(parent + sep) || !staging.startsWith(parent + sep)) fail('UPDATE_LOCAL_PATH', '更新路径校验失败');
    renameImpl(root, backup);
    const backupSkillFile = `manifest-${randomUUID()}.md.backup`;
    let manifestArchived = false;
    try {
      // A backup inside a host's skills folder must not be discovered as a second old Skill.
      renameSync(join(backup, 'SKILL.md'), join(backup, backupSkillFile)); manifestArchived = true;
      renameImpl(staging, root); staging = null;
    }
    catch (error) {
      try {
        if (manifestArchived) renameSync(join(backup, backupSkillFile), join(backup, 'SKILL.md'));
        renameSync(backup, root); backup = null;
      } catch { fail('UPDATE_ROLLBACK', '替换失败且无法自动恢复，请使用同目录 backup 备份恢复（必要时把 manifest-*.md.backup 还原为 SKILL.md）；凭据未改变'); }
      fail('UPDATE_REPLACE', '替换失败，原 Skill 已恢复；凭据未改变');
    }
    return { status: 'updated', local_version: local, latest_version: latest.version, commit: latest.commit, source: OFFICIAL_SOURCE, backup, backup_skill_file: backupSkillFile,
      restore_note: '备份不参与技能发现；恢复时先将 backup_skill_file 还原为 SKILL.md，再恢复目录。',
      message: 'Skill 已升级，原服务地址、授权记录和自定义文件已保留；重新启动接入桥以加载新版。' };
  } finally {
    if (staging && staging.startsWith(parent + sep) && dirname(staging) === parent) rmSync(staging, { recursive: true, force: true });
    closeSync(lock); unlinkSync(lockPath);
  }
}

export async function updateSkill(options = {}) {
  const path = options.statePath && resolve(options.statePath);
  let lock;
  if (path) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { lock = openSync(path + '.lock', 'wx', 0o600); writeFileSync(lock, String(process.pid)); }
    catch { fail('CLIENT_BUSY', '请先正常停止接入桥或原 Skill 操作，再执行升级；不要删除仍在使用的锁'); }
  }
  try { return await installUpdate({ ...options, statePath: path }); }
  finally { if (lock !== undefined) { closeSync(lock); unlinkSync(path + '.lock'); } }
}
