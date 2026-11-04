import {test,expect} from '@playwright/test';
import {createApp} from '../../server/index.js';

let app,server,base;
test.beforeEach(async()=>{
  app=await createApp({dbPath:':memory:',authDbPath:':memory:',authMode:'local',production:true});
  app.world.actionIntervalMs=0;
  ({server,url:base}=await app.start(0));
});
test.afterEach(async()=>{await app.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});

// These are isolated authorized clients. The spectator browser never issues an
// action, and no fixture or animation is written to the production world.
function actor(name,spriteId){
  const world=app.world,agent=world.createAgent({name}),controller=world.createController(agent.agent_id);
  world.ownerControl(agent.agent_id,'start',{controller_id:controller.controller_id,duration_minutes:15,max_calls:100});
  const auth=world.authenticate(controller.token),joined=world.callTool(auth,'join_world');
  const session={run_id:joined.run_id,session_epoch:joined.session_epoch},raw=world.agent(agent.agent_id);
  raw.appearance.sprite_id=spriteId;
  return {agent,raw,act(type,payload={}){
    const seen=world.callTool(auth,'observe',session);
    const result=world.callTool(auth,'act',{...session,action_id:seen.next_action_id,type,payload});
    expect(result.status,JSON.stringify(result)).toBe('applied');return result;
  }};
}
async function open(page){
  const errors=[],writes=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(request.url().startsWith(base)&&!['GET','HEAD'].includes(request.method()))writes.push(request.method());});
  await page.goto(base+'/watch?view=plaza');
  await expect(page.getByTestId('phaser-world')).toHaveAttribute('data-renderer-state','ready',{timeout:20000});
  return {errors,writes};
}
async function startSamples(page,ids){
  await page.evaluate(ids=>{
    const state=window.motionPolish={rows:[]};
    const frame=()=>{
      for(const id of ids){
        const unit=document.querySelector(`[data-testid="map-agent-${id}"]`),actor=unit?.querySelector('.pixel-character'),body=actor?.querySelector(':scope>.pixel-sprite');
        if(body)state.rows.push({id,at:performance.now(),action:actor.dataset.action,animation:body.dataset.animationAction,
          source:body.style.backgroundImage+' '+body.style.backgroundPosition,
          pose:body.style.transform+' '+body.style.translate,
          style:body.dataset.artStyle,frame:body.style.backgroundPosition,
          gearFrame:actor.querySelector('.pixel-tool,.pixel-weapon')?.style.backgroundPosition??null,
          foot:[Number(unit.dataset.footX),Number(unit.dataset.footY)],tool:actor.querySelector('.pixel-tool')?.dataset.item??null});
      }
      state.timer=requestAnimationFrame(frame);
    };state.timer=requestAnimationFrame(frame);
  },ids);
}
async function stopSamples(page){return page.evaluate(()=>{cancelAnimationFrame(window.motionPolish.timer);return window.motionPolish.rows;});}

test('真实Q像素走路连续推进足点并同步身体装备关键帧，世界足点仍限于获准路径',async({page})=>{
  const epoch=Date.now();let simulationTime=epoch;app.world.now=()=>simulationTime;
  const a=actor('连续步态验证旅人','wanderer_7');
  a.raw.position={x:9,y:10};a.raw.position_at=simulationTime;
  a.raw.life.inventory.iron_sword=1;a.raw.life.equipment.weapon='iron_sword';app.world.commit();
  const audit=await open(page),unit=page.getByTestId(`map-agent-${a.agent.agent_id}`);
  // Drive the real authorized movement one simulation tick at a time. Virtual
  // browser time makes source-key coverage deterministic under a busy GPU;
  // real-time scheduling/submission rates are measured separately.
  await page.clock.install({time:new Date(epoch-1000)});await page.clock.pauseAt(new Date(epoch));
  await startSamples(page,[a.agent.agent_id]);
  a.act('move',{x:12,y:10,mode:'walk'});
  await page.clock.runFor(16);
  await expect(unit.locator('.pixel-character')).toHaveAttribute('data-action','walk');
  for(let step=1;step<=15;step++){
    simulationTime=epoch+step*100;app.world.tick();await page.clock.runFor(100);
  }
  expect(a.raw.movement).toBe(null);
  await expect(unit).toHaveAttribute('data-foot-x','12');
  const rows=(await stopSamples(page)).filter(row=>row.action==='walk');
  const sourceCount=new Set(rows.map(row=>row.source)).size;
  expect(sourceCount).toBeGreaterThanOrEqual(4);
  expect(rows.every(row=>row.style==='q-pixel'&&row.source.includes('q_wanderer_7.png'))).toBe(true);
  // Q limb/bob motion is authored into its four crisp keys. Continuity belongs
  // to the actual path foot; a CSS torso wobble must not invent extra movement.
  expect(new Set(rows.map(row=>row.pose)).size).toBe(1);
  expect(rows.every(row=>row.gearFrame===row.frame)).toBe(true);
  expect(new Set(rows.map(row=>row.foot.join(','))).size).toBeGreaterThan(sourceCount);
  for(let i=1;i<rows.length;i++){
    expect(rows[i].foot[0]).toBeGreaterThanOrEqual(rows[i-1].foot[0]-.00001);
    expect(rows[i].foot[0]-rows[i-1].foot[0]).toBeLessThanOrEqual(.3);
  }
  expect(rows.every(row=>row.foot[0]>=9&&row.foot[0]<=12&&row.foot[1]===10)).toBe(true);
  expect(a.raw.position).toEqual({x:12,y:10});
  await expect(unit.locator('.pixel-weapon')).toHaveAttribute('data-item','iron_sword');
  await page.clock.resume();
  expect(audit.errors).toEqual([]);expect(audit.writes).toEqual([]);
});

test('v023徒手反复俯身拾取与站立挥斧有不同动作，取消不产生采集收益',async({page})=>{
  const hand=actor('拾枝验证旅人','wanderer_7'),axe=actor('伐木验证旅人','wanderer_8');
  // Fixture materials and starting locations only; crafting, gathering and
  // cancellation below use the same checked world actions as external AI.
  axe.raw.position={x:11,y:8};axe.raw.life.inventory.wood=10;axe.raw.life.inventory.ore=10;
  axe.act('inventory',{intent:'craft',item_id:'axe'});
  hand.raw.position={x:11,y:8};axe.raw.position={x:28,y:7};
  hand.raw.position_at=axe.raw.position_at=Date.now();app.world.commit();
  const audit=await open(page),handUnit=page.getByTestId(`map-agent-${hand.agent.agent_id}`),axeUnit=page.getByTestId(`map-agent-${axe.agent.agent_id}`);
  const initial={handWood:hand.raw.life.inventory.wood??0,axeWood:axe.raw.life.inventory.wood??0,
    branches:app.world.state.resources.nodes.camp_branches.stock,pine:app.world.state.resources.nodes.east_pine.stock};
  await startSamples(page,[hand.agent.agent_id,axe.agent.agent_id]);
  hand.act('gather',{intent:'start',node_id:'camp_branches'});axe.act('gather',{intent:'start',node_id:'east_pine'});
  await expect(handUnit.locator('.pixel-character')).toHaveAttribute('data-action','gather');
  await expect(handUnit.locator('.pixel-character>.pixel-sprite').first()).toHaveAttribute('data-animation-action','plant');
  await expect(axeUnit.locator('.pixel-character>.pixel-sprite').first()).toHaveAttribute('data-animation-action','gather');
  await expect(axeUnit.locator('.pixel-tool')).toHaveAttribute('data-item','axe');
  // More than two whole hand cycles expose a one-shot source accidentally
  // clamping forever to its final frame after the first pick-up.
  await page.waitForTimeout(2100);
  const rows=await stopSamples(page),handRows=rows.filter(row=>row.id===hand.agent.agent_id&&row.action==='gather');
  const late=handRows.filter(row=>row.at>handRows[0].at+1050),axeRows=rows.filter(row=>row.id===axe.agent.agent_id&&row.action==='gather');
  expect(new Set(late.map(row=>row.source)).size).toBeGreaterThan(1);
  expect(handRows.every(row=>row.tool===null&&row.animation==='plant')).toBe(true);
  expect(axeRows.every(row=>row.tool==='axe'&&row.animation==='gather')).toBe(true);
  expect(new Set(axeRows.map(row=>row.source)).size).toBeGreaterThanOrEqual(3);
  expect(new Set(axeRows.map(row=>row.pose)).size).toBe(1);
  expect(axeRows.every(row=>row.style==='q-pixel'&&row.gearFrame===row.frame&&row.foot[0]===28&&row.foot[1]===7)).toBe(true);
  expect(handRows.every(row=>row.style==='q-pixel'&&row.foot[0]===11&&row.foot[1]===8)).toBe(true);
  expect(hand.raw.life.inventory.wood??0).toBe(initial.handWood);expect(axe.raw.life.inventory.wood??0).toBe(initial.axeWood);
  hand.act('gather',{intent:'cancel'});axe.act('gather',{intent:'cancel'});
  await expect(handUnit.locator('.pixel-character')).not.toHaveAttribute('data-action','gather');
  await expect(axeUnit.locator('.pixel-character')).not.toHaveAttribute('data-action','gather');
  expect(hand.raw.life.gathering).toBe(null);expect(axe.raw.life.gathering).toBe(null);
  expect(hand.raw.life.inventory.wood??0).toBe(initial.handWood);expect(axe.raw.life.inventory.wood??0).toBe(initial.axeWood);
  expect(app.world.state.resources.nodes.camp_branches.stock).toBe(initial.branches);expect(app.world.state.resources.nodes.east_pine.stock).toBe(initial.pine);
  expect(audit.errors).toEqual([]);expect(audit.writes).toEqual([]);
});
