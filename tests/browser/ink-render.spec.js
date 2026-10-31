import {test,expect} from '@playwright/test';
import {assertCanvasResolution} from './canvas-assertions.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createApp} from '../../server/index.js';
import {drawInkContactSheet} from './ink-contact-sheet.js';
let app,server,base,clients;
test.beforeEach(async()=>{app=await createApp({dbPath:':memory:',authDbPath:':memory:',authMode:'local',production:true});app.world.actionIntervalMs=0;app.world.tick=()=>{};clients=[];({server,url:base}=await app.start(0));});
test.afterEach(async()=>{for(const client of clients)await client.close();await app.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
async function actor(request,index,sprite,x,y=10){
 const session=await(await request.get(base+'/api/session')).json();
 const api=async(path,data)=>{const response=await request.post(base+path,{headers:{Origin:base,'X-CSRF-Token':session.csrf_token||''},data});expect(response.ok(),await response.text()).toBe(true);return response.json();};
 const{agent}=await api('/api/agents',{name:`墨线验证${index}`}),controller=await api(`/api/agents/${agent.agent_id}/controllers`,{kind:'external',name:'隔离美术验证'});
 await api(`/api/agents/${agent.agent_id}/control`,{operation:'start',controller_id:controller.controller_id,duration_minutes:15,max_calls:100,goal:'TEST_PRIVATE_INK_GOAL'});
 const client=new Client({name:'ink-render-test',version:'1'},{capabilities:{}});clients.push(client);await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${controller.token}`}}}));const joined=await client.callTool({name:'join_world',arguments:{}});expect(joined.isError,JSON.stringify(joined.content)).not.toBe(true);
 const raw=app.world.agent(agent.agent_id);raw.appearance.sprite_id=sprite;raw.position={x,y};raw.position_at=Date.now();raw.life.inventory.iron_sword=1;raw.life.inventory.iron_armor=1;raw.life.equipment={weapon:'iron_sword',armor:'iron_armor'};return raw;
}
const ready=async page=>{await expect(page.getByTestId('phaser-world')).toHaveAttribute('data-renderer-state','ready');await assertCanvasResolution(page);};

test('v022手绘图集按需加载，新增准备帧保持权威动作，兼容图层与持物足点相同',async({page,request})=>{
 const a=await actor(request,1,'wanderer_1',10),b=await actor(request,2,'wanderer_3',13);app.world.commit();const errors=[],loaded=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().endsWith('.png'))loaded.push(new URL(r.url()).pathname);});
 await page.goto(base+'/watch?view=plaza');await ready(page);await page.getByTestId(`map-agent-${b.agent_id}`).click();await page.getByRole('button',{name:'关注角色',exact:true}).click();
 expect(loaded).not.toContain('/pixel-world/ink_actor_preparation.png');expect(loaded).not.toContain('/pixel-world/ink_wanderer_8.png');expect(loaded).not.toContain('/pixel-world/ink_tools.png');
 const now=Date.now();b.action={action_id:'supplement-needed',type:'attack',scene_id:'plaza',target_id:'isolated-test-target',target_kind:'monster',facing:'east',started_at:now,impact_at:now+10000,ends_at:now+20000,phase:'prepare',outcome:null,damage:0,resolved_at:null};app.world.commit();
 const body=page.getByTestId(`map-agent-${b.agent_id}`).locator('.pixel-character>.pixel-sprite').first();await expect(body).toHaveAttribute('data-pose-frame','0');await expect.poll(()=>loaded.includes('/pixel-world/ink_actor_preparation.png')).toBe(true);await expect.poll(()=>page.locator('.phaser-canvas-host').getAttribute('data-rendered-objects')).not.toBe('0');await page.screenshot({path:'artifacts/v022-lazy-prepare.png'});
 b.action=null;app.world.commit();await expect(body).toHaveAttribute('data-pixel-action','idle');await page.screenshot({path:'artifacts/v022-phaser-foot.png'});
 await page.route('**/assets/phaser-renderer-*.js',route=>route.abort());await page.reload();await expect(page.getByTestId('phaser-world')).toHaveAttribute('data-renderer-state','fallback');await page.getByTestId(`map-agent-${b.agent_id}`).click();await page.getByRole('button',{name:'关注角色',exact:true}).click();
 const alignment=await page.evaluate(()=>{const map=document.querySelector('.pixel-map').getBoundingClientRect();return [...document.querySelectorAll('.world-actor')].map(actor=>{const sprite=actor.querySelector('.pixel-character>.pixel-sprite'),rect=sprite.getBoundingClientRect(),origin=getComputedStyle(sprite).transformOrigin.split(' ').map(parseFloat),scale=map.width/1536;return {actual:[rect.x+origin[0]*2,rect.y+origin[1]*2],expected:[map.x+(Number(actor.dataset.footX)+.5)*32*scale,map.y+(Number(actor.dataset.footY)+.5)*32*scale]};});});
 for(const entry of alignment){expect(Math.abs(entry.actual[0]-entry.expected[0])).toBeLessThan(1.5);expect(Math.abs(entry.actual[1]-entry.expected[1])).toBeLessThan(1.5);}
 await page.screenshot({path:'artifacts/v022-dom-foot.png'});expect(errors).toEqual([]);await expect(page.locator('body')).not.toContainText('TEST_PRIVATE_INK_GOAL');
});

test('v022全部八个形象、三类怪物、四向动作与持物接触诊断',async({page,request})=>{
 const actors=[];for(let i=0;i<4;i++)actors.push(await actor(request,i+1,`wanderer_${i+1}`,9+i*3,10));app.world.commit();
 await page.goto(base+'/watch?view=plaza');await ready(page);await expect(page.locator('.world-actor')).toHaveCount(4);await page.screenshot({path:'artifacts/v022-actors-one-to-four-world.png'});
 // Respect the real five-resident room limit; switch isolated appearance fixtures
 // rather than silently exceeding production capacity for a screenshot.
 for(let i=0;i<4;i++)actors[i].appearance.sprite_id=`wanderer_${i+5}`;app.world.commit();await expect(page.locator('.world-actor .pixel-character[data-sprite-id="wanderer_8"]')).toHaveCount(1);await page.screenshot({path:'artifacts/v022-actors-five-to-eight-world.png'});
 const people=await page.evaluate(drawInkContactSheet,{});expect(people.actorCount).toBe(8);await page.locator('#ink-contact-sheet').screenshot({path:'artifacts/v022-actor-contacts.png'});await page.locator('#ink-contact-sheet').evaluate(el=>el.remove());
 await page.getByRole('button',{name:'冒险地图',exact:true}).click();await ready(page);await expect(page.locator('.adventure-monster')).toHaveCount(3);const monsters=await page.evaluate(drawInkContactSheet,{monsters:true,id:'monster-contact-sheet'});expect(monsters.actorCount).toBe(3);await page.locator('#monster-contact-sheet').screenshot({path:'artifacts/v022-monster-contacts.png'});
});

test('v022桌面双倍采样和手机原生采样切换只改变画布，不移动世界人物',async({page,request})=>{
 const a=await actor(request,1,'wanderer_1',12),before=JSON.stringify({position:a.position,scene:a.scene_id});app.world.commit();
 await page.setViewportSize({width:1440,height:1000});await page.goto(base+'/watch?view=plaza');await ready(page);
 const unit=page.getByTestId(`map-agent-${a.agent_id}`),foot=[await unit.getAttribute('data-foot-x'),await unit.getAttribute('data-foot-y')];
 const opaque=()=>page.getByTestId('phaser-canvas').evaluate(canvas=>{const copy=document.createElement('canvas');copy.width=canvas.width;copy.height=canvas.height;const g=copy.getContext('2d');g.drawImage(canvas,0,0);const pixels=g.getImageData(0,0,copy.width,copy.height).data;let count=0;for(let i=3;i<pixels.length;i+=4)if(pixels[i])count++;return {opaque:count,total:canvas.width*canvas.height};});
 const desktop=await opaque();expect(desktop.opaque).toBe(desktop.total);await page.screenshot({path:'artifacts/v022-phaser-2x.png'});
 await page.setViewportSize({width:390,height:844});await ready(page);await expect.poll(async()=>{const p=await opaque();return p.opaque===p.total;}).toBe(true);await page.screenshot({path:'artifacts/v022-phaser-mobile-1x.png'});
 await page.setViewportSize({width:1440,height:1000});await ready(page);await expect.poll(async()=>{const p=await opaque();return p.opaque===p.total;}).toBe(true);
 expect([await unit.getAttribute('data-foot-x'),await unit.getAttribute('data-foot-y')]).toEqual(foot);expect(JSON.stringify({position:a.position,scene:a.scene_id})).toBe(before);
 // Equal-layout comparison of the two drawing buffers, with no server mutation.
 await page.evaluate(()=>{window.__inkWidthDescriptor=Object.getOwnPropertyDescriptor(window,'innerWidth');Object.defineProperty(window,'innerWidth',{configurable:true,get:()=>390});window.dispatchEvent(new Event('resize'));});await ready(page);await page.screenshot({path:'artifacts/v022-phaser-1x-reference.png'});
 await page.evaluate(()=>{Object.defineProperty(window,'innerWidth',window.__inkWidthDescriptor);delete window.__inkWidthDescriptor;window.dispatchEvent(new Event('resize'));});await ready(page);await page.screenshot({path:'artifacts/v022-phaser-2x-reference.png'});
 await page.screenshot({path:'artifacts/v022-terrain-day.png'});
 app.world.state.day_cycle.epoch_at=Date.now()-360000;app.world.commit();await expect(page.getByTestId('phaser-world')).toHaveAttribute('data-day-phase','night');await page.screenshot({path:'artifacts/v022-terrain-night.png'});
 await page.route('**/assets/phaser-renderer-*.js',route=>route.abort());await page.reload();await expect(page.getByTestId('phaser-world')).toHaveAttribute('data-renderer-state','fallback');await expect(page.getByTestId('phaser-world')).toHaveAttribute('data-day-phase','night');await page.screenshot({path:'artifacts/v022-terrain-night-dom.png'});
});
