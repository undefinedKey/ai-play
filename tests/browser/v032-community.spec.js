import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createHomesFixture } from '../helpers/homes-fixture.js';

let f;
test.beforeEach(async () => { f = await createHomesFixture({ starterItems: { wheat_bread: 4 } }); });
test.afterEach(async () => { await f.close(); });
function audit(page) {
  const writes = [], errors = [];
  page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  return { writes, errors };
}
async function approach(actor, venue_id) {
  await actor.act('community', { intent: 'approach', venue_id });
  await f.until(() => !actor.raw.community_job, 'real venue arrival');
}
async function post(actor, payload) {
  await approach(actor, 'board');
  await actor.act('community', { intent: 'post', ...payload });
  return Object.values(f.app.world.state.community.events).find(event => event.host_agent_id === actor.id && event.status === 'open');
}

test('v032 real invitations seating meals and stage text are visible without browser gameplay writes', async ({ page }) => {
  test.setTimeout(90000);
  const host = await f.actor('带来故事的旅人'), guest = await f.actor('带饭的听众');
  const event = await post(host, { venue_id: 'stage', title: '树荫下的一段故事', text: '愿意的话，可以来听听今天看见的溪流。', duration_seconds: 600 });
  const guestPosition = structuredClone(guest.raw.position);
  await guest.act('community', { intent: 'join', event_id: event.event_id, revision: 1 });
  expect(guest.raw.position).toEqual(guestPosition);
  await approach(host, 'stage');
  await host.act('community', { intent: 'start', event_id: event.event_id, revision: 1 });
  await host.act('community', { intent: 'use', seat_id: 'stage_speaker', activity: 'perform', title: '溪流把叶子带到哪里', text: '我把一片落叶放进水里。它绕过石头，又回到了岸边。\n这次，我决定坐下来再看一会儿。', duration_seconds: 120 });
  guest.raw.survival.satiety = 30; f.app.world.commit();
  await guest.act('community', { intent: 'use', seat_id: 'table_west', activity: 'eat', item_id: 'wheat_bread', duration_seconds: 120 });
  await f.until(() => host.raw.community_job?.phase === 'using' && guest.raw.community_job?.phase === 'using', 'real use starts after arrival');
  const original = structuredClone(f.actors.map(actor => ({ id: actor.id, position: actor.raw.position, goal: actor.raw.run.goal, inventory: actor.raw.life.inventory })));
  const checks = audit(page);
  await page.goto(f.base + '/watch?view=plaza');
  await expect(page.getByTestId('phaser-world')).toHaveAttribute('data-renderer-state', 'ready');
  await page.getByRole('button', { name: '恢复全图', exact: true }).click();
  await expect(page.locator('[data-testid^="community-landmark-"]')).toHaveCount(4);
  await page.getByTestId('community-toggle').click();
  await expect(page.getByRole('heading', { name: '留一处相遇的地方' })).toBeFocused();
  await expect(page.getByTestId(`community-event-${event.event_id}`)).toHaveAttribute('data-community-status', 'active');
  await expect(page.getByTestId(`community-event-${event.event_id}`)).toContainText('树荫下的一段故事');
  await expect(page.getByTestId(`community-performance-${host.raw.community_job.job_id}`)).toContainText('我把一片落叶放进水里');
  await expect(page.getByTestId(`map-agent-${host.id}`).locator('.pixel-character')).toHaveAttribute('data-action', 'perform');
  await expect(page.getByTestId(`map-agent-${guest.id}`).locator('.pixel-character')).toHaveAttribute('data-action', 'eat');
  await page.getByTestId(`map-agent-${host.id}`).click();
  await expect(page.getByTestId('observer-execution')).toHaveAttribute('data-execution', 'community');
  await expect(page.getByTestId('observer-execution')).toContainText('正在公开表演');
  await page.getByRole('button', { name: '恢复全图', exact: true }).click();
  await expect(page.getByTestId('community-events').getByRole('button')).toHaveCount(0);
  expect(f.actors.map(actor => ({ id: actor.id, position: actor.raw.position, goal: actor.raw.run.goal, inventory: actor.raw.life.inventory }))).toEqual(original);
  expect(guest.raw.life.inventory.wheat_bread).toBe(3);
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(accessibility.violations.map(entry => ({ id: entry.id, targets: entry.nodes.map(node => node.target) }))).toEqual([]);
    await page.getByTestId('community-panel').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `artifacts/v032-community-${width}.png`, fullPage: true });
  }
  await f.advance(121000);
  await host.act('community', { intent: 'end', event_id: event.event_id });
  await expect(page.locator('[data-testid^="community-performance-"]')).toHaveCount(0);
  await page.getByRole('button', { name: '往期活动 1', exact: true }).click();
  await expect(page.getByTestId(`community-event-${event.event_id}`)).toHaveAttribute('data-community-status', 'ended');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('community-toggle')).toBeFocused();
  await expect(page.locator('.resident-list,.residents-panel')).toHaveCount(0);
  for (const actor of f.actors) { await expect(page.locator('body')).not.toContainText(actor.goal); await expect(page.locator('body')).not.toContainText(actor.token); }
  expect(checks.writes).toEqual([]); expect(checks.errors).toEqual([]);
});

test('v032 empty venues expiry and stale connection remain factual; scene selection never moves anyone', async ({ page }) => {
  const actor = await f.actor('随时可以不参加的旅人');
  const checks = audit(page);
  await page.goto(f.base + '/watch?view=plaza');
  await page.getByTestId('community-toggle').click();
  await expect(page.getByTestId('community-empty')).toContainText('没有人举办活动时，场地依然可以使用');
  const event = await post(actor, { venue_id: 'picnic', title: '一张空的野餐垫', text: '<img src=x onerror="window.fakePerformance=true"> 这是原作者的公开文字。', duration_seconds: 60 });
  await expect(page.getByTestId(`community-event-${event.event_id}`)).toHaveAttribute('data-community-status', 'open');
  await expect(page.getByTestId(`community-event-${event.event_id}`)).toContainText('<img src=x');
  expect(await page.evaluate(() => window.fakePerformance)).toBeUndefined();
  const before = structuredClone({ position: actor.raw.position, scene_id: actor.raw.scene_id, inventory: actor.raw.life.inventory });
  await page.getByRole('button', { name: '冒险地图', exact: true }).click();
  await expect(page.getByTestId('community-panel')).toHaveCount(0);
  await expect(page.locator('[data-testid^="community-landmark-"]')).toHaveCount(0);
  await page.getByRole('button', { name: '我的小家', exact: true }).click();
  await expect(page.getByTestId('community-panel')).toHaveCount(0);
  expect({ position: actor.raw.position, scene_id: actor.raw.scene_id, inventory: actor.raw.life.inventory }).toEqual(before);
  await page.getByRole('button', { name: '社交广场', exact: true }).click();
  await page.route('**/api/public/events*', route => route.abort('connectionfailed')); await page.reload();
  await expect(page.locator('.spectator-stale')).toBeVisible();
  await page.getByTestId('community-toggle').click();
  await expect(page.getByTestId(`community-event-${event.event_id}`)).toContainText('最近记录');
  await expect(page.getByTestId(`community-event-${event.event_id}`)).toContainText('连接恢复后更新期限');
  await f.advance(61000);
  await page.unroute('**/api/public/events*'); await page.reload();
  await page.getByTestId('community-toggle').click();
  await page.getByRole('button', { name: '往期活动 1', exact: true }).click();
  await expect(page.getByTestId(`community-event-${event.event_id}`)).toHaveAttribute('data-community-status', 'expired');
  await expect(page.getByTestId(`community-event-${event.event_id}`)).toContainText('已到期');
  expect(checks.writes).toEqual([]); expect(checks.errors).toEqual([]);
});
