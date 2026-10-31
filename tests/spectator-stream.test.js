import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import express from 'express';
import jsonPatch from 'fast-json-patch';
import { World } from '../server/world.js';
import { attachSpectator, scopeSpectatorSnapshot, spectatorSnapshot } from '../server/spectator.js';

async function fixture(t, options = {}) {
  const world = new World({ now: () => 1000000 });
  const app = express(), spectator = attachSpectator(app, world, { broadcastMs: 5, ...options });
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  t.after(async () => { spectator.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); world.close(); });
  return { world, spectator, url: `http://127.0.0.1:${server.address().port}` };
}
async function stream(t, url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      const frames = [], waiters = []; let buffer = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        buffer += chunk;
        for (let end; (end = buffer.indexOf('\n\n')) >= 0;) {
          const text = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const line = text.split('\n').find(l => l.startsWith('data: ')); if (!line) continue;
          const frame = { type: text.split('\n')[0].slice(7), data: JSON.parse(line.slice(6)) };
          const next = waiters.shift(); if (next) next(frame); else frames.push(frame);
        }
      });
      const close = () => { response.destroy(); request.destroy(); };
      t.after(close);
      resolve({ response, close, next: () => frames.length ? Promise.resolve(frames.shift()) : new Promise((r, j) => {
        const timer = setTimeout(() => j(new Error('Missing spectator frame')), 3000);
        waiters.push(frame => { clearTimeout(timer); r(frame); });
      }) });
    }); request.on('error', reject);
  });
}
function applyV2(previous, delta) {
  assert.equal(delta.protocol,2);assert.equal(delta.base_frame_id,previous.stream_frame_id);
  assert.ok(delta.patch.every(op=>!/^\/events(?:\/|$)/.test(op.path)));
  const {events,stream_frame_id,...body}=previous;
  return {...jsonPatch.applyPatch(body,delta.patch,true,false,true).newDocument,
    events:delta.event_reset?(delta.events||[]):[...events,...(delta.events||[])].slice(-150),stream_frame_id:delta.frame_id};
}
function assertCurrent(frame,world,scene=null) {
  const {stream_frame_id,...actual}=frame;
  assert.deepEqual(actual,JSON.parse(JSON.stringify(scopeSpectatorSnapshot(spectatorSnapshot(world),scene))));
}

test('scene subscription scopes public events and monsters, preserves global roster, rejects malformed scenes', async t => {
  const f = await fixture(t);
  const a = f.world.createAgent({ name: '广场人物', owner_id: 'PRIVATE_OWNER' });
  const b = f.world.createAgent({ name: '林地人物' }); f.world.agent(b.agent_id).scene_id = 'adventure';
  f.world.event('message', { agent_id: a.agent_id, channel: 'nearby', text: '村中发言', private: 'PRIVATE_SECRET' });
  f.world.event('message', { agent_id: b.agent_id, channel: 'nearby', text: '林中发言' });
  f.world.event('scene_changed', { agent_id: b.agent_id, from_scene_id: 'plaza', position: {x:11,y:8}, from_position:{x:22,y:8} });
  f.world.event('server_restarted', { text: '无场景公开事件' });
  f.world.event('invitation', { text: 'PRIVATE_INVITATION', target_agent_id:b.agent_id }); f.world.commit();
  const read = async suffix => { const r = await fetch(`${f.url}/api/public/world${suffix}`); assert.equal(r.status,200); return r.json(); };
  const [whole, plaza, adventure] = await Promise.all(['','?scene=plaza','?scene=adventure'].map(read));
  assert.deepEqual(whole.scope,{scene_id:null,events:'world',roster:'world'});
  assert.equal(plaza.agents.length,2); assert.deepEqual(plaza.agents,adventure.agents);
  assert.equal(plaza.adventure.monsters.length,0); assert.ok(adventure.adventure.monsters.length>0);
  assert.ok(plaza.events.some(e=>e.payload.text==='村中发言')); assert.ok(!plaza.events.some(e=>e.payload.text==='林中发言'));
  assert.ok(adventure.events.some(e=>e.payload.text==='林中发言')); assert.ok(!adventure.events.some(e=>e.payload.text==='村中发言'));
  for(const snapshot of [plaza,adventure]) { assert.ok(snapshot.events.some(e=>e.type==='scene_changed')); assert.ok(!snapshot.events.some(e=>e.type==='server_restarted')); }
  assert.ok(whole.events.some(e=>e.type==='server_restarted')); assert.doesNotMatch(JSON.stringify([whole,plaza,adventure]), /PRIVATE_/);
  for (const query of ['scene=farm','scene=plaza&scene=adventure','scene[]=plaza']) {
    assert.equal((await fetch(`${f.url}/api/public/world?${query}`)).status,400);
    assert.equal((await fetch(`${f.url}/api/public/events?${query}`)).status,400);
  }
  const state = JSON.stringify(f.world.state);
  for(const scene of ['plaza','adventure']) { const s=await stream(t,`${f.url}/api/public/events?delta=1&scene=${scene}`); const frame=await s.next(); assert.equal(frame.data.scope.scene_id,scene); s.close(); }
  assert.equal(JSON.stringify(f.world.state),state,'public subscriptions must not authorize or mutate characters');
});

test('camp meal public effects belong to plaza; other unscoped cooperation is only in world feed', () => {
  const snapshot={adventure:{monsters:[{}]},agents:[],events:[
    {type:'cooperation_completed',payload:{template_id:'camp_meal'}},
    {type:'cooperation_completed',payload:{template_id:'scout_and_guard'}},
  ]};
  assert.equal(scopeSpectatorSnapshot(snapshot,'plaza').events.length,1);
  assert.equal(scopeSpectatorSnapshot(snapshot,'adventure').events.length,0);
  assert.equal(scopeSpectatorSnapshot(snapshot).events.length,2);
});

test('100 real SSE clients share three scoped encodings, including ticks without a revision change', async t => {
  const f=await fixture(t,{maxPerIp:120});
  const a=f.world.createAgent({name:'共享编码'});
  const clients=await Promise.all(Array.from({length:100},(_,i)=>stream(t,`${f.url}/api/public/events?delta=1${i%3===0?'':`&scene=${i%3===1?'plaza':'adventure'}`}`)));
  const initial=await Promise.all(clients.map(c=>c.next()));
  assert.ok(initial.every(f=>f.type==='snapshot')); assert.equal(f.spectator.stats.active_streams,100);
  assert.equal(f.spectator.stats.snapshot_encodes,3); assert.equal(f.spectator.stats.snapshot_builds,1);
  const revision=f.world.state.room.world_revision;
  f.world.agent(a.agent_id).position={x:12,y:8}; f.world.commit();
  const updates=await Promise.all(clients.map(c=>c.next()));
  assert.equal(f.world.state.room.world_revision,revision);
  assert.ok(updates.every(f=>f.type==='delta'&&f.data.agents[0].position.x===12));
  assert.equal(f.spectator.stats.delta_encodes,3); assert.equal(f.spectator.stats.delta_frames_written,100);
  assert.equal(f.spectator.stats.slow_disconnects,0);
  // A reconnect gets the current complete projection, not an unapplicable delta.
  clients[0].close(); const reconnect=await stream(t,`${f.url}/api/public/events?delta=1`);
  const frame=await reconnect.next(); assert.equal(frame.type,'snapshot'); assert.equal(frame.data.agents[0].position.x,12);
  assert.ok(frame.data.life && frame.data.scenes && frame.data.history);
});

test('different baseline cohorts receive correct incremental events without duplicate replay', async t => {
  const f=await fixture(t,{broadcastMs:60}); const a=f.world.createAgent({name:'不同基线'});
  const first=await stream(t,`${f.url}/api/public/events?delta=1`); await first.next();
  f.world.event('message',{agent_id:a.agent_id,text:'第一次',channel:'nearby'}); f.world.commit();
  const second=await stream(t,`${f.url}/api/public/events?delta=1`); const middle=await second.next();
  assert.ok(middle.data.events.some(e=>e.payload.text==='第一次'));
  f.world.event('message',{agent_id:a.agent_id,text:'第二次',channel:'nearby'}); f.world.commit();
  const [one,two]=await Promise.all([first.next(),second.next()]);
  assert.deepEqual(one.data.events.map(e=>e.payload.text),['第一次','第二次']);
  assert.deepEqual(two.data.events.map(e=>e.payload.text),['第二次']);
  assert.equal(f.spectator.stats.delta_encodes,2);
});

test('legacy full frames and incremental protocol each reuse encoding without sharing incompatible messages', async t => {
  const f=await fixture(t,{maxPerIp:30});const a=f.world.createAgent({name:'兼容协议'});
  const clients=await Promise.all(Array.from({length:20},(_,i)=>stream(t,`${f.url}/api/public/events?scene=plaza${i<10?'':'&delta=1'}`)));
  await Promise.all(clients.map(c=>c.next()));assert.equal(f.spectator.stats.snapshot_encodes,1);
  f.world.agent(a.agent_id).position={x:12,y:8};f.world.commit();
  const frames=await Promise.all(clients.map(c=>c.next()));
  assert.ok(frames.slice(0,10).every(f=>f.type==='snapshot'&&f.data.scenes&&f.data.scope.scene_id==='plaza'));
  assert.ok(frames.slice(10).every(f=>f.type==='delta'&&!Object.hasOwn(f.data,'scenes')));
  assert.ok(frames.every(f=>f.data.agents[0].position.x===12));
  assert.equal(f.spectator.stats.snapshot_encodes,2);assert.equal(f.spectator.stats.delta_encodes,1);
});

test('patch v2 coexists with v1/full: a single coordinate uses a small patch and reconstructs the exact public snapshot', async t => {
  const f=await fixture(t);
  const roles=Array.from({length:5},(_,i)=>f.world.createAgent({name:`人物${i}`,owner_id:'PRIVATE_OWNER'}));
  const [v2,v1,full]=await Promise.all(['2','1',''].map(protocol=>stream(t,`${f.url}/api/public/events?${protocol?`delta=${protocol}`:''}`)));
  const [initial,old,plain]=await Promise.all([v2.next(),v1.next(),full.next()]);
  assert.equal(typeof initial.data.stream_frame_id,'string'); assert.ok(!Object.hasOwn(old.data,'stream_frame_id'));assert.ok(!Object.hasOwn(plain.data,'stream_frame_id'));
  f.world.agent(roles[0].agent_id).position={x:12,y:8};f.world.commit();
  const [small,large,complete]=await Promise.all([v2.next(),v1.next(),full.next()]);
  assert.equal(small.type,'delta');assert.equal(complete.type,'snapshot');assert.ok(!Object.hasOwn(large.data,'protocol'));
  assert.ok(small.data.patch.some(op=>op.path==='/agents/0/position/x'&&op.value===12));
  const v2Bytes=Buffer.byteLength(JSON.stringify(small.data)),v1Bytes=Buffer.byteLength(JSON.stringify(large.data));
  assert.ok(v2Bytes<v1Bytes*.15,'coordinate patch should be much smaller than replacing all actor profiles');
  t.diagnostic(JSON.stringify({single_coordinate_v1_bytes:v1Bytes,single_coordinate_v2_bytes:v2Bytes,reduction_percent:+((1-v2Bytes/v1Bytes)*100).toFixed(2)}));
  assertCurrent(applyV2(initial.data,small.data),f.world);assertCurrent(complete.data,f.world);
  assert.equal(f.spectator.stats.delta_encodes,2);assert.equal(f.spectator.stats.v2_delta_encodes,1);
  assert.doesNotMatch(JSON.stringify(small.data),/PRIVATE_|owner_id|diagnostics|ledger/);
});

test('100 patch v2 streams reuse scoped frames and recover complete snapshots on reconnect', async t => {
  const f=await fixture(t,{maxPerIp:120});const a=f.world.createAgent({name:'百人细粒度旁观'});
  const scopes=Array.from({length:100},(_,i)=>[null,'plaza','adventure'][i%3]);
  const clients=await Promise.all(scopes.map(scene=>stream(t,`${f.url}/api/public/events?delta=2${scene?`&scene=${scene}`:''}`)));
  const first=await Promise.all(clients.map(c=>c.next()));
  assert.equal(new Set(first.map(f=>f.data.stream_frame_id)).size,3);
  f.world.agent(a.agent_id).position={x:12,y:8};f.world.commit();
  const updates=await Promise.all(clients.map(c=>c.next()));
  updates.forEach((frame,i)=>assertCurrent(applyV2(first[i].data,frame.data),f.world,scopes[i]));
  assert.equal(f.spectator.stats.v2_delta_encodes,3);assert.equal(f.spectator.stats.delta_frames_written,100);
  const prior=updates.map((frame,i)=>applyV2(first[i].data,frame.data));
  const raw=f.world.agent(a.agent_id);raw.scene_id='adventure';raw.position={x:11,y:8};
  f.world.event('scene_changed',{agent_id:a.agent_id,from_scene_id:'plaza',position:{x:11,y:8},from_position:{x:22,y:8}});f.world.commit();
  const crossing=await Promise.all(clients.map(c=>c.next()));
  crossing.forEach((frame,i)=>{const state=applyV2(prior[i],frame.data);assertCurrent(state,f.world,scopes[i]);assert.ok(state.events.some(e=>e.type==='scene_changed'));});
  assert.equal(f.spectator.stats.v2_delta_encodes,6);
  clients[0].close();const reconnect=await stream(t,`${f.url}/api/public/events?delta=2`);const current=await reconnect.next();
  assert.equal(current.type,'snapshot');assertCurrent(current.data,f.world);assert.equal(current.data.stream_frame_id,crossing[0].data.frame_id);
  assert.notEqual(first[0].data.stream_frame_id,current.data.stream_frame_id);
  assert.throws(()=>applyV2(first[1].data,updates[2].data),'a delta for another scene must not apply to this baseline');
});

test('patch v2 preserves distinct baselines, event append/reset, and never patches the rolling event ring', async t => {
  const f=await fixture(t,{broadcastMs:60});const a=f.world.createAgent({name:'事件可靠合并'});
  f.world.event('message',{agent_id:a.agent_id,text:'期初消息',channel:'nearby'});f.world.commit();
  const first=await stream(t,`${f.url}/api/public/events?delta=2`);let firstState=(await first.next()).data;
  f.world.event('message',{agent_id:a.agent_id,text:'第一条新消息',channel:'nearby'});f.world.commit();
  const second=await stream(t,`${f.url}/api/public/events?delta=2`);let secondState=(await second.next()).data;
  f.world.event('message',{agent_id:a.agent_id,text:'第二条新消息',channel:'nearby'});f.world.commit();
  const [one,two]=await Promise.all([first.next(),second.next()]);
  assert.deepEqual(one.data.events.map(e=>e.payload.text),['第一条新消息','第二条新消息']);
  assert.deepEqual(two.data.events.map(e=>e.payload.text),['第二条新消息']);
  firstState=applyV2(firstState,one.data);secondState=applyV2(secondState,two.data);
  assertCurrent(firstState,f.world);assert.deepEqual(firstState,secondState);
  for(let i=0;i<151;i++) f.world.event('message',{agent_id:a.agent_id,text:`滚动事件${i}`,channel:'nearby'});
  f.world.commit();const resets=await Promise.all([first.next(),second.next()]);
  assert.ok(resets.every(f=>f.data.event_reset===true&&f.data.events.length===150));
  assertCurrent(applyV2(firstState,resets[0].data),f.world);assertCurrent(applyV2(secondState,resets[1].data),f.world);
  assert.equal(f.spectator.stats.v2_delta_encodes,3,'the two baselines converge after receiving the same current frame');
});

class FakeResponse extends EventEmitter {
  constructor({blocked=false,buffer=0}={}) {super();this.writableLength=buffer;this.blocked=blocked;this.frames=[];}
  set(){return this;} flushHeaders(){} status(){return this;} json(){return this;}
  write(text){this.frames.push(text);return !this.blocked;}
  end(){this.writableEnded=true;this.emit('close');}
  destroy(){this.destroyed=true;this.emit('close');}
}
test('slow response buffering is bounded before enqueue, drain recovers, closure does not stop world', async t => {
  const world=new World(); const routes=new Map();
  const spectator=attachSpectator({get:(path,handler)=>routes.set(path,handler)},world,{broadcastMs:2,maxBufferBytes:1000000});
  t.after(()=>{spectator.close();world.close();});
  const open=res=>routes.get('/api/public/events')({query:{delta:'1'},socket:{remoteAddress:'test'}},res);
  const slow=new FakeResponse({blocked:true}), draining=new FakeResponse({blocked:true});open(slow);open(draining);
  draining.blocked=false;draining.emit('drain');
  world.event('message',{text:'真实公开消息',channel:'nearby'});world.commit();await sleep(20);
  assert.equal(slow.destroyed,true);assert.equal(slow.frames.length,1,'never append another delta while blocked');
  assert.equal(draining.frames.length,2);assert.equal(spectator.stats.slow_disconnects,1);
  const oversized=new FakeResponse({buffer:999999});open(oversized);
  assert.equal(oversized.destroyed,true);assert.equal(oversized.frames.length,0,'check prospective frame size before writing');
  draining.destroy();assert.equal(spectator.count,0);
  const before=world.state.sequence;world.event('message',{text:'无人观看时仍发生',channel:'nearby'});world.commit();world.tick();
  assert.ok(world.state.sequence>before);const reconnected=new FakeResponse();open(reconnected);
  assert.ok(reconnected.frames[0].startsWith('event: snapshot'));
  assert.ok(reconnected.frames[0].includes('无人观看时仍发生'));
  assert.doesNotMatch(JSON.stringify(spectatorSnapshot(world)),/snapshot_encodes|bytes_enqueued/);
});
