import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createApp} from '../../server/index.js';
let app,server,base,clock,clients;
test.beforeEach(async()=>{app=await createApp({dbPath:':memory:',authDbPath:':memory:',authMode:'local',production:true});clock=Date.now();app.world.now=()=>clock;app.world.actionIntervalMs=0;clients=[];({server,url:base}=await app.start(0));});
test.afterEach(async()=>{for(const c of clients)await c.close();await app.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
async function actor(request,name='荒野旅行者'){
 const s=await(await request.get(base+'/api/session')).json();const api=async(path,data)=>{const r=await request.post(base+path,{headers:{Origin:base,'X-CSRF-Token':s.csrf_token||''},data});expect(r.ok(),await r.text()).toBe(true);return r.json();};
 const{agent}=await api('/api/agents',{name}),controller=await api(`/api/agents/${agent.agent_id}/controllers`,{kind:'external',name:'荒野隔离测试'});await api(`/api/agents/${agent.agent_id}/control`,{operation:'start',controller_id:controller.controller_id,duration_minutes:15,max_calls:1000,goal:'PRIVATE_WILDERNESS_GOAL'});
 const c=new Client({name:'wilderness-browser',version:'1'},{capabilities:{}});clients.push(c);await c.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${controller.token}`}}}));
 const call=async(name,args={})=>{const r=await c.callTool({name,arguments:args});expect(r.isError,JSON.stringify(r.content)).not.toBe(true);return r.structuredContent||JSON.parse(r.content.find(i=>i.type==='text').text);};const joined=await call('join_world'),session={run_id:joined.run_id,session_epoch:joined.session_epoch};
 return {agent,api,observe:()=>call('observe',session),act:async(type,payload={})=>{const state=await call('observe',session),r=await call('act',{...session,action_id:state.next_action_id,type,payload});expect(r.status,JSON.stringify(r)).toBe('applied');return r;}};
}
async function until(a,predicate){for(let i=0;i<1200&&!predicate();i++){clock+=100;app.world.tick();if(i%10===0)await a.observe();}expect(predicate()).toBe(true);}
async function advanceTo(a,time){while(clock<time){clock=Math.min(time,clock+10000);await a.observe();app.world.tick();}}
async function ready(page){await expect(page.getByTestId('phaser-world')).toHaveAttribute('data-renderer-state','ready');await expect(page.getByTestId('phaser-canvas')).toHaveJSProperty('width',1536);await expect(page.getByTestId('phaser-canvas')).toHaveJSProperty('height',1024);}
async function hash(page){return page.getByTestId('phaser-canvas').evaluate(canvas=>{const c=document.createElement('canvas');c.width=canvas.width;c.height=canvas.height;const g=c.getContext('2d');g.drawImage(canvas,0,0);let hash=2166136261;for(const v of g.getImageData(0,0,c.width,c.height).data)hash=Math.imul(hash^v,16777619);return hash;});}


function night(){app.world.state.day_cycle.epoch_at=clock-360000;app.world.tick();app.world.commit();}
async function prepareFire(request){const a=await actor(request,'守火的旅人'),raw=app.world.agent(a.agent.agent_id);for(let i=0;i<2;i++){await a.act('gather',{intent:'start',node_id:'meadow_grass'});await until(a,()=>!raw.life.gathering);}await a.act('survival',{intent:'approach',site_id:'plaza_hearth'});await until(a,()=>!raw.survival.travel);return {a,raw};}

test('v021夜晚没有免费篝火，真实暗处风险与饱食状态在三视口只读可见',async({page,request})=>{
 const a=await actor(request,'天黑后认真找光源的长名字旅人'),raw=app.world.agent(a.agent.agent_id);night();const writes=[];page.on('request',r=>{if(r.method()!=='GET')writes.push(r.url());});
 await page.goto(base+'/watch?view=plaza');await ready(page);await expect(page.getByTestId('fire-site-plaza_hearth')).toHaveAttribute('data-lit','false');await expect(page.getByTestId('survival-status')).toContainText('身处暗处');
 await page.getByTestId('fire-site-plaza_hearth').click();await expect(page.getByTestId('fire-inspector')).toContainText('目前没有火');await page.keyboard.press('Escape');await expect(page.getByTestId('fire-inspector')).toHaveCount(0);
 const hp=raw.adventure.hp;await until(a,()=>raw.survival.darkness_seconds>=101);expect(raw.adventure.hp).toBeLessThan(hp);await expect(page.getByTestId('survival-status')).toContainText('黑暗正在伤害角色');
 // Isolated physiology fixture covers public hunger disclosure; server drain/food conservation have separate integration tests.
 raw.survival.satiety=25;app.world.commit();await expect(page.getByTestId('survival-status')).toContainText('饥饿');
 for(const[width,height]of[[1440,900],[390,844],[390,900]]){await page.setViewportSize({width,height});await page.evaluate(()=>scrollTo(0,0));expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(axe.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))).toEqual([]);await page.screenshot({path:'artifacts/v021-dark-'+width+'x'+height+'.png'});}
 expect(writes).toEqual([]);await expect(page.locator('.resident-list')).toHaveCount(0);await expect(page.locator('body')).not.toContainText('PRIVATE_WILDERNESS_GOAL');
});

test('v021真实采草赴营建火添柴，夜间光圈与公共燃料同服务状态',async({page,request})=>{
 const {a,raw}=await prepareFire(request);night();await page.goto(base+'/watch?view=plaza');await ready(page);const site=page.getByTestId('fire-site-plaza_hearth');await site.click();await expect(page.getByTestId('fire-inspector')).toContainText('目前没有火');const dark=await hash(page);
 await a.act('survival',{intent:'build',site_id:'plaza_hearth',kind:'campfire'});const fire=Object.values(app.world.state.survival.fires)[0];await expect(site).toHaveAttribute('data-lit','true');await expect(site).toHaveAttribute('data-fuel','90');await expect.poll(()=>hash(page)).not.toBe(dark);await expect(page.getByTestId('fire-inspector')).toContainText('照明半径 5 格');await expect(page.getByTestId('survival-status')).toContainText('篝火照亮');
 await a.act('survival',{intent:'fuel',fire_id:fire.fire_id,item_id:'grass',quantity:1});await expect(site).toHaveAttribute('data-fuel','105');expect(raw.life.inventory.grass).toBe(1);await page.getByTestId('world-camera').screenshot({path:'artifacts/v021-real-fire.png'});
 for(const[width,height]of[[390,844],[390,900]]){await page.setViewportSize({width,height});await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'artifacts/v021-fire-'+width+'x'+height+'.png'});}
 await page.getByRole('button',{name:'冒险地图',exact:true}).click();await ready(page);await expect(page.getByTestId('fire-site-plaza_hearth')).toHaveCount(0);await expect(page.locator('.fire-site[data-lit=true]')).toHaveCount(0);
 await page.getByRole('button',{name:'社交广场',exact:true}).click();await ready(page);await advanceTo(a,clock+106000);await expect(site).toHaveAttribute('data-lit','false');await expect(site).toHaveAttribute('data-fuel','0');await page.getByTestId('world-camera').screenshot({path:'artifacts/v021-fire-out.png'});
});

test('v021真实砍树得松果再种树，树桩树苗幼树成熟和固定根床互相一致',async({page,request})=>{
 const a=await actor(request,'照顾新林地的旅人'),raw=app.world.agent(a.agent.agent_id);await a.act('gather',{intent:'start',node_id:'camp_stones'});await until(a,()=>!raw.life.gathering);await a.act('inventory',{intent:'craft',item_id:'axe'});
 await page.goto(base+'/watch?view=plaza');await ready(page);await page.getByRole('button',{name:'查看全景',exact:true}).click();const tree=page.getByTestId('resource-east_pine');await expect(page.locator('[data-prop-id=village_tree_2]')).toHaveCount(0);await expect(page.getByTestId('resource-village_tree_2')).toHaveCount(1);
 for(let i=0;i<3;i++){await a.act('gather',{intent:'start',node_id:'east_pine'});await until(a,()=>!raw.life.gathering);}
 await expect(tree).toHaveAttribute('data-ecology-stage','stump');expect(raw.life.inventory.pine_cone).toBe(1);await tree.click();await page.getByTestId('world-camera').screenshot({path:'artifacts/v021-felled-tree.png'});
 await a.act('gather',{intent:'plant',node_id:'planting_plaza'});await until(a,()=>raw.life.gathering?.phase==='working');await expect(page.getByTestId('map-agent-'+a.agent.agent_id).locator('.pixel-character')).toHaveAttribute('data-action','plant');await until(a,()=>!raw.life.gathering);expect(raw.life.inventory.pine_cone||0).toBe(0);
 const planted=page.getByTestId('resource-planting_plaza');await expect(planted).toHaveAttribute('data-ecology-stage','sapling');await planted.click();await expect(page.getByTestId('tree-ecology')).toContainText('树苗');await page.getByTestId('world-camera').screenshot({path:'artifacts/v021-sapling.png'});
 await a.api('/api/agents/'+a.agent.agent_id+'/control',{operation:'pause'});
 clock=app.world.state.resources.nodes.planting_plaza.ecology.next_at;app.world.tick();await expect(planted).toHaveAttribute('data-ecology-stage','young');await page.getByTestId('world-camera').screenshot({path:'artifacts/v021-young-tree.png'});
 clock=app.world.state.resources.nodes.planting_plaza.ecology.next_at;app.world.tick();await expect(planted).toHaveAttribute('data-ecology-stage','mature');await expect(planted).toHaveAttribute('data-stock','3');await page.getByTestId('world-camera').screenshot({path:'artifacts/v021-mature-tree.png'});
});

test('v021断线冻结火焰燃料和风险，兼容图层仍保留真实火点与只读详情',async({page,request})=>{
 const {a}=await prepareFire(request);night();await a.act('survival',{intent:'build',site_id:'plaza_hearth',kind:'campfire'});await page.route('**/api/public/events*',route=>route.abort('connectionfailed'));await page.goto(base+'/watch?view=plaza');await ready(page);await expect(page.locator('.spectator-stale')).toBeVisible();const site=page.getByTestId('fire-site-plaza_hearth'),fuel=await site.getAttribute('data-fuel');await expect(site.locator('.pixel-sprite')).toHaveAttribute('data-playing','false');await page.clock.install();await page.clock.fastForward(180000);await expect(site).toHaveAttribute('data-fuel',fuel);await expect(site).toHaveAttribute('data-lit','true');await site.click();await expect(page.getByTestId('fire-inspector')).toContainText('最近记录');await page.screenshot({path:'artifacts/v021-fire-disconnected.png'});
 await page.route('**/assets/phaser-renderer-*.js',route=>route.abort('failed'));await page.reload();await expect(page.getByTestId('phaser-world')).toHaveAttribute('data-renderer-state','fallback');await site.click();await expect(page.getByTestId('fire-inspector')).toContainText('燃烧中');await expect(page.locator('.night-lighting')).toBeVisible();await expect(page.getByText('游戏画布暂不可用 · 当前为兼容图层显示')).toBeVisible();await page.screenshot({path:'artifacts/v021-fire-fallback.png'});
});
