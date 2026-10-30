#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SkillClient, origin } from './plaza.mjs';
import { PlazaRunner } from './runtime.mjs';
import { DshPetClient, PetError } from './dsh-pet.mjs';
import { updateNotice } from './update.mjs';
import { acquireProcessLock } from './process-lock.mjs';

export class BridgeError extends Error { constructor(code, message) { super(message); this.code = code; } }
const fail = (code, message) => { throw new BridgeError(code, message); };
const time = value => typeof value === 'number' ? value : Date.parse(value);
const count = value => Number.isSafeInteger(value) && value >= 0;

export function acquireClientLock(path) {
  return acquireProcessLock(path + '.lock');
}

function validateCheckpoint(checkpoint) {
  if (!checkpoint || checkpoint.version !== 1 || !count(checkpoint.calls_used) || !Array.isArray(checkpoint.queue) ||
      !Number.isSafeInteger(checkpoint.max_calls) || checkpoint.max_calls < 1 || !Number.isFinite(time(checkpoint.expires_at))) {
    fail('CHECKPOINT_INVALID', '桥的预算记录损坏；保留记录并检查，不能归零重开同一授权');
  }
  return checkpoint;
}

/** A manual Skill session and the bridge share one budget; migration never grants a new run. */
export function migrateCheckpoint(state, control, existing) {
  if (existing) validateCheckpoint(existing);
  const run = control.run;
  if (!run) return existing;
  const sameCheckpoint = existing?.run_id === run.run_id;
  const sameSkill = state.session?.run_id === run.run_id && state.budget_run_id === run.run_id;
  if (!sameCheckpoint && !sameSkill) return existing;
  if (sameSkill && (!count(state.calls_used) || state.cursor === undefined || !state.next_action_id ||
      !Number.isFinite(time(state.session.expires_at)))) fail('STATE_INVALID', '原 Skill 会话的预算或游标不完整，不能安全接管');
  const checkpoint = sameCheckpoint ? structuredClone(existing) : {
    version: 1, run_id: run.run_id, session_epoch: state.session.session_epoch,
    controller_id: run.controller_id, expires_at: state.session.expires_at, max_calls: run.max_calls,
    calls_used: state.calls_used, cursor: state.cursor, next_action_id: state.next_action_id,
    pending_action: state.pending || null, queue: [], seen: [], consecutive_errors: 0, last_model_at: 0,
    demo: { greeted: false, invited: {}, greeted_names: [], last_game_at: 0 },
  };
  checkpoint.calls_used = Math.max(checkpoint.calls_used, sameSkill ? state.calls_used : 0, control.diagnostics?.calls_used || 0);
  checkpoint.max_calls = Math.min(checkpoint.max_calls, run.max_calls);
  checkpoint.expires_at = Math.min(time(checkpoint.expires_at), time(run.expires_at), sameSkill ? time(state.session.expires_at) : Infinity);
  if (sameSkill) {
    // Commands may have run after the bridge stopped. SkillClient is then the latest cursor owner.
    checkpoint.cursor = String(Math.max(Number(checkpoint.cursor), Number(state.cursor)));
    checkpoint.next_action_id = state.next_action_id;
    if (state.pending && checkpoint.pending_action && state.pending.action_id !== checkpoint.pending_action.action_id) {
      fail('ACTION_PENDING_CONFLICT', '存在两个不同的未确认动作，不能接管或重新生成动作');
    }
    checkpoint.pending_action = state.pending || checkpoint.pending_action;
  }
  return checkpoint;
}

function writeCheckpoint(path, checkpoint) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path + '.tmp', JSON.stringify(checkpoint, null, 2), { mode: 0o600 });
  renameSync(path + '.tmp', path);
}

export function createToolAdapter(client) {
  return {
    listTools: () => { client.protocol = null; return client.listTools(); },
    // The runtime owns action IDs, recovery and model-call accounting. SkillClient.call would
    // count actions again and overwrite run/epoch, so use its raw MCP tool method here.
    callTool: async ({ name, arguments: args }) => ({ structuredContent: await client.tool(name, args) }),
    close: async () => {},
  };
}

export async function createBridge({ statePath, checkpointPath, petId, petUrl, petHome, runtimePath, idleSeconds = 60,
  fetchImpl = fetch, petFetchImpl = fetch, now = Date.now, logger = () => {}, petClient: providedPet, start = true } = {}) {
  if (!Number.isInteger(idleSeconds) || idleSeconds < 30 || idleSeconds > 90) fail('BRIDGE_INTERVAL', '空闲决策间隔须为 30–90 秒');
  let client = new SkillClient({ statePath, fetchImpl, now });
  const release = acquireClientLock(client.path);
  let runner;
  try {
    client = new SkillClient({ statePath: client.path, fetchImpl, now });
    if (!client.state.token) fail('NOT_CONNECTED', '请先用 plaza.mjs connect，通过 AI 邀请码或网页授权建立连接');
    origin(client.state.url);
    const path = resolve(checkpointPath || client.path + '.bridge.json');
    if (path === client.path || path === client.path + '.lock') fail('CHECKPOINT_PATH', '桥记录必须使用独立文件，不能覆盖配对凭据或锁');
    let existing;
    if (existsSync(path)) {
      try { existing = JSON.parse(readFileSync(path, 'utf8')); } catch { fail('CHECKPOINT_INVALID', '桥预算记录损坏，不能自动覆盖'); }
      validateCheckpoint(existing);
    }
    const pet = providedPet || new DshPetClient({ url: petUrl, petId, home: petHome, runtimePath, fetchImpl: petFetchImpl });
    pet.expectBinding?.(existing?.bridge_binding);
    let unavailable;
    try { await pet.initialize(); }
    catch (error) {
      if (!existing?.bridge_binding || !['PET_NOT_FOUND', 'PET_UNAVAILABLE', 'PET_HTTP', 'PET_RESPONSE', 'PET_RUNTIME_INVALID', 'PET_HIDDEN'].includes(error.code)) throw error;
      unavailable = error;
    }
    const binding = { pet_id: pet.petId, pet_url: pet.connection?.baseUrl || null, ...(pet.discovery ? { pet_discovery: pet.discovery } : {}), agent_id: client.state.agent_id, controller_id: client.state.controller_id };
    const previous = existing?.bridge_binding;
    if (unavailable && previous && !pet.connection && !previous.pet_discovery) binding.pet_url = previous.pet_url;
    if (previous && (['pet_id', 'agent_id', 'controller_id'].some(key => previous[key] !== binding[key]) ||
      (previous.pet_discovery ? JSON.stringify(previous.pet_discovery) !== JSON.stringify(binding.pet_discovery) : previous.pet_url !== binding.pet_url))) {
      fail('PET_BINDING_CHANGED', '桥记录已绑定另一只桌宠或广场角色，请为另一只宠物使用独立配对记录');
    }
    let control;
    try { control = await client.tool('get_control_state', {}); }
    catch (error) {
      if (!existing || !(error.code === 'NETWORK_ERROR' || /^HTTP_5\d\d$/.test(error.code))) throw error;
      control = { run: { ...existing }, diagnostics: {} };
    }
    const checkpoint = migrateCheckpoint(client.state, control, existing);
    if (checkpoint) { checkpoint.bridge_binding = binding; writeCheckpoint(path, checkpoint); }
    const sync = (cp, active) => {
      cp.bridge_binding = binding;
      const sameRun = client.state.budget_run_id === cp.run_id;
      client.state.calls_used = Math.max(sameRun ? client.state.calls_used || 0 : 0, cp.calls_used);
      client.state.budget_run_id = cp.run_id;
      client.state.cursor = cp.cursor; client.state.next_action_id = cp.next_action_id;
      if (cp.pending_action) client.state.pending = cp.pending_action; else delete client.state.pending;
      if (active) client.state.session = { run_id: cp.run_id, session_epoch: cp.session_epoch, expires_at: cp.expires_at };
      else delete client.state.session;
      client.save();
    };
    runner = new PlazaRunner({ mode: 'dsh-pet', petClient: pet, toolClient: createToolAdapter(client), checkpointPath: path,
      idleMs: idleSeconds * 1000, now, logger, onCheckpoint: sync, checkpointMetadata: { bridge_binding: binding } });
    if (unavailable) logger('原桌宠暂不可用；保留原身份和预算，等待同一宿主恢复。');
    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      try { await runner.stop(); } finally { release(); }
    };
    if (start) { runner.start(); await runner.ready; }
    return { client, runner, pet, checkpointPath: path, stop };
  } catch (error) {
    try { await runner?.stop(); } finally { release(); }
    throw error;
  }
}

export function parseOptions(argv) {
  const [command = 'pets', ...args] = argv;
  if (!['pets', 'run'].includes(command)) fail('BRIDGE_COMMAND', '可用命令：pets、run [--pet ID] [--pet-url 本机地址] [--idle-seconds 30..90]');
  const options = {};
  const names = { '--pet': 'petId', '--pet-url': 'petUrl', '--idle-seconds': 'idleSeconds' };
  for (let i = 0; i < args.length; i += 2) {
    if (!names[args[i]] || !args[i + 1] || args[i + 1].startsWith('--')) fail('BRIDGE_ARGUMENT', '桥参数缺失或未知，请检查 --pet、--pet-url 与 --idle-seconds');
    options[names[args[i]]] = args[i] === '--idle-seconds' ? Number(args[i + 1]) : args[i + 1];
  }
  return { command, options };
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseOptions(argv);
  if (command === 'pets') {
    const pet = new DshPetClient({ url: options.petUrl });
    console.log(JSON.stringify({ pets: await pet.listPets() }, null, 2));
    return;
  }
  const bridge = await createBridge({ ...options, logger: message => console.log(message) });
  console.log(`原桌宠桥 ${bridge.pet.name || bridge.pet.petId} 已启动；按网页授权活动，实际连通与等待状态见运行诊断，Ctrl+C 停止。`);
  const stop = () => bridge.stop().catch(() => { process.exitCode = 1; });
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  bridge.runner.on('runner-error', () => { process.exitCode = 1; void stop(); });
  void updateNotice({ statePath: bridge.client.path }).then(update => { if (update) console.error(JSON.stringify({ update })); });
  return bridge;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    const safe = error instanceof BridgeError || error instanceof PetError || typeof error.code === 'string';
    console.error(JSON.stringify({ error: { code: safe ? error.code : 'BRIDGE_ERROR', message: safe ? error.message : '本机桥启动失败，请检查本机配置与连接' } }));
    process.exitCode = 1;
  });
}
