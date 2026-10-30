import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DshPetClient } from '../skills/ai-plaza/scripts/dsh-pet.mjs';

const json = value => ({ ok: true, json: async () => value });
const config = id => ({ main: { pets: [{ id, name: '原来的我', display: 'both' }] } });
const context = { observation: {}, rules: {}, events: [] };
function fixture(t) {
  const parent = resolve(tmpdir()), home = mkdtempSync(join(parent, 'pet-recovery-'));
  t.after(() => { assert.equal(dirname(home), parent); rmSync(home, { recursive: true, force: true }); });
  mkdirSync(join(home, 'dsh-pet'));
  const update = (port, token = 'a'.repeat(43)) => writeFileSync(join(home, 'dsh-pet', 'standalone-runtime.json'), JSON.stringify({ port, token }));
  update(32980); return { home, update };
}

test('准备提示和本机预检不调用模型；实际发送前await预算钩子，拒绝后不fetch', async t => {
  const f = fixture(t), requests = []; let authorized = false, charged = 0;
  const pet = new DshPetClient({ home: f.home, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/config')) return json(config('original'));
    assert.equal(authorized, true); return json({ ok: true, text: '{"type":"wait","payload":{}}' });
  } });
  await pet.initialize(); const prepared = pet.prepareDecision(context); await pet.preflight();
  assert.equal(requests.filter(r => r.options.method === 'POST').length, 0);
  await assert.rejects(pet.decide(context, { prepared, onRequest: async () => { throw Object.assign(new Error('budget'), { code: 'BUDGET_EXHAUSTED' }); } }), { code: 'BUDGET_EXHAUSTED' });
  await assert.rejects(pet.decide(context, { prepared: { text: 'x'.repeat(2001) }, onRequest: () => { charged++; } }), { code: 'PET_CONTEXT_TOO_LARGE' });
  assert.equal(charged, 0); assert.equal(requests.filter(r => r.options.method === 'POST').length, 0);
  await pet.decide(context, { prepared, onRequest: async () => { await Promise.resolve(); authorized = true; charged++; } });
  assert.equal(charged, 1); assert.equal(requests.filter(r => r.options.method === 'POST').length, 1);
});

test('固定原发现来源允许端口和能力轮换，原pet不变，能力仅发给新本机端口', async t => {
  const f = fixture(t), requests = [];
  const pet = new DshPetClient({ home: f.home, url: 'http://127.0.0.1:32980', fetchImpl: async (url, options) => {
    requests.push({ url, options }); return json(url.endsWith('/config') ? config('original') : { ok: true, text: '{}' });
  } });
  await pet.initialize(); const binding = { pet_id: pet.petId, pet_discovery: pet.discovery };
  f.update(32981, 'b'.repeat(43));
  await pet.decide(context);
  const request = requests.at(-1); assert.ok(request.url.startsWith('http://127.0.0.1:32981/'));
  assert.equal(request.options.headers['X-DSH-Pet-Token'], 'b'.repeat(43)); assert.equal(request.options.headers.Authorization, undefined);
  assert.ok(!request.options.body.includes('b'.repeat(43))); assert.equal(pet.petId, 'original');
  const restored = new DshPetClient({ home: f.home, url: 'http://127.0.0.1:32980', fetchImpl: pet.fetch });
  restored.expectBinding(binding); await restored.initialize(); assert.equal(restored.petId, 'original'); assert.equal(restored.connection.baseUrl, pet.connection.baseUrl);
});

test('原pet消失不能默选剩下的另一只，失败不调用预算钩子或模型', async t => {
  const f = fixture(t); let id = 'original', calls = 0, charged = 0;
  const pet = new DshPetClient({ home: f.home, fetchImpl: async url => { if (!url.endsWith('/config')) calls++; return json(config(id)); } });
  await pet.initialize(); id = 'different'; // Same endpoint: never trust even a recent cached pet list for /chat.
  await assert.rejects(pet.decide(context, { onRequest: () => { charged++; } }), { code: 'PET_NOT_FOUND' });
  assert.equal(pet.petId, 'original'); assert.equal(calls, 0); assert.equal(charged, 0);
});

test('变更固定地址或发现文件在请求前拒绝，旧绑定验证后可迁移至稳定发现来源', async t => {
  const f = fixture(t);
  const forbidden = new DshPetClient({ home: f.home, url: 'http://127.0.0.1:32981', petId: 'original', fetchImpl: async () => assert.fail('must not contact another host') });
  forbidden.expectBinding({ pet_id: 'original', pet_discovery: { kind: 'explicit', url: 'http://127.0.0.1:32980/dsh-pet-7340' } });
  await assert.rejects(forbidden.initialize(), { code: 'PET_BINDING_CHANGED' });
  assert.throws(() => forbidden.expectBinding({ pet_id: 'original', pet_discovery: { kind: 'runtime', path: join(f.home, 'other.json') } }), { code: 'PET_BINDING_CHANGED' });
  const legacy = new DshPetClient({ home: f.home, url: 'http://127.0.0.1:32980', fetchImpl: async () => json(config('original')) });
  legacy.expectBinding({ pet_id: 'original', pet_url: 'http://127.0.0.1:32980/dsh-pet-7340' });
  await legacy.initialize(); f.update(32981); await legacy.initialize();
  assert.equal(legacy.connection.baseUrl, 'http://127.0.0.1:32981/dsh-pet-7340');
});

test('预检网络失败与真实模型POST失败区分；不自动重放不确定的模型请求', async t => {
  const f = fixture(t); let failGet = false, posts = 0, charged = 0;
  const pet = new DshPetClient({ home: f.home, fetchImpl: async url => {
    if (url.endsWith('/config')) { if (failGet) throw new Error('secret-host-detail'); return json(config('original')); }
    posts++; throw new Error('secret-model-detail');
  } });
  await pet.initialize(); failGet = true; f.update(32981);
  await assert.rejects(pet.decide(context, { onRequest: () => { charged++; } }), error => error.code === 'PET_UNAVAILABLE' && !error.message.includes('secret'));
  assert.equal(charged, 0); failGet = false;
  await assert.rejects(pet.decide(context, { onRequest: () => { charged++; } }), error => error.code === 'PET_MODEL_UNAVAILABLE' && !error.message.includes('secret'));
  assert.equal(charged, 1); assert.equal(posts, 1);
});
