import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { acquireProcessLock } from '../skills/ai-plaza/scripts/process-lock.mjs';

function fixture(t) {
  const parent = resolve(tmpdir()), directory = mkdtempSync(join(parent, 'plaza-lock-'));
  t.after(() => { assert.equal(dirname(directory), parent); rmSync(directory, { recursive: true, force: true }); });
  return join(directory, 'client.lock');
}
function previous(path, values = {}) {
  const token = randomUUID(); mkdirSync(path);
  const owner = { version: 1, pid: 13579, host: hostname(), identity: 'old-start', token, ...values };
  writeFileSync(join(path, token + '.json'), JSON.stringify(owner));
  return owner;
}
const ownProbe = owner => pid => pid === process.pid ? { state: 'alive', identity: 'self-start' } : owner;

test('活锁、权限不明、跨主机、旧版PID文件与损坏记录不被自动抢占', t => {
  for (const current of [{ state: 'alive', identity: 'old-start' }, { state: 'unknown' }, { state: 'alive' }]) {
    const path = fixture(t); const owner = previous(path);
    assert.throws(() => acquireProcessLock(path, { probe: ownProbe(current) }), { code: 'CLIENT_BUSY' });
    assert.deepEqual(JSON.parse(readFileSync(join(path, owner.token + '.json'))), owner);
  }
  const foreign = fixture(t); previous(foreign, { host: 'another-machine' });
  assert.throws(() => acquireProcessLock(foreign, { probe: ownProbe({ state: 'dead' }) }), { code: 'CLIENT_BUSY' });
  const legacy = fixture(t); writeFileSync(legacy, '13579');
  assert.throws(() => acquireProcessLock(legacy), { code: 'CLIENT_BUSY' });
  assert.equal(readFileSync(legacy, 'utf8'), '13579');
  const broken = fixture(t); mkdirSync(broken); writeFileSync(join(broken, randomUUID() + '.json'), '{broken');
  assert.throws(() => acquireProcessLock(broken), { code: 'CLIENT_BUSY' });
  const empty = fixture(t); mkdirSync(empty);
  assert.throws(() => acquireProcessLock(empty), { code: 'CLIENT_BUSY' });
});

test('确认死亡或PID复用后恢复，旧release不能删掉新持有者', t => {
  for (const current of [{ state: 'dead' }, { state: 'alive', identity: 'new-start' }]) {
    const path = fixture(t); previous(path);
    const release = acquireProcessLock(path, { probe: ownProbe(current) });
    const owner = JSON.parse(readFileSync(join(path, readdirSync(path)[0])));
    assert.equal(owner.pid, process.pid); assert.equal(owner.identity, 'self-start');
    release(); release(); assert.equal(existsSync(path), false);
  }
  const path = fixture(t), release = acquireProcessLock(path, { probe: ownProbe({ state: 'dead' }) });
  release(); const next = acquireProcessLock(path, { probe: ownProbe({ state: 'dead' }) });
  release(); assert.equal(existsSync(path), true); next();
});

function child(path, { hold = true } = {}) {
  const module = new URL('../skills/ai-plaza/scripts/process-lock.mjs', import.meta.url).href;
  const source = `import {acquireProcessLock} from ${JSON.stringify(module)}; try { const release=acquireProcessLock(process.argv[1]); console.log('acquired'); ${hold ? "setInterval(()=>{},1000);process.on('SIGTERM',()=>{release();process.exit(0)})" : 'release();'} } catch(e) { console.log(e.code); process.exitCode=2; }`;
  const processChild = spawn(process.execPath, ['--input-type=module', '-e', source, path], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = new Promise((resolveOutput, reject) => { let text = ''; processChild.stdout.on('data', part => { text += part; if (text.includes('\n')) resolveOutput(text.trim()); }); processChild.once('error', reject); });
  const done = new Promise(resolveDone => processChild.once('exit', resolveDone));
  return { process: processChild, output, done };
}

test('真实进程强杀后恢复；同时竞争只能一个执行者持锁', async t => {
  const path = fixture(t), first = child(path);
  t.after(() => first.process.kill('SIGKILL'));
  assert.equal(await first.output, 'acquired');
  assert.throws(() => acquireProcessLock(path), { code: 'CLIENT_BUSY' });
  first.process.kill('SIGKILL'); await first.done;
  const competitors = Array.from({ length: 4 }, () => child(path));
  t.after(async () => { for (const c of competitors) c.process.kill('SIGKILL'); await Promise.all(competitors.map(c => c.done)); });
  const results = await Promise.all(competitors.map(c => c.output));
  assert.equal(results.filter(value => value === 'acquired').length, 1);
  assert.equal(results.filter(value => value === 'CLIENT_BUSY').length, 3);
  for (const c of competitors) c.process.kill('SIGKILL'); await Promise.all(competitors.map(c => c.done));
  const release = acquireProcessLock(path); release(); assert.equal(existsSync(path), false);
});
