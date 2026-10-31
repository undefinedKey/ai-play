import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OFFICIAL_SOURCE, blobHash, checkForUpdate, compareVersions, updateNotice, updateSkill } from '../skills/ai-plaza/scripts/update.mjs';

const document = version => `---\nname: ai-plaza\nmetadata:\n  version: "${version}"\n---\n# World\n`;
function fixture(t) {
  const parent = resolve(tmpdir()), directory = mkdtempSync(join(parent, 'plaza-update-test-'));
  t.after(() => { assert.equal(dirname(directory), parent); rmSync(directory, { recursive: true, force: true }); });
  const root = join(directory, 'ai-plaza'), statePath = join(directory, 'state', 'client.json');
  mkdirSync(join(root, 'scripts'), { recursive: true }); mkdirSync(dirname(statePath));
  writeFileSync(join(root, 'SKILL.md'), document('0.5.0'));
  writeFileSync(join(root, 'config.json'), JSON.stringify({ default_url: 'http://my-world.example:3000', custom: 'keep' }));
  writeFileSync(join(root, 'scripts', 'plaza.mjs'), 'old source');
  writeFileSync(join(root, 'my-notes.md'), 'private custom notes');
  const state = JSON.stringify({ token: 'WORLD_PRIVATE', session: { run_id: 'same-run' }, calls_used: 37 });
  writeFileSync(statePath, state);
  return { directory, root, statePath, state };
}
function github({ version = '0.6.0', extra = [], corrupt = false, newFiles = {} } = {}) {
  const files = {
    'SKILL.md': document(version),
    'config.json': JSON.stringify({ default_url: 'https://new-default.example', added: true }),
    'scripts/plaza.mjs': 'new source',
    'scripts/update.mjs': 'new updater',
    ...newFiles,
  };
  const blobs = new Map();
  const tree = Object.entries(files).map(([path, text]) => {
    const buffer = Buffer.from(text), sha = blobHash(buffer);
    blobs.set(sha, { sha, content: buffer.toString('base64'), encoding: 'base64', size: buffer.length });
    return { path: 'skills/ai-plaza/' + path, sha, type: 'blob', mode: '100644', size: buffer.length };
  });
  tree.push(...extra);
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    assert.ok(url.startsWith('https://api.github.com/repos/undefinedKey/ai-play/'));
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.headers['X-DSH-Pet-Token'], undefined);
    let body;
    if (url.endsWith('/commits/main')) body = { sha: 'a'.repeat(40), commit: { tree: { sha: 'b'.repeat(40) } } };
    else if (url.includes('/git/trees/')) body = { sha: 'b'.repeat(40), truncated: false, tree };
    else {
      const sha = url.split('/').at(-1); body = structuredClone(blobs.get(sha));
      if (corrupt && body && Buffer.from(body.content, 'base64').toString() === 'new source') body.content = Buffer.from('bad source').toString('base64');
    }
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { fetchImpl, requests };
}

test('0.8.2升级必须包含移动模块并校验下载，独立Skill更新后不依赖补丁脚本', async t => {
  const f = fixture(t);
  const source = readFileSync(new URL('../skills/ai-plaza/scripts/movement.mjs', import.meta.url), 'utf8');
  const shared = { 'scripts/runtime.mjs': 'new runtime', 'scripts/dsh-pet.mjs': 'new pet', 'scripts/bridge.mjs': 'new bridge' };
  await assert.rejects(updateSkill({ skillRoot: f.root, statePath: f.statePath, fetchImpl: github({ version: '0.8.2', newFiles: shared }).fetchImpl }), { code: 'UPDATE_TREE' });
  assert.match(readFileSync(join(f.root, 'SKILL.md'), 'utf8'), /0\.5\.0/);
  await updateSkill({ skillRoot: f.root, statePath: f.statePath, fetchImpl: github({ version: '0.8.2', newFiles: { ...shared, 'scripts/movement.mjs': source } }).fetchImpl });
  assert.equal(readFileSync(join(f.root, 'scripts/movement.mjs'), 'utf8'), source);
  assert.equal(readFileSync(f.statePath, 'utf8'), f.state);
});

test('0.9.0完整升级要求版本文件与Skill一致，保留已有身份和预算', async t => {
  const f = fixture(t), modules = Object.fromEntries(['runtime', 'dsh-pet', 'bridge', 'movement'].map(name => [`scripts/${name}.mjs`, `new ${name}`]));
  await assert.rejects(updateSkill({ skillRoot: f.root, statePath: f.statePath, fetchImpl: github({ version: '0.9.0', newFiles: modules }).fetchImpl }), { code: 'UPDATE_TREE' });
  await assert.rejects(updateSkill({ skillRoot: f.root, statePath: f.statePath, fetchImpl: github({ version: '0.9.0', newFiles: { ...modules, 'version.json': '{"version":"0.8.2"}' } }).fetchImpl }), { code: 'UPDATE_VERSION' });
  await updateSkill({ skillRoot: f.root, statePath: f.statePath, fetchImpl: github({ version: '0.9.0', newFiles: { ...modules, 'version.json': '{"version":"0.9.0"}' } }).fetchImpl });
  assert.equal(JSON.parse(readFileSync(join(f.root, 'version.json'), 'utf8')).version, '0.9.0');
  assert.equal(readFileSync(f.statePath, 'utf8'), f.state);
});

test('0.14.0独立升级包含生活规则与恢复锁，实际桥可脱离仓库加载并报告真实版本与能力', async t => {
  const f = fixture(t);
  const files = Object.fromEntries(['SKILL.md', 'version.json', 'references/play.md', 'references/fatigue.md', 'references/farming-tools.md', 'references/recovery.md', 'references/gathering-cooking-trading.md', 'references/exploration-strategy-goals.md', 'scripts/v014-context.mjs',
    ...['runtime', 'dsh-pet', 'bridge', 'movement', 'plaza', 'update', 'process-lock'].map(name => `scripts/${name}.mjs`)]
    .map(path => [path, readFileSync(new URL(`../skills/ai-plaza/${path}`, import.meta.url), 'utf8')]));
  for (const missing of ['references/play.md', 'references/fatigue.md', 'references/farming-tools.md', 'references/recovery.md', 'references/gathering-cooking-trading.md', 'references/exploration-strategy-goals.md', 'scripts/v014-context.mjs', 'scripts/process-lock.mjs']) {
    const incomplete = { ...files }; delete incomplete[missing];
    await assert.rejects(updateSkill({ skillRoot: f.root, statePath: f.statePath, fetchImpl: github({ version: '0.14.0', newFiles: incomplete }).fetchImpl }), { code: 'UPDATE_TREE' });
    assert.match(readFileSync(join(f.root, 'SKILL.md'), 'utf8'), /0\.5\.0/);
  }
  await assert.rejects(updateSkill({ skillRoot: f.root, statePath: f.statePath, fetchImpl: github({ version: '0.14.0', newFiles: { ...files, 'version.json': '{"version":"0.12.0"}' } }).fetchImpl }), { code: 'UPDATE_VERSION' });
  await updateSkill({ skillRoot: f.root, statePath: f.statePath, fetchImpl: github({ version: '0.14.0', newFiles: files }).fetchImpl });
  const { PlazaRunner } = await import(pathToFileURL(join(f.root, 'scripts/runtime.mjs')).href);
  const { createBridge } = await import(pathToFileURL(join(f.root, 'scripts/bridge.mjs')).href);
  assert.equal(typeof createBridge, 'function');
  const reports = [], runner = new PlazaRunner({ mode: 'dsh-pet', petClient: {}, toolClient: {
    callTool: async ({ arguments: args }) => { reports.push(args); return { structuredContent: {} }; },
  } });
  runner.rules = { fatigue: {} }; runner.active = true;
  runner.checkpoint = { run_id: 'same-run', session_epoch: 1, calls_used: 37 };
  await runner.report('waiting');
  assert.equal(reports.at(-1).runtime_version, '0.14.0');
  assert.deepEqual(reports.at(-1).capabilities, ['fatigue', 'recovery', 'reliable_events']);
  runner.rules = { allowed_actions: ['farm', 'inventory'], life: { tools: ['hoe', 'watering_can'].map(id => ({ id, levels: [{ level: 1 }] })) } };
  await runner.report('waiting'); assert.deepEqual(reports.at(-1).capabilities, ['farming', 'inventory', 'equipment', 'farm_tools', 'recovery', 'reliable_events']);
  delete runner.rules.life.tools; await runner.report('waiting'); assert.ok(!reports.at(-1).capabilities.includes('farm_tools'));
  runner.rules = {}; await runner.report('waiting'); assert.deepEqual(reports.at(-1).capabilities, ['recovery', 'reliable_events']);
  runner.rules = { fatigue: {}, allowed_actions: ['farm', 'inventory'], life: { tools: ['hoe', 'watering_can'].map(id => ({ id, levels: [{ level: 1 }] })) } };
  runner.mode = 'demo'; await runner.report('waiting'); assert.deepEqual(reports.at(-1).capabilities, []);
  assert.match(readFileSync(join(f.root, 'references/fatigue.md'), 'utf8'), /不会.*替你选择/);
  assert.equal(readFileSync(f.statePath, 'utf8'), f.state);
});

test('版本检测使用数值语义，固定官方仓库并缓存，不把本地新版本降级', async t => {
  assert.equal(compareVersions('0.10.0', '0.9.8'), 1);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
  assert.equal(compareVersions('0.5.0', '0.5.0'), 0);
  const f = fixture(t), remote = github(), cachePath = join(f.directory, 'cache.json');
  const result = await checkForUpdate({ skillRoot: f.root, cachePath, fetchImpl: remote.fetchImpl, now: () => 1000 });
  assert.equal(result.status, 'update_available'); assert.equal(result.source, OFFICIAL_SOURCE);
  assert.equal(result.local_version, '0.5.0'); assert.equal(result.latest_version, '0.6.0');
  const count = remote.requests.length;
  assert.equal((await checkForUpdate({ skillRoot: f.root, cachePath, fetchImpl: remote.fetchImpl, now: () => 2000 })).cached, true);
  assert.equal(remote.requests.length, count);
  const ahead = await checkForUpdate({ skillRoot: f.root, fetchImpl: github({ version: '0.4.0' }).fetchImpl });
  assert.equal(ahead.status, 'local_newer');
});

test('自动提示只报告新版本一次，离线和损坏响应不阻止使用、不改凭证', async t => {
  const f = fixture(t), remote = github();
  const options = { skillRoot: f.root, statePath: f.statePath, fetchImpl: remote.fetchImpl, now: () => 1000 };
  assert.match((await updateNotice(options)).message, /可用/);
  assert.equal(await updateNotice(options), null);
  const offline = await checkForUpdate({ skillRoot: f.root, fetchImpl: async () => { throw new Error('offline private details'); } });
  assert.equal(offline.status, 'unavailable'); assert.ok(!JSON.stringify(offline).includes('private details'));
  assert.equal(readFileSync(f.statePath, 'utf8'), f.state);
});

test('显式升级校验每个blob、固定提交，保留地址/授权/本地文件和可恢复备份', async t => {
  const f = fixture(t), remote = github();
  const result = await updateSkill({ skillRoot: f.root, statePath: f.statePath, fetchImpl: remote.fetchImpl });
  assert.equal(result.status, 'updated'); assert.equal(result.commit, 'a'.repeat(40));
  assert.match(readFileSync(join(f.root, 'SKILL.md'), 'utf8'), /0\.6\.0/);
  assert.equal(readFileSync(join(f.root, 'scripts', 'plaza.mjs'), 'utf8'), 'new source');
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'config.json'), 'utf8')), { default_url: 'http://my-world.example:3000', added: true, custom: 'keep' });
  assert.equal(readFileSync(join(f.root, 'my-notes.md'), 'utf8'), 'private custom notes');
  assert.equal(readFileSync(f.statePath, 'utf8'), f.state);
  assert.equal(readFileSync(join(result.backup, 'scripts', 'plaza.mjs'), 'utf8'), 'old source');
  assert.equal(existsSync(join(result.backup, 'SKILL.md')), false, '备份不能被宿主识别成第二份旧Skill');
  assert.match(readFileSync(join(result.backup, result.backup_skill_file), 'utf8'), /0\.5\.0/);
  assert.equal(existsSync(f.statePath + '.lock'), false);
  assert.ok(remote.requests.every(request => !JSON.stringify(request).includes('WORLD_PRIVATE')));
});

test('校验失败与危险路径不修改安装，不下载链接、路径逃逸或过量文件', async t => {
  for (const remote of [github({ corrupt: true }), github({ extra: [{ path: 'skills/ai-plaza/../escape', sha: 'c'.repeat(40), type: 'blob', mode: '100644', size: 1 }] }),
    github({ extra: [{ path: 'skills/ai-plaza/link', sha: 'c'.repeat(40), type: 'blob', mode: '120000', size: 1 }] }),
    github({ extra: Array.from({ length: 65 }, (_, i) => ({ path: `skills/ai-plaza/file${i}.md`, sha: 'c'.repeat(40), type: 'blob', mode: '100644', size: 1 })) })]) {
    const f = fixture(t);
    await assert.rejects(updateSkill({ skillRoot: f.root, statePath: f.statePath, fetchImpl: remote.fetchImpl }), error => /^UPDATE_/.test(error.code));
    assert.match(readFileSync(join(f.root, 'SKILL.md'), 'utf8'), /0\.5\.0/);
    assert.equal(readFileSync(f.statePath, 'utf8'), f.state);
    assert.ok(!readdirSync(f.directory).some(name => name.startsWith('.ai-plaza-update-')));
    assert.equal(existsSync(f.statePath + '.lock'), false);
  }
});

test('接入桥持锁时拒绝更新，更新持锁期间不能开始另一连接操作', async t => {
  const f = fixture(t), remote = github();
  writeFileSync(f.statePath + '.lock', 'running');
  await assert.rejects(updateSkill({ skillRoot: f.root, statePath: f.statePath, fetchImpl: remote.fetchImpl }), { code: 'CLIENT_BUSY' });
  assert.equal(remote.requests.length, 0);
  rmSync(f.statePath + '.lock');
  const fetchImpl = (url, options) => { assert.equal(existsSync(f.statePath + '.lock'), true); return remote.fetchImpl(url, options); };
  await updateSkill({ skillRoot: f.root, statePath: f.statePath, fetchImpl });
});

test('目录替换失败恢复原Skill，Git工作区只给快进更新指引', async t => {
  const f = fixture(t), remote = github(); let renames = 0;
  await assert.rejects(updateSkill({ skillRoot: f.root, statePath: f.statePath, fetchImpl: remote.fetchImpl,
    renameImpl: (source, target) => { if (++renames === 2) throw new Error('simulated Windows rename failure'); renameSync(source, target); } }), { code: 'UPDATE_REPLACE' });
  assert.match(readFileSync(join(f.root, 'SKILL.md'), 'utf8'), /0\.5\.0/);
  assert.equal(readFileSync(join(f.root, 'scripts', 'plaza.mjs'), 'utf8'), 'old source');
  mkdirSync(join(f.directory, '.git'));
  const result = await updateSkill({ skillRoot: f.root, statePath: f.statePath, fetchImpl: async () => assert.fail('Git checkout must not fetch or overwrite') });
  assert.equal(result.status, 'git_checkout'); assert.match(result.message, /git pull --ff-only/);
});
