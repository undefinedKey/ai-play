import {test,expect} from '@playwright/test';
import {writeFileSync,mkdirSync} from 'node:fs';
import {recordMovement} from '../../server/spatial.js';
import {createPaperDollFixture,startRigSamples,stopRigSamples,rigState} from './paper-doll-fixture.js';

test.use({video:{mode:'on',size:{width:1280,height:720}}});
test.setTimeout(90000);
let fixture;
test.afterEach(async()=>{await fixture?.close();fixture=null;});
const unitFor=(page,a,scene='plaza')=>page.getByTestId(`${scene==='adventure'?'adventure-agent':'map-agent'}-${a.id}`);
const signature=row=>JSON.stringify(row.parts);
const save=(name,value)=>{mkdirSync('artifacts/paper-doll',{recursive:true});writeFileSync(`artifacts/paper-doll/${name}.json`,JSON.stringify(value,null,2));};
async function screenshot(page,name){mkdirSync('artifacts/paper-doll',{recursive:true});await page.screenshot({path:`artifacts/paper-doll/${name}.png`});}
async function zoomActor(page,unit){
  await page.getByRole('button',{name:'查看全景',exact:true}).click();await unit.click();
  const follow=page.getByRole('button',{name:'关注角色',exact:true});if(await follow.isVisible())await follow.click();
  for(let i=0;i<7;i++){const plus=page.getByRole('button',{name:'放大地图',exact:true});if(!await plus.isEnabled())break;await plus.click();}
  await expect(page.getByTestId('world-camera')).toHaveAttribute('data-camera-zoom','4.00');
}
async function actionCloseup(page,unit,name){
  const screen=await unit.evaluate(unit=>{const map=document.querySelector('.pixel-map').getBoundingClientRect();return {x:map.x+(Number(unit.dataset.footX)+.5)/48*map.width,y:map.y+(Number(unit.dataset.footY)+.5)/32*map.height};});
  const viewport=page.viewportSize(),size=360;
  mkdirSync('artifacts/paper-doll',{recursive:true});await page.screenshot({path:`artifacts/paper-doll/${name}.png`,clip:{x:Math.max(0,Math.min(viewport.width-size,screen.x-size/2)),y:Math.max(0,Math.min(viewport.height-size,screen.y-size*.72)),width:size,height:size}});
}
async function clean(page,audit){expect(audit.errors).toEqual([]);expect(audit.writes).toEqual([]);await expect(page.locator('body')).not.toContainText('PRIVATE_PAPER_DOLL_TEST_GOAL');}

test('专属骨骼在真实四向走跑中分肢运动并携带装备，同形象的其他AI仍用旧动画',async({page})=>{
  fixture=await createPaperDollFixture();
  const a=fixture.actor('骨骼验证旅人'),legacy=fixture.actor('同形象对照旅人',{position:{x:11,y:16}});
  a.raw.life.inventory.iron_sword=1;a.raw.life.inventory.iron_armor=1;a.raw.life.equipment={weapon:'iron_sword',armor:'iron_armor'};
  const audit=await fixture.open(page,[a.id]),unit=unitFor(page,a),rig=unit.locator('.paper-doll-rig');
  await expect(unit.locator('.pixel-character')).toHaveAttribute('data-render-rig','feiyu_v1');
  await expect(unitFor(page,legacy).locator('.paper-doll-rig')).toHaveCount(0);
  await expect(unitFor(page,legacy).locator('.pixel-character>.pixel-sprite').first()).toBeAttached();
  expect(await rig.locator('[data-rig-part]').count()).toBeGreaterThanOrEqual(15);
  await expect(rig.locator('.pixel-weapon[data-attachment-slot="hand"]')).toHaveAttribute('data-item','iron_sword');
  await expect(rig.locator('.pixel-armor[data-attachment-slot="chest"]')).toHaveAttribute('data-item','iron_armor');
  legacy.act('move',{x:14,y:16,mode:'walk'});
  await expect(unitFor(page,legacy).locator('.pixel-character')).toHaveAttribute('data-action','walk');
  await expect(unitFor(page,legacy).locator('.paper-doll-rig')).toHaveCount(0);
  const traces=[];
  for(const mode of ['walk','run'])for(const [facing,target] of [['east',{x:14,y:10}],['south',{x:14,y:13}],['west',{x:11,y:13}],['north',{x:11,y:10}]]){
    const origin={...a.raw.position};await startRigSamples(page,a.id);
    a.act('move',{...target,mode});
    await expect(rig).toHaveAttribute('data-action',mode);
    await expect(rig).toHaveAttribute('data-facing',facing);
    await page.waitForTimeout(250);await screenshot(page,`${mode}-${facing}`);
    await expect.poll(()=>a.raw.movement,{timeout:5000}).toBe(null);
    await expect(unit).toHaveAttribute('data-foot-x',String(target.x));await expect(unit).toHaveAttribute('data-foot-y',String(target.y));
    const rows=(await stopRigSamples(page)).filter(row=>row.action===mode);
    expect(rows.length).toBeGreaterThan(5);
    expect(new Set(rows.map(signature)).size,'continuous poses must exceed a handful of whole-body frames').toBeGreaterThan(5);
    const movingParts=rows[0].parts.map(part=>part.id).filter(id=>new Set(rows.map(row=>{const part=row.parts.find(p=>p.id===id);return part.transform+' '+part.translate;})).size>4);
    expect(movingParts.length,'multiple independent limbs must move').toBeGreaterThanOrEqual(6);
    expect(rows.every(row=>row.parts.every(part=>!/(?:NaN|Infinity)/.test(part.transform+' '+part.translate)))).toBe(true);
    const axis=origin.x===target.x?1:0,other=1-axis,direction=Math.sign((axis?target.y:target.x)-(axis?origin.y:origin.x));
    for(let i=0;i<rows.length;i++){
      expect(rows[i].foot[other]).toBe(other?origin.y:origin.x);
      expect(rows[i].foot[axis]).toBeGreaterThanOrEqual(Math.min(axis?origin.y:origin.x,axis?target.y:target.x)-1e-7);
      expect(rows[i].foot[axis]).toBeLessThanOrEqual(Math.max(axis?origin.y:origin.x,axis?target.y:target.x)+1e-7);
      if(i)expect((rows[i].foot[axis]-rows[i-1].foot[axis])*direction).toBeGreaterThanOrEqual(-1e-5);
      const wrist=rows[i].parts.find(part=>part.id==='hand_r'),grip=rows[i].attachments.find(layer=>layer.item==='iron_sword');
      const offset=audit.rig.attachment_offsets?.hand||{x:0,y:0},flip=facing==='west'?-1:1;
      // Bone rotation excludes the image's independent authored-axis
      // correction; grip offsets belong to the actual wrist joint.
      const rotation=wrist.rotation;
      expect(grip.x).toBeCloseTo(wrist.x+Math.cos(rotation)*offset.x*flip-Math.sin(rotation)*offset.y,5);
      expect(grip.y).toBeCloseTo(wrist.y+Math.sin(rotation)*offset.x*flip+Math.cos(rotation)*offset.y,5);
    }
    expect(a.raw.position).toEqual(target);traces.push({mode,facing,movingParts,rows});
  }
  save('four-direction-locomotion',traces);await clean(page,audit);
});

test('攻击准备不伪造命中，真实结算驱动命中、落空、受击与取消',async({page})=>{
  fixture=await createPaperDollFixture({manualClock:true});
  const a=fixture.actor('战斗骨骼验证旅人',{scene:'adventure',position:{x:19,y:7}}),world=fixture.app.world;
  a.raw.life.inventory.iron_sword=1;a.raw.life.equipment.weapon='iron_sword';
  a.raw.adventure.hp=a.raw.adventure.max_hp=1000;
  const monster=world.state.adventure.monsters.find(m=>m.monster_id==='ruins_guardian');
  monster.hp=monster.max_hp=1000;monster.position={x:20,y:7};monster.movement=null;monster.next_attack_at=fixture.now()+100000;
  const audit=await fixture.open(page,[a.id],{scene:'adventure'}),unit=unitFor(page,a,'adventure'),character=unit.locator('.pixel-character'),rig=unit.locator('.paper-doll-rig');
  await zoomActor(page,unit);
  a.act('adventure_plan',{intent:'hunt',monster_id:monster.monster_id});await fixture.advance(page,100);
  await expect(character).toHaveAttribute('data-action-phase','prepare');await expect(rig).toHaveAttribute('data-action','attack');
  const prepare=await rigState(unit),actionId=a.raw.action.action_id;
  expect(a.raw.action.outcome).toBe(null);expect(monster.hp).toBe(1000);
  await actionCloseup(page,unit,'attack-prepare');
  await fixture.advance(page,400);
  expect(a.raw.action.action_id).toBe(actionId);expect(a.raw.action.outcome).toBe('hit');expect(monster.hp).toBeLessThan(1000);
  await expect(character).toHaveAttribute('data-action-outcome','hit');
  const hit=await rigState(unit);expect(hit.parts).not.toEqual(prepare.parts);await actionCloseup(page,unit,'attack-confirmed-hit');
  a.act('adventure_plan',{intent:'stop'});monster.next_attack_at=fixture.now();
  await fixture.advance(page,100);expect(monster.action?.phase).toBe('prepare');
  const hpBefore=a.raw.adventure.hp;await fixture.advance(page,500);
  expect(a.raw.adventure.hp).toBeLessThan(hpBefore);expect(a.raw.hurt?.action_id).toBe(monster.action.action_id);
  await expect(rig).toHaveAttribute('data-action','hurt');await expect(unit.locator('.combat-number')).toHaveCount(1);
  await screenshot(page,'confirmed-monster-hurt');monster.next_attack_at=fixture.now()+100000;
  // Cancel the completed plan, then start a real new attack whose target moves
  // out of range along a valid server route during its preparation.
  a.act('adventure_plan',{intent:'stop'});await fixture.advance(page,1200);
  a.act('adventure_plan',{intent:'hunt',monster_id:monster.monster_id});await fixture.advance(page,100);
  expect(a.raw.action.outcome).toBe(null);const beforeMiss=monster.hp;
  recordMovement(monster,[{x:20,y:7},{x:21,y:7}],fixture.now(),'run');await fixture.advance(page,400);
  expect(a.raw.action.outcome).toBe('miss');expect(monster.hp).toBe(beforeMiss);
  await expect(character).toHaveAttribute('data-action-outcome','miss');await screenshot(page,'attack-confirmed-miss');
  a.act('adventure_plan',{intent:'stop'});await fixture.advance(page,1200);
  // Fixture placement establishes a new encounter; only real hunt/tick logic
  // creates the action and pause must cancel it before any damage is applied.
  monster.position={x:20,y:7};monster.movement=null;a.raw.position={x:19,y:7};a.raw.position_at=fixture.now();
  a.act('adventure_plan',{intent:'hunt',monster_id:monster.monster_id});await fixture.advance(page,100);
  const beforeCancel=monster.hp,cancelledId=a.raw.action.action_id;world.ownerControl(a.id,'pause');await fixture.publish(page);
  expect(a.raw.action.outcome).toBe('cancelled');await expect(rig).toHaveAttribute('data-action','idle');
  await fixture.advance(page,700);expect(monster.hp).toBeGreaterThanOrEqual(beforeCancel);
  expect(world.state.events.some(event=>event.type==='adventure_combat'&&event.payload.action_id===cancelledId)).toBe(false);
  await screenshot(page,'attack-cancelled');
  save('combat-outcomes',{prepare,hit,cancelled:a.raw.action});await clean(page,audit);
});

test('手采与工具采集采用不同肢体动作，取消无收益且装备随手部挂点移动',async({page})=>{
  fixture=await createPaperDollFixture();
  const hand=fixture.actor('拾枝骨骼验证旅人',{position:{x:11,y:8}}),axe=fixture.actor('挥斧骨骼验证旅人',{position:{x:11,y:8}});
  axe.raw.life.inventory.wood=10;axe.raw.life.inventory.ore=10;axe.act('inventory',{intent:'craft',item_id:'axe'});axe.raw.position={x:28,y:7};axe.raw.position_at=fixture.now();
  const audit=await fixture.open(page,[hand.id,axe.id]);
  const handUnit=unitFor(page,hand),axeUnit=unitFor(page,axe);
  await zoomActor(page,axeUnit);
  const wood=[hand.raw.life.inventory.wood||0,axe.raw.life.inventory.wood||0];
  hand.act('gather',{intent:'start',node_id:'camp_branches'});axe.act('gather',{intent:'start',node_id:'east_pine'});
  await expect(handUnit.locator('.paper-doll-rig')).toHaveAttribute('data-action','gather');await expect(axeUnit.locator('.paper-doll-rig')).toHaveAttribute('data-action','gather');
  await expect(handUnit.locator('[data-attachment-slot="hand"]')).toHaveCount(0);
  await expect(axeUnit.locator('[data-attachment-slot="hand"]')).toHaveAttribute('data-item','axe');
  await startRigSamples(page,hand.id);await page.waitForTimeout(800);const handRows=await stopRigSamples(page);
  await startRigSamples(page,axe.id);await page.waitForTimeout(800);const axeRows=await stopRigSamples(page);
  expect(new Set(handRows.map(signature)).size).toBeGreaterThan(5);expect(new Set(axeRows.map(signature)).size).toBeGreaterThan(5);
  expect(handRows[0].parts).not.toEqual(axeRows[0].parts);
  expect(new Set(axeRows.flatMap(row=>row.attachments.filter(a=>a.slot==='hand').map(a=>a.transform+' '+a.translate))).size).toBeGreaterThan(5);
  await screenshot(page,'hand-and-axe-gather');
  await actionCloseup(page,axeUnit,'axe-work-closeup');
  hand.act('gather',{intent:'cancel'});axe.act('gather',{intent:'cancel'});
  await expect(handUnit.locator('.paper-doll-rig')).not.toHaveAttribute('data-action','gather');await expect(axeUnit.locator('.paper-doll-rig')).not.toHaveAttribute('data-action','gather');
  expect([hand.raw.life.inventory.wood||0,axe.raw.life.inventory.wood||0]).toEqual(wood);
  save('gather-actions',{hand:handRows,axe:axeRows});await clean(page,audit);
});

test('暂停、断流与减少动态效果停止骨骼播放，不驱动AI或虚构世界移动',async({page,context})=>{
  await page.addInitScript(()=>{
    const NativeSource=window.EventSource,streams=[];
    window.EventSource=class extends NativeSource{constructor(...args){super(...args);streams.push(this);}};
    // Chromium offline emulation does not consistently tear down an already
    // open SSE response. Inject its actual error boundary after closing the
    // transport; incoming actor/state values are never replaced.
    window.__disconnectPaperDollStream=()=>{for(const stream of streams){stream.close();stream.dispatchEvent(new Event('error'));}};
  });
  fixture=await createPaperDollFixture();const a=fixture.actor('冻结骨骼验证旅人');
  const audit=await fixture.open(page,[a.id]),unit=unitFor(page,a),rig=unit.locator('.paper-doll-rig');
  a.act('move',{x:14,y:10,mode:'run'});await expect(rig).toHaveAttribute('data-action','run');
  fixture.app.world.ownerControl(a.id,'pause');await expect(rig).toHaveAttribute('data-playing','false');
  const pausedPosition={...a.raw.position},paused=await rigState(unit);await page.waitForTimeout(350);
  expect(await rigState(unit)).toEqual(paused);expect(a.raw.position).toEqual(pausedPosition);
  // A separate active granted resident exercises disconnect and motion
  // preference. A spectator preference never pauses its server simulation.
  const b=fixture.actor('断流骨骼验证旅人',{position:{x:11,y:13}});
  await page.unroute('**/pixel-world/manifest.json*');
  await fixture.open(page,[a.id,b.id]);
  const other=unitFor(page,b),otherRig=other.locator('.paper-doll-rig');
  await page.emulateMedia({reducedMotion:'reduce'});b.act('move',{x:14,y:13,mode:'walk'});
  await expect(otherRig).toHaveAttribute('data-playing','false');await expect(otherRig).toHaveAttribute('data-facing','east');const reduced=await rigState(other);
  await page.waitForTimeout(350);expect((await rigState(other)).parts).toEqual(reduced.parts);
  await expect.poll(()=>b.raw.movement).toBe(null);expect(b.raw.position).toEqual({x:14,y:13});
  await page.emulateMedia({reducedMotion:'no-preference'});b.act('move',{x:11,y:13,mode:'walk'});await expect(otherRig).toHaveAttribute('data-action','walk');
  await context.setOffline(true);await page.evaluate(()=>window.__disconnectPaperDollStream());
  await expect(page.locator('.spectator-stale')).toBeVisible();await expect(otherRig).toHaveAttribute('data-playing','false');
  const disconnected=await rigState(other),foot=[await other.getAttribute('data-foot-x'),await other.getAttribute('data-foot-y')];
  await page.waitForTimeout(600);expect(await rigState(other)).toEqual(disconnected);expect([await other.getAttribute('data-foot-x'),await other.getAttribute('data-foot-y')]).toEqual(foot);
  await screenshot(page,'paused-offline');await context.setOffline(false);await clean(page,audit);
});

test('原型图集缺失时保留旧角色和真实移动，不出现半身或隐形角色',async({page})=>{
  fixture=await createPaperDollFixture();const a=fixture.actor('素材失败验证旅人');
  let failures=0;
  await page.route(/\/pixel-world\/ink_feiyu[^/]*\.(?:png|webp)(?:\?|$)/,route=>{failures++;return route.abort();});
  const audit=await fixture.open(page,[a.id],{expectRig:false}),unit=unitFor(page,a);
  await expect.poll(()=>failures).toBeGreaterThan(0);await expect(unit.locator('.paper-doll-rig')).toHaveCount(0);
  await expect(unit.locator('.pixel-character>.pixel-sprite').first()).toBeAttached();
  a.act('move',{x:14,y:10,mode:'walk'});await expect(unit.locator('.pixel-character')).toHaveAttribute('data-action','walk');
  await screenshot(page,'missing-rig-fallback');await expect.poll(()=>a.raw.movement).toBe(null);
  expect(a.raw.position).toEqual({x:14,y:10});await clean(page,audit);
});

test('真实画布四向无护甲近照用于头身比例、袖裤关节和脚底视觉验收',async({page})=>{
  fixture=await createPaperDollFixture();const a=fixture.actor('肥鱼纸娃娃近照',{sprite:'wanderer_3'});
  a.raw.appearance.accessory_id=null;
  // Test-only access to actual retained Phaser objects. The added diagnostic
  // callback observes the unmodified built renderer; it does not move objects.
  await page.route('**/assets/phaser-renderer-*.js',async route=>{
    const response=await route.fetch(),source=await response.text(),pattern=/new ([\w$]+)\.Game\(\{type:/g;
    expect([...source.matchAll(pattern)]).toHaveLength(1);
    await route.fulfill({response,body:source.replace(pattern,'new $1.Game({callbacks:{postBoot:game=>{window.__paperDollPhaser=game}},type:')});
  });
  const audit=await fixture.open(page,[a.id]),unit=unitFor(page,a),rig=unit.locator('.paper-doll-rig');
  await zoomActor(page,unit);
  const captures=[];
  const closeup=async name=>{
    // Crop pixels from the actual browser canvas and its surrounding terrain;
    // no atlas compositing or synthetic contact-sheet drawing is involved.
    const measurement=await page.evaluate(id=>{
      const unit=document.querySelector(`[data-testid$="-${id}"]`),map=document.querySelector('.pixel-map').getBoundingClientRect();
      const foot={x:Number(unit.dataset.footX),y:Number(unit.dataset.footY)},screen={x:map.x+(foot.x+.5)/48*map.width,y:map.y+(foot.y+.5)/32*map.height};
      let mark=document.getElementById('paper-doll-foot-probe');
      if(!mark){mark=document.createElement('div');mark.id='paper-doll-foot-probe';mark.style.cssText='position:fixed;z-index:99999;pointer-events:none;width:18px;height:18px;background:linear-gradient(transparent 8px,#ff4050 8px,#ff4050 10px,transparent 10px),linear-gradient(90deg,transparent 8px,#ff4050 8px,#ff4050 10px,transparent 10px);transform:translate(-50%,-50%)';document.body.appendChild(mark);}
      if(window.__paperDollMarkFrame)cancelAnimationFrame(window.__paperDollMarkFrame);
      const track=()=>{const map=document.querySelector('.pixel-map').getBoundingClientRect();mark.style.left=(map.x+(Number(unit.dataset.footX)+.5)/48*map.width)+'px';mark.style.top=(map.y+(Number(unit.dataset.footY)+.5)/32*map.height)+'px';window.__paperDollMarkFrame=requestAnimationFrame(track);};track();
      const canvas=document.querySelector('[data-testid="phaser-canvas"]'),canvasBox=canvas.getBoundingClientRect();
      const game=window.__paperDollPhaser,objects=(game?.scene?.getScenes(true)||[]).flatMap(scene=>scene.children.list).filter(root=>root.type==='Container'&&root.list[0]?.getData('source')?.includes('ink_feiyu')).map(root=>{const sprite=root.list[0];return {root:{x:root.x,y:root.y,rotation:root.rotation,scaleX:root.scaleX,scaleY:root.scaleY},sprite:{x:sprite.x,y:sprite.y,scaleX:sprite.scaleX,scaleY:sprite.scaleY,originX:sprite.originX,originY:sprite.originY,displayOriginX:sprite.displayOriginX,displayOriginY:sprite.displayOriginY},frame:{x:sprite.frame.cutX,y:sprite.frame.cutY,w:sprite.frame.cutWidth,h:sprite.frame.cutHeight},source:sprite.getData('source')};});
      const fire=[...document.querySelectorAll('.fire-bed,.fire-site-mark')].map(node=>{const box=node.getBoundingClientRect();return {className:node.className,text:node.textContent,x:box.x,y:box.y,width:box.width,height:box.height};});
      return {foot,screen,zoom:document.querySelector('[data-testid="world-camera"]').dataset.cameraZoom,map:{x:map.x,y:map.y,width:map.width,height:map.height},canvas:{x:canvasBox.x,y:canvasBox.y,width:canvasBox.width,height:canvasBox.height,logicalWidth:canvas.width,logicalHeight:canvas.height,resolution:canvas.dataset.renderResolution},objects,fire};
    },a.id);
    const viewport=page.viewportSize(),size=360;
    const clip={x:Math.max(0,Math.min(viewport.width-size,measurement.screen.x-size/2)),y:Math.max(0,Math.min(viewport.height-size,measurement.screen.y-size*.72)),width:size,height:size};
    expect(measurement.objects.length,'read the actual Phaser parts, not only DOM metadata').toBeGreaterThanOrEqual(15);
    mkdirSync('artifacts/paper-doll',{recursive:true});await page.screenshot({path:`artifacts/paper-doll/closeup-${name}.png`,clip});
    if(name.startsWith('idle')){
      const rule=await page.evaluate(()=>{const sheet=[...document.styleSheets].find(sheet=>sheet.href?.includes('/assets/'));return {href:sheet.href,index:sheet.insertRule('[data-render-rig="feiyu_v1"]::after{display:none!important}',sheet.cssRules.length)};});
      await page.screenshot({path:`artifacts/paper-doll/closeup-${name}-selection-hidden.png`,clip});
      await page.evaluate(({href,index})=>[...document.styleSheets].find(sheet=>sheet.href===href).deleteRule(index),rule);
    }
    captures.push({name,...measurement,clip});
  };
  for(const mode of ['walk','run'])for(const[facing,target]of [['east',{x:14,y:10}],['south',{x:14,y:13}],['west',{x:11,y:13}],['north',{x:11,y:10}]]){
    a.act('move',{...target,mode});await expect(rig).toHaveAttribute('data-action',mode);await expect(rig).toHaveAttribute('data-facing',facing);
    await page.waitForTimeout(220);await closeup(`${mode}-${facing}`);
    await expect.poll(()=>a.raw.movement).toBe(null);await expect(rig).toHaveAttribute('data-action','idle');
    if(mode==='walk')await closeup(`idle-${facing}`);
  }
  save('closeup-foot-measurements',captures);await clean(page,audit);
});
