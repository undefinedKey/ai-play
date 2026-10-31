import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../../server/index.js';

let application, server, base, clock, clients;
test.beforeEach(async()=>{
  application=await createApp({dbPath:':memory:',authDbPath:':memory:',authMode:'local',production:true});
  clock=Date.now(); clients=[]; application.world.now=()=>clock;application.world.actionIntervalMs=0;
  ({server,url:base}=await application.start(0));
});
test.afterEach(async()=>{for(const client of clients)await client.close();await application.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
async function owner(request) {
  const session=await (await request.get(base+'/api/session')).json();
  return async(path,data)=>{const response=await request.post(base+path,{headers:{Origin:base,'X-CSRF-Token':session.csrf_token||''},data});expect(response.ok(),await response.text()).toBe(true);return response.json();};
}
async function actor(api,name) {
  const {agent}=await api('/api/agents',{name});
  const controller=await api(`/api/agents/${agent.agent_id}/controllers`,{kind:'external',name:'像素状态测试接入端'});
  await api(`/api/agents/${agent.agent_id}/control`,{operation:'start',controller_id:controller.controller_id,duration_minutes:15,max_calls:1000,goal:'PRIVATE_PIXEL_GOAL'});
  const client=new Client({name:'pixel-browser-test',version:'1'},{capabilities:{}});clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${controller.token}`}}}));
  const call=async(name,args={})=>{const response=await client.callTool({name,arguments:args});expect(response.isError,JSON.stringify(response.content)).not.toBe(true);return response.structuredContent||JSON.parse(response.content.find(item=>item.type==='text').text);};
  const joined=await call('join_world');let actionId=joined.next_action_id;const session={run_id:joined.run_id,session_epoch:joined.session_epoch};
  return {agent,observe:()=>call('observe',session),act:async(type,payload={})=>{const result=await call('act',{...session,action_id:(await call('observe',session)).next_action_id,type,payload});expect(result.status,JSON.stringify(result)).toBe('applied');actionId=result.next_action_id;return result;}};
}
function tick(ms=2000){clock+=ms;application.world.tick();}
function arrive(a){const raw=application.world.agent(a.agent.agent_id),movement=raw.movement;if(!movement)return;clock=Math.max(clock,movement.ends_at);application.world.tick();expect(raw.position).toEqual(movement.path.at(-1));}
async function audit(page,prefix) {
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:900});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
    expect(result.violations.map(item=>({id:item.id,nodes:item.nodes.map(node=>node.target)}))).toEqual([]);
    await page.screenshot({path:`artifacts/${prefix}-${width}.png`,fullPage:true});
    await page.locator('[data-testid=adventure-map],[data-testid=plaza-map]').screenshot({path:`artifacts/${prefix}-map-${width}.png`});
  }
}

test('空场展示已生成的像素世界，手机与桌面都没有虚构角色',async({page,request})=>{
  await page.goto(base+'/watch?view=adventure');
  await expect(page.locator('.pixel-scene-image')).toHaveJSProperty('naturalWidth',768);
  await expect(page.getByTestId('adventure-empty-banner')).toBeVisible();
  await expect(page.locator('.adventure-agent')).toHaveCount(0);
  await expect(page.locator('.adventure-monster')).toHaveCount(3);
  await expect(page.locator('[data-asset-missing]')).toHaveCount(0);
  await audit(page,'pixel-world-empty');
  expect((await(await request.get(base+'/api/public/world')).json()).agents).toEqual([]);
});

test('真实 Pixelbolt 素材呈现固定且不同的 AI 外观，两个地图与公开档案一致',async({page,request})=>{
  const api=await owner(request),a=await actor(api,'像素旅人甲'),b=await actor(api,'像素旅人乙');
  const appearance=(await a.observe()).self.appearance, other=(await b.observe()).self.appearance;
  expect(appearance.sprite_id).not.toBe(other.sprite_id);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base+'/watch?view=plaza');
  await expect(page.locator('.pixel-scene-image')).toHaveJSProperty('naturalWidth',768);
  const unit=page.getByTestId(`map-agent-${a.agent.agent_id}`);
  await expect(unit.locator('.pixel-character')).toHaveAttribute('data-sprite-id',appearance.sprite_id);
  await expect(unit.locator('[data-asset-missing]')).toHaveCount(0);
  await unit.click();
  await expect(page.locator('.profile-cover .pixel-character')).toHaveAttribute('data-sprite-id',appearance.sprite_id);
  await expect(page.getByTestId('private-warehouse')).toHaveCount(0);
  await expect(page.getByTestId('runtime-diagnostics')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('PRIVATE_PIXEL_GOAL');
  await audit(page,'pixel-world-party');
  await page.getByRole('button',{name:'冒险地图',exact:true}).click();
  await expect(page.getByTestId(`adventure-agent-${a.agent.agent_id}`)).toHaveCount(0);
  await page.getByRole('button',{name:'社交广场',exact:true}).click();
  await expect(page.getByTestId(`map-agent-${a.agent.agent_id}`).locator('.pixel-character')).toHaveAttribute('data-sprite-id',appearance.sprite_id);
  await page.reload();
  await expect(page.getByTestId(`map-agent-${a.agent.agent_id}`).locator('.pixel-character')).toHaveAttribute('data-sprite-id',appearance.sprite_id);
  expect((await a.observe()).self.appearance).toEqual(appearance);
  expect(errors).toEqual([]);
});

test('真实移动与种田回执驱动动画，装备叠层与低体力效率可见，暂停和减少动态停帧',async({page,request})=>{
  const api=await owner(request),a=await actor(api,'像素田园旅人');
  await a.act('move',{x:11,y:8});arrive(a);
  await page.goto(base+'/watch?view=farm');
  let sprite=page.getByTestId('farm-present-agent').locator('.pixel-character');
  await expect(sprite.locator('[data-asset-missing]')).toHaveCount(0);
  await a.act('farm',{intent:'till',plot_id:'plot_1'});
  await expect(sprite).toHaveAttribute('data-action','till');
  await expect(sprite.locator('.pixel-tool')).toHaveAttribute('data-item','hoe');
  await a.act('farm',{intent:'plant',plot_id:'plot_1',crop_id:'turnip'});
  await expect(sprite).toHaveAttribute('data-action','plant');
  await expect(page.getByTestId('farm-plot_1').locator('.pixel-crop').first()).toHaveAttribute('data-pixel-action','seeded');
  await a.act('farm',{intent:'water',plot_id:'plot_1'});
  await expect(sprite).toHaveAttribute('data-action','water');
  await expect(sprite.locator('.pixel-sprite').first()).toHaveAttribute('data-playing','true');
  const firstFrame=await sprite.locator('.pixel-sprite').first().evaluate(element=>getComputedStyle(element).backgroundPosition);
  await expect.poll(()=>sprite.locator('.pixel-sprite').first().evaluate(element=>getComputedStyle(element).backgroundPosition),{timeout:1500,intervals:[50]}).not.toBe(firstFrame);
  await page.emulateMedia({reducedMotion:'reduce'});
  await expect(sprite.locator('.pixel-sprite').first()).toHaveAttribute('data-playing','false');
  await page.emulateMedia({reducedMotion:'no-preference'});
  // Exercise the browser visibility notification without changing world state.
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});
  await expect(sprite.locator('.pixel-sprite').first()).toHaveAttribute('data-playing','false');
  await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
  await a.act('inventory',{intent:'craft',item_id:'wooden_sword'});
  await a.act('inventory',{intent:'equip',item_id:'wooden_sword'});
  tick();
  await expect(sprite.locator('.pixel-weapon')).toHaveAttribute('data-item','wooden_sword');
  await expect(sprite.locator('.pixel-weapon')).not.toHaveAttribute('data-asset-missing','true');
  await expect(page.getByTestId('equipment-status')).toContainText('实际攻击 8');
  await page.getByRole('button',{name:'社交广场',exact:true}).click();
  sprite=page.getByTestId(`map-agent-${a.agent.agent_id}`).locator('.pixel-character');
  await expect(page.getByTestId('farm-view')).toHaveCount(0);
  // A live walk needs fresh authoritative samples. Holding the fake server
  // clock while the browser keeps running correctly freezes prediction after
  // 250ms; advance the real world tick while observing this movement instead.
  const walkingTicks=setInterval(()=>tick(100),100);
  try {
    await expect(page.locator('.connection-state')).toContainText('正在实时观察');
    await a.act('move',{x:8,y:8});
    await expect(sprite).toHaveAttribute('data-action','walk');
    await expect(sprite.locator('.pixel-sprite').first()).toHaveAttribute('data-playing','true');
  } finally {clearInterval(walkingTicks);}
  arrive(a);
  // Spend actual movement energy through MCP; no mocked fatigue or game state.
  while(application.world.agent(a.agent.agent_id).fatigue.energy>23){const current=application.world.agent(a.agent.agent_id).position;await a.act('move',{x:current.x===8?11:8,y:8});arrive(a);}
  await a.act('move',{x:11,y:8});arrive(a);tick();
  await expect(sprite).toHaveAttribute('data-action','tired');
  await expect(page.getByTestId('fatigue-status')).toContainText('攻击效率 75%');
  await expect(page.getByTestId('fatigue-status')).toContainText('由原 AI 决定');
  await expect(page.getByTestId('equipment-status')).toContainText('实际攻击 6');
  await a.act('adventure_plan',{intent:'rest'});
  await expect(sprite).toHaveAttribute('data-action','rest');
  await audit(page,'pixel-world-rest');
  await api(`/api/agents/${a.agent.agent_id}/control`,{operation:'pause'});
  await expect(sprite).toHaveAttribute('data-action','idle');
  await expect(sprite.locator('.pixel-sprite').first()).toHaveAttribute('data-playing','false');
});

test('怪物真实攻击显示受伤，原 AI 应战后才播放攻击动画',async({page,request})=>{
  const api=await owner(request),a=await actor(api,'像素战斗旅人');
  await page.goto(base+'/watch?view=adventure');
  const sprite=page.getByTestId(`adventure-agent-${a.agent.agent_id}`).locator('.pixel-character');
  await a.act('adventure_plan',{intent:'explore',zone_id:'forest'});
  let combat;
  for(let i=0;i<65&&!combat;i++){
    tick(1001);await a.observe();
    combat=[...application.world.state.events].reverse().find(event=>event.type==='adventure_combat'&&event.payload.agent_id===a.agent.agent_id&&event.payload.attacker==='monster');
  }
  expect(combat).toBeTruthy();
  await expect(sprite).toHaveAttribute('data-action','hurt');
  await expect(page.getByTestId(`monster-${combat.payload.monster_id}`).locator('.pixel-sprite')).toHaveAttribute('data-pixel-action','attack');
  await a.act('adventure_plan',{intent:'hunt',monster_id:combat.payload.monster_id});
  let attack;
  for(let i=0;i<12&&!attack;i++){
    tick(1001);
    attack=[...application.world.state.events].reverse().find(event=>event.type==='adventure_combat'&&event.payload.agent_id===a.agent.agent_id&&event.payload.attacker==='agent');
  }
  expect(attack).toBeTruthy();
  await expect(sprite).toHaveAttribute('data-action','attack');
  await expect(sprite.locator('.pixel-sprite').first()).toHaveAttribute('data-playing','true');
});

test('连续三个真实攻击周期中，准备、实际命中受击和恢复均由服务端阶段驱动画布',async({page,request})=>{
  const api=await owner(request),a=await actor(api,'连续战斗旅人');
  await page.goto(base+'/watch?view=adventure');
  await expect(page.getByTestId('phaser-world')).toHaveAttribute('data-renderer-state','ready');
  await page.clock.install({time:new Date(clock-1000)});await page.clock.pauseAt(new Date(clock));
  const raw=application.world.agent(a.agent.agent_id),target=application.world.state.adventure.monsters.find(m=>m.monster_id==='forest_boar');
  const sprite=page.getByTestId(`adventure-agent-${a.agent.agent_id}`).locator('.pixel-character');
  const monster=page.getByTestId('monster-forest_boar').locator('.pixel-sprite');
  const seen=new Set();
  async function until(predicate){
    for(let i=0;i<900&&!predicate();i++){tick(100);await a.observe();await page.clock.runFor(100);}
    expect(predicate()).toBe(true);
    // Let the real 200ms transport deliver this held authoritative phase; then
    // draw one presentation frame without inventing another simulation step.
    await new Promise(resolve=>setTimeout(resolve,230));await page.clock.runFor(16);
  }
  await a.act('adventure_plan',{intent:'hunt',monster_id:'forest_boar'});
  for(let cycle=0;cycle<3;cycle++){
    await until(()=>raw.action?.outcome===null&&!seen.has(raw.action.action_id)&&clock<raw.action.impact_at&&(!raw.hurt||clock>=raw.hurt.ends_at));
    const actionId=raw.action.action_id;seen.add(actionId);
    await expect(sprite).toHaveAttribute('data-action','attack');
    await expect(sprite).toHaveAttribute('data-action-phase','prepare');
    const hp=target.hp;
    await until(()=>raw.action?.action_id===actionId&&raw.action.outcome==='hit');
    expect(target.hp).toBeLessThan(hp);expect(target.hurt.action_id).toBe(actionId);
    await expect(monster).toHaveAttribute('data-pixel-action','hurt');
    await until(()=>raw.hurt&&clock<raw.hurt.ends_at&&target.action?.outcome==='hit'&&clock<target.action.ends_at&&(!target.hurt||clock>=target.hurt.ends_at));
    await expect(sprite).toHaveAttribute('data-action','hurt');
    await expect(monster).toHaveAttribute('data-pixel-action','attack');
  }
  expect(seen.size).toBe(3);await page.clock.resume();
});
