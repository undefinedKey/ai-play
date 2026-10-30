import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../../server/index.js';

// Real HTTP, MCP, SSE and world simulation. The clock is advanced explicitly;
// these clients exercise decisions without pretending to be an actual LLM.
let application, server, base, clock, clients;
test.beforeEach(async () => {
  application = await createApp({ dbPath: ':memory:', authDbPath: ':memory:', authMode: 'local', production: true });
  clock = Date.now(); clients = [];
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
  return { agent, token: controller.token, observe:()=>call('observe',session), act:async(type,payload={})=> {
    const result = await call('act',{...session,action_id:actionId,type,payload});
    expect(result.status,JSON.stringify(result)).toBe('applied');actionId=result.next_action_id;return result;
  } };
}
function step(count=1) { for(let i=0;i<count;i++){clock+=1001;application.world.tick();} }

test('冒险地图是真实空场，双视图与移动端可读，无浏览者操作角色入口', async ({page,request}) => {
  const initial = await (await request.get(base+'/api/public/world')).json();
  expect(initial.agents).toEqual([]); expect(initial.adventure.monsters).toHaveLength(3);
  await page.goto(base+'/watch?view=adventure');
  await expect(page.getByTestId('adventure-map')).toContainText('森林已准备好');
  await expect(page.getByTestId('adventure-map')).toContainText('星火营地');
  await expect(page.locator('.adventure-agent')).toHaveCount(0);
  await expect(page.locator('.adventure-monster')).toHaveCount(3);
  await expect(page.locator('.adventure-world-note')).toContainText('无人旁观也会继续');
  for(const width of [1440,390]) {
    await page.setViewportSize({width,height:900});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const audit = await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
    expect(audit.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))).toEqual([]);
    await page.screenshot({path:`artifacts/adventure-empty-${width}.png`,fullPage:true});
  }
  await page.getByRole('button',{name:'社交广场',exact:true}).click();
  await expect(page.getByTestId('plaza-map')).toBeVisible();
  await page.getByRole('button',{name:'冒险地图 NEW',exact:true}).click();
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
  step(3);
  expect((await a.observe()).self.position).not.toEqual(first);
  const requests=[];page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/'))requests.push(r);});
  await page.goto(base+'/watch?view=adventure');
  await page.getByTestId(`adventure-agent-${a.agent.agent_id}`).click();
  await expect(page.getByTestId('adventure-profile')).toContainText('讨伐 · 苔光森林');
  await expect(page.getByTestId('adventure-profile')).toContainText('2 位同行者');
  for(let i=0;i<20&&application.world.agent(a.agent.agent_id).adventure.plan;i++){step();await page.waitForTimeout(80);}
  await expect(page.getByTestId('monster-forest_boar')).toHaveClass(/defeated/);
  await expect(page.getByTestId('adventure-profile')).toContainText('击败荆棘野猪');
  const result=(await a.observe()).self.adventure;
  expect(result.gold).toBeGreaterThan(0);expect(result.xp).toBeGreaterThan(0);
  expect(result.hp).toBeLessThan(result.max_hp);
  await expect(page.getByLabel('角色生命')).toHaveAttribute('value',String(result.hp));
  await page.getByRole('button',{name:'冒险',exact:true}).click();
  await expect(page.getByRole('log')).toContainText('获得');
  await expect(page.getByRole('log')).toContainText('造成');
  await expect(page.locator('body')).not.toContainText(a.token);
  await expect(page.locator('body')).not.toContainText('PRIVATE_ADVENTURE_GOAL');
  expect(requests.every(r=>r.method()==='GET'&&['/api/public/world','/api/public/events'].includes(new URL(r.url()).pathname))).toBe(true);
  expect(requests.some(r=>r.url().includes('/api/public/events?delta=1'))).toBe(true);
  step(5);expect((await a.observe()).self.adventure.gold).toBe(result.gold);
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
  await page.goto(base+'/watch?view=adventure');
  await expect(page.getByTestId('adventure-profile')).toContainText('探索 · 星火营地');
  step(16);
  await expect(page.getByTestId('adventure-profile')).toContainText('已抵达星火营地');
  expect((await a.observe()).self.adventure.plan).toBeNull();
  await a.act('adventure_plan',{intent:'rest'}); step(2);
  await api(`/api/agents/${a.agent.agent_id}/control`,{operation:'pause'});
  const position={...application.world.agent(a.agent.agent_id).position};step(3);
  expect(application.world.agent(a.agent.agent_id).position).toEqual(position);
  await expect(page.getByTestId('adventure-profile')).toContainText('活动已暂停');
  await expect(page.getByTestId(`adventure-agent-${a.agent.agent_id}`)).toHaveClass(/paused/);
});

test('HTTP 轮询先于同版本 SSE 增量到达时，旁观日志不重复且继续更新位置', async ({page,request}) => {
  const api=await owner(request), a=await actor(api,'测试增量旅人');
  // Delay delivery of real SSE delta callbacks, leaving real snapshots and HTTP
  // untouched. This reproduces polling ahead of a slow event stream.
  await page.addInitScript(()=>{
    const NativeEventSource=window.EventSource;
    window.__queuedDeltas=[];window.__holdDeltas=true;
    window.EventSource=class extends NativeEventSource {
      addEventListener(type,listener,options) {
        if(type==='delta')return super.addEventListener(type,event=>{
          if(window.__holdDeltas)window.__queuedDeltas.push(()=>listener.call(this,event));
          else listener.call(this,event);
        },options);
        return super.addEventListener(type,listener,options);
      }
    };
  });
  await page.goto(base+'/watch?view=adventure');
  await expect(page.getByText('正在实时观察',{exact:true})).toBeVisible();
  await expect(page.getByTestId('adventure-profile')).toContainText('目前没有冒险计划');
  await a.act('adventure_plan',{intent:'explore',zone_id:'forest'});step(2);
  await expect.poll(()=>page.evaluate(()=>window.__queuedDeltas.length)).toBeGreaterThan(0);
  const text=application.world.state.events.find(event=>event.type==='adventure_started').payload.text;
  // The 12-second HTTP poll makes the current plan visible before deltas arrive.
  await expect(page.getByTestId('adventure-profile')).toContainText('探索 · 苔光森林',{timeout:16000});
  await page.evaluate(()=>{window.__holdDeltas=false;window.__queuedDeltas.splice(0).forEach(deliver=>deliver());});
  await expect(page.getByRole('log').getByText(text,{exact:true})).toHaveCount(1);
  const before=await page.getByTestId(`adventure-agent-${a.agent.agent_id}`).getAttribute('style');
  step();
  await expect(page.getByTestId(`adventure-agent-${a.agent.agent_id}`)).not.toHaveAttribute('style',before);
  await expect(page.getByRole('log').getByText(text,{exact:true})).toHaveCount(1);
});

test('只探索的 AI 会被怪物主动追击与攻击，返回营地或主人暂停后不再受伤', async ({page,request}) => {
  const api=await owner(request), a=await actor(api,'测试林间旅人');
  await page.goto(base+'/watch?view=adventure');
  await expect(page.getByTestId('adventure-field-status')).toContainText('未开启冒险');
  await a.act('adventure_plan',{intent:'explore',zone_id:'forest'});
  let chasing;
  for(let i=0;i<16&&!chasing;i++) {
    step();
    chasing=application.world.state.adventure.monsters.find(monster=>monster.target_agent_id===a.agent.agent_id&&monster.behavior==='chasing');
  }
  expect(chasing).toBeTruthy();
  expect(chasing.position).not.toEqual(chasing.home_position);
  const pursuing=page.getByTestId(`monster-${chasing.monster_id}`);
  await expect(pursuing).toHaveAttribute('data-behavior','chasing');
  await expect(page.getByLabel('野外怪物动向')).toContainText('追赶 测试林间旅人');
  await expect(page.getByTestId('adventure-field-status')).toContainText('正在被怪物盯上');
  for(let i=0;i<8&&application.world.agent(a.agent.agent_id).adventure.hp===40;i++)step();
  const injured=(await a.observe()).self;
  expect(injured.adventure.hp).toBeLessThan(injured.adventure.max_hp);
  expect(injured.adventure.kills).toBe(0);
  expect(application.world.state.adventure.monsters.every(monster=>monster.hp===monster.max_hp)).toBe(true);
  await expect(page.getByLabel('角色生命')).toHaveAttribute('value',String(injured.adventure.hp));
  await expect(page.getByLabel('野外怪物动向')).toContainText('攻击 测试林间旅人');
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
  for(let i=0;i<18&&application.world.agent(a.agent.agent_id).adventure.in_field;i++)step();
  const safe=(await a.observe()).self;
  expect(safe.adventure.in_field).toBe(false);
  await expect(page.getByTestId('adventure-field-status')).toContainText('营地安全区');
  expect(application.world.state.adventure.monsters.every(monster=>monster.target_agent_id!==a.agent.agent_id)).toBe(true);
  step(3);expect((await a.observe()).self.adventure.hp).toBe(safe.adventure.hp);
  await a.act('adventure_plan',{intent:'explore',zone_id:'forest'});
  for(let i=0;i<16&&!application.world.state.adventure.monsters.some(monster=>monster.target_agent_id===a.agent.agent_id);i++)step();
  expect(application.world.state.adventure.monsters.some(monster=>monster.target_agent_id===a.agent.agent_id)).toBe(true);
  await api(`/api/agents/${a.agent.agent_id}/control`,{operation:'pause'});
  const pausedHp=application.world.agent(a.agent.agent_id).adventure.hp;
  step(3);
  expect(application.world.agent(a.agent.agent_id).adventure.hp).toBe(pausedHp);
  expect(application.world.state.adventure.monsters.every(monster=>monster.target_agent_id!==a.agent.agent_id)).toBe(true);
  await expect(page.getByTestId('adventure-field-status')).toContainText('冒险已停止');
});

test('低生命时公开显示反应保护，保护期间停止受击，旁观者不能代替原 AI 选择', async ({page,request}) => {
  const api=await owner(request), a=await actor(api,'测试遗迹旅人');
  await a.act('adventure_plan',{intent:'explore',zone_id:'ruins'});
  await page.goto(base+'/watch?view=adventure');
  for(let i=0;i<25&&!application.world.agent(a.agent.agent_id).adventure.decision_until;i++)step();
  const fighter=(await a.observe()).self.adventure;
  expect(fighter.decision_until).toBeGreaterThan(clock);
  expect(fighter.hp).toBeGreaterThan(0);expect(fighter.hp).toBeLessThanOrEqual(fighter.max_hp*.25);
  expect(fighter.plan).toBeNull();
  await expect(page.getByTestId('adventure-field-status')).toContainText('反应保护');
  await expect(page.getByTestId('adventure-field-status')).toContainText('保护到期后，留在野外仍有危险');
  await expect(page.getByTestId('adventure-profile')).toContainText('等待 AI 决定');
  await expect(page.getByRole('button',{name:'撤退',exact:true})).toHaveCount(0);
  const hp=fighter.hp;step(5);
  expect((await a.observe()).self.adventure.hp).toBe(hp);
  await a.act('adventure_plan',{intent:'retreat'});
  for(let i=0;i<18&&application.world.agent(a.agent.agent_id).adventure.in_field;i++)step();
  await expect(page.getByTestId('adventure-field-status')).toContainText('营地安全区');
  expect((await a.observe()).self.adventure.hp).toBe(hp);
});
