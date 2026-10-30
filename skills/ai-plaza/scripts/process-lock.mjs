import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';

/** No command line, environment or credentials are read. Unknown means keep it. */
export function probeProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return { state: 'unknown' };
  try { process.kill(pid, 0); }
  catch (error) { return { state: error.code === 'ESRCH' ? 'dead' : 'unknown' }; }
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (fields[0] === 'Z') return { state: 'dead' };
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      if (/^\d+$/.test(fields[19])) return { state: 'alive', identity: `${boot}:${fields[19]}` };
    } else if (process.platform === 'win32') {
      const script = `try { [System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks } catch { exit 1 }`;
      const started = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (/^\d+$/.test(started)) return { state: 'alive', identity: started };
    }
  } catch { /* Permission errors or disappearing processes never prove ownership. */ }
  return { state: 'alive' };
}

const ownerName = /^[a-f0-9-]{36}\.json$/;
const missing = error => error.code === 'ENOENT';

/** mkdir exclusively reserves the lock, including against legacy PID files.
 * Reclaim/release removes only its unique owner entry. An empty/unknown lock is
 * never reclaimed: it may be an owner still publishing its identity. */
export function acquireProcessLock(path, { code = 'CLIENT_BUSY', probe = probeProcess, host = hostname() } = {}) {
  const lock = resolve(path), parent = dirname(lock), token = randomUUID(), file = token + '.json';
  const busy = () => { throw Object.assign(new Error('已有操作占用此记录，或锁的进程身份无法确认；请正常停止原进程。旧版或损坏锁须人工核实，不会自动抢占。'), { code }); };
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const identity = probe(process.pid).identity || null;
  let acquired = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    try { mkdirSync(lock, { mode: 0o700 }); acquired = true; }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES', 'ENOTDIR', 'EISDIR'].includes(error.code)) throw error;
    }
    if (acquired) {
      try { writeFileSync(join(lock, file), JSON.stringify({ version: 1, pid: process.pid, identity, host, token }), { mode: 0o600, flag: 'wx' }); }
      catch (error) { try { rmdirSync(lock); } catch { /* Preserve an uncertain lock. */ } throw error; }
      break;
    }
    let entries, owner;
    try {
      const info = lstatSync(lock);
      if (!info.isDirectory() || info.isSymbolicLink()) busy(); // Legacy PID-only files remain fail-closed.
      entries = readdirSync(lock);
      if (entries.length !== 1 || !ownerName.test(entries[0])) busy();
      const entry = join(lock, entries[0]), stat = lstatSync(entry);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2048) busy();
      owner = JSON.parse(readFileSync(entry, 'utf8'));
      if (owner.version !== 1 || owner.host !== host || entries[0] !== owner.token + '.json' || !Number.isSafeInteger(owner.pid) || owner.pid < 1) busy();
    } catch (error) { if (missing(error)) continue; busy(); }
    const current = probe(owner.pid);
    const previousExited = current.state === 'dead' || current.state === 'alive' && owner.identity && current.identity && owner.identity !== current.identity;
    if (!previousExited) busy();
    try { unlinkSync(join(lock, entries[0])); }
    catch (error) { if (missing(error)) continue; busy(); }
    try { rmdirSync(lock); } catch (error) { if (!missing(error) && error.code !== 'ENOTEMPTY') busy(); }
  }
  if (!acquired) busy();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { unlinkSync(join(lock, file)); }
    catch (error) { if (missing(error)) return; throw error; }
    try { rmdirSync(lock); } catch (error) { if (!missing(error) && error.code !== 'ENOTEMPTY') throw error; }
  };
}
