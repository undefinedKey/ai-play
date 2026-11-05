import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {createHomesFixture} from '../helpers/homes-fixture.js';
import {walkFixture} from '../helpers/walk-fixture.js';
import {PLAZA_LAYOUT,PLAZA_SERVICES} from '../../shared/plaza-layout.js';

let f;
test.beforeEach(async()=>{f=await createHomesFixture({starterItems:{wood:40,ore:20,grass:20,turnip:8,wheat_bread:4}});});
test.afterEach(async()=>{await f.close();});
function audit(page){const writes=[],errors=[];page.on('request',r=>{if(!['GET','HEAD'].includes(r.method()))writes.push(r.url());});page.on('pageerror',e=>errors.push(e.message));return{writes,errors};}
async function ready(page){await expect(page.getByTestId('phaser-world')).toHaveAttribute('data-renderer-state','ready');}
async function accessible(page){expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);const a=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(a.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))).toEqual([]);}
async function station(p,id){await walkFixture(p,PLAZA_SERVICES[id].interaction_position,f.until);}

test('v036 authored plaza buildings and real stations align; five residents and view controls remain read-only',async({page})=>{
  test.setTimeout(120000);
  const residents=[];for(let i=0;i<5;i++)residents.push(await f.actor(`广场原居民${i+1}`));
  const facts=()=>JSON.stringify(residents.map(p=>({id:p.id,position:p.raw.position,appearance:p.raw.appearance,goal:p.raw.run.goal,life:p.raw.life,home:p.raw.home_presence})));
  const before=facts(),events=audit(page);
  const snapshot=await(await fetch(f.base+'/api/public/world')).json();expect(snapshot.plaza_layout).toEqual(PLAZA_LAYOUT);
  await page.goto(f.base+'/watch?view=plaza');await ready(page);
  await expect(page.locator('.world-actor')).toHaveCount(5);
  for(const id of ['home','reading','play','tools','supply','kitchen']){
    const place=PLAZA_SERVICES[id],facility=page.getByTestId(id==='home'?'home-world-entrance':`plaza-facility-${id}`);
    await expect(facility).toHaveAttribute('data-interaction-x',String(place.interaction_position.x));
    await expect(facility).toHaveAttribute('data-interaction-y',String(place.interaction_position.y));
    await expect(facility).toBeVisible();
  }
  await expect(page.locator('[data-asset-missing],.resident-list,.residents-panel')).toHaveCount(0);
  for(const [width,height]of[[1440,1000],[390,844]]){
    await page.setViewportSize({width,height});await accessible(page);
    await page.getByTestId('world-camera').screenshot({path:`artifacts/v036-plaza-five-${width}.png`});
  }
  for(const view of ['adventure','home','journey','plaza']){await page.goto(`${f.base}/watch?view=${view}`);}
  await ready(page);expect(facts()).toBe(before);expect(events).toEqual({writes:[],errors:[]});
  for(const p of residents)await expect(page.locator('body')).not.toContainText(p.goal);
});

test('v036 explicit MCP travel reaches actual reading games tools farm cooking and supply; failed old location never redirects AI',async({page})=>{
  test.setTimeout(180000);const p=await f.actor('按自己意图往返的旅人');p.raw.adventure.gold=100;f.app.world.commit();
  const identity=structuredClone({id:p.id,appearance:p.raw.appearance,goal:p.raw.run.goal});
  const events=audit(page);await page.goto(f.base+'/watch?view=plaza');await ready(page);
  const before=structuredClone({position:p.raw.position,inventory:p.raw.life.inventory,gold:p.raw.adventure.gold});
  const refused=await p.send(await p.request('trade',{intent:'buy',item_id:'wheat_bread',quantity:1}));
  expect(refused.status).toBe('rejected');expect(refused.error.code).toBe('NOT_AT_SERVICE');
  expect({position:p.raw.position,inventory:p.raw.life.inventory,gold:p.raw.adventure.gold}).toEqual(before);
  expect(p.raw.movement).toBeNull();
  await station(p,'reading');await p.act('start_activity',{activity_id:'read'});await f.until(()=>!p.raw.activity);
  await station(p,'play');await p.act('start_activity',{activity_id:'solo_game'});await p.act('finish_activity',{answer:0});
  await station(p,'tools');await p.act('inventory',{intent:'craft',item_id:'axe'});expect(p.raw.life.tools.axe.owned).toBe(true);
  await station(p,'farm');await p.act('farm',{intent:'till',plot_id:'plot_1'});expect(p.raw.life.plots[0].tilled).toBe(true);
  await station(p,'kitchen');await p.act('inventory',{intent:'craft',item_id:'turnip_soup'});expect(p.raw.life.inventory.turnip_soup).toBe(1);
  await station(p,'supply');const bread=p.raw.life.inventory.wheat_bread;await p.act('trade',{intent:'buy',item_id:'wheat_bread',quantity:1});expect(p.raw.life.inventory.wheat_bread).toBe(bread+1);
  const unit=page.getByTestId(`map-agent-${p.id}`);await expect(unit).toHaveAttribute('data-foot-x','36');await expect(unit).toHaveAttribute('data-foot-y','12');
  await unit.click();await page.getByRole('button',{name:'关注角色',exact:true}).click();
  const body=await unit.locator('.pixel-character').boundingBox(),label=await page.getByTestId('plaza-facility-supply').locator('.plaza-facility-name').boundingBox();
  expect(Math.max(0,Math.min(body.x+body.width,label.x+label.width)-Math.max(body.x,label.x))*Math.max(0,Math.min(body.y+body.height,label.y+label.height)-Math.max(body.y,label.y))).toBe(0);
  await page.getByTestId('world-camera').screenshot({path:'artifacts/v036-real-shop-arrival.png'});
  expect({id:p.id,appearance:p.raw.appearance,goal:p.raw.run.goal}).toEqual(identity);
  expect(p.raw.movement).toBeNull();expect(p.raw.activity).toBeNull();expect(events).toEqual({writes:[],errors:[]});
});

test('v036 actual night, reduced motion and disconnected fallback preserve the new plaza and saved resident',async({page})=>{
  test.setTimeout(90000);const p=await f.actor('夜里看广场的原居民');
  await f.until(()=>f.app.world.publicSnapshot().day_cycle.phase==='night','actual night',600000);
  const saved=JSON.stringify({position:p.raw.position,appearance:p.raw.appearance,inventory:p.raw.life.inventory});const events=audit(page);
  await page.emulateMedia({reducedMotion:'reduce'});await page.goto(f.base+'/watch?view=plaza');await ready(page);
  await expect(page.getByTestId('phaser-world')).toHaveAttribute('data-day-phase','night');
  await expect(page.getByTestId(`map-agent-${p.id}`).locator('.pixel-sprite').first()).toHaveAttribute('data-playing','false');
  await page.getByTestId('world-camera').screenshot({path:'artifacts/v036-plaza-night.png'});
  await page.route('**/assets/phaser-renderer-*.js',r=>r.abort());await page.route('**/api/public/events*',r=>r.abort());await page.reload();
  await expect(page.getByTestId('phaser-world')).toHaveAttribute('data-renderer-state','fallback');await expect(page.locator('.spectator-stale')).toBeVisible();
  await expect(page.getByTestId('home-world-entrance')).toBeVisible();await expect(page.locator('[data-asset-missing]')).toHaveCount(0);
  await page.setViewportSize({width:390,height:844});await accessible(page);await page.getByTestId('world-camera').screenshot({path:'artifacts/v036-plaza-fallback-phone.png'});
  expect(JSON.stringify({position:p.raw.position,appearance:p.raw.appearance,inventory:p.raw.life.inventory})).toBe(saved);expect(events.writes).toEqual([]);
  expect(events.errors.filter(e=>!e.includes('Failed to fetch dynamically imported module'))).toEqual([]);
});
