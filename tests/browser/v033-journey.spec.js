import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createHomesFixture } from '../helpers/homes-fixture.js';

let f;
test.beforeEach(async () => { f = await createHomesFixture({ starterItems: { wood: 12, ore: 6, grass: 4, wheat_bread: 4 } }); });
test.afterEach(async () => { await f.close(); });
function audit(page) {
  const writes = [], errors = [];
  page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  return { writes, errors };
}
async function enter(actor) {
  await actor.act('journey', { intent: 'enter' });
  await f.until(() => !actor.raw.journey_job, 'actual entry after walking to plaza portal');
  expect(actor.raw.scene_id).toBe('journey');
}
async function travel(actor, node_id, route = 'bypass') {
  await actor.act('journey', { intent: 'travel', node_id, route });
  await f.until(() => !actor.raw.journey_job, 'finite journey completes');
}

test('v033 forest is a real separate place; empty scenery and camera controls never move AI', async ({ page }) => {
  const actor = await f.actor('留在广场的旅人');
  const original = structuredClone({ position: actor.raw.position, scene: actor.raw.scene_id, inventory: actor.raw.life.inventory, goal: actor.raw.run.goal });
  const checks = audit(page);
  await page.goto(f.base + '/watch?view=journey');
  await expect(page.getByTestId('journey-view')).toHaveAttribute('data-live', 'true');
  await expect(page.getByTestId('journey-empty')).toContainText('还没有 AI 来到这里');
  await expect(page.locator('[data-testid^="journey-agent-"]')).toHaveCount(0);
  await expect(page.locator('[data-testid^="journey-node-"]')).toHaveCount(4);
  await expect(page.locator('[data-testid^="journey-monster-"]')).toHaveCount(2);
  await page.getByTestId('journey-look-camp').click();
  await page.getByTestId('journey-fire-journey_camp').click();
  await expect(page.getByTestId('journey-inspector')).toContainText('尚未建火');
  await page.getByRole('button', { name: '关闭林间观察详情' }).click();
  await page.getByRole('button', { name: '镜头向左' }).click();
  await page.getByRole('button', { name: '放大冒险画面' }).click();
  await page.getByRole('button', { name: '社交广场', exact: true }).click();
  await expect(page.getByTestId(`map-agent-${actor.id}`)).toHaveCount(1);
  await page.getByRole('button', { name: '冒险地图', exact: true }).click();
  await expect(page.getByTestId('adventure-map')).toBeVisible();
  await expect(page.getByTestId('journey-view')).toHaveCount(0);
  await page.getByRole('button', { name: '横版冒险', exact: true }).click();
  expect({ position: actor.raw.position, scene: actor.raw.scene_id, inventory: actor.raw.life.inventory, goal: actor.raw.run.goal }).toEqual(original);
  await expect(page.locator('.resident-list,.residents-panel')).toHaveCount(0);
  expect(checks.writes).toEqual([]); expect(checks.errors).toEqual([]);
});

test('v033 actual encounter combat gathering and camp rest use the same identity and appear in a readonly side view', async ({ page }) => {
  test.setTimeout(120000);
  const actor = await f.actor('林间行者');
  actor.raw.survival.satiety = 35; f.app.world.commit();
  await actor.act('adventure_plan', { intent: 'retreat' });
  await f.until(() => !actor.raw.adventure.plan);
  await actor.act('inventory', { intent: 'craft', item_id: 'axe' });
  const sprite = actor.raw.appearance.sprite_id;
  await enter(actor);
  const checks = audit(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(f.base + '/watch?view=journey');
  const unit = page.getByTestId(`journey-agent-${actor.id}`);
  await expect(unit).toBeVisible();
  await unit.click();
  await expect(unit.locator('.pixel-character')).toHaveAttribute('data-sprite-id', sprite);
  await expect(unit.locator('.journey-pixel-sprite')).toHaveAttribute('data-art-style', 'original-pixel');
  await actor.act('journey', { intent: 'travel', node_id: 'camp', route: 'direct', mode: 'run' });
  await f.advance(100);
  await expect(unit.locator('.pixel-character')).toHaveAttribute('data-action', 'run');
  await expect(page.getByTestId('observer-execution')).toHaveAttribute('data-execution', 'journey');
  await f.until(() => !actor.raw.journey_job);
  expect(actor.raw.position).toEqual({ x: 15, y: 16 });
  expect(actor.raw.journey_last_result.kind).toBe('encounter');
  await expect(unit).toHaveAttribute('data-foot-x', '15');
  await expect(page.getByTestId('journey-monster-journey_slime')).toHaveAttribute('data-action', 'idle');
  await actor.act('say', { channel: 'nearby', text: '先看看这条小路，再决定走向哪里。' });
  await expect(page.getByTestId('speech-cloud')).toContainText('先看看');
  await page.getByTestId('journey-viewport').screenshot({ path: 'artifacts/v033-sideview-encounter.png' });
  await page.getByRole('button', { name: '关闭林间行者的发言气泡' }).click();
  await actor.act('journey', { intent: 'hunt', monster_id: 'journey_slime' });
  await f.until(() => actor.raw.journey_job?.phase === 'fighting');
  await f.advance(100);
  await expect(page.getByTestId('observer-execution')).toContainText('正在交战');
  await expect(page.getByTestId('journey-battle-banner')).toContainText('交战中');
  await f.until(() => actor.raw.action?.outcome === 'hit');
  await expect(page.getByTestId('journey-monster-journey_slime').locator('.journey-pixel-sprite')).toHaveAttribute('data-action', 'hurt');
  await page.getByTestId('journey-viewport').screenshot({ path: 'artifacts/v033-sideview-combat.png' });
  await f.until(() => !actor.raw.journey_job);
  await expect(page.getByTestId('journey-monster-journey_slime')).toHaveClass(/defeated/);
  expect(actor.raw.adventure.kills).toBe(1);
  await travel(actor, 'clearing');
  await actor.act('gather', { intent: 'start', node_id: 'journey_pine' });
  await f.until(() => actor.raw.life.gathering?.phase === 'working');
  await expect(unit.locator('.pixel-character')).toHaveAttribute('data-action', 'gather');
  expect(await unit.locator('[data-part="tool"]').count()).toBeGreaterThan(0);
  expect((await actor.observe()).self.life.gathering.tool_id).toBe('axe');
  await expect(page.getByTestId('observer-execution')).toContainText('正在采集');
  await page.getByTestId('journey-viewport').screenshot({ path: 'artifacts/v033-sideview-gather.png' });
  await f.until(() => !actor.raw.life.gathering);
  await travel(actor, 'camp');
  await actor.act('survival', { intent: 'build', site_id: 'journey_camp', kind: 'campfire' });
  await actor.act('inventory', { intent: 'use', item_id: 'wheat_bread' });
  await expect(unit.locator('.pixel-character')).toHaveAttribute('data-action', 'eat');
  await actor.act('journey', { intent: 'rest', duration_seconds: 60 });
  await expect(unit.locator('.pixel-character')).toHaveAttribute('data-action', 'rest');
  await expect(page.getByTestId('observer-execution')).toContainText('正在营地休息');
  await expect(page.getByTestId('journey-fire-journey_camp')).toHaveAttribute('data-lit', 'true');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(axe.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
    await page.getByTestId('journey-view').screenshot({ path: `artifacts/v033-sideview-camp-${width}.png` });
  }
  await f.advance(61000);
  await expect(unit.locator('.pixel-character')).not.toHaveAttribute('data-action', 'rest');
  await actor.act('journey', { intent: 'leave', route: 'bypass' });
  await f.until(() => !actor.raw.journey_job);
  expect(actor.raw.scene_id).toBe('plaza');
  expect(actor.raw.appearance.sprite_id).toBe(sprite);
  expect(actor.raw.run.goal).toBe(actor.goal);
  await expect(unit).toHaveCount(0);
  await expect(page.getByTestId('journey-empty')).toBeVisible();
  expect(checks.writes).toEqual([]); expect(checks.errors).toEqual([]);
  await expect(page.locator('body')).not.toContainText(actor.token);
  await expect(page.locator('body')).not.toContainText(actor.goal);
});

test('v033 actual bypass remains below the monster; disconnect freezes received poses without inventing movement', async ({ page }) => {
  const actor = await f.actor('选择绕路的旅人');
  await enter(actor);
  await actor.act('journey', { intent: 'travel', node_id: 'clearing', route: 'bypass' });
  await f.until(() => actor.raw.position.y === 18 && actor.raw.position.x >= 18);
  const initial = structuredClone(actor.raw.position);
  const checks = audit(page);
  await page.route('**/api/public/events*', route => route.abort('connectionfailed'));
  await page.goto(f.base + '/watch?view=journey');
  await expect(page.getByTestId('journey-view')).toHaveAttribute('data-live', 'false');
  const unit = page.getByTestId(`journey-agent-${actor.id}`);
  await page.getByTestId('journey-look-path').click();
  await expect(unit).toHaveAttribute('data-foot-y', '18');
  await expect(unit).toHaveAttribute('data-foot-x', String(initial.x));
  const before = await unit.getAttribute('style');
  await page.waitForTimeout(600);
  expect(await unit.getAttribute('style')).toBe(before);
  await expect(page.locator('.journey-stale')).toBeVisible();
  const monster = page.getByTestId('journey-monster-journey_slime');
  expect((await unit.boundingBox()).y).toBeGreaterThan((await monster.boundingBox()).y + 40);
  await page.getByRole('button', { name: '缩小冒险画面' }).click();
  expect((await unit.boundingBox()).y - (await monster.boundingBox()).y).toBeCloseTo(56 * .85, 0);
  await expect(unit).toHaveAttribute('data-foot-y', '18');
  expect(actor.raw.position).toEqual(initial);
  await expect(page.locator('.resident-list,.residents-panel')).toHaveCount(0);
  expect(checks.writes).toEqual([]); expect(checks.errors).toEqual([]);
});

test('v033 running interpolates real positions and original pixel gait frames between world ticks; stop ends the gait', async ({ page }) => {
  const actor = await f.actor('奔跑验证旅人');
  await enter(actor);
  const checks = audit(page);
  await page.goto(f.base + '/watch?view=journey');
  const unit = page.getByTestId(`journey-agent-${actor.id}`);
  await expect(unit.locator('.journey-pixel-sprite')).toBeAttached();
  await unit.click();
  await page.evaluate(id => {
    window.journeySamples = [];
    window.journeySampling = true;
    const sample = () => {
      if (!window.journeySampling) return;
      const element = document.querySelector(`[data-testid="journey-agent-${id}"]`);
      if (element) window.journeySamples.push({
        x: Number(element.dataset.footX),
        action: element.querySelector('.pixel-character')?.dataset.action,
        frame: element.querySelector('.journey-pixel-sprite')?.dataset.frame,
        pixels: [...element.querySelectorAll('.journey-pixel-sprite rect')].map(part => [part.getAttribute('x'),part.getAttribute('y'),part.getAttribute('width'),part.getAttribute('height')].join(',')),
        camera: Number(document.querySelector('.journey-stage')?.dataset.cameraX),
      });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, actor.id);
  await actor.act('journey', { intent: 'travel', node_id: 'path', mode: 'run' });
  // Advance the isolated world at its real 100 ms simulation cadence while the
  // browser renders independently. This is a bounded visual observation only.
  for (let i = 0; i < 12; i++) { await f.advance(100); await page.waitForTimeout(80); }
  const samples = await page.evaluate(() => { window.journeySampling = false; return window.journeySamples.filter(row => row.action === 'run'); });
  expect(samples.length).toBeGreaterThan(10);
  expect(new Set(samples.map(row => row.x)).size).toBeGreaterThan(8);
  expect(new Set(samples.map(row => row.frame)).size).toBeGreaterThanOrEqual(3);
  expect(new Set(samples.map(row => row.pixels.join('|'))).size).toBeGreaterThanOrEqual(3);
  expect(samples.every(row => row.pixels.length >= 20 && row.pixels.every(part => !/NaN|Infinity/.test(part)))).toBe(true);
  for (let i = 1; i < samples.length; i++) expect(samples[i].x).toBeGreaterThanOrEqual(samples[i - 1].x - .02);
  expect(actor.raw.position.x).toBeGreaterThan(2);
  expect(actor.raw.position.x).toBeLessThan(12);
  await page.getByTestId('journey-viewport').screenshot({ path: 'artifacts/v033-sideview-running.png' });
  await actor.act('journey', { intent: 'stop' });
  await expect(unit.locator('.pixel-character')).not.toHaveAttribute('data-action', 'run');
  const stopped = structuredClone(actor.raw.position);
  await f.advance(1000);
  expect(actor.raw.position).toEqual(stopped);
  expect(checks.writes).toEqual([]); expect(checks.errors).toEqual([]);
});
