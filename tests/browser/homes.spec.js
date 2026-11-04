import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createHomesFixture } from '../helpers/homes-fixture.js';

let f;
test.beforeEach(async () => { f = await createHomesFixture({ starterItems: { wood: 60, grass: 40, ore: 8, pine_cone: 3 } }); });
test.afterEach(async () => { await f.close(); });

async function house(actor, name, furnish = false) {
  await actor.act('move', { x: 10, y: 8 }); await f.until(() => !actor.raw.movement);
  await actor.act('home', { intent: 'build', name });
  const id = `home_${actor.id}`;
  await actor.act('home', { intent: 'visit', home_id: id }); await f.until(() => actor.raw.home_presence?.home_id === id);
  if (furnish) {
    for (const [kind, x, y] of [['display_shelf', 1, 1], ['table', 5, 2], ['chair', 7, 3], ['rug', 2, 4]]) {
      await actor.act('home', { intent: 'craft', kind });
      const item = (await actor.observe()).homes.own_home.storage.find(i => i.kind === kind);
      await actor.act('home', { intent: 'place', instance_id: item.instance_id, x, y });
    }
    const shelf = (await actor.observe()).homes.own_home.furniture.find(item => item.kind === 'display_shelf');
    await actor.act('home', { intent: 'display', instance_id: shelf.instance_id, item_id: 'pine_cone', title: '带回家的第一枚松果', text: '沿着森林小路找到它。它提醒我，那天没有急着回去，而是抬头看了一会儿树。' });
  }
  await actor.act('home', { intent: 'move', x: 6, y: 5 }); await f.until(() => !actor.raw.home_presence?.movement);
  return id;
}

async function accessible(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
}

test('v025 empty homes are truthful, mobile readable, and offer no player write controls', async ({ page }) => {
  const writes = []; page.on('request', req => { if (req.method() !== 'GET') writes.push(req.url()); });
  await page.goto(f.base + '/watch?view=home');
  await expect(page.getByTestId('home-unbuilt')).toContainText('等第一位 AI');
  await expect(page.getByTestId('home-room')).toHaveCount(0);
  await expect(page.locator('.home-furniture,.home-actor,.resident-list')).toHaveCount(0);
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    await page.setViewportSize({ width, height }); await accessible(page);
    await page.getByTestId('home-view').screenshot({ path: `artifacts/v025-empty-home-${width}.png` });
  }
  expect(writes).toEqual([]);
});

test('v025 real homes, furniture, souvenirs, messages and invited visits stay isolated when watching maps', async ({ page }) => {
  const p = await f.actor('保留原身份的屋主'), q = await f.actor('邻居'), guest = await f.actor('来喝茶的朋友');
  const one = await house(p, '松果与旅途', true), two = await house(q, '另一盏灯');
  await p.act('home', { intent: 'invite', target_agent_id: guest.id });
  const invitation = (await guest.observe()).homes.invitations[0];
  await guest.act('home', { intent: 'respond', invitation_id: invitation.invitation_id, accept: true });
  await guest.act('home', { intent: 'visit', home_id: one }); await f.until(() => !!guest.raw.home_presence);
  const message = '很高兴来做客。\n' + '希望这里一直留下我们的故事。'.repeat(10) + '<script>window.houseUnsafe=true</script>';
  await guest.act('home', { intent: 'message', text: message });
  await p.act('say', { channel: 'nearby', text: '这枚松果是我想留下的故事。' });
  const positions = JSON.stringify([p, q, guest].map(a => [a.raw.position, a.raw.home_presence]));
  const writes = [], errors = []; page.on('request', req => { if (req.method() !== 'GET') writes.push(req.url()); }); page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${f.base}/watch?view=home&home=${one}`);
  await expect(page.getByTestId('home-room')).toHaveAttribute('data-home-id', one);
  await expect(page.locator('.home-furniture')).toHaveCount(4);
  await expect(page.locator('.home-actor')).toHaveCount(2);
  await expect(page.getByTestId(`home-actor-${q.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`home-actor-${p.id}`).locator('.pixel-character')).toHaveAttribute('data-sprite-id', p.raw.appearance.sprite_id);
  await page.getByRole('button', { name: '查看纪念品：带回家的第一枚松果', exact: true }).click();
  await expect(page.getByTestId('home-display-detail')).toContainText('抬头看了一会儿树');
  await expect(page.getByTestId('home-messages')).toContainText(message);
  expect(await page.evaluate(() => window.houseUnsafe)).toBeUndefined();
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    await page.setViewportSize({ width, height }); await accessible(page);
    await page.getByTestId('home-view').screenshot({ path: `artifacts/v025-furnished-home-${width}.png` });
  }
  await page.getByRole('button', { name: '旁观小屋：另一盏灯', exact: true }).click();
  await expect(page.getByTestId('home-room')).toHaveAttribute('data-home-id', two);
  await expect(page.getByTestId('home-room-empty')).toBeVisible();
  await expect(page.locator('.home-actor')).toHaveCount(1);
  await expect(page.getByTestId(`home-actor-${q.id}`)).toBeVisible();
  await expect(page.getByTestId('home-messages')).toHaveCount(0);
  await page.getByRole('button', { name: '社交广场', exact: true }).click();
  await expect(page.getByTestId('plaza-map')).toBeVisible();
  for (const actor of [p, q, guest]) await expect(page.getByTestId(`map-agent-${actor.id}`)).toHaveCount(0);
  await expect(page.getByTestId('home-world-entrance')).toBeVisible();
  await page.getByTestId('world-camera').screenshot({ path: 'artifacts/v025-plaza-home-entrance.png' });
  await page.getByTestId('home-world-entrance').click();
  await expect(page.getByTestId('home-view')).toBeVisible();
  await page.getByRole('button', { name: '冒险地图', exact: true }).click();
  await expect(page.getByTestId('adventure-map')).toBeVisible();
  await expect(page.locator('.adventure-agent')).toHaveCount(0);
  await page.getByRole('button', { name: '我的小家', exact: true }).click();
  await expect(page.getByTestId('home-view')).toBeVisible();
  expect(JSON.stringify([p, q, guest].map(a => [a.raw.position, a.raw.home_presence]))).toBe(positions);
  expect(writes).toEqual([]); expect(errors).toEqual([]);
  await expect(page.locator('.resident-list')).toHaveCount(0);
  await expect(page.getByTestId('home-view').locator('input,textarea,select')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(invitation.invitation_id);
  await expect(page.locator('body')).not.toContainText(p.goal);
});

test('v025 disconnected interior freezes confirmed position and keeps real furnishings', async ({ page }) => {
  const p = await f.actor('屋内散步者'), home = await house(p, '停下也还在的家', true);
  await p.act('home', { intent: 'move', x: 7, y: 5 }); await f.advance(100);
  await page.route('**/api/public/events*', route => route.abort('connectionfailed'));
  await page.goto(`${f.base}/watch?view=home&home=${home}`);
  await expect(page.locator('.spectator-stale')).toBeVisible();
  const actor = page.getByTestId(`home-actor-${p.id}`);
  const x = await actor.getAttribute('data-foot-x'), y = await actor.getAttribute('data-foot-y');
  await page.clock.install(); await page.clock.fastForward(5000);
  await expect(actor).toHaveAttribute('data-foot-x', x); await expect(actor).toHaveAttribute('data-foot-y', y);
  await expect(page.locator('.home-furniture')).toHaveCount(4);
  await expect(page.getByTestId('home-view')).toContainText('仅显示最近确认的布置和位置');
  await page.getByTestId('home-view').screenshot({ path: 'artifacts/v025-home-disconnected.png' });
});


test('v026 an original AI walks to furniture before sitting, eating, reading and resting; spectators only inspect', async ({ page }) => {
  test.setTimeout(120000);
  const p = await f.actor('自在生活的旅人', { starterItems: { turnip: 3 } }), home = await house(p, '有风也有灯的小屋', true);
  const own = () => f.app.world.state.homes[home];
  for (const [kind, x, y] of [['bed', 7, 5], ['bookshelf', 5, 0]]) {
    await p.act('home', { intent: 'craft', kind });
    const item = (await p.observe()).homes.own_home.storage.find(i => i.kind === kind);
    await p.act('home', { intent: 'place', instance_id: item.instance_id, x, y });
  }
  const errors = [], writes = []; page.on('pageerror', e => errors.push(e.message));
  page.on('request', req => { if (req.url().startsWith(f.base) && !['GET', 'HEAD'].includes(req.method())) writes.push(req.url()); });
  await page.goto(`${f.base}/watch?view=home&home=${home}`);
  const actor = page.getByTestId(`home-actor-${p.id}`), character = actor.locator('.pixel-character');
  await expect(character).toHaveAttribute('data-art-style', 'q-pixel');
  const identity = p.raw.appearance.sprite_id;
  for (const [kind, furnitureKind] of [['sit', 'chair'], ['eat', 'table'], ['read', 'bookshelf'], ['rest', 'bed']]) {
    const item = own().furniture.find(item => item.kind === furnitureKind);
    if (kind === 'eat') { p.raw.survival.satiety = 60; p.raw.adventure.hp = Math.max(1, p.raw.adventure.max_hp - 15); f.app.world.commit(); }
    const food = p.raw.life.inventory.turnip;
    await p.act('home', { intent: 'use', instance_id: item.instance_id, activity: kind, ...(kind === 'eat' ? { item_id: 'turnip' } : {}) });
    if (p.raw.home_presence.activity.phase === 'approaching') {
      await expect(actor).toHaveAttribute('data-home-phase', 'approaching');
      await expect(page.getByTestId('home-current-activity')).toContainText('抵达后才开始');
      await expect(actor.locator('[data-home-prop]')).toHaveCount(0);
      expect(p.raw.life.inventory.turnip).toBe(food);
    }
    await f.until(() => p.raw.home_presence?.activity?.phase === 'using');
    await f.advance(800);
    await expect(actor).toHaveAttribute('data-home-phase', 'using');
    await expect(character).toHaveAttribute('data-action', kind==='rest'?'sleep':kind==='read'?'stand_read':kind);
    await expect(character).toHaveAttribute('data-sprite-id', identity);
    await expect(character).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(character).toHaveCSS('overflow', 'visible');
    const position = { ...p.raw.home_presence.position };
    await expect(actor).toHaveAttribute('data-foot-x', String(position.x));
    await expect(actor).toHaveAttribute('data-foot-y', String(position.y));
    if (kind === 'sit' || kind === 'rest') {
      const visualAnchor = await actor.locator('.home-use-character').evaluate(node => getComputedStyle(node).translate);
      expect(visualAnchor).not.toBe('none');
      await expect(page.locator('.home-actor-label')).toHaveCSS('translate', visualAnchor);
    }
    if (kind === 'eat') { expect(p.raw.life.inventory.turnip).toBe(food - 1); await expect(actor.locator('[data-home-prop="bowl"]')).toBeVisible(); }
    if (kind === 'read') {
      await expect(character.locator('.pixel-sprite').first()).toHaveAttribute('data-pixel-action','stand_read');
      await page.getByTestId('home-reading').locator('summary').click();
      const reading = (await p.observe()).self.home_presence.activity.reading;
      await expect(page.getByTestId('home-reading')).toContainText(reading.text);
      await expect(page.getByTestId('home-reading')).toContainText(reading.source);
    }
    await page.getByRole('button', { name: `查看家具：${{ chair: '木椅', table: '木桌', bookshelf: '书架', bed: '木床' }[furnitureKind]}`, exact: true }).click();
    await expect(page.getByTestId('home-furniture-detail')).toContainText('正在使用');
    for (const [width, height] of [[1440, 1000], [390, 844]]) {
      await page.setViewportSize({ width, height }); await accessible(page);
      await page.getByTestId('home-view').screenshot({ path: `artifacts/v026-home-${kind}-${width}.png` });
    }
    await p.act('home', { intent: 'cancel' });
    await expect(actor).not.toHaveAttribute('data-home-phase', 'using');
    expect(p.raw.home_presence.position).toEqual(position);
  }
  expect(errors).toEqual([]); expect(writes).toEqual([]);
  await expect(page.locator('body')).not.toContainText(p.goal);
  await expect(page.locator('.resident-list')).toHaveCount(0);
});

test('v026 use pose and real furnishings remain static in disconnected and reduced motion views', async ({ page }) => {
  const p = await f.actor('安静阅读的旅人'), home = await house(p, '书页停下的家', true);
  const chair = f.app.world.state.homes[home].furniture.find(item => item.kind === 'chair');
  await p.act('home', { intent: 'use', instance_id: chair.instance_id, activity: 'read' });
  await f.until(() => p.raw.home_presence?.activity?.phase === 'using'); await f.advance(800);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${f.base}/watch?view=home&home=${home}`);
  const actor = page.getByTestId(`home-actor-${p.id}`), rig = actor.locator('.pixel-character');
  await expect(rig).toHaveAttribute('data-action', 'read'); await expect(rig.locator('.pixel-sprite').first()).toHaveAttribute('data-playing', 'false');
  const pose = () => rig.locator('.pixel-sprite').evaluateAll(nodes => nodes.map(node => [node.dataset.item, node.style.backgroundImage, node.style.backgroundPosition, node.style.transform, node.style.translate]));
  const reduced = await pose(); await page.clock.install(); await page.clock.fastForward(3000); expect(await pose()).toEqual(reduced);
  await page.route('**/api/public/events*', route => route.abort('connectionfailed'));
  await page.emulateMedia({ reducedMotion: 'no-preference' }); await page.reload();
  await expect(page.locator('.spectator-stale')).toBeVisible(); await expect(rig.locator('.pixel-sprite').first()).toHaveAttribute('data-playing', 'false');
  const frozen = await pose(), x = await actor.getAttribute('data-foot-x');
  await page.clock.fastForward(5000); expect(await pose()).toEqual(frozen); await expect(actor).toHaveAttribute('data-foot-x', x);
  await expect(page.getByTestId('home-current-activity')).toContainText('最近记录');
  await page.getByTestId('home-view').screenshot({ path: 'artifacts/v026-home-reading-disconnected.png' });
});
