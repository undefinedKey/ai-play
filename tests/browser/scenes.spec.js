import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../../server/index.js';
let app,server,base,clock,clients,actors;
test.beforeEach(async()=>{app=await createApp({dbPath:':memory:',authDbPath:':memory:',authMode:'local',production:true});clock=Date.now();app.world.now=()=>clock;app.world.actionIntervalMs=0;clients=[];actors=[];({server,url:base}=await app.start(0));});
test.afterEach(async()=>{for(const c of clients)await c.close();await app.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
async function actor(request,name){
 const session=await(await request.get(base+'/api/session')).json();
 const api=async(path,data)=>{const r=await request.post(base+path,{headers:{Origin:base,'X-CSRF-Token':session.csrf_token||''},data});expect(r.ok(),await r.text()).toBe(true);return r.json();};
 const {agent}=await api('/api/agents',{name});const controller=await api(`/api/agents/${agent.agent_id}/controllers`,{kind:'external',name:'隔离场景测试'});
 await api(`/api/agents/${agent.agent_id}/control`,{operation:'start',controller_id:controller.controller_id,duration_minutes:15,max_calls:300,goal:'PRIVATE_SCENE_OWNER_GOAL'});
 const c=new Client({name:'scene-browser',version:'1'},{capabilities:{}});clients.push(c);await c.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${controller.token}`}}}));
 const call=async(name,args={})=>{const r=await c.callTool({name,arguments:args});expect(r.isError,JSON.stringify(r.content)).not.toBe(true);return r.structuredContent||JSON.parse(r.content.find(x=>x.type==='text').text);};
 const joined=await call('join_world');const observe=()=>call('observe',{run_id:joined.run_id,session_epoch:joined.session_epoch});
 const result={agent,api,observe,act:async(type,payload={})=>{const seen=await observe();const r=await call('act',{run_id:joined.run_id,session_epoch:joined.session_epoch,action_id:seen.next_action_id,type,payload});expect(r.status,JSON.stringify(r)).toBe('applied');return r;}};actors.push(result);return result;
}
async function stepUntil(predicate,max=80){for(let i=0;i<max&&!predicate();i++){clock+=1000;app.world.tick();for(const a of actors)await a.observe();}expect(predicate()).toBe(true);}
async function capture(page,name){for(const[width,height]of[[1440,900],[390,844],[390,900]]){await page.setViewportSize({width,height});await page.evaluate(()=>scrollTo(0,0));const stage=page.getByTestId('world-camera');const rect=await stage.boundingBox();expect(rect.width/rect.height).toBeCloseTo(1.5,2);expect(rect.y).toBeLessThan(width===390?270:220);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),JSON.stringify(await page.evaluate(()=>[...document.querySelectorAll("body *")].filter(e=>e.getBoundingClientRect().right>innerWidth+1).map(e=>[e.className,e.getBoundingClientRect().right]).slice(0,15)))).toBe(true);await expect(page.locator('.pixel-scene-image').first()).toHaveJSProperty('complete',true);const audit=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(audit.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))).toEqual([]);await page.screenshot({path:`artifacts/scenes-v017-${name}-${width}x${height}.png`});await stage.screenshot({path:`artifacts/scenes-v017-${name}-${width}x${height}-map.png`});}}

test('独立场景真实入口往返，旁观切换不移动、空场不宣称世界无人、镜头和发言隔离',async({page,request})=>{
 const a=await actor(request,'往返林地的旅人'),id=a.agent.agent_id;const raw=()=>app.world.agent(id);
 await a.act('say',{channel:'nearby',text:'这是广场岸边的公开发言。'});
 const calls=[];page.on('request',req=>{if(req.method()==='POST')calls.push(req.url());});
 await page.goto(base+'/watch?view=plaza');await expect(page.getByTestId(`map-agent-${id}`)).toBeVisible();await expect(page.getByTestId('speech-cloud')).toContainText('广场岸边');
 await page.getByRole('button',{name:'关注角色',exact:true}).click();await expect(page.getByTestId('world-camera')).toHaveAttribute('data-camera-mode','following');
 const before={...raw().position};await page.getByRole('button',{name:'冒险地图',exact:true}).click();expect(raw().position).toEqual(before);expect(raw().scene_id).toBe('plaza');expect(calls).toEqual([]);
 await expect(page.getByTestId('world-camera')).toHaveAttribute('data-camera-mode','overview');await expect(page.locator('.world-actor')).toHaveCount(0);await expect(page.getByTestId('speech-cloud')).toHaveCount(0);await expect(page.locator('.scene-elsewhere')).toContainText('生活广场');await expect(page.getByTestId('adventure-empty-banner')).toContainText('0 位 AI');
 await capture(page,'adventure-empty');
 await a.act('adventure_plan',{intent:'explore',zone_id:'forest'});let observedPath=false;
 for(let i=0;i<80&&raw().scene_id!=='adventure';i++){clock+=1000;app.world.tick();await a.observe();if(raw().movement?.path?.length>1)observedPath=true;}
 expect(observedPath).toBe(true);expect(raw().scene_id).toBe('adventure');await expect(page.getByTestId(`adventure-agent-${id}`)).toBeVisible();await expect(page.getByTestId('speech-cloud')).toHaveCount(0);
 await a.act('say',{channel:'nearby',text:'穿过入口，终于到林地了。'});await expect(page.getByTestId('speech-cloud')).toContainText('终于到林地');
 await page.getByRole('button',{name:'关注角色',exact:true}).click();await a.act('adventure_plan',{intent:'rest'});await stepUntil(()=>raw().scene_id==='plaza');
 await expect(page.getByTestId('world-camera')).toHaveAttribute('data-camera-mode','overview');await expect(page.getByTestId(`adventure-agent-${id}`)).toHaveCount(0);await expect(page.getByTestId('speech-cloud')).toHaveCount(0);await page.getByRole('button',{name:'查看所在地',exact:true}).click();await expect(page.getByTestId(`map-agent-${id}`)).toBeVisible();
 await expect(page.locator('body')).not.toContainText('PRIVATE_SCENE_OWNER_GOAL');
});

test('五位原角色、同格长名、真实脚底遮挡、场景比例和只读农田近景',async({page,request})=>{
 const people=[];for(let i=0;i<5;i++)people.push(await actor(request,i<2?'同名的长名字林间旅行者':'世界朋友'+i));
 for(const a of people)await a.act('say',{channel:'nearby',text:'我们在广场相遇，这是本人公开说的话。'});
 await page.goto(base+'/watch?view=plaza');await expect(page.locator('.world-actor')).toHaveCount(5);await expect(page.getByTestId('speech-cloud')).toHaveCount(5);await capture(page,'plaza-five');
 // Explicit spatial fixture tests depth on each side of the same authoritative tree.
 const one=app.world.agent(people[0].agent.agent_id),two=app.world.agent(people[1].agent.agent_id);one.position={x:5,y:5};two.position={x:5,y:7};one.movement=null;two.movement=null;app.world.tick();
 await page.reload();const behind=page.getByTestId(`map-agent-${one.agent_id}`),front=page.getByTestId(`map-agent-${two.agent_id}`),tree=page.locator('[data-prop-id="village_tree_2"]');
 expect(await behind.evaluate(el=>Number(getComputedStyle(el).zIndex))).toBeLessThan(await tree.evaluate(el=>Number(getComputedStyle(el).zIndex)));
 expect(await front.evaluate(el=>Number(getComputedStyle(el).zIndex))).toBeGreaterThan(await tree.evaluate(el=>Number(getComputedStyle(el).zIndex)));
 await page.getByLabel('观察对象',{exact:true}).selectOption(one.agent_id);expect(await behind.evaluate(el=>Number(getComputedStyle(el).zIndex))).toBeLessThan(await tree.evaluate(el=>Number(getComputedStyle(el).zIndex)));
 const move=await people[0].act('move',{x:6,y:6});expect(move.path?.length||move.result?.path?.length).toBeGreaterThan(1);await capture(page,'plaza-depth');
 await people[4].act('adventure_plan',{intent:'explore',zone_id:'forest'});await stepUntil(()=>app.world.agent(people[4].agent.agent_id).scene_id==='adventure');
 await page.getByLabel('观察对象',{exact:true}).selectOption(people[4].agent.agent_id);await page.getByRole('button',{name:'农作区',exact:true}).click();await expect(page.getByTestId('farm-present-agent')).toHaveCount(0);await expect(page.locator('.scene-elsewhere')).toContainText('林地冒险');
 await page.getByRole('button',{name:'查看所在地',exact:true}).click();await expect(page.locator('.adventure-agent')).toHaveCount(1);await capture(page,'adventure-active');
});

test('加载、资源缺失、断线及失败重试均诚实反馈，旁观没有角色操作权限',async({page,request})=>{
 const a=await actor(request,'状态验证旅人');let release;
 await page.route('**/api/public/world',async route=>{await new Promise(resolve=>{release=resolve;});await route.continue();});
 const loading=page.goto(base+'/watch?view=plaza');await expect(page.getByText('正在打开旁观窗口…')).toBeVisible();await page.screenshot({path:'artifacts/scenes-v017-loading.png'});release();await loading;await page.unroute('**/api/public/world');await expect(page.getByTestId(`map-agent-${a.agent.agent_id}`)).toBeVisible();
 await page.route('**/pixel-world/manifest.json*',async route=>{const response=await route.fetch(),json=await response.json();delete json.props.bookshop;await route.fulfill({response,json});});await page.reload();await expect(page.getByText('部分场景素材未载入 · 角色位置仍按服务器记录显示')).toBeVisible();await expect(page.getByTestId(`map-agent-${a.agent.agent_id}`)).toBeVisible();await page.screenshot({path:'artifacts/scenes-v017-partial.png'});await page.unroute('**/pixel-world/manifest.json*');
 await page.route('**/api/public/events*',route=>route.abort('connectionfailed'));await page.reload();await expect(page.locator('.spectator-stale')).toContainText('最近收到');await expect(page.getByTestId(`map-agent-${a.agent.agent_id}`).locator('.pixel-sprite').first()).toHaveAttribute('data-playing','false');await page.screenshot({path:'artifacts/scenes-v017-disconnected.png'});
 await page.route('**/api/public/world',route=>route.abort('connectionfailed'));await page.reload();await expect(page.getByRole('alert')).toContainText('暂时看不到广场');await page.screenshot({path:'artifacts/scenes-v017-error.png'});await page.unroute('**/api/public/world');await page.unroute('**/api/public/events*');await page.getByRole('button',{name:'重新连接',exact:true}).click();await expect(page.getByTestId(`map-agent-${a.agent.agent_id}`)).toBeVisible();
 await expect(page.getByRole('button',{name:/^(攻击|穿过入口|移动角色|播种|浇水)$/})).toHaveCount(0);await expect(page.locator('footer')).toContainText('旁观只读');await page.emulateMedia({reducedMotion:'reduce'});await page.getByRole('button',{name:'关注角色',exact:true}).focus();await page.keyboard.press('Enter');await expect(page.getByTestId('world-camera')).toHaveAttribute('data-camera-mode','following');expect(await page.locator('.world-camera-layer').evaluate(el=>getComputedStyle(el).transitionDuration)).toBe('0s');
});

test('真实拐弯回执逐段呈现，不直穿树干；减少动态直接使用确认落点',async({page,request})=>{
 const a=await actor(request,'沿着道路走的旅人'),raw=app.world.agent(a.agent.agent_id);
 // Only the initial position is an explicit isolated fixture; the route below is server-computed.
 raw.position={x:5,y:5};raw.movement=null;app.world.commit();
 await page.clock.install({time:new Date(clock)});await page.clock.pauseAt(new Date(clock));await page.goto(base+'/watch?view=plaza');
 const unit=page.getByTestId(`map-agent-${a.agent.agent_id}`);await expect(unit).toBeVisible();const receipt=await a.act('move',{x:6,y:6});
 expect(receipt.path).toEqual([{x:5,y:5},{x:6,y:5},{x:6,y:6}]);await expect(unit).toHaveAttribute('data-foot-y','5');
 const point=()=>unit.evaluate(el=>({x:parseFloat(el.style.left)/100*24-.5,y:parseFloat(el.style.top)/100*16-.5}));
 await page.clock.runFor(100);const first=await point();expect(first.x).toBeGreaterThan(5);expect(first.x).toBeLessThan(6);expect(first.y).toBeCloseTo(5,4);
 await page.clock.runFor(200);const second=await point();expect(second.x).toBeCloseTo(6,4);expect(second.y).toBeGreaterThan(5);expect(second.y).toBeLessThan(6);
 await page.emulateMedia({reducedMotion:'reduce'});await expect(unit).toHaveAttribute('data-foot-y','6');await expect(unit.locator('.pixel-sprite').first()).toHaveAttribute('data-playing','false');
});
