import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createHomesFixture } from '../helpers/homes-fixture.js';
import { assertCanvasResolution } from './canvas-assertions.js';

let f;
test.beforeEach(async()=>{f=await createHomesFixture({starterItems:{wood:60,grass:40,ore:8}});});
test.afterEach(async()=>{await f.close();});
function audit(page){
  const writes=[],errors=[],oldTextures=[],broken=[];
  page.on('request',req=>{
    if(!['GET','HEAD'].includes(req.method()))writes.push(req.url());
    if(/\/pixel-world\/ink_|\/pixel-home\/v028\/.*\.(png|webp)/.test(req.url()))oldTextures.push(req.url());
  });
  page.on('pageerror',e=>errors.push(e.message));
  page.on('response',r=>{if(r.status()>=400&&/\/pixel-world\//.test(r.url()))broken.push([r.status(),r.url()]);});
  return {writes,errors,oldTextures,broken};
}
async function screen(page,name,small=false){
  await page.setViewportSize(small?{width:390,height:844}:{width:1440,height:1000});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(await page.locator('[data-asset-missing],.resident-list,.residents-panel').evaluateAll(nodes=>nodes.map(n=>n.outerHTML+' parent:'+n.parentElement.outerHTML.slice(0,1000)))).toEqual([]);
  const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  expect(result.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))).toEqual([]);
  await page.screenshot({path:`artifacts/v034-${name}-${small?'phone':'desktop'}.png`});
}
async function worldReady(page){
  await expect(page.getByTestId('phaser-world')).toHaveAttribute('data-renderer-state','ready');
  await expect(page.getByTestId('phaser-world')).toHaveAttribute('data-art-style','q-pixel');
  await assertCanvasResolution(page);
}

test('v034 all independent maps use Q art on desktop and phone without changing AI state',async({page})=>{
  test.setTimeout(120000);
  const a=await f.actor('像素旅人甲'),b=await f.actor('像素旅人乙');
  const saved=JSON.stringify([a,b].map(p=>({id:p.id,appearance:p.raw.appearance,position:p.raw.position,scene:p.raw.scene_id,inventory:p.raw.life.inventory,goal:p.raw.run.goal})));
  const events=audit(page);
  for(const view of ['plaza','adventure','ruins']){
    await page.goto(`${f.base}/watch?view=${view}`);await worldReady(page);
    await expect(page.locator('.pixel-scene-image').first()).toHaveAttribute('src',/\/pixel-world\/q_/);
    if(view==='plaza'){
      for(const p of [a,b])await expect(page.getByTestId(`map-agent-${p.id}`).locator('.pixel-character')).toHaveAttribute('data-sprite-id',p.raw.appearance.sprite_id);
      await expect(page.locator('.world-actor .pixel-sprite[data-art-style="q-pixel"]')).not.toHaveCount(0);
    }else await expect(page.locator('.world-actor')).toHaveCount(0);
    await screen(page,view);await screen(page,view,true);
  }
  await page.goto(f.base+'/watch?view=journey');
  await expect(page.getByTestId('journey-empty')).toBeVisible();await screen(page,'journey',true);
  expect(JSON.stringify([a,b].map(p=>({id:p.id,appearance:p.raw.appearance,position:p.raw.position,scene:p.raw.scene_id,inventory:p.raw.life.inventory,goal:p.raw.run.goal})))).toBe(saved);
  expect(events).toEqual({writes:[],errors:[],oldTextures:[],broken:[]});
});

test('v034 actual farm stages show native ground crops and owned tools; viewer remains read only',async({page})=>{
  test.setTimeout(90000);
  const a=await f.actor('农田的原角色');
  await a.act('move',{x:11,y:8});await f.until(()=>!a.raw.movement);
  const events=audit(page);
  await page.goto(f.base+'/watch?view=farm');
  const unit=page.getByTestId('farm-present-agent');
  await expect(unit.locator('.pixel-character')).toHaveAttribute('data-sprite-id',a.raw.appearance.sprite_id);
  await expect(page.locator('.pixel-farm-backdrop')).toHaveAttribute('data-art-style','q-pixel');
  await a.act('farm',{intent:'till',plot_id:'plot_1'});
  await expect(unit.locator('.pixel-tool')).toHaveAttribute('data-item','hoe');
  await expect(unit.locator('.pixel-tool')).toHaveAttribute('data-art-style','q-pixel');
  await a.act('farm',{intent:'plant',plot_id:'plot_1',crop_id:'turnip'});
  await expect(page.getByTestId('farm-plot_1').locator('.pixel-crop').first()).toHaveAttribute('data-pixel-action','seeded');
  await expect(page.getByTestId('farm-plot_1').locator('.pixel-crop').first()).toHaveAttribute('data-art-style','q-pixel');
  await screen(page,'farm');await screen(page,'farm',true);
  expect(events).toEqual({writes:[],errors:[],oldTextures:[],broken:[]});
});

test('v034 DOM fallback and actual night retain pixel sources and state without missing sprites',async({page})=>{
  test.setTimeout(60000);
  const a=await f.actor('夜里的旅人');
  const events=audit(page);
  await page.route('**/assets/phaser-renderer-*.js',route=>route.abort());
  await page.goto(f.base+'/watch?view=plaza');
  await expect(page.getByTestId('phaser-world')).toHaveAttribute('data-renderer-state','fallback');
  await expect(page.getByTestId(`map-agent-${a.id}`).locator('.pixel-character>.pixel-sprite').first()).toHaveAttribute('data-art-style','q-pixel');
  // Advance the isolated world's real day cycle, not a painted preview flag.
  await f.until(()=>f.app.world.publicSnapshot().day_cycle.phase==='night','real night begins',600000);
  await page.reload();
  await expect(page.getByTestId('phaser-world')).toHaveAttribute('data-day-phase','night');
  await page.emulateMedia({reducedMotion:'reduce'});
  await expect(page.getByTestId(`map-agent-${a.id}`).locator('.pixel-sprite').first()).toHaveAttribute('data-playing','false');
  await screen(page,'night-fallback');
  expect(events.writes).toEqual([]);expect(events.oldTextures).toEqual([]);expect(events.broken).toEqual([]);
  expect(events.errors.filter(e=>!e.includes('Failed to fetch dynamically imported module'))).toEqual([]);
});
