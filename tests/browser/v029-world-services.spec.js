import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createHomesFixture } from '../helpers/homes-fixture.js';
import { selectObservedAgent } from './observer-navigation.js';

let f;
test.beforeEach(async () => { f = await createHomesFixture(); });
test.afterEach(async () => { await f.close(); });

function lowResources(p) {
  // Isolated starting state. Real HTTP/MCP requests below choose every action.
  p.raw.position = { x: 36, y: 12 }; p.raw.position_at = f.now();
  p.raw.fatigue.energy = 0; p.raw.survival.satiety = 0;
  // Isolate receipt/observer semantics from fatal hunger during the longer street walk.
  p.raw.survival.protected_until = f.now() + 120000;
  p.raw.life.inventory = {}; p.raw.adventure.gold = 0;
  f.app.world.commit();
}
function audit(page) {
  const writes = [], errors = [];
  page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  return { writes, errors };
}
async function show(page, p) {
  await page.goto(f.base + '/watch?view=plaza');
  await expect(page.getByTestId('phaser-world')).toHaveAttribute('data-renderer-state', 'ready');
  await selectObservedAgent(page, p.id);
}

test('v029 observer separates current work from dated failure and exposes shared food services without AI controls', async ({ page }) => {
  const p = await f.actor('自己做决定的旅人'); lowResources(p);
  const failed = await p.send(await p.request('trade', { intent: 'buy', item_id: 'wheat_bread', quantity: 1 }));
  expect(failed.status).toBe('rejected');
  const checks = audit(page); await show(page, p);
  await expect(page.getByTestId('observer-execution')).toHaveText('暂无执行中的行动');
  await expect(page.getByTestId('observer-action-result')).toContainText('交易未执行 · 金币不足');
  await expect(page.getByTestId('observer-action-result')).toContainText('最近操作');
  await expect(page.getByTestId('observer-conditions')).toContainText('体力为 0 · 饱食度为 0');
  const services = page.getByTestId('world-services');
  await expect(services).not.toHaveAttribute('open', '');
  await services.locator(':scope > summary').focus(); await page.keyboard.press('Enter');
  await expect(services).toHaveAttribute('open', '');
  const market = page.getByTestId('food-market'), forage = page.getByTestId('food-resource-camp_fallen_berries');
  await expect(market).toContainText('麦香面包'); await expect(market).toContainText('12 金币 / 份');
  await expect(market).toContainText('萝卜'); await expect(market).toContainText('5 金币 / 份');
  await expect(market).toContainText('每位角色每 300 秒最多购买 20 份');
  await expect(forage).toContainText('0 体力基础消耗'); await expect(forage).toContainText('6 秒基础工作');
  await expect(forage).toContainText('共享储量 1 / 1');
  await expect(services.getByRole('button')).toHaveCount(0);
  await expect(page.locator('.resident-list,.residents-panel')).toHaveCount(0);
  await expect(page.getByTestId('private-warehouse')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(p.goal); await expect(page.locator('body')).not.toContainText(p.token);

  await p.act('gather', { intent: 'start', node_id: 'camp_fallen_berries', mode: 'walk' });
  await expect(page.getByTestId('observer-execution')).toContainText('正在前往营地落果处');
  await expect(page.getByTestId('observer-action-result')).toContainText('采集已受理');
  await f.until(() => p.raw.life.gathering?.phase === 'working');
  await expect(page.getByTestId('observer-execution')).toContainText('正在采集 · 营地落果处');
  await expect(forage).toContainText('正在采集');
  await f.until(() => !p.raw.life.gathering);
  await expect(page.getByTestId('observer-execution')).toHaveText('暂无执行中的行动');
  await expect(page.getByTestId('observer-action-result')).toContainText('采集已受理');
  await expect(forage).toContainText('共享储量 0 / 1'); await expect(forage).toContainText('等待恢复');
  expect(p.raw.life.inventory.berry).toBe(1); expect(p.raw.survival.satiety).toBe(0);
  await page.getByTestId('resource-camp_fallen_berries').focus(); await page.keyboard.press('Enter');
  await expect(page.getByTestId('resource-inspector')).toContainText('0 体力基础消耗');
  await page.keyboard.press('Escape');
  await services.locator(':scope > summary').focus();
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await page.getByTestId('observer-status').boundingBox()).height).toBeLessThan(240);
    const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(accessibility.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.target) }))).toEqual([]);
    await services.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `artifacts/v029-world-services-${width}.png`, fullPage: true });
  }
  await services.locator(':scope > summary').focus(); await page.keyboard.press('Enter');
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: 'artifacts/v029-world-services-collapsed-390.png' });
  expect(checks.writes).toEqual([]); expect(checks.errors).toEqual([]);
});

test('v029 stale night snapshot stays factual and scene switching does not move a resident or show another scene resource', async ({ page }) => {
  const p = await f.actor('保留原本想法的旅人'); lowResources(p);
  f.app.world.state.day_cycle.epoch_at = f.now() - 360000; f.app.world.state.day_cycle.last_at = f.now();
  const before = structuredClone({ position: p.raw.position, appearance: p.raw.appearance, inventory: p.raw.life.inventory, goal: p.raw.goal });
  await p.act('wait');
  const checks = audit(page);
  await page.route('**/api/public/events*', route => route.abort('connectionfailed'));
  await show(page, p);
  await expect(page.locator('.spectator-stale')).toBeVisible();
  await expect(page.getByTestId('observer-status')).toContainText('最近记录');
  await expect(page.getByTestId('observer-conditions')).toContainText('夜间当前位置无光源');
  await page.getByTestId('world-services').locator(':scope > summary').click();
  await expect(page.getByTestId('world-services')).toContainText('最近记录 · 连接恢复后更新库存与条件');
  await page.getByRole('button', { name: '冒险地图', exact: true }).click();
  await expect(page.getByTestId('phaser-world')).toHaveAttribute('data-renderer-state', 'ready');
  await expect(page.getByTestId('food-resource-camp_fallen_berries')).toHaveCount(0);
  await expect(page.getByTestId('food-market')).toContainText('生活广场');
  await expect(page.getByTestId('observer-execution')).toHaveText('暂无执行中的行动');
  expect({ position: p.raw.position, appearance: p.raw.appearance, inventory: p.raw.life.inventory, goal: p.raw.goal }).toEqual(before);
  expect(checks.writes).toEqual([]); expect(checks.errors).toEqual([]);
});
