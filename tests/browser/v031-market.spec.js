import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createHomesFixture } from '../helpers/homes-fixture.js';

let f;
test.beforeEach(async () => { f = await createHomesFixture({ starterItems: { wood: 12, ore: 6, wheat_bread: 4 } }); });
test.afterEach(async () => { await f.close(); });
function audit(page) {
  const writes = [], errors = [];
  page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  return { writes, errors };
}
async function marketActor(name) {
  const actor = await f.actor(name);
  await actor.act('peer_market', { intent: 'approach', mode: 'walk' });
  await f.until(() => !actor.raw.movement, 'real market approach');
  return actor;
}
async function post(actor, payload) {
  await actor.act('peer_market', { intent: 'post', ...payload });
  const observed = await actor.observe();
  return observed.peer_market.own_offer;
}
const goods = (items, gold = 0) => ({ items, gold });
const card = (page, offer) => page.getByTestId(`peer-market-offer-${offer.offer_id}`);

test('v031 real exchange gift and delivery request appear on the readonly board and settle from MCP alone', async ({ page }) => {
  test.setTimeout(90000);
  const a = await marketActor('面包摊主'), b = await marketActor('采矿旅人'), c = await marketActor('小屋主人');
  const exchange = await post(a, { kind: 'exchange', title: '面包换两块矿石', give: goods({ wheat_bread: 1 }), want: goods({ ore: 2 }) });
  const gift = await post(b, { kind: 'gift', title: '送给小屋的一捆木材', target_agent_id: c.id, give: goods({ wood: 3 }) });
  const request = await post(c, { kind: 'request', title: '需要木材修理书架', give: goods({ ore: 1 }), want: goods({ wood: 2 }) });
  const original = structuredClone(f.actors.map(actor => ({ id: actor.id, position: actor.raw.position, goal: actor.raw.run.goal, inventory: actor.raw.life.inventory })));
  const checks = audit(page);
  await page.goto(f.base + '/watch?view=plaza');
  await expect(page.getByTestId('phaser-world')).toHaveAttribute('data-renderer-state', 'ready');
  await page.getByRole('button', { name: '恢复全图', exact: true }).click();
  await expect(page.getByTestId('peer-market-landmark')).toHaveCount(1);
  await page.getByTestId('peer-market-toggle').click();
  await expect(page.getByRole('heading', { name: '物品在这里相遇' })).toBeFocused();
  await expect(card(page, exchange)).toContainText('面包换两块矿石');
  await expect(card(page, exchange)).toContainText('麦香面包');
  await expect(card(page, exchange)).toContainText('矿石');
  await expect(card(page, gift)).toContainText('无需回礼');
  await expect(card(page, request)).toContainText('交付后获得');
  await expect(card(page, request)).toContainText('需要交付');
  await expect(page.getByTestId('peer-market-offers').getByRole('button')).toHaveCount(0);
  expect(f.actors.map(actor => ({ id: actor.id, position: actor.raw.position, goal: actor.raw.run.goal, inventory: actor.raw.life.inventory }))).toEqual(original);
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(accessibility.violations.map(entry => ({ id: entry.id, targets: entry.nodes.map(node => node.target) }))).toEqual([]);
    await page.getByTestId('peer-market').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `artifacts/v031-market-${width}.png`, fullPage: true });
  }
  await b.act('peer_market', { intent: 'accept', offer_id: exchange.offer_id, revision: exchange.revision });
  await c.act('peer_market', { intent: 'accept', offer_id: gift.offer_id, revision: gift.revision });
  await a.act('peer_market', { intent: 'accept', offer_id: request.offer_id, revision: request.revision });
  await expect(page.getByTestId('peer-market-empty')).toBeVisible();
  await page.getByRole('button', { name: '已结束 3', exact: true }).click();
  await expect(card(page, exchange)).toHaveAttribute('data-market-status', 'settled');
  await expect(card(page, gift)).toContainText('礼物已收下');
  await expect(card(page, request)).toContainText('已交付结算');
  expect(a.raw.life.inventory.wood).toBe(10);
  expect(c.raw.life.inventory.wood).toBe(17);
  await page.getByRole('button', { name: '关闭集市公告' }).click();
  await expect(page.getByTestId('peer-market-toggle')).toBeFocused();
  await expect(page.locator('.resident-list,.residents-panel')).toHaveCount(0);
  for (const actor of f.actors) { await expect(page.locator('body')).not.toContainText(actor.goal); await expect(page.locator('body')).not.toContainText(actor.token); }
  expect(checks.writes).toEqual([]); expect(checks.errors).toEqual([]);
});

test('v031 board remains factual on expiry and stale connection; changing camera never moves traders', async ({ page }) => {
  const actor = await marketActor('仍可选择不摆摊的旅人');
  const offer = await post(actor, { kind: 'request', title: '只等一分钟的木材委托', give: goods({ ore: 1 }), want: goods({ wood: 2 }), duration_seconds: 60 });
  const before = structuredClone({ position: actor.raw.position, scene_id: actor.raw.scene_id, inventory: actor.raw.life.inventory });
  const checks = audit(page);
  await page.goto(f.base + '/watch?view=plaza');
  await page.getByRole('button', { name: '恢复全图', exact: true }).click();
  await page.getByTestId('peer-market-landmark').focus(); await page.keyboard.press('Enter');
  await expect(card(page, offer)).toHaveAttribute('data-market-status', 'open');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('peer-market-toggle')).toBeFocused();
  await page.getByRole('button', { name: '冒险地图', exact: true }).click();
  await expect(page.getByTestId('peer-market')).toHaveCount(0);
  await expect(page.getByTestId('peer-market-landmark')).toHaveCount(0);
  expect({ position: actor.raw.position, scene_id: actor.raw.scene_id, inventory: actor.raw.life.inventory }).toEqual(before);
  await page.getByRole('button', { name: '社交广场', exact: true }).click();
  await page.route('**/api/public/events*', route => route.abort('connectionfailed'));
  await page.reload();
  await expect(page.locator('.spectator-stale')).toBeVisible();
  await page.getByTestId('peer-market-toggle').click();
  await expect(card(page, offer)).toContainText('最近记录');
  await expect(card(page, offer)).toContainText('连接恢复后更新期限');
  await f.advance(61000);
  await page.unroute('**/api/public/events*'); await page.reload();
  await page.getByTestId('peer-market-toggle').click();
  await page.getByRole('button', { name: '已结束 1', exact: true }).click();
  await expect(card(page, offer)).toHaveAttribute('data-market-status', 'expired');
  await expect(card(page, offer)).toContainText('已到期');
  expect(actor.raw.life.inventory.ore).toBe(6);
  expect(checks.writes).toEqual([]); expect(checks.errors).toEqual([]);
});
