import {expect} from '@playwright/test';
import {createApp} from '../../server/index.js';

// Isolated in-memory worlds only. There is no fixture endpoint or production
// mutation: a real owner grant and the checked AI tool boundary authorize acts.
export async function createPaperDollFixture({manualClock=false}={}) {
  const app=await createApp({dbPath:':memory:',authDbPath:':memory:',authMode:'local',production:true});
  let now=Date.now(),serial=0;
  if(manualClock)app.world.now=()=>now;
  app.world.actionIntervalMs=0;
  const {server,url:base}=await app.start(0);
  const actors=[];
  function actor(name,{position={x:11,y:10},scene='plaza',sprite='wanderer_7'}={}) {
    const world=app.world,created=world.createAgent({name}),controller=world.createController(created.agent_id);
    world.ownerControl(created.agent_id,'start',{controller_id:controller.controller_id,duration_minutes:15,max_calls:500,goal:'PRIVATE_PAPER_DOLL_TEST_GOAL'});
    const auth=world.authenticate(controller.token),joined=world.callTool(auth,'join_world');
    const session={run_id:joined.run_id,session_epoch:joined.session_epoch},raw=world.agent(created.agent_id);
    raw.position={...position};raw.position_at=world.now();raw.scene_id=scene;raw.appearance.sprite_id=sprite;
    const observe=()=>world.callTool(auth,'observe',session);
    const value={id:created.agent_id,raw,observe,act(type,payload={}) {
      const result=world.callTool(auth,'act',{...session,action_id:observe().next_action_id,type,payload});
      expect(result.status,JSON.stringify(result)).toBe('applied');return result;
    }};
    actors.push(value);return value;
  }
  async function open(page,eligibleIds,{scene='plaza',expectRig=true}={}) {
    const audit={errors:[],writes:[]};
    page.on('pageerror',error=>audit.errors.push(error.message));
    page.on('request',request=>{if(request.url().startsWith(base)&&!['GET','HEAD'].includes(request.method()))audit.writes.push(request.method());});
    // Only the test browser's copy is opted in. Names and shared sprite IDs do
    // not grant access; even another identical-looking resident stays legacy.
    const source=await (await fetch(base+'/pixel-world/manifest.json')).json();
    expect(source.paper_dolls?.feiyu_v1,'the actual shipped rig must be present').toBeTruthy();
    const manifest=structuredClone(source);
    manifest.paper_dolls.feiyu_v1.eligible_agent_ids=[...eligibleIds];
    audit.rig=manifest.paper_dolls.feiyu_v1;
    await page.route('**/pixel-world/manifest.json*',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(manifest)}));
    if(manualClock) {
      await page.addInitScript(()=>{
        const streams=[];
        class ControlledSource {
          constructor(url){this.url=String(url);this.readyState=0;this.listeners=new Map();streams.push(this);}
          addEventListener(type,listener){if(!this.listeners.has(type))this.listeners.set(type,[]);this.listeners.get(type).push(listener);}
          close(){this.readyState=2;}
          emit(type,data){if(this.readyState===2)return;if(type==='open')this.readyState=1;const event=type==='snapshot'?new MessageEvent(type,{data:JSON.stringify(data)}):new Event(type);this[`on${type}`]?.(event);for(const listener of this.listeners.get(type)||[])listener(event);}
        }
        window.EventSource=ControlledSource;
        window.__paperDollTransport={send:value=>{const current=streams.findLast(s=>s.readyState!==2);if(current){current.emit('open');current.emit('snapshot',value);}},count:()=>streams.length};
      });
    }
    app.world.commit();
    await page.goto(base+`/watch?view=${scene}`);
    await expect(page.getByTestId('phaser-world')).toHaveAttribute('data-renderer-state','ready',{timeout:20000});
    if(manualClock){await page.clock.install({time:new Date(now-1000)});await page.clock.pauseAt(new Date(now));await publish(page,scene);}
    if(expectRig)for(const id of eligibleIds)await expect(page.locator(`[data-testid$="-${id}"] .paper-doll-rig`).first()).toHaveAttribute('data-rig-id','feiyu_v1');
    return audit;
  }
  async function publish(page,scene='adventure') {
    // Timing/delivery is controlled only for short combat phases. Snapshot
    // values are obtained through the real public HTTP projection after ticks.
    const response=await fetch(`${base}/api/public/world?scene=${scene}`);
    expect(response.ok).toBe(true);
    const snapshot=await response.json();snapshot.stream_frame_id=`paper-doll:${++serial}`;
    await expect.poll(()=>page.evaluate(()=>window.__paperDollTransport.count())).toBeGreaterThan(0);
    await page.evaluate(value=>window.__paperDollTransport.send(value),snapshot);
    await page.clock.runFor(16);
  }
  async function advance(page,ms,{scene='adventure'}={}) {
    expect(manualClock).toBe(true);
    let remaining=ms;
    while(remaining>0){const dt=Math.min(100,remaining);now+=dt;remaining-=dt;app.world.tick();for(const a of actors)if(a.raw.status==='active')a.observe();await publish(page,scene);await page.clock.runFor(dt);}
  }
  return {app,base,actor,open,publish,advance,now:()=>app.world.now(),async close(){await app.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}

export async function startRigSamples(page,id) {
  await page.evaluate(id=>{
    const trace=window.__paperDollTrace={rows:[]};
    const sample=()=>{
      const unit=document.querySelector(`[data-testid$="-${id}"]`),rig=unit?.querySelector('.paper-doll-rig');
      if(rig)trace.rows.push({at:performance.now(),action:rig.dataset.action,facing:rig.dataset.facing,playing:rig.dataset.playing,
        foot:[Number(unit.dataset.footX),Number(unit.dataset.footY)],
        parts:[...rig.querySelectorAll('[data-rig-part]')].map(node=>({id:node.dataset.rigPart,x:Number(node.dataset.rigX),y:Number(node.dataset.rigY),rotation:Number(node.dataset.rigRotation),transform:node.style.transform,translate:node.style.translate,rect:node.style.backgroundPosition})),
        attachments:[...rig.querySelectorAll('[data-attachment-slot]')].map(node=>({slot:node.dataset.attachmentSlot,item:node.dataset.item,x:Number(node.dataset.rigX),y:Number(node.dataset.rigY),rotation:Number(node.dataset.rigRotation),transform:node.style.transform,translate:node.style.translate}))});
      trace.timer=requestAnimationFrame(sample);
    };trace.timer=requestAnimationFrame(sample);
  },id);
}
export async function stopRigSamples(page) {return page.evaluate(()=>{cancelAnimationFrame(window.__paperDollTrace.timer);return window.__paperDollTrace.rows;});}
export async function rigState(unit) {
  return unit.locator('.paper-doll-rig').evaluate(rig=>({playing:rig.dataset.playing,action:rig.dataset.action,
    parts:[...rig.querySelectorAll('[data-rig-part]')].map(node=>[node.dataset.rigPart,node.style.transform,node.style.translate]),
    attachments:[...rig.querySelectorAll('[data-attachment-slot]')].map(node=>[node.dataset.attachmentSlot,node.dataset.item,node.style.transform,node.style.translate])}));
}
