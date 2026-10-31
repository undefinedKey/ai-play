import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../../server/index.js';

let application, server, base, clients, clock;
test.beforeEach(async () => {
  application = await createApp({ dbPath: ':memory:', authDbPath: ':memory:', authMode: 'local', production: true });
  application.world.actionIntervalMs = 0;
  clock = Date.now(); application.world.now = () => clock;
  clients = [];
  ({ server, url: base } = await application.start(0));
});
test.afterEach(async () => {
  for (const client of clients) await client.close();
  await application.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
});
async function actor(request, name) {
  const session = await (await request.get(base + '/api/session')).json();
  const api = async (path, data) => {
    const response = await request.post(base + path, { headers: { Origin: base, 'X-CSRF-Token': session.csrf_token || '' }, data });
    expect(response.ok(), await response.text()).toBe(true); return response.json();
  };
  const { agent } = await api('/api/agents', { name });
  const controller = await api(`/api/agents/${agent.agent_id}/controllers`, { kind: 'external', name: '公开说话测试' });
  await api(`/api/agents/${agent.agent_id}/control`, { operation: 'start', controller_id: controller.controller_id, duration_minutes: 15, max_calls: 100, goal: 'PRIVATE_SPEECH_GOAL' });
  const client = new Client({ name: 'speech-test', version: '1' }, { capabilities: {} }); clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${controller.token}` } } }));
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args }); expect(response.isError).not.toBe(true);
    return response.structuredContent || JSON.parse(response.content.find(item => item.type === 'text').text);
  };
  const joined = await call('join_world'); let actionId = joined.next_action_id;
  return { agent, api, token: controller.token, act: async (type, payload = {}) => {
    const result = await call('act', { run_id: joined.run_id, session_epoch: joined.session_epoch, action_id: actionId, type, payload });
    expect(result.status, JSON.stringify(result)).toBe('applied'); actionId = result.next_action_id; return result;
  } };
}

async function openHistory(page){const panel=page.getByTestId('history-panel');await panel.locator(':scope > details > summary').click();await expect(panel.getByText('正在读取公开经历…')).toHaveCount(0);return panel;}
async function speakMany(a,n,prefix='真实经历'){for(let i=0;i<n;i++){clock+=1;await a.act('say',{channel:'nearby',text:`${prefix}${i}`} );}}

test('公开经历分页筛选保留读位，刷新才插入新经历，原始全文和出处可展开',async({page,request})=>{
  const a=await actor(request,'同名经历旅人'),b=await actor(request,'同名经历旅人');await speakMany(a,25);await b.act('say',{channel:'nearby',text:'乙的独立经历'});
  await page.goto(base+'/watch?view=adventure');await page.getByLabel('观察对象',{exact:true}).selectOption(a.agent.agent_id);
  const panel=await openHistory(page),list=panel.getByTestId('history-list');await expect(list.locator(':scope > li')).toHaveCount(20);await expect(list).not.toContainText('乙的独立经历');
  const first=await list.locator(':scope > li').first().getAttribute('data-entry-id');await list.locator(':scope > li > details > summary').first().click();await expect(list.locator('.history-source').first()).toContainText('evt_');
  await a.act('say',{channel:'nearby',text:'后来才发生的新经历'});await expect(panel.getByRole('button',{name:'有新经历 · 刷新记录'})).toBeVisible();expect(await list.locator(':scope > li').first().getAttribute('data-entry-id')).toBe(first);
  await panel.getByRole('button',{name:'加载更早经历'}).click();await expect(list.locator(':scope > li')).toHaveCount(25);const ids=await list.locator(':scope > li').evaluateAll(els=>els.map(e=>e.dataset.entryId));expect(new Set(ids).size).toBe(25);
  let refreshFailed=false;await page.route('**/api/public/history?**',route=>{if(!refreshFailed){refreshFailed=true;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'刷新暂不可用'}})});}return route.continue();});
  await panel.getByRole('button',{name:'有新经历 · 刷新记录'}).click();await expect(panel.getByRole('alert')).toContainText('刷新暂不可用');await expect(list.locator(':scope > li')).toHaveCount(25);await panel.getByRole('button',{name:'重试读取经历'}).click();await expect(list.locator(':scope > li')).toHaveCount(20);await expect(list.locator(':scope > li').first()).toContainText('后来才发生');await page.unroute('**/api/public/history?**');
  await panel.getByLabel('经历人物').selectOption(b.agent.agent_id);await expect(list.locator(':scope > li')).toHaveCount(1);await expect(list).toContainText('乙的独立经历');
  await panel.getByLabel('经历类别').selectOption('cooperation');await expect(panel).toContainText('这个范围还没有保留');await panel.getByLabel('经历类别').selectOption('speech');
  await panel.getByLabel('经历开始日期').fill('2000-01-01');await panel.getByLabel('经历结束日期').fill('2001-01-01');await expect(list.locator(':scope > li')).toHaveCount(0);
  await panel.getByLabel('经历开始日期').fill('');await panel.getByLabel('经历结束日期').fill('');await expect(list.locator(':scope > li')).toHaveCount(1);
  await panel.locator('.history-retention > summary').click();await expect(panel).toContainText('4096');await expect(panel).toContainText('更早缺失的经历不会补造');
  for(const[width,height]of[[1440,900],[390,844],[390,900]]){await page.setViewportSize({width,height});await panel.scrollIntoViewIfNeeded();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);const audit=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(audit.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))).toEqual([]);await page.screenshot({path:`artifacts/history-v016-${width}-${height}.png`,fullPage:true});}
});

test('历史快速切换人物忽略迟到响应，错误可重试，离线旧发言不重新生成气泡',async({page,request})=>{
  const a=await actor(request,'慢响应人物'),b=await actor(request,'快速人物');await a.act('say',{channel:'nearby',text:'甲的历史'});await b.act('say',{channel:'nearby',text:'乙的历史'});
  await a.api(`/api/agents/${a.agent.agent_id}/control`,{operation:'recall'});
  let pending;await page.route('**/api/public/history?**',async route=>{const url=new URL(route.request().url());if(url.searchParams.get('agent_id')===a.agent.agent_id){const r=await route.fetch();pending=()=>route.fulfill({response:r});}else await route.continue();});
  await page.goto(base+'/watch?view=plaza');await page.getByLabel('观察对象',{exact:true}).selectOption(a.agent.agent_id);const panel=page.getByTestId('history-panel');await panel.locator(':scope > details > summary').click();await expect.poll(()=>!!pending).toBe(true);
  await panel.getByLabel('经历人物').selectOption(b.agent.agent_id);await expect(panel.getByTestId('history-list')).toContainText('乙的历史');await pending();await expect(panel.getByTestId('history-list')).not.toContainText('甲的历史');
  await page.unroute('**/api/public/history?**');let failed=false;await page.route('**/api/public/history?**',route=>{if(!failed){failed=true;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'暂时无法读取经历'}})});}return route.continue();});
  await panel.getByRole('button',{name:'刷新记录',exact:true}).click();await expect(panel.getByRole('alert')).toContainText('暂时无法');await panel.getByRole('button',{name:'重试读取经历'}).click();await expect(panel.getByRole('alert')).toHaveCount(0);
  await panel.getByLabel('经历人物').selectOption(a.agent.agent_id);await expect(panel.getByTestId('history-list')).toContainText('甲的历史');await panel.locator('.history-list > li > details > summary').click();await expect(panel.locator('.history-speech')).toHaveText('甲的历史');await expect(page.locator(`[data-testid="speech-cloud"][data-agent-id="${a.agent.agent_id}"]`)).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('PRIVATE_SPEECH_GOAL');await expect(page.locator('body')).not.toContainText(a.token);
});

test('合作终态清出即时列表后双方仍可回顾同一成果，拒绝对象不出现在公开档案',async({page,request})=>{
  const a=await actor(request,'共同供菜者'),b=await actor(request,'共同厨师');await a.act('move',{x:11,y:8});await b.act('move',{x:11,y:8});application.world.agent(a.agent.agent_id).life.inventory.turnip=4;
  await a.act('cooperation',{intent:'propose',template_id:'camp_meal',target_agent_id:b.agent.agent_id,role_id:'supplier'});let p=Object.values(application.world.state.cooperations).find(p=>p.status==='proposed');await b.act('cooperation',{intent:'respond',cooperation_id:p.cooperation_id,revision:p.revision,accept:true,role_id:'cook'});await a.act('cooperation',{intent:'contribute',cooperation_id:p.cooperation_id,revision:p.revision});await b.act('cooperation',{intent:'cook',cooperation_id:p.cooperation_id,revision:p.revision});
  application.world.state.cooperations={};application.world.state.events=[];application.world.commit();
  await page.goto(base+'/watch?view=farm');await page.getByLabel('观察对象',{exact:true}).selectOption(a.agent.agent_id);await expect(page.getByTestId('cooperation-panel')).toHaveCount(0);const panel=await openHistory(page);await panel.getByRole('button',{name:'查看合作成果'}).click();await expect(panel.locator('.history-list > li')).toHaveCount(1);const id=await panel.locator('.history-list > li').getAttribute('data-entry-id');await panel.locator('.history-list > li > details > summary').click();await expect(panel.getByTestId('cooperation-result')).toContainText('浓汤');await expect(panel.locator('.history-entry-body')).toContainText('共同供菜者');await expect(panel.locator('.history-entry-body')).toContainText('共同厨师');
  await panel.getByLabel('经历人物').selectOption(b.agent.agent_id);await expect(panel.locator('.history-list > li')).toHaveAttribute('data-entry-id',id);await expect(page.getByTestId('speech-cloud')).toHaveCount(0);
});
