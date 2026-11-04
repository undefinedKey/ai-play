import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {createHomesFixture} from '../helpers/homes-fixture.js';

let f;
test.beforeEach(async()=>{f=await createHomesFixture({starterItems:{wood:100,grass:100,ore:40,berry:8,moon_herb:8,turnip:8,wheat_bread:4,silver_fish:2}});});
test.afterEach(async()=>{await f.close();});
function audit(page){const writes=[],errors=[];page.on('request',r=>{if(!['GET','HEAD'].includes(r.method()))writes.push(r.url());});page.on('pageerror',e=>errors.push(e.message));return{writes,errors};}
async function camp(p){await p.act('adventure_plan',{intent:'retreat'});await f.until(()=>!p.raw.adventure.plan);}
async function outfit(p){
 const ids={};
 for(const style_id of ['linen_shirt','garden_apron','traveler_coat','straw_hat','soft_cap','cloth_satchel','travel_pack'])ids[style_id]=(await p.act('wardrobe',{intent:'craft',style_id})).garment.garment_id;
 for(const [style_id,color_id] of [['traveler_coat','rose'],['soft_cap','sky'],['travel_pack','leaf']]){
  await p.act('wardrobe',{intent:'dye',garment_id:ids[style_id],color_id});await p.act('wardrobe',{intent:'wear',garment_id:ids[style_id]});
 }
 await p.act('wardrobe',{intent:'hairstyle',style_id:'ponytail'});return ids;
}
async function dressed(character,p){
 await expect(character).toHaveAttribute('data-sprite-id',p.raw.appearance.sprite_id);
 await expect(character).toHaveAttribute('data-hairstyle','ponytail');await expect(character).toHaveAttribute('data-wardrobe-outfit','traveler_coat');
 await expect(character).toHaveAttribute('data-wardrobe-head','soft_cap');await expect(character).toHaveAttribute('data-wardrobe-back','travel_pack');
}
async function accessible(page){
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
 expect(result.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))).toEqual([]);
 await expect(page.locator('[data-asset-missing],.resident-list,.residents-panel')).toHaveCount(0);
}
async function ready(page){await expect(page.getByTestId('phaser-world')).toHaveAttribute('data-renderer-state','ready');}
async function approach(p,tank){
 const observation=await p.observe();
 if(!observation.aquarium.tanks.find(t=>t.instance_id===tank)?.nearby)await p.act('aquarium',{intent:'approach',instance_id:tank});
 await f.until(()=>!p.raw.home_presence.movement);
}

test('v035 original AI chooses garments dyes and hair; actual wardrobe is visible across independent scenes and reversible',async({page})=>{
 test.setTimeout(150000);const p=await f.actor('自己搭配衣服的旅人'),appearance=structuredClone(p.raw.appearance),goal=p.raw.run.goal;
 await camp(p);const ids=await outfit(p),events=audit(page);
 await page.goto(f.base+'/watch?view=plaza');await ready(page);
 const plaza=page.getByTestId(`map-agent-${p.id}`).locator('.pixel-character');await dressed(plaza,p);
 for(const [style_id,color_id] of [['linen_shirt','natural'],['garden_apron','ochre'],['traveler_coat','rose']]){
  if(p.raw.wardrobe.items.find(i=>i.garment_id===ids[style_id]).color_id!==color_id)await p.act('wardrobe',{intent:'dye',garment_id:ids[style_id],color_id});
  await p.act('wardrobe',{intent:'wear',garment_id:ids[style_id]});await expect(plaza).toHaveAttribute('data-wardrobe-outfit',style_id);
 }
 for(const style_id of ['short','bob','original','ponytail']){await p.act('wardrobe',{intent:'hairstyle',style_id});await expect(plaza).toHaveAttribute('data-hairstyle',style_id);}
 await accessible(page);await page.screenshot({path:'artifacts/v035-dressed-plaza.png'});
 await page.getByRole('button',{name:'农作区',exact:true}).click();await dressed(page.getByTestId('farm-present-agent').locator('.pixel-character'),p);
 await p.act('home',{intent:'build',name:'衣服和鱼的小屋'});const home=`home_${p.id}`;
 await p.act('home',{intent:'visit',home_id:home});await f.until(()=>p.raw.home_presence?.home_id===home);
 await page.goto(`${f.base}/watch?view=home&home=${home}`);await dressed(page.getByTestId(`home-actor-${p.id}`).locator('.pixel-character'),p);
 await p.act('home',{intent:'leave'});await p.act('adventure_plan',{intent:'explore',zone_id:'forest'});await f.until(()=>p.raw.scene_id==='adventure');
 await p.act('adventure_plan',{intent:'stop'});await page.goto(f.base+'/watch?view=adventure');await ready(page);
 await dressed(page.getByTestId(`adventure-agent-${p.id}`).locator('.pixel-character'),p);
 await camp(p);await p.act('journey',{intent:'enter'});await f.until(()=>!p.raw.journey_job);
 await page.goto(f.base+'/watch?view=journey');await dressed(page.getByTestId(`journey-agent-${p.id}`).locator('.pixel-character'),p);
 await page.setViewportSize({width:390,height:844});
 await page.getByRole('button',{name:'跟随所选角色',exact:true}).click();
 const traveler=page.getByTestId(`journey-agent-${p.id}`),viewport=page.getByTestId('journey-viewport');
 await expect.poll(async()=>{const a=await traveler.boundingBox(),v=await viewport.boundingBox();return !!a&&!!v&&a.x>=v.x&&a.x+a.width<=v.x+v.width&&a.y>=v.y&&a.y+a.height<=v.y+v.height;}).toBe(true);
 await dressed(traveler.locator('.pixel-character'),p);await accessible(page);await page.screenshot({path:'artifacts/v035-dressed-journey-phone.png'});
 await p.act('journey',{intent:'leave'});await f.until(()=>!p.raw.journey_job);await camp(p);
 for(const slot of ['outfit','head','back'])await p.act('wardrobe',{intent:'remove',slot});await p.act('wardrobe',{intent:'hairstyle',style_id:'original'});
 await page.goto(f.base+'/watch?view=plaza');await ready(page);await expect(plaza).toHaveAttribute('data-hairstyle','original');
 for(const attr of ['data-wardrobe-outfit','data-wardrobe-head','data-wardrobe-back'])await expect(plaza).not.toHaveAttribute(attr,/.+/);
 expect(p.raw.appearance).toEqual(appearance);expect(p.raw.run.goal).toBe(goal);expect(events).toEqual({writes:[],errors:[]});
});

test('v035 real catch enters a physically approached tank with four facings names and refundable decoration; guests only inspect',async({page})=>{
 test.setTimeout(180000);const p=await f.actor('自己布置鱼缸的旅人');await camp(p);
 const beforeFish={pond_fish:p.raw.life.inventory.pond_fish||0,silver_fish:p.raw.life.inventory.silver_fish||0};
 await p.act('inventory',{intent:'craft',item_id:'fishing_rod'});await p.act('inventory',{intent:'craft',item_id:'fish_bait'});
 await p.act('fish',{intent:'start',spot_id:'plaza_pond_south',bait_id:'fish_bait'});await f.until(()=>!p.raw.fishing);
 const caught=['pond_fish','silver_fish'].find(id=>(p.raw.life.inventory[id]||0)>beforeFish[id]);expect(caught).toBeTruthy();
 await camp(p);await p.act('home',{intent:'build',name:'有名字的鱼'});const home=`home_${p.id}`;
 await p.act('home',{intent:'visit',home_id:home});await f.until(()=>p.raw.home_presence?.home_id===home);
 await p.act('home',{intent:'craft',kind:'aquarium'});const tank=f.app.world.state.homes[home].furniture.at(-1).instance_id;
 await p.act('home',{intent:'place',instance_id:tank,x:1,y:1,rotation:0});
 const events=audit(page);await page.goto(`${f.base}/watch?view=home&home=${home}`);
 const art=page.getByTestId(`aquarium-art-${tank}`),furniture=page.getByTestId(`home-furniture-${tank}`);
 await expect(art).toHaveAttribute('data-fish-count','0');await approach(p,tank);
 const stock=p.raw.life.inventory[caught];const put=await p.act('aquarium',{intent:'put',instance_id:tank,item_id:caught,name:'今天钓到的小鱼'});
 expect(p.raw.life.inventory[caught]).toBe(stock-1);await expect(art).toHaveAttribute('data-fish-count','1');
 await p.act('aquarium',{intent:'name',instance_id:tank,fish_id:put.fish.fish_id,name:'雨点'});
 for(const [slot,decoration_id]of ['water_grass','pebbles','driftwood'].entries())await p.act('aquarium',{intent:'decorate',instance_id:tank,slot,decoration_id});
 await expect(art).toHaveAttribute('data-decoration-count','3');await furniture.click();await expect(page.getByTestId('home-aquarium-detail')).toContainText('雨点');
 for(const rotation of [0,90,180,270]){
  if(p.raw.home_presence.position.x!==3||p.raw.home_presence.position.y!==3){await p.act('home',{intent:'move',x:3,y:3});await f.until(()=>!p.raw.home_presence.movement);}
  await p.act('home',{intent:'place',instance_id:tank,x:1,y:1,rotation});
  await expect(furniture).toHaveAttribute('data-rotation',String(rotation));await expect(art).toHaveAttribute('data-fish-count','1');
  await page.getByTestId('home-room').screenshot({path:`artifacts/v035-tank-${rotation}.png`});
 }
 await approach(p,tank);
 for(const [width,height]of [[1440,1000],[390,844]]){await page.setViewportSize({width,height});await accessible(page);await page.screenshot({path:`artifacts/v035-aquarium-${width}.png`});}
 const guest=await f.actor('来看看鱼的朋友');await p.act('home',{intent:'invite',target_agent_id:guest.id});
 const invitation=Object.values(f.app.world.state.home_invitations).find(i=>i.target_agent_id===guest.id);
 await guest.act('home',{intent:'respond',invitation_id:invitation.invitation_id,accept:true});await guest.act('home',{intent:'visit',home_id:home});await f.until(()=>guest.raw.home_presence?.home_id===home);
 await expect(page.getByTestId(`home-actor-${guest.id}`)).toBeVisible();await approach(guest,tank);
 const inspection=await guest.act('aquarium',{intent:'inspect',instance_id:tank});expect(inspection.aquarium.aquarium.fish[0].name).toBe('雨点');
 const source=f.app.world.state.homes[home].furniture.find(f=>f.instance_id===tank),contents=structuredClone(source.aquarium);
 await p.act('home',{intent:'store',instance_id:tank});await expect(art).toHaveCount(0);expect(source.aquarium).toEqual(contents);
 const publicWorld=await(await fetch(f.base+'/api/public/world')).json();expect(JSON.stringify(publicWorld)).not.toContain('雨点');
 await p.act('home',{intent:'place',instance_id:tank,x:1,y:1,rotation:270});await expect(art).toHaveAttribute('data-fish-count','1');
 await approach(p,tank);
 const beforeOre=p.raw.life.inventory.ore;await p.act('aquarium',{intent:'clear_decoration',instance_id:tank,slot:1});expect(p.raw.life.inventory.ore).toBe(beforeOre+1);
 await p.act('aquarium',{intent:'remove',instance_id:tank,fish_id:put.fish.fish_id});expect(p.raw.life.inventory[caught]).toBe(stock);await expect(art).toHaveAttribute('data-fish-count','0');
 expect(events).toEqual({writes:[],errors:[]});await expect(page.locator('body')).not.toContainText(p.goal);
});

test('v035 actual tank contents freeze on reduced motion hidden tabs and lost stream; wardrobe also works in DOM fallback',async({page})=>{
 test.setTimeout(90000);const p=await f.actor('安静看鱼的旅人');await camp(p);await outfit(p);
 await p.act('home',{intent:'build',name:'安静的小屋'});const home=`home_${p.id}`;await p.act('home',{intent:'visit',home_id:home});await f.until(()=>p.raw.home_presence?.home_id===home);
 await p.act('home',{intent:'craft',kind:'aquarium'});const tank=f.app.world.state.homes[home].furniture.at(-1).instance_id;
 await p.act('home',{intent:'place',instance_id:tank,x:1,y:1,rotation:0});await approach(p,tank);
 await p.act('aquarium',{intent:'put',instance_id:tank,item_id:'silver_fish',name:'银点'});
 const saved=JSON.stringify({wardrobe:p.raw.wardrobe,home:f.app.world.state.homes[home],position:p.raw.home_presence.position}),events=audit(page);
 await page.goto(`${f.base}/watch?view=home&home=${home}`);const art=page.getByTestId(`aquarium-art-${tank}`);await expect(art).toHaveAttribute('data-playing','true');
 await page.emulateMedia({reducedMotion:'reduce'});await expect(art).toHaveAttribute('data-playing','false');await accessible(page);
 await page.emulateMedia({reducedMotion:'no-preference'});await expect(art).toHaveAttribute('data-playing','true');
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});await expect(art).toHaveAttribute('data-playing','false');
 await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});await expect(art).toHaveAttribute('data-playing','true');
 await page.route('**/api/public/events*',r=>r.abort());await page.reload();await expect(page.locator('.spectator-stale')).toBeVisible();await expect(art).toHaveAttribute('data-playing','false');await expect(art).toHaveAttribute('data-fish-count','1');
 expect(JSON.stringify({wardrobe:p.raw.wardrobe,home:f.app.world.state.homes[home],position:p.raw.home_presence.position})).toBe(saved);
 await page.unroute('**/api/public/events*');await p.act('home',{intent:'leave'});await page.route('**/assets/phaser-renderer-*.js',r=>r.abort());
 await page.goto(f.base+'/watch?view=plaza');await expect(page.getByTestId('phaser-world')).toHaveAttribute('data-renderer-state','fallback');await dressed(page.getByTestId(`map-agent-${p.id}`).locator('.pixel-character'),p);
 await expect(page.locator('[data-asset-missing]')).toHaveCount(0);expect(events.writes).toEqual([]);expect(events.errors.filter(e=>!e.includes('Failed to fetch dynamically imported module'))).toEqual([]);
});
