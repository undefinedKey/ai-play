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
 return {agent,observe:()=>call('observe',session),act:async(type,payload={})=>{const state=await call('observe',session),r=await call('act',{...session,action_id:state.next_action_id,type,payload});expect(r.status,JSON.stringify(r)).toBe('applied');return r;}};
}
async function until(a,predicate){for(let i=0;i<1200&&!predicate();i++){clock+=100;app.world.tick();if(i%10===0)await a.observe();}expect(predicate()).toBe(true);}
async function advanceTo(a,time){while(clock<time){clock=Math.min(time,clock+10000);await a.observe();app.world.tick();}}
async function ready(page){await expect(page.getByTestId('phaser-world')).toHaveAttribute('data-renderer-state','ready');await expect(page.getByTestId('phaser-canvas')).toHaveJSProperty('width',1536);await expect(page.getByTestId('phaser-canvas')).toHaveJSProperty('height',1024);}
async function hash(page){return page.getByTestId('phaser-canvas').evaluate(canvas=>{const c=document.createElement('canvas');c.width=canvas.width;c.height=canvas.height;const g=c.getContext('2d');g.drawImage(canvas,0,0);let hash=2166136261;for(const v of g.getImageData(0,0,c.width,c.height).data)hash=Math.imul(hash^v,16777619);return hash;});}

test('v020四倍真实世界保留角色尺寸，墨线荒野昼夜、全景与三视口可读',async({page,request})=>{
 const a=await actor(request,'有很长中文名字的荒野旅行者');await a.act('say',{channel:'nearby',text:'先看看东坡的松林，再决定要不要出发。'});const writes=[];page.on('request',r=>{if(r.method()!=='GET')writes.push(r.url());});
 await page.goto(base+'/watch?view=plaza');await ready(page);const camera=page.getByTestId('world-camera');await expect(camera).toHaveAttribute('data-camera-zoom','2.00');
 const character=page.getByTestId(`map-agent-${a.agent.agent_id}`).locator('.pixel-character'),near=(await character.boundingBox()).width;await page.getByRole('button',{name:'查看全景',exact:true}).click();await expect(camera).toHaveAttribute('data-camera-zoom','1.00');expect((await character.boundingBox()).width).toBeCloseTo(near/2,1);await page.screenshot({path:'artifacts/v020-wilderness-overview.png'});
 await page.getByTestId('resource-east_pine').click();await expect(page.getByTestId('resource-inspector')).toContainText('需要斧头');await expect(page.getByTestId('resource-inspector')).toContainText('(29, 7)');await page.keyboard.press('Escape');await expect(page.getByTestId('resource-inspector')).toHaveCount(0);await page.getByRole('button',{name:'镜头复位',exact:true}).click();
 const day=await hash(page);await advanceTo(a,app.world.state.day_cycle.epoch_at+370000);await expect(page.getByTestId('world-time')).toHaveAttribute('data-phase','night');await expect(page.getByTestId('phaser-world')).toHaveAttribute('data-day-phase','night');await expect.poll(()=>hash(page)).not.toBe(day);
 for(const[width,height]of[[1440,900],[390,844],[390,900]]){await page.setViewportSize({width,height});await page.evaluate(()=>scrollTo(0,0));expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(axe.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))).toEqual([]);await page.screenshot({path:`artifacts/v020-night-${width}x${height}.png`});}
 expect(writes).toEqual([]);await expect(page.locator('.resident-list')).toHaveCount(0);await expect(page.locator('body')).not.toContainText('PRIVATE_WILDERNESS_GOAL');
});

test('v020原AI走到扩展林区才用斧头工作，真实共享库存耗尽与再生可见',async({page,request})=>{
 const a=await actor(request),raw=app.world.agent(a.agent.agent_id);await a.act('move',{x:11,y:8});await until(a,()=>!raw.movement);await a.act('gather',{intent:'start',node_id:'camp_stones'});await until(a,()=>!raw.life.gathering);await a.act('inventory',{intent:'craft',item_id:'axe'});
 await page.goto(base+'/watch?view=plaza');await ready(page);await page.getByRole('button',{name:'查看全景',exact:true}).click();const tree=page.getByTestId('resource-east_pine');
 await a.act('gather',{intent:'start',node_id:'east_pine'});await expect(tree).toHaveAttribute('data-resource-state','reserved');expect(raw.life.gathering.phase).toBe('approaching');
 await until(a,()=>raw.life.gathering?.phase==='working');expect(raw.position.x).toBeGreaterThanOrEqual(24);await expect(tree).toHaveAttribute('data-resource-state','working');const unit=page.getByTestId(`map-agent-${a.agent.agent_id}`);await expect(unit.locator('.pixel-tool')).toHaveAttribute('data-item','axe');
 // Both the worker and the resource retain their own visible, unforced click target.
 await tree.click();await page.getByTestId('plaza-map').screenshot({path:'artifacts/v020-tree-working.png'});
 await until(a,()=>!raw.life.gathering);expect(app.world.state.resources.nodes.east_pine.stock).toBe(2);
 for(let i=0;i<2;i++){await a.act('gather',{intent:'start',node_id:'east_pine'});await until(a,()=>!raw.life.gathering);}
 await expect(tree).toHaveAttribute('data-resource-state','depleted');await expect(tree).toHaveAttribute('data-stock','0');await expect(page.getByTestId('resource-inspector')).toContainText('等待恢复');await page.getByTestId('plaza-map').screenshot({path:'artifacts/v020-tree-depleted.png'});
 await advanceTo(a,app.world.state.resources.nodes.east_pine.regrow_at);await expect(tree).toHaveAttribute('data-resource-state','available');await expect(tree).toHaveAttribute('data-stock','1');
 await page.getByRole('button',{name:'冒险地图',exact:true}).click();await ready(page);await page.getByRole('button',{name:'查看全景',exact:true}).click();await page.getByTestId('resource-ridge_ore').click();await expect(page.getByTestId('resource-inspector')).toContainText('需要镐');await page.getByTestId('adventure-map').screenshot({path:'artifacts/v020-quarry-overview.png'});
});

test('v020昼夜断线不跳阶段，素材缺失和兼容图层保留资源只读入口',async({page,request})=>{
 await actor(request);clock=app.world.state.day_cycle.epoch_at+370000;app.world.tick();await page.route('**/api/public/events*',r=>r.abort());await page.goto(base+'/watch?view=adventure');await ready(page);await expect(page.locator('.spectator-stale')).toBeVisible();await expect(page.getByTestId('world-time')).toContainText('最近记录');const before=await hash(page);await page.waitForTimeout(500);expect(await hash(page)).toBe(before);await page.screenshot({path:'artifacts/v020-disconnected.png'});
 await page.unroute('**/api/public/events*');await page.route('**/pixel-world/props_ink.png',r=>r.abort());await page.reload();await ready(page);await expect(page.locator('.renderer-notice')).toContainText('部分场景素材未载入');await page.getByRole('button',{name:'查看全景',exact:true}).click();await page.getByTestId('resource-ridge_ore').click();await expect(page.getByTestId('resource-inspector')).toContainText('山脊矿脉');await page.screenshot({path:'artifacts/v020-partial.png'});
 await page.unroute('**/pixel-world/props_ink.png');await page.route('**/assets/phaser-renderer-*.js',r=>r.abort());await page.reload();await expect(page.getByTestId('phaser-world')).toHaveAttribute('data-renderer-state','fallback');await page.getByRole('button',{name:'查看全景',exact:true}).click();await page.getByTestId('resource-ridge_ore').click();await expect(page.getByTestId('resource-inspector')).toBeVisible();expect(await page.getByTestId('resource-deep_berries').evaluate(el=>getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');await page.screenshot({path:'artifacts/v020-fallback.png'});
});


test('v020原AI制作镐并经入口到山脊，矿脉工作使用真实工具和共享库存',async({page,request})=>{
 const a=await actor(request,'山脊采矿旅人'),raw=app.world.agent(a.agent.agent_id);await a.act('move',{x:11,y:8});await until(a,()=>!raw.movement);
 for(let i=0;i<2;i++){await a.act('gather',{intent:'start',node_id:'camp_stones'});await until(a,()=>!raw.life.gathering);}
 await a.act('inventory',{intent:'craft',item_id:'pickaxe'});expect(raw.life.tools.pickaxe.durability).toBe(12);
 await a.act('adventure_plan',{intent:'explore',zone_id:'quarry'});await until(a,()=>raw.scene_id==='adventure'&&!raw.adventure.plan);expect(raw.position.x).toBeGreaterThan(30);
 await page.goto(base+'/watch?view=adventure');await ready(page);await page.getByRole('button',{name:'查看全景',exact:true}).click();
 await a.act('gather',{intent:'start',node_id:'ridge_ore'});await until(a,()=>raw.life.gathering?.phase==='working');const node=page.getByTestId('resource-ridge_ore');await expect(node).toHaveAttribute('data-resource-state','working');await expect(page.getByTestId('adventure-agent-'+a.agent.agent_id).locator('.pixel-tool')).toHaveAttribute('data-item','pickaxe');expect(raw.life.tools.pickaxe.durability).toBe(11);
 await node.click();await expect(page.getByTestId('resource-inspector')).toContainText('山脊采矿旅人');await page.getByTestId('adventure-map').screenshot({path:'artifacts/v020-quarry-working.png'});
 await until(a,()=>!raw.life.gathering);await expect(node).toHaveAttribute('data-stock','2');expect(raw.life.inventory.ore).toBe(3);
});
