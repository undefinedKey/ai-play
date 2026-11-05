import {test,expect} from '@playwright/test';
import {assertCanvasResolution} from './canvas-assertions.js';
import AxeBuilder from '@axe-core/playwright';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createApp} from '../../server/index.js';
import {stableTextureSampler} from '../../src/texture-sampling.js';
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
async function ready(page){await expect(page.getByTestId('phaser-world')).toHaveAttribute('data-renderer-state','ready');await expect(page.getByTestId('phaser-canvas')).toHaveCount(1);await assertCanvasResolution(page);}
async function pixels(page,rect=[0,0,1536,1024]){return page.getByTestId('phaser-canvas').evaluate((canvas,[x,y,w,h])=>{const resolution=Number(canvas.dataset.renderResolution);x*=resolution;y*=resolution;w*=resolution;h*=resolution;const target=document.createElement('canvas');target.width=canvas.width;target.height=canvas.height;const ctx=target.getContext('2d');ctx.drawImage(canvas,0,0);const data=ctx.getImageData(x,y,w,h).data;let hash=2166136261,opaque=0;for(let i=0;i<data.length;i++){hash=Math.imul(hash^data[i],16777619);if(i%4===3&&data[i])opaque++;}return{hash:hash>>>0,opaque};},rect);}
async function settledPixels(page){
 // DOM data-playing changes before the sleeping Phaser loop consumes the
 // updated packet. Establish a rendered baseline, then test continued freeze.
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 let previous,consecutive=0;
 await expect.poll(async()=>{const current=await pixels(page);consecutive=previous?.hash===current.hash&&previous?.opaque===current.opaque?consecutive+1:0;previous=current;return consecutive;},{timeout:5000,intervals:[80,120,160]}).toBeGreaterThanOrEqual(4);
 return previous;
}
async function capture(page,name){for(const[width,height]of[[1440,900],[390,844],[390,900]]){await page.setViewportSize({width,height});await page.evaluate(()=>scrollTo(0,0));await ready(page);const map=await page.getByTestId('world-camera').boundingBox();expect(map.width/map.height).toBeCloseTo(1.5,2);expect(map.y).toBeLessThan(width===390?300:270);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);const audit=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(audit.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))).toEqual([]);await page.screenshot({path:`artifacts/phaser-v018-${name}-${width}x${height}.png`});await page.getByTestId('phaser-canvas').screenshot({path:`artifacts/phaser-v018-${name}-${width}x${height}-canvas.png`});}}

test('WebGL多纹理采样容忍插值误差，旋转三角形内部不出现透明洞',async({page})=>{
 const results=await page.evaluate(additions=>additions.map(({count,header})=>{
  const canvas=document.createElement('canvas');canvas.width=count*32;canvas.height=96;
  const gl=canvas.getContext('webgl',{preserveDrawingBuffer:true});if(!gl)throw new Error('WebGL regression requires a real WebGL context');
  const compile=(type,source)=>{const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(shader));return shader;};
  const program=gl.createProgram();gl.attachShader(program,compile(gl.VERTEX_SHADER,'attribute vec2 point; attribute float textureIndex; varying highp float outTexDatum; void main(){gl_Position=vec4(point,0.0,1.0);outTexDatum=textureIndex;}'));
  gl.attachShader(program,compile(gl.FRAGMENT_SHADER,`precision highp float;\n#define TEXTURE_COUNT ${count}\nvarying highp float outTexDatum;\n${header}\nvoid main(){gl_FragColor=getTexture(vec2(0.5));}`));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));gl.useProgram(program);
  const colors=Array.from({length:count},(_,i)=>[30+i*23,210-i*19,60+i*13,255]);
  for(let i=0;i<count;i++){gl.activeTexture(gl.TEXTURE0+i);gl.bindTexture(gl.TEXTURE_2D,gl.createTexture());gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(colors[i]));}
  gl.uniform1iv(gl.getUniformLocation(program,'uMainSampler[0]'),Int32Array.from({length:count},(_,i)=>i));
  const data=[];
  // The same integer is supplied at every vertex in production. Explicit tiny
  // positive/negative errors reproduce drivers' varying interpolation drift.
  for(let row=0;row<3;row++)for(let i=0;i<count;i++)for(const corner of [[-1,-1],[-1,1],[1,1],[-1,-1],[1,1],[1,-1]]){
   const a=.17+row*.11,x=corner[0]*11,y=corner[1]*11;
   data.push(((i*32+16+x*Math.cos(a)-y*Math.sin(a))/canvas.width)*2-1,((row*32+16+x*Math.sin(a)+y*Math.cos(a))/96)*2-1,i+(row-1)*.00001);
  }
  gl.bindBuffer(gl.ARRAY_BUFFER,gl.createBuffer());gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(data),gl.STATIC_DRAW);
  for(const[name,size,offset]of[['point',2,0],['textureIndex',1,8]]){const location=gl.getAttribLocation(program,name);if(location>=0){gl.enableVertexAttribArray(location);gl.vertexAttribPointer(location,size,gl.FLOAT,false,12,offset);}}
  gl.viewport(0,0,canvas.width,canvas.height);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);gl.drawArrays(gl.TRIANGLES,0,data.length/3);
  const pixels=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);let mismatches=0;
  for(let row=0;row<3;row++)for(let i=0;i<count;i++)for(let dy=-5;dy<=5;dy++)for(let dx=-5;dx<=5;dx++){const offset=((row*32+16+dy)*canvas.width+i*32+16+dx)*4;for(let c=0;c<4;c++)if(pixels[offset+c]!==colors[i][c]){mismatches++;break;}}
  const error=gl.getError();gl.getExtension('WEBGL_lose_context')?.loseContext();return{count,mismatches,error};
 }),[1,4,8].map(count=>({count,header:stableTextureSampler(count).additions.fragmentHeader})));
 expect(results).toEqual([1,4,8].map(count=>({count,mismatches:0,error:0})));
});

test('Phaser真实画布绘制地面物件人物装备，真实移动改变像素，切换销毁且不操作AI',async({page,request})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/watch?view=plaza');await ready(page);
 expect((await pixels(page)).opaque).toBe(await page.getByTestId('phaser-canvas').evaluate(canvas=>canvas.width*canvas.height));
 const bare=await pixels(page);
 const a=await actor(request);await expect(page.getByTestId(`map-agent-${a.agent.agent_id}`)).toBeVisible();
 await expect.poll(async()=>(await pixels(page)).hash).not.toBe(bare.hash);
 await a.act('move',{x:24,y:16});clock+=2000;await a.observe();app.world.tick();await expect(page.getByTestId(`map-agent-${a.agent.agent_id}`).locator('.pixel-character')).toHaveAttribute('data-action','idle');const raw=app.world.agent(a.agent.agent_id);raw.life.inventory.wooden_sword=1;app.world.commit();
 const beforeGear=await pixels(page);await a.act('inventory',{intent:'equip',item_id:'wooden_sword'});
 await expect.poll(async()=>(await pixels(page)).hash).not.toBe(beforeGear.hash);
 const beforeMove=await pixels(page);const receipt=await a.act('move',{x:25,y:16});expect(receipt.path.length).toBeLessThanOrEqual(4);
 await expect.poll(async()=>(await pixels(page)).hash).not.toBe(beforeMove.hash);
 const fixed=JSON.stringify({scene:raw.scene_id,position:raw.position});const old=await page.getByTestId('phaser-canvas').elementHandle();
 await page.getByRole('button',{name:'冒险地图',exact:true}).click();await ready(page);expect(await old.evaluate(el=>el.isConnected)).toBe(false);expect(JSON.stringify({scene:raw.scene_id,position:raw.position})).toBe(fixed);await expect(page.locator('.world-actor')).toHaveCount(0);expect((await pixels(page)).hash).not.toBe(beforeMove.hash);
 await capture(page,'forest-empty');
 for(let i=0;i<3;i++){await page.getByRole('button',{name:'社交广场',exact:true}).click();await ready(page);await page.getByRole('button',{name:'农作区',exact:true}).click();await expect(page.getByTestId('phaser-canvas')).toHaveCount(0);await page.getByRole('button',{name:'冒险地图',exact:true}).click();await ready(page);}
 await page.getByRole('button',{name:'社交广场',exact:true}).click();await ready(page);await capture(page,'plaza-active');expect(errors).toEqual([]);
});

test('画布加载、网络失败、兼容图层重试及缺失纹理均明确反馈',async({page,request})=>{
 const pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));await actor(request,'等待画布的原角色');
 let release;await page.route('**/assets/phaser-renderer-*.js',async route=>{await new Promise(resolve=>{release=resolve;});await route.abort();});
 await page.goto(base+'/watch?view=plaza');await expect(page.getByText('游戏画布载入中…',{exact:true})).toBeVisible();await page.screenshot({path:'artifacts/phaser-v018-loading.png'});release();
 await expect(page.getByTestId('phaser-world')).toHaveAttribute('data-renderer-state','fallback');await expect(page.getByText(/当前为兼容图层显示/)).toBeVisible();await expect(page.getByTestId('phaser-canvas')).toHaveCount(0);await page.screenshot({path:'artifacts/phaser-v018-fallback.png'});
 await page.unroute('**/assets/phaser-renderer-*.js');await page.getByRole('button',{name:'重试游戏画布'}).click();await ready(page);
 const manifest=await(await request.get(base+'/pixel-world/manifest.json')).json(),building=manifest.plaza_props.bookshop;
 expect(building?.animations.idle.frames.length).toBeGreaterThan(0);
 const texturePath=new URL(building.animations.idle.frames[0].image||building.image,base).pathname,textureRoute=url=>url.pathname===texturePath;let blockedTextures=0;
 await page.route(textureRoute,route=>{blockedTextures++;return route.abort();});await page.reload();await ready(page);await expect.poll(()=>blockedTextures).toBeGreaterThan(0);await expect(page.getByText('部分场景素材未载入 · 已保留可用画面和真实位置')).toBeVisible();expect((await pixels(page)).opaque).toBe(await page.getByTestId('phaser-canvas').evaluate(canvas=>canvas.width*canvas.height));await page.screenshot({path:'artifacts/phaser-v018-partial.png'});
 await page.unroute(textureRoute);await page.reload();await ready(page);
 await page.getByTestId('phaser-canvas').evaluate(canvas=>canvas.dispatchEvent(new Event('webglcontextlost')));await expect(page.getByTestId('phaser-world')).toHaveAttribute('data-renderer-state','fallback');await page.getByRole('button',{name:'重试游戏画布'}).click();await ready(page);
 await page.addInitScript(()=>{const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){return /webgl/i.test(type)?null:original.call(this,type,...args);};});await page.reload();await ready(page);expect(await page.getByTestId('phaser-canvas').evaluate(canvas=>!!canvas.getContext('2d'))).toBe(true);expect((await pixels(page)).opaque).toBe(await page.getByTestId('phaser-canvas').evaluate(canvas=>canvas.width*canvas.height));expect(pageErrors).toEqual([]);
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
 const a=await actor(request,'路径旅人'),raw=app.world.agent(a.agent.agent_id);raw.position={x:13,y:25};raw.position_at=clock;app.world.commit();
 await page.goto(base+'/watch?view=plaza');await ready(page);
 const unit=page.getByTestId(`map-agent-${a.agent.agent_id}`),before=await pixels(page);
 const receipt=await a.act('move',{x:14,y:26});expect(receipt.path).toEqual([{x:13,y:25},{x:14,y:25},{x:14,y:26}]);
 expect(raw.position).toEqual({x:13,y:25});
 clock+=100;app.world.tick();
 await expect.poll(()=>unit.getAttribute('data-foot-x').then(Number)).toBeGreaterThan(13);
 await expect(unit).toHaveAttribute('data-foot-y','25');
 expect(raw.position.x).toBeCloseTo(13.2,5);expect(raw.position.y).toBe(25);
 await expect.poll(()=>pixels(page).then(p=>p.hash)).not.toBe(before.hash);
 clock+=600;app.world.tick();
 await expect(unit).toHaveAttribute('data-foot-x','14');
 await expect.poll(()=>unit.getAttribute('data-foot-y').then(Number)).toBeGreaterThan(25);
 expect(raw.position.x).toBe(14);expect(raw.position.y).toBeCloseTo(25.4,5);
 await page.emulateMedia({reducedMotion:'reduce'});await expect(unit.locator('.pixel-sprite').first()).toHaveAttribute('data-playing','false');
 // Reduced motion stops frame playback, but a finite walk can still expire to
 // its idle pose. Compare a settled semantic state, not two different actions.
 await expect(unit.locator('.pixel-character')).toHaveAttribute('data-action','idle');
 await expect(unit).toHaveAttribute('data-foot-x','14');
 expect(Number(await unit.getAttribute('data-foot-y'))).toBeCloseTo(25.4,5);
 const still=await settledPixels(page);await page.waitForTimeout(400);expect(await pixels(page)).toEqual(still);
 await page.emulateMedia({reducedMotion:'no-preference'});
 clock+=400;app.world.tick();await a.act('gather',{intent:'start',node_id:'camp_branches'});clock+=100;app.world.tick();
 await expect(unit.locator('.pixel-character')).toHaveAttribute('data-action','gather');
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});const hidden=await pixels(page);await page.waitForTimeout(450);expect(await pixels(page)).toEqual(hidden);
 await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});await expect(unit.locator('.pixel-sprite').first()).toHaveAttribute('data-playing','true');
 await page.route('**/api/public/events*',route=>route.abort());await page.reload();await ready(page);await expect(page.locator('.spectator-stale')).toBeVisible();const disconnected=await pixels(page);await page.waitForTimeout(1200);expect(await pixels(page)).toEqual(disconnected);
 await page.screenshot({path:'artifacts/phaser-v019-disconnected.png'});
});
