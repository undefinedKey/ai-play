import test from 'node:test';
import assert from 'node:assert/strict';
import {resourceState,cycleState} from '../src/wilderness-state.js';
import {characterAction} from '../src/pixel-state.js';
import {gatheringState} from '../src/life-state.js';

test('resource UI does not replenish stock or change phase when its visual countdown expires',()=>{
 const node={stock:0,regrow_at:2000};assert.deepEqual(resourceState(node,[],3000),{key:'depleted',label:'等待恢复',seconds:0});assert.equal(node.stock,0);
 const cycle={phase:'night',day_index:2,next_at:2000};assert.deepEqual(cycleState(cycle,3000),{phase:'night',label:'夜晚',day:2,seconds:0});assert.equal(cycle.phase,'night');
 assert.equal(cycleState(null,3000),null);
});
test('approaching resources is not labour and reservations do not invent a working animation',()=>{
 const actor={agent_id:'a',status:'active',position:{x:11,y:8},position_at:1000,action:null,hurt:null,movement:null,life:{gathering:{job_id:'j',phase:'approaching',started_at:1000,ends_at:5000,item_id:'wood'}}};
 assert.notEqual(characterAction(actor,[{type:'life_gather_started',occurred_at:1000,payload:{agent_id:'a'}}],2000),'gather');assert.equal(gatheringState(actor,null,2000).approaching,true);
 const node={stock:2,available:false,reservation:{agent_id:'a',job_id:'j'}};assert.equal(resourceState(node,[actor],2000).key,'reserved');actor.life.gathering.phase='working';assert.equal(resourceState(node,[actor],2000).key,'working');assert.equal(characterAction(actor,[],2000),'gather');
});


test('hand-drawn pond geometry stays inside its actual blocking footprint and scenes have separate roads',async()=>{
 const {wildernessGround,pondGeometry}=await import('../src/wilderness-art.js');
 const a=wildernessGround('plaza'),b=wildernessGround('adventure');assert.notDeepEqual(a.trails,b.trails);
 for(const data of[a,b]){const pond=pondGeometry(data.pond);if(!pond)continue;for(const p of[...pond.bank,...pond.water])assert.ok(data.pond.some(cell=>p.x>=cell.x*32&&p.x<cell.x*32+32&&p.y>=cell.y*32&&p.y<cell.y*32+32),'painted water/bank outside authoritative blocked cell');assert.ok(pond.water.length>8);}
});
