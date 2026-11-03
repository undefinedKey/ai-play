import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createHomesFixture } from '../helpers/homes-fixture.js';
import { RUINS_RULES } from '../../shared/ruins-layout.js';

let f;
test.beforeEach(async () => { f = await createHomesFixture({ starterItems: { wood: 10, ore: 4 } }); });
test.afterEach(async () => { await f.close(); });
function audit(page) {
  const writes = [], errors = [];
  page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  return { writes, errors };
}
async function entered(name = '自选路线的访客') {
  const actor = await f.actor(name);
  // Fixture starts outdoors, then actual MCP travel owns every later move.
  actor.raw.scene_id = 'adventure'; actor.raw.position = { ...RUINS_RULES.entrance.position }; actor.raw.position_at = f.now();
  f.app.world.commit();
  await actor.act('ruins', { intent: 'enter', mode: 'walk' });
  await f.until(() => actor.raw.scene_id === 'ruins' && !actor.raw.ruins_job, 'real entrance transfer');
  return actor;
}
async function approach(actor, id) {
  await actor.act('ruins', { intent: 'approach', object_id: id, mode: 'run' });
  await f.until(() => !actor.raw.ruins_job, `real approach ${id}`);
}
const item = (page, id) => page.getByTestId(`ruins-object-${id}`);

test('v030 real HTTP/MCP decisions change rendered routes rune discs and finite relics without spectator writes', async ({ page }) => {
  test.setTimeout(90000);
  const actor = await entered(), checks = audit(page);
  await page.goto(f.base + '/watch?view=ruins');
  await expect(page.getByTestId('phaser-world')).toHaveAttribute('data-renderer-state', 'ready');
  await expect(page.getByTestId('phaser-world')).toHaveAttribute('data-renderer-scene', 'ruins');
  await expect(item(page, 'main_gate')).toHaveAttribute('data-ruins-state', 'closed');
  await expect(item(page, 'broken_bridge')).toHaveAttribute('data-ruins-state', 'broken');
  await expect(item(page, 'dial_west')).toHaveAttribute('data-rune-symbol', 'leaf');
  await expect(page.locator(`[data-speech-agent="${actor.id}"]`)).toHaveCount(1);
  await page.getByRole('button', { name: '恢复全图', exact: true }).click();
  await page.screenshot({ path: 'artifacts/v030-ruins-locked.png' });

  await approach(actor, 'broken_bridge'); await actor.act('ruins', { intent: 'repair', object_id: 'broken_bridge' });
  await expect(item(page, 'broken_bridge')).toHaveAttribute('data-ruins-state', 'repairing');
  await expect(page.getByTestId('observer-execution')).toContainText('修复木桥');
  await f.until(() => !actor.raw.ruins_job, 'confirmed bridge repair');
  await expect(item(page, 'broken_bridge')).toHaveAttribute('data-ruins-state', 'repaired');

  await approach(actor, 'key_cache'); await actor.act('ruins', { intent: 'claim', object_id: 'key_cache' });
  await expect(item(page, 'key_cache')).toHaveAttribute('data-ruins-state', 'taken');
  await approach(actor, 'main_gate'); await actor.act('ruins', { intent: 'unlock', object_id: 'main_gate' });
  await expect(item(page, 'main_gate')).toHaveAttribute('data-ruins-state', 'open');
  await approach(actor, 'dial_west'); await actor.act('ruins', { intent: 'turn', object_id: 'dial_west', direction: 'previous' });
  await expect(item(page, 'dial_west')).toHaveAttribute('data-rune-symbol', 'moon');
  await approach(actor, 'dial_east'); await actor.act('ruins', { intent: 'turn', object_id: 'dial_east', direction: 'next' });
  await expect(item(page, 'dial_east')).toHaveAttribute('data-rune-symbol', 'sun');
  await approach(actor, 'rune_console'); await actor.act('ruins', { intent: 'submit', object_id: 'rune_console' });
  await expect(item(page, 'archive_gate')).toHaveAttribute('data-ruins-state', 'open');
  await approach(actor, 'relic_leaf'); await actor.act('ruins', { intent: 'claim', object_id: 'relic_leaf' });
  await expect(item(page, 'relic_leaf')).toHaveAttribute('data-ruins-state', 'taken');
  expect(actor.raw.life.inventory.ruins_leaf_medallion).toBe(1);
  await page.getByRole('button', { name: '恢复全图', exact: true }).click();
  await item(page, 'relic_leaf').focus(); await page.keyboard.press('Enter');
  await expect(page.getByTestId('ruins-inspector')).toContainText('已取走 · 空展台');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('ruins-inspector')).toHaveCount(0);
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(accessibility.violations.map(entry => ({ id: entry.id, targets: entry.nodes.map(node => node.target) }))).toEqual([]);
    await page.screenshot({ path: `artifacts/v030-ruins-${width}.png`, fullPage: true });
  }
  expect(checks.writes).toEqual([]); expect(checks.errors).toEqual([]);
  await expect(page.locator('.resident-list,.residents-panel')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(actor.goal); await expect(page.locator('body')).not.toContainText(actor.token);
});

test('v030 spectator map switches only the camera, stale state stays factual and real exit travels to the forest', async ({ page }) => {
  const actor = await entered(), checks = audit(page);
  await page.goto(f.base + '/watch?view=adventure');
  await expect(page.getByTestId('phaser-world')).toHaveAttribute('data-renderer-state', 'ready');
  await expect(page.locator(`[data-speech-agent="${actor.id}"]`)).toHaveCount(0);
  const before = structuredClone({ position: actor.raw.position, scene_id: actor.raw.scene_id, inventory: actor.raw.life.inventory });
  await page.getByTestId('ruins-entrance').click();
  await expect(page.getByTestId('ruins-map')).toBeVisible();
  await expect(page.locator(`[data-speech-agent="${actor.id}"]`)).toHaveCount(1);
  await page.getByTestId('ruins-exit-view').click();
  await expect(page.getByTestId('adventure-map')).toBeVisible();
  expect({ position: actor.raw.position, scene_id: actor.raw.scene_id, inventory: actor.raw.life.inventory }).toEqual(before);
  await page.getByRole('button', { name: '林间遗迹', exact: true }).click();
  await page.route('**/api/public/events*', route => route.abort('connectionfailed'));
  await page.reload();
  await expect(page.locator('.spectator-stale')).toBeVisible();
  await expect(page.getByTestId('ruins-route-status')).toContainText('最近记录');
  await expect(item(page, 'archive_gate')).toHaveAttribute('data-ruins-state', 'closed');
  await actor.act('ruins', { intent: 'leave', mode: 'walk' });
  await f.until(() => actor.raw.scene_id === 'adventure' && !actor.raw.ruins_job, 'real exit transfer');
  await page.unroute('**/api/public/events*'); await page.reload();
  await expect(page.getByTestId('ruins-empty-banner')).toBeVisible();
  await expect(page.locator(`[data-speech-agent="${actor.id}"]`)).toHaveCount(0);
  expect(checks.writes).toEqual([]); expect(checks.errors).toEqual([]);
});
