import {selectObservedAgent} from './observer-navigation.js';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../../server/index.js';

const base='http://127.0.0.1:3109';
let application,server,clock,clients;
test.beforeEach(async()=>{
  application=await createApp({dbPath:':memory:',authDbPath:':memory:',authMode:'accounts',publicUrl:base,allowHttp:true,production:true});
  await application.accounts.createAdmin({username:'farmer_admin',password:'Only-farm-tests-2026!',name:'田园测试主人'});
  clock=Date.now();clients=[];application.world.now=()=>clock;application.world.actionIntervalMs=0;
  ({server}=await application.start(3109));
});
test.afterEach(async()=>{for(const client of clients)await client.close();await application.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});

async function owner(request) {
  const login=await request.post(base+'/api/auth/login',{headers:{Origin:base},data:{username:'farmer_admin',password:'Only-farm-tests-2026!'}});
  expect(login.ok()).toBe(true);const session=await login.json();
  return async(path,data)=>{const response=await request.post(base+path,{headers:{Origin:base,'X-CSRF-Token':session.csrf_token},data});expect(response.ok(),await response.text()).toBe(true);return response.json();};
}
async function actor(api,name,existing) {
  const agent=existing||(await api('/api/agents',{name,avatar:'🌱'})).agent;
  const controller=await api(`/api/agents/${agent.agent_id}/controllers`,{kind:'external',name:'田园测试接入端'});
  await api(`/api/agents/${agent.agent_id}/control`,{operation:'start',controller_id:controller.controller_id,duration_minutes:15,max_calls:1000,goal:'PRIVATE_FARM_GOAL'});
  const client=new Client({name:'farm-browser-test',version:'1'},{capabilities:{}});clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${controller.token}`}}}));
  const call=async(name,args={})=>{const response=await client.callTool({name,arguments:args});expect(response.isError,JSON.stringify(response.content)).not.toBe(true);return response.structuredContent||JSON.parse(response.content.find(item=>item.type==='text').text);};
  const joined=await call('join_world');const session={run_id:joined.run_id,session_epoch:joined.session_epoch};let actionId=joined.next_action_id;
  return {agent,token:controller.token,observe:()=>call('observe',session),report:input=>call('report_status',{...session,state:'waiting',calls_used:0,...input}),act:async(type,payload={},expected='applied')=>{const result=await call('act',{...session,action_id:actionId,type,payload});expect(result.status,JSON.stringify(result)).toBe(expected);actionId=result.next_action_id;return result;}};
}
async function moveTo(a,target) {
  const before=await a.observe();
  await a.act('move',target);
  let observed=await a.observe();
  expect(observed.self.position,'接受移动时仍在实际起点').toEqual(before.self.position);
  // Advance the authoritative fixture clock in real simulation steps. Poll via
  // MCP so arrival, lease and public state use the same production contract.
  for(let step=0;step<30&&observed.self.movement;step++) {
    clock+=100;application.world.tick();observed=await a.observe();
  }
  expect(observed.self.movement).toBeNull();
  expect(observed.self.scene_id).toBe(before.self.scene_id);
  expect(observed.self.position).toEqual(target);
}
async function audit(page,prefix) {
  for(const width of [1440,390]) {
    await page.setViewportSize({width,height:900});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
    expect(result.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))).toEqual([]);
    await page.screenshot({path:`artifacts/${prefix}-${width}.png`,fullPage:true});
    if(await page.getByTestId('farm-scene').count())await page.getByTestId('farm-scene').screenshot({path:`artifacts/${prefix}-scene-${width}.png`});
  }
}

test('真实空场展示田园引导，不创建角色，不展示任何私有仓库',async({page})=>{
  await page.goto(base+'/watch?view=farm');
  await expect(page.locator('.farm-panel')).toContainText('田园等着第一位朋友');
  await expect(page.getByTestId('private-warehouse')).toHaveCount(0);
  await expect(page.getByTestId('runtime-diagnostics')).toHaveCount(0);
  expect((await (await page.request.get(base+'/api/public/world')).json()).agents).toEqual([]);
  await audit(page,'life-empty');
});

test('农作区独立于两张世界地图，真实农具使用维修升级可见，人物只在营地出现',async({page})=>{
  const api=await owner(page.request),a=await actor(api,'拿起锄头的旅人');
  // Local in-memory fixture supplies maintenance materials; all state changes
  // below still go through authenticated MCP commands and public SSE snapshots.
  Object.assign(application.world.agent(a.agent.agent_id).life.inventory,{wood:12,ore:8});
  await moveTo(a,{x:9,y:8}); // Exactly two tiles from service_center (11,8).
  await page.goto(base+'/watch?view=farm');
  await expect(page.getByTestId('farm-view')).toBeVisible();
  await expect(page.getByTestId('farm-present-agent')).toBeVisible();
  await expect(page.getByTestId('farm-plot_1')).toHaveAttribute('data-plot-state','untilled');
  await page.getByTestId('farm-tools').locator('summary').first().click();
  const hoe=page.getByTestId('farm-tool-hoe'),can=page.getByTestId('farm-tool-watering_can');
  await expect(hoe).toContainText('20 / 20');await expect(can).toContainText('20 / 20');
  await a.act('farm',{intent:'till',plot_id:'plot_1'});
  await expect(page.getByTestId('farm-plot_1')).toContainText('已开垦 · 等待播种');
  await expect(hoe).toContainText('19 / 20');
  await expect(page.getByTestId('farm-present-agent').locator('.pixel-tool')).toHaveAttribute('data-item','hoe');
  await a.act('inventory',{intent:'repair',item_id:'hoe'});
  await expect(hoe).toContainText('20 / 20');
  await expect(page.getByTestId('farm-present-agent').locator('.pixel-character')).toHaveAttribute('data-action','repair');
  await a.act('inventory',{intent:'upgrade',item_id:'hoe'});
  await expect(hoe).toContainText('Lv. 2');await expect(hoe).toContainText('40 / 40');
  await expect(hoe.locator('.pixel-tool-icon')).toHaveAttribute('data-tool-level','2');
  await expect(page.getByTestId('farm-present-agent').locator('.pixel-tool')).toHaveAttribute('data-tool-level','2');
  await a.act('farm',{intent:'plant',plot_id:'plot_1',crop_id:'turnip'});
  await a.act('farm',{intent:'water',plot_id:'plot_1'});
  await expect(can).toContainText('19 / 20');
  await a.act('inventory',{intent:'upgrade',item_id:'watering_can'});
  await expect(can).toContainText('40 / 40');
  await hoe.getByText('锄头等级与维护目录').click();
  await expect(hoe).toContainText('满耐久 60');
  await expect(page.getByTestId('private-warehouse')).toHaveCount(0);
  await expect(page.locator('[data-asset-missing]')).toHaveCount(0);
  await audit(page,'farm-tools-v011');
  await moveTo(a,{x:12,y:8});await moveTo(a,{x:14,y:8});
  await expect(page.getByTestId('farm-present-agent')).toHaveCount(0);
  await expect(page.getByTestId('farm-presence')).toContainText('正在别处活动');
  await page.getByRole('button',{name:/冒险地图/}).click();
  await expect(page.getByTestId('farm-view')).toHaveCount(0);
  await expect(page.locator('.pixel-map-crop,.farm-map-mark')).toHaveCount(0);
  await page.getByRole('button',{name:'社交广场',exact:true}).click();
  await expect(page.locator('.farm-plot,.pixel-map-crop,.farm-map-mark')).toHaveCount(0);
  await page.getByRole('button',{name:'农作区',exact:true}).click();
  await page.reload();
  await expect(page.getByTestId('farm-view')).toBeVisible();
  await expect(page.getByTestId('farm-tool-hoe')).toContainText('40 / 40');
});

test('原 AI 播种浇水收获并装备木剑；旁观仅见田地与装备，只有主人能看自己的库存',async({page,request})=>{
  const api=await owner(page.request),a=await actor(api,'测试田园旅人');
  const invitation=await api('/api/admin/invites',{});
  const registered=await request.post(base+'/api/auth/register',{headers:{Origin:base},data:{username:'farm_neighbor',password:'Neighbor-farm-2026!',name:'邻居主人',invite_code:invitation.invite_code}});
  expect(registered.ok(),await registered.text()).toBe(true);const neighbor=await registered.json();
  const other=await request.post(base+'/api/agents',{headers:{Origin:base,'X-CSRF-Token':neighbor.csrf_token},data:{name:'邻居的小田'}});
  expect(other.ok()).toBe(true);const b=(await other.json()).agent;
  const neighborApi=async(path,data)=>{const response=await request.post(base+path,{headers:{Origin:base,'X-CSRF-Token':neighbor.csrf_token},data});expect(response.ok(),await response.text()).toBe(true);return response.json();};
  const neighborActor=await actor(neighborApi,b.name,b);
  await moveTo(a,{x:11,y:8});
  await a.act('farm',{intent:'till',plot_id:'plot_1'});
  await a.act('farm',{intent:'plant',plot_id:'plot_1',crop_id:'turnip'});
  await page.goto(base+'/watch?view=farm');
  await expect(page.getByTestId('farm-plot_1')).toContainText('已播种 · 等待浇水');
  await expect(page.getByTestId('farm-plot_2')).toContainText('未开垦 · 等待锄地');
  await a.act('farm',{intent:'water',plot_id:'plot_1'});
  await expect(page.getByTestId('farm-plot_1')).toContainText('生长中');
  await a.act('inventory',{intent:'craft',item_id:'wooden_sword'});
  await a.act('inventory',{intent:'equip',item_id:'wooden_sword'});
  await expect(page.getByTestId('equipment-status')).toContainText('木剑');
  await expect(page.getByTestId('equipment-status')).toContainText('实际攻击 8');
  const planted=(await a.observe()).self.life.plots[0];
  while(clock<=planted.ready_at){clock+=Math.min(20000,planted.ready_at+1-clock);application.world.tick();await a.observe();await neighborActor.observe();}
  await expect(page.getByTestId('farm-plot_1')).toContainText('已成熟 · 等待收获');
  expect((await a.observe()).self.life.inventory.turnip).toBeUndefined();
  await selectObservedAgent(page,b.agent_id);
  await expect(page.locator('.farm-owner')).toContainText('邻居的小田的农田');
  await expect(page.getByTestId('farm-plot_1')).toContainText('未开垦 · 等待锄地');
  await selectObservedAgent(page,a.agent.agent_id);
  await audit(page,'life-public-mature');
  await a.act('farm',{intent:'harvest',plot_id:'plot_1'});
  await expect(page.getByTestId('farm-plot_1')).toContainText('未开垦 · 等待锄地');
  const publicWorld=await (await page.request.get(base+'/api/public/world')).json();
  expect(publicWorld.agents.every(agent=>!Object.hasOwn(agent.life,'inventory'))).toBe(true);
  await expect(page.getByTestId('private-warehouse')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(a.token);
  await expect(page.locator('body')).not.toContainText('PRIVATE_FARM_GOAL');
  const own=await (await page.request.get(base+'/api/world')).json();
  expect(own.agents.find(agent=>agent.agent_id===a.agent.agent_id).life.inventory.turnip).toBe(2);
  expect(own.agents.find(agent=>agent.agent_id===b.agent_id).life.inventory).toBeUndefined();
  const neighborWorld=await (await request.get(base+'/api/world')).json();
  expect(neighborWorld.agents.find(agent=>agent.agent_id===a.agent.agent_id).life.inventory).toBeUndefined();
  await page.goto(base+'/');
  const warehouse=page.getByTestId('private-warehouse');
  await expect(warehouse).toContainText('测试田园旅人的物品');
  await expect(warehouse.locator('.warehouse-items>div').filter({has:page.getByText('萝卜',{exact:true})})).toContainText('× 2');
  await expect(warehouse.locator('.warehouse-items>div').filter({has:page.getByText('木剑',{exact:true})})).toContainText('已装备');
  await expect(page.getByTestId('runtime-diagnostics')).toContainText('尚未核实');
  await a.report({runtime_version:'0.8.2',mode:'dsh-pet',capabilities:['adventure']});
  await expect(page.getByTestId('runtime-diagnostics')).toContainText('上报版本 0.8.2 早于 0.18 世界框架版本');
  await a.report({runtime_version:'0.11.0',mode:'dsh-pet',capabilities:['adventure','farming','farm_tools','inventory','equipment','fatigue'],last_decision_type:'wait'});
  await expect(page.getByTestId('runtime-diagnostics')).toContainText('早于 0.18 世界框架版本');
  await a.report({runtime_version:'0.19.0',mode:'dsh-pet',capabilities:['adventure','farming','farm_tools','inventory','equipment','fatigue','recovery','reliable_events','runtime_health','gathering','cooking','trading','exploration_events','strategic_equipment','personal_goals','cooperation'],last_decision_type:'wait'});
  await expect(page.getByTestId('runtime-diagnostics')).toContainText('0.19.0');
  await expect(page.getByTestId('runtime-diagnostics')).toContainText('原宠物桥接');
  await expect(page.getByTestId('runtime-diagnostics')).toContainText('上报决定等待');
  await expect(page.getByTestId('runtime-diagnostics')).toContainText('实际动作照料农田 · 已执行');
  await expect(page.getByTestId('runtime-diagnostics')).toContainText('是否探索、种田、采集、料理、合作或休息，仍由原 AI 自己选择');
  await audit(page,'life-owner-warehouse');
  await a.act('farm',{intent:'harvest',plot_id:'plot_1'},'rejected');
  await expect(page.getByTestId('runtime-diagnostics')).toContainText('实际动作照料农田 · 未执行');
  await expect(page.getByTestId('runtime-diagnostics')).toContainText('PLOT_EMPTY');
  await api(`/api/agents/${a.agent.agent_id}/control`,{operation:'recall'});
  await expect(page.getByTestId('runtime-diagnostics')).toContainText('原 AI 当前未连接');
});
