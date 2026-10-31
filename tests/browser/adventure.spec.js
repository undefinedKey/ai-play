import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../../server/index.js';

// Real HTTP, MCP, SSE and world simulation. The clock is advanced explicitly;
// these clients exercise decisions without pretending to be an actual LLM.
let application, server, base, clock, clients, actors, heartbeatAt;
test.beforeEach(async () => {
  application = await createApp({ dbPath: ':memory:', authDbPath: ':memory:', authMode: 'local', production: true });
  clock = Date.now(); heartbeatAt = clock; clients = []; actors = [];
  application.world.now = () => clock;
  application.world.actionIntervalMs = 0;
  ({ server, url: base } = await application.start(0));
});
test.afterEach(async () => {
  for (const client of clients) await client.close();
  await application.close(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});
async function owner(request) {
  const response = await request.get(base + '/api/session');
  const session = await response.json();
  return async (path, data) => {
    const result = await request.post(base + path, { headers: { Origin: base, 'X-CSRF-Token': session.csrf_token || '' }, data });
    expect(result.ok(), await result.text()).toBe(true);
    return result.json();
  };
}
async function actor(api, name) {
  const { agent } = await api('/api/agents', { name, bio: '测试接入端保留自己的性格，由明确的 MCP 指令选择旅程。' });
  const controller = await api(`/api/agents/${agent.agent_id}/controllers`, { kind: 'external', name: '冒险浏览器测试' });
  await api(`/api/agents/${agent.agent_id}/control`, { operation: 'start', controller_id: controller.controller_id, duration_minutes: 15, max_calls: 1000, goal: 'PRIVATE_ADVENTURE_GOAL' });
  const client = new Client({ name: 'adventure-browser-test', version: '1' }, { capabilities: {} }); clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${controller.token}` } } }));
  const call = async (name, args={}) => {
    const response = await client.callTool({ name, arguments: args });
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    return response.structuredContent || JSON.parse(response.content.find(item=>item.type==='text').text);
  };
  const joined = await call('join_world'); let actionId = joined.next_action_id;
  const session = { run_id: joined.run_id, session_epoch: joined.session_epoch };
  const person = { agent, token: controller.token, observe:()=>call('observe',session), act:async(type,payload={})=> {
    actionId = (await call('observe',session)).next_action_id;
    const result = await call('act',{...session,action_id:actionId,type,payload});
    expect(result.status,JSON.stringify(result)).toBe('applied');actionId=result.next_action_id;return result;
  } }; actors.push(person); return person;
}
async function advance(ms) {
  for(let elapsed=0;elapsed<ms;) {
    const dt=Math.min(100,ms-elapsed);elapsed+=dt;clock+=dt;application.world.tick();
    if(clock-heartbeatAt>=1000) {
      for(const p of actors)if(application.world.agent(p.agent.agent_id).status==='active')await p.observe();
      heartbeatAt=clock;
    }
  }
}
async function step(count=1) { await advance(count*1000); }
async function until(predicate, limit=80) { for(let i=0;i<limit&&!predicate();i++)await step(); expect(predicate()).toBe(true); }
async function declinePending(person) { const e=application.world.agent(person.agent.agent_id).adventure.encounter; if(e?.status==='pending')await person.act('adventure_event',{event_id:e.event_id,choice_id:'decline'}); }

test('冒险地图是真实空场，三视图与移动端可读，无浏览者操作角色入口', async ({page,request}) => {
  const initial = await (await request.get(base+'/api/public/world')).json();
  expect(initial.agents).toEqual([]); expect(initial.adventure.monsters).toHaveLength(3);
  await page.goto(base+'/watch?view=adventure');
  await expect(page.getByTestId('adventure-empty-banner')).toContainText('0 位 AI · 林地等待冒险者');
  await expect(page.getByRole('img',{name:'场景入口，通往生活广场，仅由 AI 旅行计划通过'})).toBeVisible();
  await expect(page.locator('.adventure-agent')).toHaveCount(0);
  await expect(page.locator('.adventure-monster')).toHaveCount(3);
  await expect(page.locator('.scene-caption')).toContainText('林地冒险');
  for(const width of [1440,390]) {
    await page.setViewportSize({width,height:900});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const audit = await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
    expect(audit.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))).toEqual([]);
    await page.screenshot({path:`artifacts/adventure-empty-${width}.png`,fullPage:true});
  }
  await page.getByRole('button',{name:'社交广场',exact:true}).click();
  await expect(page.getByTestId('plaza-map')).toBeVisible();
  await page.getByRole('button',{name:'农作区',exact:true}).click();
  await expect(page.getByTestId('farm-view')).toContainText('田园等着第一位朋友');
  await expect(page.getByTestId('adventure-map')).toHaveCount(0);
  await page.getByRole('button',{name:/冒险地图/}).click();
  await expect(page.getByTestId('adventure-map')).toBeVisible();
  expect((await (await request.get(base+'/api/public/world')).json()).agents).toEqual([]);
});

test('两个真实 MCP 接入端选择组队讨伐，无观众时前进，旁观实时看到战斗与各自收获', async ({page,request}) => {
  const api=await owner(request), a=await actor(api,'测试旅人甲'), b=await actor(api,'测试旅人乙');
  const {group_id}=await a.act('create_group');
  const {invite_id}=await a.act('invite',{group_id,target_agent_id:b.agent.agent_id});
  await b.act('respond_invite',{invite_id,accept:true});
  const first=(await a.observe()).self.position;
  for(const actor of [a,b])await actor.act('adventure_plan',{intent:'hunt',monster_id:'forest_boar'});
  await step(3);
  expect((await a.observe()).self.position).not.toEqual(first);
  await until(()=>[a,b].every(person=>application.world.agent(person.agent.agent_id).scene_id==='adventure'));
  const requests=[];page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/'))requests.push(r);});
  await page.goto(base+'/watch?view=adventure');
  await page.getByTestId(`adventure-agent-${a.agent.agent_id}`).click();
  await expect(page.getByTestId('adventure-profile')).toContainText('讨伐 · 苔光森林');
  await expect(page.getByTestId('adventure-profile')).toContainText('2 位同行者');
  for(let i=0;i<60&&application.world.agent(a.agent.agent_id).adventure.plan;i++){await step();await page.waitForTimeout(80);}
  await expect(page.getByTestId('monster-forest_boar')).toHaveClass(/defeated/);
  await expect(page.getByTestId('adventure-profile')).toContainText('击败荆棘野猪');
  const result=(await a.observe()).self.adventure;
  expect(result.gold).toBeGreaterThan(0);expect(result.xp).toBeGreaterThan(0);
  const teammate=(await b.observe()).self.adventure;
  const party=[{id:a.agent.agent_id,fighter:result},{id:b.agent.agent_id,fighter:teammate}];
  const injured=party.filter(member=>member.fighter.hp<member.fighter.max_hp);
  expect(injured.length).toBeGreaterThan(0);
  for(const member of injured) {
    const hits=application.world.state.events.filter(event=>event.type==='adventure_combat'&&event.payload.attacker==='monster'&&event.payload.agent_id===member.id);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every(event=>event.payload.damage>0)).toBe(true);
    expect(hits.at(-1).payload.hp).toBe(member.fighter.hp);
  }
  await expect(page.getByLabel('角色生命')).toHaveAttribute('value',String(result.hp));
  await page.getByRole('button',{name:'冒险',exact:true}).click();
  await expect(page.getByRole('log')).toContainText('获得');
  await expect(page.getByRole('log')).toContainText('造成');
  await expect(page.locator('body')).not.toContainText(a.token);
  await expect(page.locator('body')).not.toContainText('PRIVATE_ADVENTURE_GOAL');
  expect(requests.every(r=>r.method()==='GET'&&['/api/public/world','/api/public/events','/api/public/history'].includes(new URL(r.url()).pathname))).toBe(true);
  expect(requests.some(r=>r.url().includes('/api/public/events?delta=2'))).toBe(true);
  await step(5);expect((await a.observe()).self.adventure.gold).toBe(result.gold);
  for(const width of [1440,390]) {
    await page.setViewportSize({width,height:900});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const audit=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
    expect(audit.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))).toEqual([]);
    await page.screenshot({path:`artifacts/adventure-party-${width}.png`,fullPage:true});
  }
});

test('原 AI 的探索计划抵达即结束，主人暂停后停止执行且旁观档案同步', async ({page,request}) => {
  const api=await owner(request), a=await actor(api,'测试探索者');
  await a.act('adventure_plan',{intent:'explore',zone_id:'camp'});
  await page.goto(base+'/watch?view=plaza');
  await expect(page.getByTestId('adventure-profile')).toContainText('探索 · 星火营地');
  await step(16);
  await expect(page.getByTestId('adventure-profile')).toContainText('已抵达星火营地');
  expect((await a.observe()).self.adventure.plan).toBeNull();
  await a.act('adventure_plan',{intent:'rest'}); await step(2);
  await api(`/api/agents/${a.agent.agent_id}/control`,{operation:'pause'});
  const position={...application.world.agent(a.agent.agent_id).position};await step(3);
  expect(application.world.agent(a.agent.agent_id).position).toEqual(position);
  await expect(page.getByTestId('adventure-profile')).toContainText('活动已暂停');
  await expect(page.getByTestId(`map-agent-${a.agent.agent_id}`)).toHaveClass(/paused/);
});

test('断线 HTTP 轮询先于排队的同版本 SSE 增量到达时，旁观日志不重复且继续更新位置', async ({page,request}) => {
  const api=await owner(request), a=await actor(api,'测试增量旅人');
  // Delay real SSE callbacks at the transport boundary. A transient error is
  // delivered before HTTP polling; healthy streams intentionally no longer poll.
  await page.addInitScript(()=>{
    const NativeEventSource=window.EventSource;
    window.__queuedDeltas=[];window.__holdDeltas=true;
    window.EventSource=class extends NativeEventSource {
      constructor(...args){super(...args);window.__testSource=this;}
      addEventListener(type,listener,options) {
        if(type==='delta')return super.addEventListener(type,event=>{
          if(window.__holdDeltas)window.__queuedDeltas.push(()=>listener.call(this,event));
          else listener.call(this,event);
        },options);
        return super.addEventListener(type,listener,options);
      }
    };
  });
  await page.goto(base+'/watch?view=plaza');
  await expect(page.getByText('正在实时观察',{exact:true})).toBeVisible();
  await expect(page.getByTestId('adventure-profile')).toContainText('目前没有冒险计划');
  await a.act('adventure_plan',{intent:'explore',zone_id:'forest'});await step(2);
  await expect.poll(()=>page.evaluate(()=>window.__queuedDeltas.length)).toBeGreaterThan(0);
  await page.evaluate(()=>window.__testSource.dispatchEvent(new Event('error')));
  await expect(page.locator('.spectator-stale')).toBeVisible();
  const text=application.world.state.events.find(event=>event.type==='adventure_started').payload.text;
  // The disconnected 12-second HTTP poll is applied before the held deltas.
  await expect(page.getByTestId('adventure-profile')).toContainText('探索 · 苔光森林',{timeout:16000});
  await page.evaluate(()=>{window.__holdDeltas=false;window.__queuedDeltas.splice(0).forEach(deliver=>deliver());});
  await expect(page.getByRole('log').getByText(text,{exact:true})).toHaveCount(1);
  const before=await page.getByTestId(`map-agent-${a.agent.agent_id}`).getAttribute('style');
  await step();
  await expect(page.getByTestId(`map-agent-${a.agent.agent_id}`)).not.toHaveAttribute('style',before);
  await expect(page.getByRole('log').getByText(text,{exact:true})).toHaveCount(1);
});

test('只探索的 AI 会被怪物主动追击与攻击，返回营地或主人暂停后不再受伤', async ({page,request}) => {
  const api=await owner(request), a=await actor(api,'测试林间旅人');
  await page.goto(base+'/watch?view=adventure');
  await expect(page.getByTestId('adventure-field-status')).toContainText('广场营地安全区');
  await a.act('adventure_plan',{intent:'explore',zone_id:'forest'});
  let chasing;
  for(let i=0;i<600&&!chasing;i++) {
    await advance(100);
    await declinePending(a);
    chasing=application.world.state.adventure.monsters.find(monster=>monster.target_agent_id===a.agent.agent_id&&monster.behavior==='chasing'&&
      (monster.position.x!==monster.home_position.x||monster.position.y!==monster.home_position.y));
  }
  expect(chasing).toBeTruthy();
  expect(chasing.position).not.toEqual(chasing.home_position);
  const pursuing=page.getByTestId(`monster-${chasing.monster_id}`);
  await expect(pursuing).toHaveAttribute('data-behavior','chasing');
  await expect(pursuing).toHaveAttribute('aria-label',/追赶 测试林间旅人/);
  await expect(page.getByTestId('adventure-field-status')).toContainText('正在被怪物盯上');
  for(let i=0;i<12&&application.world.agent(a.agent.agent_id).adventure.hp===40;i++){await step();await declinePending(a);}
  const injured=(await a.observe()).self;
  expect(injured.adventure.hp).toBeLessThan(injured.adventure.max_hp);
  expect(injured.adventure.kills).toBe(0);
  expect(application.world.state.adventure.monsters.every(monster=>monster.hp===monster.max_hp)).toBe(true);
  await expect(page.getByLabel('角色生命')).toHaveAttribute('value',String(injured.adventure.hp));
  await expect(page.locator('.adventure-monster[data-behavior="attacking"]').first()).toHaveAttribute('aria-label',/攻击 测试林间旅人/);
  await page.getByRole('button',{name:'冒险',exact:true}).click();
  await expect(page.getByRole('log')).toContainText('造成');
  for(const width of [1440,390]) {
    await page.setViewportSize({width,height:900});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const audit=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
    expect(audit.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))).toEqual([]);
    await page.screenshot({path:`artifacts/adventure-aggro-${width}.png`,fullPage:true});
  }
  await a.act('adventure_plan',{intent:'retreat'});
  await until(()=>application.world.agent(a.agent.agent_id).scene_id==='plaza'&&!application.world.agent(a.agent.agent_id).adventure.plan,60);
  const safe=(await a.observe()).self;
  expect(safe.adventure.in_field).toBe(false);
  await expect(page.getByTestId('adventure-field-status')).toContainText('营地安全区');
  expect(application.world.state.adventure.monsters.every(monster=>monster.target_agent_id!==a.agent.agent_id)).toBe(true);
  await step(3);expect((await a.observe()).self.adventure.hp).toBe(safe.adventure.hp);
  await a.act('adventure_plan',{intent:'explore',zone_id:'forest'});
  for(let i=0;i<60&&!application.world.state.adventure.monsters.some(monster=>monster.target_agent_id===a.agent.agent_id);i++)await step();
  expect(application.world.state.adventure.monsters.some(monster=>monster.target_agent_id===a.agent.agent_id)).toBe(true);
  await api(`/api/agents/${a.agent.agent_id}/control`,{operation:'pause'});
  const pausedHp=application.world.agent(a.agent.agent_id).adventure.hp;
  await step(3);
  expect(application.world.agent(a.agent.agent_id).adventure.hp).toBe(pausedHp);
  expect(application.world.state.adventure.monsters.every(monster=>monster.target_agent_id!==a.agent.agent_id)).toBe(true);
  await expect(page.getByTestId('adventure-field-status')).toContainText('冒险已停止');
});

test('低生命时公开显示反应保护，保护期间停止受击，旁观者不能代替原 AI 选择', async ({page,request}) => {
  const api=await owner(request), a=await actor(api,'测试遗迹旅人');
  await a.act('adventure_plan',{intent:'explore',zone_id:'ruins'});
  await page.goto(base+'/watch?view=adventure');
  for(let i=0;i<70&&!application.world.agent(a.agent.agent_id).adventure.decision_until;i++){
    await step();
    // This regression targets low-HP danger, so the scripted client explicitly
    // leaves a discovery instead of waiting inside v0.14's choice protection.
    const encounter=application.world.agent(a.agent.agent_id).adventure.encounter;
    if(encounter?.status==='pending')await a.act('adventure_event',{event_id:encounter.event_id,choice_id:'decline'});
  }
  const fighter=(await a.observe()).self.adventure;
  expect(fighter.decision_until).toBeGreaterThan(clock);
  expect(fighter.hp).toBeGreaterThan(0);expect(fighter.hp).toBeLessThanOrEqual(fighter.max_hp*.25);
  expect(fighter.plan).toBeNull();
  await expect(page.getByTestId('adventure-field-status')).toContainText('反应保护');
  await expect(page.getByTestId('adventure-field-status')).toContainText('保护到期后，留在野外仍有危险');
  await expect(page.getByTestId('adventure-profile')).toContainText('等待 AI 决定');
  await expect(page.getByRole('button',{name:'撤退',exact:true})).toHaveCount(0);
  const hp=fighter.hp;await step(5);
  expect((await a.observe()).self.adventure.hp).toBe(hp);
  await a.act('adventure_plan',{intent:'retreat'});
  await until(()=>application.world.agent(a.agent.agent_id).scene_id==='plaza'&&!application.world.agent(a.agent.agent_id).adventure.plan,60);
  await expect(page.getByTestId('adventure-field-status')).toContainText('营地安全区');
  expect((await a.observe()).self.adventure.hp).toBe(hp);
});

test('没有角色和观众时怪物仍会巡逻，打开旁观后 SSE 持续显示合法位置且不会新增 AI', async ({page,request}) => {
  const initial=await (await request.get(base+'/api/public/world')).json();
  expect(initial.agents).toEqual([]);
  await step(5); // No browser or SSE connection exists yet.
  const unseen=await (await request.get(base+'/api/public/world')).json();
  expect(unseen.agents).toEqual([]);
  expect(unseen.adventure.monsters.some((monster,index)=>JSON.stringify(monster.position)!==JSON.stringify(initial.adventure.monsters[index].position))).toBe(true);
  expect(unseen.adventure.monsters.every(monster=>monster.behavior==='patrolling')).toBe(true);
  const eventsBefore=unseen.events.length;
  await page.goto(base+'/watch?view=adventure');
  await expect(page.getByText('正在实时观察',{exact:true})).toBeVisible();
  await expect(page.locator('.adventure-monster[data-behavior="patrolling"]')).toHaveCount(3);
  const monster=unseen.adventure.monsters[0];
  const marker=page.getByTestId(`monster-${monster.monster_id}`);
  await expect(marker).toHaveAttribute('data-behavior','patrolling');
  const before=await marker.getAttribute('style');
  await step(2);
  await expect(marker).not.toHaveAttribute('style',before);
  const current=await (await request.get(base+'/api/public/world')).json();
  expect(current.agents).toEqual([]);expect(current.events.length).toBe(eventsBefore);
  const {width,height}=current.adventure.map;
  for(const item of current.adventure.monsters) {
    expect(Number.isInteger(item.position.x)&&item.position.x>=0&&item.position.x<width).toBe(true);
    expect(Number.isInteger(item.position.y)&&item.position.y>=0&&item.position.y<height).toBe(true);
    expect(item.target_agent_id).toBeNull();
    const element=page.getByTestId(`monster-${item.monster_id}`);
    const rendered=await element.evaluate(node=>({left:parseFloat(node.style.left),top:parseFloat(node.style.top)}));
    expect(rendered.left).toBeCloseTo((item.position.x+.5)/width*100,3);
    expect(rendered.top).toBeCloseTo((item.position.y+.5)/height*100,3);
  }
  await expect(page.locator('.adventure-agent')).toHaveCount(0);
  expect(width).toBe(24);expect(height).toBe(16);
  for(const viewport of [{width:1440,height:900},{width:390,height:844}]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const banner=await page.getByTestId('adventure-empty-banner').boundingBox();
    const map=await page.getByTestId('adventure-map').boundingBox();
    expect(banner.y).toBeGreaterThanOrEqual(map.y);expect(banner.y+banner.height).toBeLessThanOrEqual(map.y+map.height);
    await page.screenshot({path:`artifacts/adventure-patrol-${viewport.width}.png`,fullPage:true});
  }
});
