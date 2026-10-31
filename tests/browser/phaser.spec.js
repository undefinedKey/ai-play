import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createApp} from '../../server/index.js';
let app,server,base,clock,clients;
test.beforeEach(async()=>{app=await createApp({dbPath:':memory:',authDbPath:':memory:',authMode:'local',production:true});clock=Date.now();app.world.now=()=>clock;app.world.actionIntervalMs=0;clients=[];({server,url:base}=await app.start(0));});
test.afterEach(async()=>{for(const client of clients)await client.close();await app.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
async function actor(request,name='真实画布旅人'){
 const session=await(await request.get(base+'/api/session')).json();
 const api=async(path,data)=>{const response=await request.post(base+path,{headers:{Origin:base,'X-CSRF-Token':session.csrf_token||''},data});expect(response.ok(),await response.text()).toBe(true);return response.json();};
 const {agent}=await api('/api/agents',{name}),controller=await api(`/api/agents/${agent.agent_id}/controllers`,{kind:'external',name:'隔离画布验证'});
 await api(`/api/agents/${agent.agent_id}/control`,{operation:'start',controller_id:controller.controller_id,duration_minutes:15,max_calls:500,goal:'PRIVATE_PHASER_GOAL'});
 const client=new Client({name:'phaser-browser',version:'1'},{capabilities:{}});clients.push(client);await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${controller.token}`}}}));
 const call=async(name,args={})=>{const r=await client.callTool({name,arguments:args});expect(r.isError,JSON.stringify(r.content)).not.toBe(true);return r.structuredContent||JSON.parse(r.content.find(x=>x.type==='text').text);};
 const joined=await call('join_world'),observe=()=>call('observe',{run_id:joined.run_id,session_epoch:joined.session_epoch});
 return{agent,api,observe,act:async(type,payload={})=>{const seen=await observe();const result=await call('act',{run_id:joined.run_id,session_epoch:joined.session_epoch,action_id:seen.next_action_id,type,payload});expect(result.status,JSON.stringify(result)).toBe('applied');return result;}};
}
async function ready(page){await expect(page.getByTestId('phaser-world')).toHaveAttribute('data-renderer-state','ready');await expect(page.getByTestId('phaser-canvas')).toHaveCount(1);}
async function pixels(page,rect=[0,0,768,512]){return page.getByTestId('phaser-canvas').evaluate((canvas,[x,y,w,h])=>{const target=document.createElement('canvas');target.width=768;target.height=512;const ctx=target.getContext('2d');ctx.drawImage(canvas,0,0);const data=ctx.getImageData(x,y,w,h).data;let hash=2166136261,opaque=0;for(let i=0;i<data.length;i++){hash=Math.imul(hash^data[i],16777619);if(i%4===3&&data[i])opaque++;}return{hash:hash>>>0,opaque};},rect);}
async function capture(page,name){for(const[width,height]of[[1440,900],[390,844],[390,900]]){await page.setViewportSize({width,height});await page.evaluate(()=>scrollTo(0,0));await ready(page);const map=await page.getByTestId('world-camera').boundingBox();expect(map.width/map.height).toBeCloseTo(1.5,2);expect(map.y).toBeLessThan(width===390?270:220);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);const audit=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(audit.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))).toEqual([]);await page.screenshot({path:`artifacts/phaser-v018-${name}-${width}x${height}.png`});await page.getByTestId('phaser-canvas').screenshot({path:`artifacts/phaser-v018-${name}-${width}x${height}-canvas.png`});}}

test('Phaser真实画布绘制地面物件人物装备，真实移动改变像素，切换销毁且不操作AI',async({page,request})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/watch?view=plaza');await ready(page);
 expect((await pixels(page)).opaque).toBe(768*512);
 const bare=await pixels(page);
 const a=await actor(request);await expect(page.getByTestId(`map-agent-${a.agent.agent_id}`)).toBeVisible();
 await expect.poll(async()=>(await pixels(page)).hash).not.toBe(bare.hash);
 await a.act('move',{x:11,y:8});clock+=2000;await a.observe();app.world.tick();await expect(page.getByTestId(`map-agent-${a.agent.agent_id}`).locator('.pixel-character')).toHaveAttribute('data-action','idle');const raw=app.world.agent(a.agent.agent_id);raw.life.inventory.wooden_sword=1;app.world.commit();
 const beforeGear=await pixels(page);await a.act('inventory',{intent:'equip',item_id:'wooden_sword'});
 await expect.poll(async()=>(await pixels(page)).hash).not.toBe(beforeGear.hash);
 const beforeMove=await pixels(page);const receipt=await a.act('move',{x:12,y:8});expect(receipt.path.length).toBeLessThanOrEqual(4);
 await expect.poll(async()=>(await pixels(page)).hash).not.toBe(beforeMove.hash);
 const fixed=JSON.stringify({scene:raw.scene_id,position:raw.position});const old=await page.getByTestId('phaser-canvas').elementHandle();
 await page.getByRole('button',{name:'冒险地图',exact:true}).click();await ready(page);expect(await old.evaluate(el=>el.isConnected)).toBe(false);expect(JSON.stringify({scene:raw.scene_id,position:raw.position})).toBe(fixed);await expect(page.locator('.world-actor')).toHaveCount(0);expect((await pixels(page)).hash).not.toBe(beforeMove.hash);
 await capture(page,'forest-empty');
 for(let i=0;i<3;i++){await page.getByRole('button',{name:'社交广场',exact:true}).click();await ready(page);await page.getByRole('button',{name:'农作区',exact:true}).click();await expect(page.getByTestId('phaser-canvas')).toHaveCount(0);await page.getByRole('button',{name:'冒险地图',exact:true}).click();await ready(page);}
 await page.getByRole('button',{name:'社交广场',exact:true}).click();await ready(page);await capture(page,'plaza-active');expect(errors).toEqual([]);
});

test('画布加载、网络失败、兼容图层重试及缺失纹理均明确反馈',async({page,request})=>{
 await actor(request,'等待画布的原角色');
 let release;await page.route('**/assets/phaser-renderer-*.js',async route=>{await new Promise(resolve=>{release=resolve;});await route.abort();});
 await page.goto(base+'/watch?view=plaza');await expect(page.getByText('游戏画布载入中…',{exact:true})).toBeVisible();await page.screenshot({path:'artifacts/phaser-v018-loading.png'});release();
 await expect(page.getByTestId('phaser-world')).toHaveAttribute('data-renderer-state','fallback');await expect(page.getByText(/当前为兼容图层显示/)).toBeVisible();await expect(page.getByTestId('phaser-canvas')).toHaveCount(0);await page.screenshot({path:'artifacts/phaser-v018-fallback.png'});
 await page.unroute('**/assets/phaser-renderer-*.js');await page.getByRole('button',{name:'重试游戏画布'}).click();await ready(page);
 await page.route('**/pixel-world/bookshop.png',route=>route.abort());await page.reload();await ready(page);await expect(page.getByText('部分场景素材未载入 · 已保留可用画面和真实位置')).toBeVisible();expect((await pixels(page)).opaque).toBe(768*512);await page.screenshot({path:'artifacts/phaser-v018-partial.png'});
 await page.unroute('**/pixel-world/bookshop.png');await page.reload();await ready(page);
 await page.getByTestId('phaser-canvas').evaluate(canvas=>canvas.dispatchEvent(new Event('webglcontextlost')));await expect(page.getByTestId('phaser-world')).toHaveAttribute('data-renderer-state','fallback');await page.getByRole('button',{name:'重试游戏画布'}).click();await ready(page);
 await page.addInitScript(()=>{const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){return /webgl/i.test(type)?null:original.call(this,type,...args);};});await page.reload();await ready(page);expect(await page.getByTestId('phaser-canvas').evaluate(canvas=>!!canvas.getContext('2d'))).toBe(true);expect((await pixels(page)).opaque).toBe(768*512);
});

test('当前场景和整个世界同步可切换，公开名册仍完整，重连取得对应场景新快照',async({page,request})=>{
 const a=await actor(request,'广场发言者'),b=await actor(request,'林地发言者');
 const raw=app.world.agent(b.agent.agent_id);raw.scene_id='adventure';raw.position={x:11,y:8};raw.movement=null;app.world.commit();
 await a.act('say',{channel:'nearby',text:'只在广场收到的公开话。'});await b.act('say',{channel:'nearby',text:'只在林地收到的公开话。'});
 const streams=[];page.on('request',req=>{if(req.url().includes('/api/public/events?'))streams.push(req.url());});
 await page.goto(base+'/watch?view=plaza');await ready(page);await expect(page.locator('.resident-list')).toHaveCount(0);await expect(page.getByLabel('观察对象',{exact:true})).toHaveCount(0);const roster=await(await request.get(base+'/api/public/world?scene=plaza')).json();expect(roster.agents.map(agent=>agent.name)).toContain('林地发言者');await expect.poll(()=>streams.at(-1)).toContain('scene=plaza');await expect(page.getByTestId(`map-agent-${a.agent.agent_id}`)).toBeVisible();
 await page.getByRole('button',{name:'冒险地图',exact:true}).click();await ready(page);await expect.poll(()=>streams.at(-1)).toContain('scene=adventure');await expect(page.getByTestId(`adventure-agent-${b.agent.agent_id}`)).toBeVisible();
 await page.getByLabel('动态范围',{exact:true}).selectOption('world');await expect.poll(()=>streams.at(-1)).not.toContain('scene=');
 await a.act('say',{channel:'nearby',text:'整个世界范围能收到这句话。'});await expect(page.getByRole('log')).toContainText('整个世界范围能收到这句话。');
 await page.getByLabel('动态范围',{exact:true}).selectOption('scene');await expect.poll(()=>streams.at(-1)).toContain('scene=adventure');
 await page.route('**/api/public/events*',route=>route.abort());await page.reload();await expect(page.locator('.spectator-stale')).toBeVisible();await page.unroute('**/api/public/events*');await expect.poll(()=>streams.filter(url=>url.includes('scene=adventure')).length).toBeGreaterThan(2);await expect(page.locator('.spectator-stale')).toHaveCount(0);
 await expect(page.locator('body')).not.toContainText('PRIVATE_PHASER_GOAL');await expect(page.getByRole('button',{name:/^(攻击|移动角色|穿过入口)$/})).toHaveCount(0);
});

test('画布像素沿真实折线路径逐段移动，减少动态停止播放且断线不假扮实时活动',async({page,request})=>{
 await page.clock.install({time:new Date(clock)});
 await page.goto(base+'/watch?view=plaza');await ready(page);
 const baseline=await page.getByTestId('phaser-canvas').evaluate(canvas=>{const c=document.createElement('canvas');c.width=768;c.height=512;const ctx=c.getContext('2d');ctx.drawImage(canvas,0,0);return Array.from(ctx.getImageData(260,270,150,120).data);});
 const a=await actor(request,'折线画布验证者');const raw=app.world.agent(a.agent.agent_id);raw.position={x:9,y:10};raw.movement=null;app.world.commit();
 await expect(page.getByTestId(`map-agent-${a.agent.agent_id}`)).toHaveAttribute('data-foot-y','10');
 await page.waitForTimeout(100);clock=await page.evaluate(()=>Date.now())+10;await page.clock.pauseAt(new Date(clock));
 const bounds=()=>page.getByTestId('phaser-canvas').evaluate((canvas,before)=>{const c=document.createElement('canvas');c.width=768;c.height=512;const ctx=c.getContext('2d');ctx.drawImage(canvas,0,0);const data=ctx.getImageData(260,270,150,120).data;let minX=150,maxX=-1,minY=120,maxY=-1;for(let i=0;i<data.length;i+=4){if(data[i]!==before[i]||data[i+1]!==before[i+1]||data[i+2]!==before[i+2]){const x=i/4%150,y=Math.floor(i/4/150);minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}}return{x:260+(minX+maxX)/2,y:270+(minY+maxY)/2,count:maxX>=0};},baseline);
 const initial=await bounds();expect(initial.count).toBe(true);
 const receipt=await a.act('move',{x:10,y:11});expect(receipt.path).toEqual([{x:9,y:10},{x:10,y:10},{x:10,y:11}]);await expect(page.getByTestId(`map-agent-${a.agent.agent_id}`).locator('.pixel-character')).toHaveAttribute('data-action','walk');
 await expect(page.getByTestId(`map-agent-${a.agent.agent_id}`)).toHaveAttribute('data-foot-y','10');
 await page.clock.runFor(100);await expect.poll(()=>page.getByTestId(`map-agent-${a.agent.agent_id}`).evaluate(el=>parseFloat(el.style.left))).toBeGreaterThan(40);await page.clock.runFor(20);const first=await bounds();expect(first.x-initial.x).toBeGreaterThan(8);expect(first.x-initial.x).toBeLessThan(25);expect(Math.abs(first.y-initial.y)).toBeLessThan(5);
 await page.clock.runFor(200);await page.clock.runFor(20);const second=await bounds();expect(second.x-initial.x).toBeGreaterThan(27);expect(second.x-initial.x).toBeLessThan(37);expect(second.y-first.y).toBeGreaterThan(8);
 await page.emulateMedia({reducedMotion:'reduce'});await expect(page.getByTestId(`map-agent-${a.agent.agent_id}`).locator('.pixel-sprite').first()).toHaveAttribute('data-playing','false');await page.clock.runFor(120);const still=await pixels(page);await page.clock.runFor(400);expect(await pixels(page)).toEqual(still);
 await page.clock.resume();await page.emulateMedia({reducedMotion:'no-preference'});await a.act('move',{x:10,y:9});await a.act('gather',{intent:'start',resource_id:'wood'});
 await expect(page.getByTestId(`map-agent-${a.agent.agent_id}`).locator('.pixel-character')).toHaveAttribute('data-action','gather');
 // Drive the browser visibility event without changing server state or time.
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});const hidden=await pixels(page);await page.waitForTimeout(450);expect(await pixels(page)).toEqual(hidden);
 await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});await expect(page.getByTestId(`map-agent-${a.agent.agent_id}`).locator('.pixel-sprite').first()).toHaveAttribute('data-playing','true');
 await page.route('**/api/public/events*',route=>route.abort());await page.reload();await ready(page);await expect(page.locator('.spectator-stale')).toBeVisible();const disconnected=await pixels(page);await page.waitForTimeout(1200);expect(await pixels(page)).toEqual(disconnected);
 await page.screenshot({path:'artifacts/phaser-v018-disconnected.png'});
});
