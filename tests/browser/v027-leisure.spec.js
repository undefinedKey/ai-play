import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createHomesFixture } from '../helpers/homes-fixture.js';

let f;
test.beforeEach(async () => { f = await createHomesFixture({ starterItems: { wood: 70, grass: 60, ore: 12 } }); });
test.afterEach(async () => { await f.close(); });

async function originalRig(page, id) {
  const manifest = await (await fetch(f.base + '/pixel-world/manifest.json')).json();
  manifest.paper_dolls.feiyu_v1.eligible_agent_ids = [id];
  await page.route('**/pixel-world/manifest.json*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(manifest) }));
}
async function accessible(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(result.violations.map(value => ({ id: value.id, nodes: value.nodes.map(node => node.target) }))).toEqual([]);
}
function readOnly(page) {
  const writes = [], errors = [];
  page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  return { writes, errors };
}

test('v027 true shore approach, fishing, completion and cancellation remain read-only on desktop and mobile', async ({ page }) => {
  test.setTimeout(120000);
  const p = await f.actor('池边的原居民');
  await p.act('move', { x: 10, y: 8 }); await f.until(() => !p.raw.movement);
  await p.act('inventory', { intent: 'craft', item_id: 'fishing_rod' });
  await p.act('inventory', { intent: 'craft', item_id: 'fish_bait' });
  await originalRig(page, p.id);
  const audit = readOnly(page);
  await p.act('fish', { intent: 'start', spot_id: 'plaza_pond_south', bait_id: 'fish_bait' });
  await page.goto(f.base + '/watch?view=plaza');
  await page.getByRole('button', { name: '恢复全图', exact: true }).click();
  await expect(page.getByTestId(`fishing-line-${p.id}`)).toHaveCount(0);
  await page.getByTestId('fishing-spot-plaza_pond_south').click();
  await expect(page.getByTestId('fishing-inspector')).toContainText('正沿小路走向岸边');
  await expect(page.getByTestId('fishing-inspector')).not.toContainText('钓到');
  await f.until(() => p.raw.fishing?.phase === 'fishing'); await f.advance(800);
  await expect(page.getByTestId(`fishing-line-${p.id}`)).toBeVisible();
  const actor = page.getByTestId(`map-agent-${p.id}`);
  await expect(actor).toHaveAttribute('data-foot-x', '3'); await expect(actor).toHaveAttribute('data-foot-y', '4');
  await expect(actor.locator('.pixel-character')).toHaveAttribute('data-action', 'fish');
  await expect(actor.locator('.paper-doll-rig')).toBeVisible();
  await expect(actor.locator('.pixel-character')).toHaveAttribute('data-sprite-id', p.raw.appearance.sprite_id);
  await actor.click(); await page.getByRole('button', { name: '定位角色', exact: true }).click();
  for (const [width, height] of [[1440, 1000], [390, 844]]) {
    await page.setViewportSize({ width, height }); await accessible(page);
    await page.getByTestId('world-camera').screenshot({ path: `artifacts/v027-fishing-${width}.png` });
  }
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.reload();
  await expect(page.getByTestId(`fishing-line-${p.id}`)).toHaveAttribute('data-playing', 'false');
  await expect(actor.locator('.paper-doll-rig')).toHaveAttribute('data-playing', 'false');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.route('**/api/public/events*', route => route.abort()); await page.reload();
  await expect(page.locator('.spectator-stale')).toBeVisible();
  await expect(page.getByTestId(`fishing-line-${p.id}`)).toHaveAttribute('data-playing', 'false');
  await page.unroute('**/api/public/events*'); await page.reload();
  await f.until(() => !p.raw.fishing);
  await expect(page.getByTestId(`fishing-line-${p.id}`)).toHaveCount(0);
  await page.getByRole('button', { name: '恢复全图', exact: true }).click(); await page.getByTestId('fishing-spot-plaza_pond_south').click();
  await expect(page.getByTestId('fishing-inspector')).toContainText('钓到');
  await p.act('inventory', { intent: 'craft', item_id: 'fish_bait' });
  await p.act('fish', { intent: 'start', spot_id: 'plaza_pond_east', bait_id: 'fish_bait' });
  await p.act('fish', { intent: 'cancel' });
  await expect(page.getByTestId(`fishing-line-${p.id}`)).toHaveCount(0);
  await page.getByRole('button', { name: '冒险地图', exact: true }).click();
  await expect(page.locator('.fishing-spot,.fishing-line')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(p.goal);
  expect(audit.writes).toEqual([]); expect(audit.errors).toEqual([]);
});

test('v027 writing stays private until complete, real books and comments can be inspected without changing AI state', async ({ page }) => {
  test.setTimeout(120000);
  const p = await f.actor('写故事的原居民');
  await p.act('move', { x: 10, y: 8 }); await f.until(() => !p.raw.movement);
  await p.act('home', { intent: 'build', name: '池风和纸页' });
  const home = `home_${p.id}`;
  await p.act('home', { intent: 'visit', home_id: home }); await f.until(() => !!p.raw.home_presence);
  const furniture = {};
  for (const [kind, x, y] of [['table', 5, 2], ['chair', 7, 3], ['bookshelf', 1, 1]]) {
    await p.act('home', { intent: 'craft', kind }); const item = (await p.observe()).homes.own_home.storage.find(value => value.kind === kind);
    furniture[kind] = item.instance_id; await p.act('home', { intent: 'place', instance_id: item.instance_id, x, y });
  }
  const body = '今天我在池塘边等了一阵风。\n' + '水面没有催我，我也慢慢翻过一天。'.repeat(35) + '\n<script>window.bookUnsafe=true</script>';
  await p.act('home', { intent: 'write_book', instance_id: furniture.table, title: '等风来的一页', text: body });
  await originalRig(page, p.id); const audit = readOnly(page);
  await page.goto(`${f.base}/watch?view=home&home=${home}`);
  await expect(page.getByTestId('home-books')).toContainText('还没有完稿');
  await expect(page.locator('[data-home-prop="writing"]')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(body);
  await f.until(() => p.raw.home_presence?.activity?.phase === 'using'); await f.advance(800);
  const actor = page.getByTestId(`home-actor-${p.id}`);
  await expect(actor).toHaveAttribute('data-home-activity', 'write');
  await expect(actor.locator('[data-home-prop="writing"]')).toBeVisible();
  await expect(page.getByTestId('home-current-activity')).toContainText('等风来的一页');
  await expect(page.locator('body')).not.toContainText(body);
  await page.getByTestId('home-room').screenshot({ path: 'artifacts/v027-writing-1440.png' });
  await f.until(() => !p.raw.home_presence.activity);
  const book = (await p.observe()).homes.own_home.books[0];
  await p.act('home', { intent: 'shelve_book', book_id: book.book_id, instance_id: furniture.bookshelf });
  await p.act('home', { intent: 'book_comment', book_id: book.book_id, text: '留给下次坐在池边的自己。' });
  await p.act('home', { intent: 'use', instance_id: furniture.chair, activity: 'read', book_id: book.book_id });
  await f.until(() => p.raw.home_presence.activity?.phase === 'using'); await f.advance(800);
  await expect(actor.locator('[data-home-prop="book"]')).toBeVisible();
  await page.getByRole('button', { name: '阅读架上作品：等风来的一页', exact: true }).click();
  await expect(page.getByTestId('home-book-detail')).toContainText(body);
  await expect(page.getByTestId('home-book-detail')).toContainText('留给下次坐在池边的自己');
  await page.getByTestId('home-reading').locator('summary').click();
  await expect(page.getByTestId('home-reading')).toContainText(body);
  await expect(page.getByTestId('home-reading')).toContainText(p.raw.name);
  expect(await page.locator('.home-book-text').evaluate(element => element.scrollHeight > element.clientHeight && element.clientHeight <= 400)).toBe(true);
  expect(await page.getByTestId('home-reading').locator('p').evaluate(element => element.scrollHeight > element.clientHeight && element.clientHeight <= 220)).toBe(true);
  const before = JSON.stringify(p.raw.home_presence);
  for (const [width, height] of [[1440, 1000], [390, 844]]) {
    await page.setViewportSize({ width, height }); await accessible(page);
    await page.getByTestId('home-view').screenshot({ path: `artifacts/v027-books-${width}.png` });
  }
  expect(await page.evaluate(() => window.bookUnsafe)).toBeUndefined();
  await expect(page.locator('body')).not.toContainText(p.goal); await expect(page.locator('.resident-list')).toHaveCount(0);
  expect(JSON.stringify(p.raw.home_presence)).toBe(before); expect(audit.writes).toEqual([]); expect(audit.errors).toEqual([]);
});
