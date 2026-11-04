import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { World } from '../server/world.js';
import { verifyJourney } from '../deploy/verify-journey.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(resolve(tmpdir()), 'v033-journey-save-')), dbPath = join(directory,'world.sqlite');
  let now = 2000000000000, world = new World({dbPath,now:()=>now,actionIntervalMs:0});
  t.after(()=>{world.close();assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(basename(directory).startsWith('v033-journey-save-'));rmSync(directory,{recursive:true,force:true});});
  const id=world.createAgent({name:'原来的旅人',bio:'由原宿主定义的想法',owner_id:'original-owner'}).agent_id;
  const ctl=world.createController(id);world.ownerControl(id,'start',{controller_id:ctl.controller_id,duration_minutes:60,max_calls:null,goal:'ORIGINAL_PRIVATE_GOAL'});
  const auth=world.authenticate(ctl.token);world.callTool(auth,'join_world');
  return {get world(){return world;},get a(){return world.agent(id);},
    act(payload){const a=this.a,s={run_id:a.run.run_id,session_epoch:a.session_epoch};const o=world.callTool(auth,'observe',s);const r=world.callTool(auth,'act',{...s,type:'journey',action_id:o.next_action_id,payload});assert.equal(r.status,'applied',JSON.stringify(r));},
    restart(){const old=structuredClone(world.state);world.close();now+=2000;world=new World({dbPath,now:()=>now,actionIntervalMs:0});world.tick();return {old,current:structuredClone(world.state)};}
  };
}
function verify(pair) {
  const program="import importlib.util,json,sys\nfrom pathlib import Path\np=Path(sys.argv[1]);s=importlib.util.spec_from_file_location('v',p/'deploy/verify-migration.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m);x=json.load(sys.stdin);m.compare_states(x['old'],x['current'],project_root=p,require_history=True,require_scenes=True)";
  return spawnSync(process.platform==='win32'?'python':'python3',['-c',program,resolve('.')],{input:JSON.stringify(pair),encoding:'utf8',timeout:30000});
}
const pass=pair=>{const result=verify(pair);assert.equal(result.status,0,result.stderr);};

test('v033 upgrade adds an empty journey service and authored resources without relocating legacy residents or changing saves',t=>{
  const f=fixture(t); f.a.scene_id='adventure';f.a.position={x:11.5,y:8};
  delete f.world.state.journey; delete f.a.journey_job; delete f.a.journey_last_result;
  for(const id of ['journey_pine','journey_ore','journey_berries'])delete f.world.state.resources.nodes[id];
  const pair=f.restart();pass(pair);
  assert.deepEqual(pair.current.agents[f.a.agent_id].position,pair.old.agents[f.a.agent_id].position);
  assert.equal(pair.current.journey.monsters.length,2);assert.equal(f.a.journey_job,null);
  for(const mutate of [
    s=>s.journey.monsters[0].hp--,
    s=>s.journey.monsters.push(structuredClone(s.journey.monsters[0])),
    s=>s.resources.nodes.journey_ore.stock++,
    s=>s.agents[f.a.agent_id].life.inventory.wood++,
    s=>s.agents[f.a.agent_id].goal='偷偷去横版森林',
    s=>s.agents[f.a.agent_id].scene_id='journey',
  ]){const changed=structuredClone(pair);mutate(changed.current);assert.notEqual(verify(changed).status,0);}
});

test('v033 restart interrupts a chosen real trip while preserving fractional position, damaged monsters and pending respawns',t=>{
  const f=fixture(t);f.a.scene_id='journey';f.a.position={x:16.5,y:18};
  f.act({intent:'travel',node_id:'camp',route:'bypass'});
  const [slime,boar]=f.world.state.journey.monsters;
  slime.hp=7;boar.hp=0;boar.status='respawning';boar.respawn_at=2000000090000;
  const pair=f.restart();pass(pair);
  assert.deepEqual(f.a.position,{x:16.5,y:18});assert.equal(f.a.journey_last_result.kind,'restarted');
  assert.equal(f.world.state.journey.monsters[0].hp,7);assert.equal(f.world.state.journey.monsters[1].respawn_at,boar.respawn_at);
  for(const mutate of [
    s=>s.agents[f.a.agent_id].journey_last_result.intent='rest',
    s=>s.agents[f.a.agent_id].journey_job=structuredClone(pair.old.agents[f.a.agent_id].journey_job),
    s=>s.journey.monsters[0].hp=24,
    s=>s.journey.monsters[1].respawn_at++,
    s=>s.events=s.events.filter(e=>e.type!=='journey_finished'),
  ]){const current=structuredClone(pair.current);mutate(current);assert.throws(()=>verifyJourney(pair.old,current));}
  pass(f.restart());
});

test('v033 only an elapsed real respawn deadline can restore a monster at restart',t=>{
  const f=fixture(t),m=f.world.state.journey.monsters[0];m.hp=0;m.status='respawning';m.respawn_at=2000000001000;
  const pair=f.restart();pass(pair);assert.equal(f.world.state.journey.monsters[0].hp,24);
  const forged=structuredClone(pair.current);forged.events=forged.events.filter(e=>e.type!=='journey_respawn');
  assert.throws(()=>verifyJourney(pair.old,forged));
});
