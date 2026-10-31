import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createApp} from '../../server/index.js';
let app,server,base,clock,clients;
test.beforeEach(async()=>{app=await createApp({dbPath:':memory:',authDbPath:':memory:',authMode:'local',production:true});clock=Date.now();app.world.now=()=>clock;app.world.actionIntervalMs=0;clients=[];({server,url:base}=await app.start(0));});
test.afterEach(async()=>{for(const client of clients)await client.close();await app.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
async function actor(request,name='动作镜头验证旅人'){
 const session=await(await request.get(base+'/api/session')).json();
 const api=async(path,data)=>{const response=await request.post(base+path,{headers:{Origin:base,'X-CSRF-Token':session.csrf_token||''},data});expect(response.ok(),await response.text()).toBe(true);return response.json();};
 const {agent}=await api('/api/agents',{name}),controller=await api(`/api/agents/${agent.agent_id}/controllers`,{kind:'external',name:'隔离动作验证'});
 await api(`/api/agents/${agent.agent_id}/control`,{operation:'start',controller_id:controller.controller_id,duration_minutes:15,max_calls:500,goal:'PRIVATE_V019_GOAL'});
 const client=new Client({name:'motion-browser',version:'1'},{capabilities:{}});clients.push(client);await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${controller.token}`}}}));
 const call=async(name,args={})=>{const r=await client.callTool({name,arguments:args});expect(r.isError,JSON.stringify(r.content)).not.toBe(true);return r.structuredContent||JSON.parse(r.content.find(x=>x.type==='text').text);};
 const joined=await call('join_world'),observe=()=>call('observe',{run_id:joined.run_id,session_epoch:joined.session_epoch});
 return{agent,api,observe,act:async(type,payload={})=>{const seen=await observe();const result=await call('act',{run_id:joined.run_id,session_epoch:joined.session_epoch,action_id:seen.next_action_id,type,payload});expect(result.status,JSON.stringify(result)).toBe('applied');return result;}};
}
async function ready(page){await expect(page.getByTestId('phaser-world')).toHaveAttribute('data-renderer-state','ready');await expect(page.getByTestId('phaser-canvas')).toHaveCount(1);}
async function pixels(page){return page.getByTestId('phaser-canvas').evaluate(canvas=>{const c=document.createElement('canvas');c.width=768;c.height=512;const ctx=c.getContext('2d');ctx.drawImage(canvas,0,0);let hash=2166136261,opaque=0;const colors=new Set(),data=ctx.getImageData(0,0,768,512).data;for(let i=0;i<data.length;i+=4){hash=Math.imul(hash^data[i]^data[i+1]<<8^data[i+2]<<16,16777619);if(data[i+3])opaque++;colors.add(`${data[i]},${data[i+1]},${data[i+2]}`);}return{hash,opaque,colors:colors.size};});}

test('v019镜头可缩放拖动跟随复位全屏，手机键盘操作与匿名只读',async({page,request})=>{
 const a=await actor(request,'第一位很喜欢探险的长名字旅人'),b=await actor(request,'第二位同伴');
 await a.act('say',{channel:'nearby',text:'我先看看地图，再决定向哪里走。'});
 const extras=[];for(let i=0;i<3;i++)extras.push(await actor(request,`第${i+3}位很喜欢旅行的同伴`));for(const friend of extras){const raw=app.world.agent(friend.agent.agent_id);raw.position={x:10,y:10};raw.position_at=clock;}
 const raw=app.world.agent(a.agent.agent_id);raw.position={x:10,y:10};raw.position_at=clock;app.world.agent(b.agent.agent_id).position={x:11,y:10};app.world.commit();
 const writes=[],errors=[];page.on('request',r=>{if(r.method()!=='GET')writes.push(r.url());});page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/watch?view=plaza');await ready(page);const camera=page.getByTestId('world-camera');
 expect((await pixels(page)).opaque).toBe(768*512);expect((await pixels(page)).colors).toBeGreaterThan(50);
 await page.getByTestId(`map-agent-${a.agent.agent_id}`).focus();await page.keyboard.press('Enter');await page.getByRole('button',{name:'关注角色',exact:true}).click();await expect(camera).toHaveAttribute('data-camera-mode','following');
 await page.getByRole('button',{name:'放大地图',exact:true}).click();await expect(camera).toHaveAttribute('data-camera-mode','manual');await expect(camera).toHaveAttribute('data-camera-zoom','2.50');
 const prior=Number(await camera.getAttribute('data-camera-x')),rect=await camera.boundingBox();
 await page.mouse.move(rect.x+rect.width*.52,rect.y+rect.height*.62);await page.mouse.down();await page.mouse.move(rect.x+rect.width*.65,rect.y+rect.height*.62,{steps:8});await page.mouse.up();expect(Number(await camera.getAttribute('data-camera-x'))).toBeLessThan(prior);
 await camera.focus();await page.keyboard.press('ArrowRight');await page.keyboard.press('-');await expect(camera).toHaveAttribute('data-camera-zoom','2.00');await page.keyboard.press('Home');await expect(camera).toHaveAttribute('data-camera-mode','overview');
 await page.getByRole('button',{name:'全屏观看'}).click();await expect.poll(()=>page.evaluate(()=>!!document.fullscreenElement)).toBe(true);await page.screenshot({path:'artifacts/v019-fullscreen.png'});await page.getByRole('button',{name:'退出全屏'}).click();await expect.poll(()=>page.evaluate(()=>!!document.fullscreenElement)).toBe(false);
 await page.getByRole('button',{name:'开启游戏音效'}).click();await expect(page.getByRole('button',{name:'关闭游戏音效'})).toHaveAttribute('aria-pressed','true');await page.getByRole('button',{name:'关闭游戏音效'}).click();
 for(const[width,height]of[[1440,900],[390,844],[390,900]]){
   await page.setViewportSize({width,height});await page.evaluate(()=>scrollTo(0,0));expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   const box=await camera.boundingBox();expect(box.width/box.height).toBeCloseTo(1.5,2);
   const audit=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(audit.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))).toEqual([]);
   await page.screenshot({path:`artifacts/v019-camera-${width}x${height}.png`});
 }
 // Browser pointer events exercise the actual two-touch handler, including cancellation.
 await camera.evaluate(el=>{const r=el.getBoundingClientRect();for(const[id,x]of[[10,.3],[11,.7]])el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:id,pointerType:'touch',button:0,clientX:r.x+r.width*x,clientY:r.y+r.height*.5}));el.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:11,pointerType:'touch',button:0,clientX:r.x+r.width*.9,clientY:r.y+r.height*.5}));for(const id of[10,11])el.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,pointerId:id,pointerType:'touch',button:0}));});
 await expect(camera).toHaveAttribute('data-camera-zoom','1.50');await page.getByRole('button',{name:'镜头复位'}).click();await expect(camera).toHaveAttribute('data-camera-zoom','1.00');
 await expect(page.locator('.resident-list')).toHaveCount(0);await expect(page.getByLabel('观察对象',{exact:true})).toHaveCount(0);expect(writes).toEqual([]);expect(errors).toEqual([]);await expect(page.locator('body')).not.toContainText('PRIVATE_V019_GOAL');
});

test('v019真实走跑与镜头名牌同位置，断线和减少动态效果停止动画',async({page,request})=>{
 const a=await actor(request);const raw=app.world.agent(a.agent.agent_id);raw.position={x:9,y:10};raw.position_at=clock;raw.life.inventory.iron_sword=1;raw.life.inventory.iron_armor=1;raw.life.equipment={weapon:'iron_sword',armor:'iron_armor'};app.world.commit();
 await page.goto(base+'/watch?view=plaza');await ready(page);const unit=page.getByTestId(`map-agent-${a.agent.agent_id}`),sprite=unit.locator('.pixel-character'),camera=page.getByTestId('world-camera');
 await unit.click();await page.getByRole('button',{name:'关注角色',exact:true}).click();
 app.world.now=Date.now;raw.last_contact_at=Date.now();const initial=await pixels(page);await a.act('move',{x:12,y:10,mode:'run'});
 await expect(sprite).toHaveAttribute('data-action','run');await expect(sprite).toHaveAttribute('data-facing','east');
 await expect.poll(()=>pixels(page).then(p=>p.hash)).not.toBe(initial.hash);
 const same=await camera.evaluate(el=>{const actor=el.querySelector('.world-actor');return {camera:Number(el.dataset.cameraX),actor:parseFloat(actor.style.left)/100};});expect(Math.abs(same.camera-same.actor)).toBeLessThan(.006);
 await page.screenshot({path:'artifacts/v019-running-follow.png'});
 await expect.poll(()=>app.world.agent(a.agent.agent_id).position.x).toBe(12);
 await page.emulateMedia({reducedMotion:'reduce'});await expect(sprite.locator('.pixel-sprite').first()).toHaveAttribute('data-playing','false');
 await page.emulateMedia({reducedMotion:'no-preference'});await page.route('**/api/public/events*',route=>route.abort());await page.reload();await ready(page);await expect(page.locator('.spectator-stale')).toBeVisible();
 const still=await pixels(page);await page.waitForTimeout(400);expect(await pixels(page)).toEqual(still);await page.screenshot({path:'artifacts/v019-disconnected.png'});
});

test('v019真实图集方向、攻击关键姿势、装备同锚点与怪物场景截图',async({page,request})=>{
 const a=await actor(request),raw=app.world.agent(a.agent.agent_id);raw.scene_id='adventure';raw.position={x:11,y:8};raw.position_at=clock;raw.life.inventory.iron_sword=1;raw.life.inventory.iron_armor=1;raw.life.equipment={weapon:'iron_sword',armor:'iron_armor'};app.world.commit();
 await page.goto(base+'/watch?view=adventure');await ready(page);expect((await pixels(page)).opaque).toBe(768*512);await expect(page.locator('.adventure-monster')).toHaveCount(3);await page.screenshot({path:'artifacts/v019-adventure-monsters.png'});
 // Contact sheet uses the very same shipped textures/atlas and directional mirrors.
 await page.evaluate(async()=>{
   const m=await(await fetch('/pixel-world/manifest.json')).json(),cache=new Map();
   async function load(def){if(!cache.has(def.image)){const img=new Image();img.src=def.image;await img.decode();cache.set(def.image,img);}return cache.get(def.image);}
   const canvas=document.createElement('canvas');canvas.id='v019-contact-sheet';canvas.width=1120;canvas.height=1170;canvas.style='position:fixed;inset:0;z-index:99999;width:1120px;height:1170px;background:#e9e4cd';document.body.append(canvas);const ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=false;ctx.fillStyle='#e9e4cd';ctx.fillRect(0,0,1120,1170);ctx.font='16px sans-serif';ctx.fillStyle='#294638';ctx.fillText('v0.19 shipped atlas · body + armor + sword · same foot/hand anchors',20,26);
   const dirs=['south','north','east','west'],rows=[['idle',0],['walk',0],['walk',2],['run',0],['run',1],['run',2],['attack',0],['attack',1],['attack',2],['attack',3],['hurt',1],['water',2]];
   async function draw(def,action,direction,index,x,y){const frames=(def.animations[`${action}_${direction==='west'?'east':direction}`]||def.animations[action]).frames,f=frames[index%frames.length],img=await load(def);ctx.save();ctx.translate(x+(direction==='west'?96:0),y);ctx.scale(direction==='west'?-2:2,2);ctx.drawImage(img,f.x,f.y,f.w,f.h,0,0,48,48);ctx.restore();}
   for(let row=0;row<rows.length;row++){const[action,index]=rows[row],y=43+row*88;ctx.fillStyle='#294638';ctx.fillText(`${action} ${index}`,15,y+40);for(let col=0;col<4;col++){const d=dirs[col],x=150+col*210;ctx.fillText(d,x+100,y+40);if(d==='north')await draw(m.equipment.iron_sword,action,d,index,x,y);await draw(m.characters.wanderer_1,action,d,index,x,y);await draw(m.equipment.iron_armor,action,d,index,x,y);if(d!=='north')await draw(m.equipment.iron_sword,action,d,index,x,y);if(action==='water')await draw(m.tools.watering_can_2,action,d,index,x,y);}}
 });
 await page.locator('#v019-contact-sheet').screenshot({path:'artifacts/v019-motion-contact.png'});
});

test('v019画布按权威攻击阶段选帧，未结算不假命中，受击与取消均准确',async({page,request})=>{
 const a=await actor(request),raw=app.world.agent(a.agent.agent_id);raw.scene_id='adventure';raw.position={x:11,y:8};raw.position_at=clock;
 // This is a renderer contract fixture; engine settlement is tested independently.
 raw.position={x:11,y:9};raw.life.inventory.iron_sword=1;raw.life.inventory.iron_armor=1;raw.life.equipment={weapon:'iron_sword',armor:'iron_armor'};app.world.tick=()=>{};app.world.commit();await page.goto(base+'/watch?view=adventure');await ready(page);
 await page.getByTestId(`adventure-agent-${a.agent.agent_id}`).click();await page.getByRole('button',{name:'关注角色',exact:true}).click();
 await page.clock.install({time:new Date(clock-1000)});await page.clock.pauseAt(new Date(clock));
 const sprite=page.getByTestId(`adventure-agent-${a.agent.agent_id}`).locator('.pixel-character');
 const publish=async action=>{raw.action=action;app.world.commit();await page.clock.runFor(34);};
 const attack={action_id:'visual-timeline',type:'attack',scene_id:'adventure',target_id:'forest_slime',target_kind:'monster',facing:'north',started_at:clock-80,impact_at:clock+400,ends_at:clock+1200,phase:'prepare',outcome:null,damage:0,resolved_at:null};
 await publish(attack);await expect(sprite).toHaveAttribute('data-action','attack');await expect(sprite).toHaveAttribute('data-facing','north');await expect(sprite.locator('.pixel-sprite').first()).toHaveAttribute('data-pose-frame','0');
 await page.clock.runFor(220);await expect(sprite.locator('.pixel-sprite').first()).toHaveAttribute('data-pose-frame','1');
 await page.clock.runFor(220);await expect(sprite.locator('.pixel-sprite').first()).toHaveAttribute('data-pose-frame','1');await expect(sprite).not.toHaveAttribute('data-action-outcome','hit');
 const beforeHit=await pixels(page);clock+=500;await publish({...attack,phase:'recovery',outcome:'hit',damage:6,resolved_at:clock});await expect(sprite.locator('.pixel-sprite').first()).toHaveAttribute('data-pose-frame','2');
 await page.clock.runFor(34);await expect.poll(()=>pixels(page).then(p=>p.hash)).not.toBe(beforeHit.hash);await page.screenshot({path:'artifacts/v019-confirmed-hit.png'});
 clock+=200;await publish({...attack,phase:'recovery',outcome:'miss',damage:0,resolved_at:clock});await expect(sprite.locator('.pixel-sprite').first()).toHaveAttribute('data-pose-frame','3');
 raw.hurt={action_id:'actual-incoming-hit',started_at:clock,ends_at:clock+600,damage:4};await publish(null);await expect(sprite).toHaveAttribute('data-action','hurt');await expect(page.locator('.combat-number')).toContainText('4');
 raw.hurt=null;await publish({...attack,outcome:'cancelled',phase:'cancelled'});await expect(sprite).toHaveAttribute('data-action','idle');await expect(page.locator('.combat-number')).toHaveCount(0);await page.clock.resume();
});
