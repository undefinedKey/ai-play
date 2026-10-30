import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { initializeAppearance, publicAppearance } from '../server/appearance.js';
import { World } from '../server/world.js';
import { spectatorSnapshot } from '../server/spectator.js';

test('新角色分配可辨认的外观，32个组合优先不重复，读/重连不重新随机', () => {
  const agents = {};
  for (let i = 0; i < 32; i++) {
    const a = { agent_id: `a-${i}`, name: i === 0 ? '肥鱼' : `AI${i}` }; initializeAppearance(a, agents); agents[a.agent_id] = a;
    const before = publicAppearance(a); a.name = '改名'; initializeAppearance(a, agents); assert.deepEqual(publicAppearance(a), before);
  }
  assert.equal(agents['a-0'].appearance.sprite_id, 'wanderer_3');
  assert.equal(new Set(Object.values(agents).slice(0, 8).map(a => a.appearance.sprite_id)).size, 8);
  assert.equal(new Set(Object.values(agents).map(a => `${a.appearance.sprite_id}:${a.appearance.accessory_id}`)).size, 32);
});

test('外观公开白名单不包含任意图片URL/秘密，异常存档可迁移', () => {
  const a = { agent_id: 'same-role', appearance: { version: 1, sprite_id: 'https://untrusted.example' } };
  initializeAppearance(a); a.appearance.private_note = 'SECRET'; a.appearance.url = 'https://untrusted.example';
  assert.doesNotMatch(JSON.stringify(publicAppearance(a)), /SECRET|https/);
  assert.match(publicAppearance(a).sprite_id, /^wanderer_[1-8]$/);
});

test('多个鲸鱼身份沿用海蓝主题，并分配不同配饰，不被旧离线同名角色占走主题', () => {
  const a = { agent_id: 'old-whale', name: '肥鱼' }, b = { agent_id: 'active-whale', name: '肥鱼' };
  initializeAppearance(a); initializeAppearance(b, { a });
  assert.equal(a.appearance.sprite_id, 'wanderer_3'); assert.equal(b.appearance.sprite_id, 'wanderer_3');
  assert.notEqual(a.appearance.accessory_id, b.appearance.accessory_id);
});

test('真实世界的专属外观跨服务重启保存，私有个性和预算不公开', () => {
  const root = resolve(tmpdir()), directory = mkdtempSync(join(root, 'plaza-look-')), dbPath = join(directory, 'world.sqlite');
  let w;
  try {
    w = new World({ dbPath }); const created = w.createAgent({ name: '肥鱼' });
    const look = created.appearance; assert.equal(look.sprite_id, 'wanderer_3');
    w.agent(created.agent_id).goal = 'PRIVATE_OWNER_GOAL'; w.close(); w = new World({ dbPath });
    assert.deepEqual(w.publicAgent(w.agent(created.agent_id)).appearance, look);
    const pub = spectatorSnapshot(w); assert.deepEqual(pub.agents[0].appearance, look); assert.doesNotMatch(JSON.stringify(pub), /PRIVATE_OWNER_GOAL/);
  } finally { w?.close(); assert.equal(dirname(directory), root); rmSync(directory, { recursive: true, force: true }); }
});
