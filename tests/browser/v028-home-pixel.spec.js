import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createHomesFixture } from '../helpers/homes-fixture.js';
import { HOME_PIXEL_ART } from '../../src/home-pixel-manifest.js';

let f;
test.beforeEach(async () => { f = await createHomesFixture({ starterItems: { wood: 90, grass: 60, ore: 12, pine_cone: 2 } }); });
test.afterEach(async () => { await f.close(); });

async function buildHome(actor, name) {
  await actor.act('adventure_plan', { intent: 'retreat' }); await f.until(() => !actor.raw.adventure.plan);
  await actor.act('home', { intent: 'build', name });
  const id = `home_${actor.id}`;
  await actor.act('home', { intent: 'visit', home_id: id }); await f.until(() => actor.raw.home_presence?.home_id === id);
  return id;
}
async function place(actor, kind, x, y, rotation = 0) {
  await actor.act('home', { intent: 'craft', kind });
  const item = (await actor.observe()).homes.own_home.storage.find(value => value.kind === kind);
  await actor.act('home', { intent: 'place', instance_id: item.instance_id, x, y, rotation });
  return { ...item, x, y, rotation };
}
function audit(page) {
  const writes = [], errors = [], brokenAssets = [];
  page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400 && /home.*\.(?:png|webp|json)(?:\?|$)/.test(response.url())) brokenAssets.push([response.status(), response.url()]); });
  return { writes, errors, brokenAssets };
}
async function accessible(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(result.violations.map(value => ({ id: value.id, nodes: value.nodes.map(node => node.target) }))).toEqual([]);
}
function storedHome(actor, home) {
  return JSON.stringify({ identity: actor.raw.appearance, position: actor.raw.home_presence.position,
    furniture: f.app.world.state.homes[home].furniture, displays: f.app.world.state.homes[home].displays });
}

test('v028 pixel furniture keeps real saved positions, four headings, flat rugs and proportions at desktop and phone sizes', async ({ page }) => {
  test.setTimeout(120000);
  const p = await f.actor('原来的像素旅人'), home = await buildHome(p, '依然是我的布置');
  const placed = [];
  for (const [index, rotation] of [0, 90, 180, 270].entries()) placed.push(await place(p, 'chair', index * 2, 0, rotation));
  for (const args of [['table', 0, 2, 0], ['table', 3, 2, 90], ['bookshelf', 8, 0, 0], ['display_shelf', 6, 2, 0], ['rug', 6, 4, 0], ['bed', 0, 5, 0]]) placed.push(await place(p, ...args));
  const shelf = placed.find(item => item.kind === 'display_shelf');
  await p.act('home', { intent: 'display', instance_id: shelf.instance_id, item_id: 'pine_cone', title: '原来的松果', text: '换了家具画风，这枚松果和我的布置还在。' });
  const before = storedHome(p, home), events = audit(page);
  await page.goto(`${f.base}/watch?view=home&home=${home}`);
  await expect(page.getByTestId('home-room')).toHaveAttribute('data-home-id', home);
  await expect(page.locator('.home-furniture')).toHaveCount(10);
  await expect(page.getByTestId(`home-actor-${p.id}`).locator('.pixel-character')).toHaveAttribute('data-sprite-id', p.raw.appearance.sprite_id);
  await expect(page.locator('.home-furniture-foreground')).toHaveCount(0);
  for (const item of placed) {
    const node = page.getByTestId(`home-furniture-${item.instance_id}`);
    await expect(node).toHaveAttribute('data-foot-x', String(item.x));
    await expect(node).toHaveAttribute('data-foot-y', String(item.y));
    await expect(node).toHaveAttribute('data-rotation', String(item.rotation));
    await expect(node).toHaveAttribute('data-render-layer', item.kind === 'rug' ? 'floor' : 'furniture');
    await expect(node.locator('.home-furniture-art')).toHaveAttribute('data-art-rotation', String(item.rotation));
  }
  const chairFrames = await page.locator('.home-furniture[data-furniture-kind="chair"] .home-furniture-art>g>svg').evaluateAll(nodes => nodes.map(node => node.innerHTML));
  expect(chairFrames).toHaveLength(4); expect(new Set(chairFrames).size).toBe(4);
  const rug = page.locator('.home-furniture[data-furniture-kind="rug"]');
  const furnitureDepths = await page.locator('.home-furniture:not([data-furniture-kind="rug"])').evaluateAll(nodes => nodes.map(node => Number(getComputedStyle(node).zIndex)));
  expect(Number(await rug.evaluate(node => getComputedStyle(node).zIndex))).toBeLessThan(Math.min(...furnitureDepths));
  for (const [width, height] of [[1440, 1000], [390, 844]]) {
    await page.setViewportSize({ width, height });
    const metrics = await page.locator('.home-furniture').evaluateAll(nodes => nodes.map(node => {
      const box = node.getBoundingClientRect(), svg = node.querySelector('.home-furniture-art');
      return { kind: node.dataset.furnitureKind, width: box.width, height: box.height,
        expectedWidth: Number(node.dataset.renderWidth), expectedHeight: Number(node.dataset.renderHeight),
        stretch: svg?.getAttribute('preserveAspectRatio'), imageCount: svg?.querySelectorAll('image').length || 0,
        rectCount:svg?.querySelectorAll('rect').length||0, release:svg?.getAttribute('data-art-release') };
    }));
    for (const value of metrics) {
      expect(value.width).toBeGreaterThan(0); expect(value.height).toBeGreaterThan(0);
      expect(value.width / value.height).toBeCloseTo(value.expectedWidth / value.expectedHeight, 2);
      expect(value.stretch).not.toBe('none'); expect(value.imageCount).toBe(0);
      expect(value.rectCount).toBeGreaterThan(5); expect(value.release).toBe('0.36.0');
    }
    await accessible(page);
    await page.getByTestId('home-view').screenshot({ path: `artifacts/v028-pixel-room-${width}.png` });
  }
  await page.getByRole('button', { name: '查看纪念品：原来的松果', exact: true }).click();
  await expect(page.getByTestId('home-display-detail')).toContainText('这枚松果和我的布置还在');
  await page.getByRole('button', { name: '社交广场', exact: true }).click();
  await expect(page.getByTestId(`map-agent-${p.id}`)).toHaveCount(0);
  await page.getByRole('button', { name: '我的小家', exact: true }).click();
  await expect(page.locator('.home-furniture')).toHaveCount(10);
  expect(storedHome(p, home)).toBe(before);
  expect(events).toEqual({ writes: [], errors: [], brokenAssets: [] });
  await expect(page.locator('.resident-list')).toHaveCount(0);
  await expect(page.getByTestId('home-view').locator('input,textarea,select')).toHaveCount(0);
});

test('v028 only a confirmed seated or sleeping actor gets a clipped furniture foreground, across all four headings', async ({ page }) => {
  test.setTimeout(120000);
  const p = await f.actor('同一个像素居民'), home = await buildHome(p, '坐得稳睡得好的家');
  const chair = await place(p, 'chair', 2, 2), bed = await place(p, 'bed', 6, 3);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const events = audit(page), identity = p.raw.appearance.sprite_id;
  await page.goto(`${f.base}/watch?view=home&home=${home}`);
  const actor = page.getByTestId(`home-actor-${p.id}`), character = actor.locator('.pixel-character');
  await expect(character).toHaveAttribute('data-art-style', 'q-pixel');
  for (const [item, activity] of [[chair, 'sit'], [bed, 'rest']]) {
    for (const rotation of [0, 90, 180, 270]) {
      await p.act('home', { intent: 'place', instance_id: item.instance_id, x: item.x, y: item.y, rotation });
      await p.act('home', { intent: 'use', instance_id: item.instance_id, activity });
      if (p.raw.home_presence.activity.phase === 'approaching') {
        await expect(actor).toHaveAttribute('data-home-phase', 'approaching');
        await expect(page.locator('.home-furniture-foreground')).toHaveCount(0);
      }
      await f.until(() => p.raw.home_presence?.activity?.phase === 'using'); await f.advance(800);
      await expect(actor).toHaveAttribute('data-home-phase', 'using');
      await expect(actor).toHaveAttribute('data-home-furniture', item.instance_id);
      await expect(character).toHaveAttribute('data-action', activity==='rest'?'sleep':activity);
      await expect(character).toHaveAttribute('data-sprite-id', identity);
      const authoritativePosition = { ...p.raw.home_presence.position };
      await expect(actor).toHaveAttribute('data-foot-x', String(authoritativePosition.x));
      await expect(actor).toHaveAttribute('data-foot-y', String(authoritativePosition.y));
      const foreground = page.locator(`.home-furniture-foreground[data-furniture-instance="${item.instance_id}"]`);
      await expect(foreground).toHaveCount(1); await expect(foreground).toHaveAttribute('data-occludes-agent', p.id);
      await expect(foreground).toHaveCSS('pointer-events', 'none');
      const base = page.getByTestId(`home-furniture-${item.instance_id}`);
      const [baseDepth, actorDepth, foregroundDepth] = await Promise.all([base, actor, foreground].map(node => node.evaluate(value => Number(getComputedStyle(value).zIndex))));
      expect(baseDepth).toBeLessThan(actorDepth); expect(actorDepth).toBeLessThan(foregroundDepth);
      // A separate foreground must actually clip the pixel art. Repainting the
      // complete sprite here would hide the original AI under its own chair.
      const clipping = await foreground.evaluate(node => {
        const art = node.querySelector('.home-furniture-art'), bounds = art.viewBox.baseVal;
        return { count: node.querySelectorAll('clipPath').length,
          uses: [...node.querySelectorAll('[clip-path]')].map(value => value.getAttribute('clip-path')),
          areaRatio: [...node.querySelectorAll('clipPath rect')].reduce((total, rect) => total + rect.width.baseVal.value * rect.height.baseVal.value, 0) / (bounds.width * bounds.height) };
      });
      expect(clipping.count).toBeGreaterThan(0); expect(clipping.uses.some(value => value?.startsWith('url('))).toBe(true);
      expect(clipping.areaRatio).toBeGreaterThan(0); expect(clipping.areaRatio).toBeLessThan(.98);
      for (const [width, height] of [[1440, 1000], [390, 844]]) {
        await page.setViewportSize({ width, height });
        const spec=HOME_PIXEL_ART[item.kind].variants[rotation];
        const contact=await actor.evaluate((node,{instance,seat,artWidth,artHeight})=>{
          const character=node.querySelector('.pixel-character').getBoundingClientRect();
          const furniture=document.querySelector(`[data-testid="home-furniture-${instance}"]`).getBoundingClientRect();
          const hip=43-Number(node.querySelector('[data-home-contact-height]').dataset.homeContactHeight);
          return {actual:{x:character.x+character.width/2,y:character.y+character.height*hip/48},
            expected:{x:furniture.x+furniture.width*seat.x/artWidth,y:furniture.y+furniture.height*seat.y/artHeight}};
        },{instance:item.instance_id,seat:spec.seat,artWidth:spec.width,artHeight:spec.height});
        expect(Math.abs(contact.actual.x-contact.expected.x)).toBeLessThan(1.2);
        expect(Math.abs(contact.actual.y-contact.expected.y)).toBeLessThan(1.2);
        await page.getByTestId('home-room').screenshot({ path: `artifacts/v028-${activity}-${rotation}-${width}.png` });
      }
      await p.act('home', { intent: 'cancel' });
      await expect(page.locator('.home-furniture-foreground')).toHaveCount(0);
      await expect(actor).not.toHaveAttribute('data-home-phase', 'using');
      expect(p.raw.home_presence.position).toEqual(authoritativePosition);
    }
  }
  expect(events).toEqual({ writes: [], errors: [], brokenAssets: [] });
});
