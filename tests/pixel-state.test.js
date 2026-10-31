import test from 'node:test';
import assert from 'node:assert/strict';
import { animationFrame, characterAction, characterActionKey, monsterAction, movementFacing } from '../src/pixel-state.js';

const actor = { agent_id:'a',status:'active',position:{x:11,y:8},fatigue:{state:'fresh'} };
const event = (type, payload = {}, occurred_at=1000) => ({type,occurred_at,payload:{agent_id:'a',...payload}});
test('gathering poses require a live bounded job; cooking and eating only confirmed receipts',()=>{
  const gathering={...actor,life:{gathering:{job_id:'job',resource_id:'wood',started_at:1000,ends_at:13000}}};
  assert.equal(characterAction(gathering,[],5000),'gather');
  assert.equal(characterAction(gathering,[],14000),'idle');
  assert.equal(characterAction({...gathering,status:'offline'},[],5000),'idle');
  assert.equal(characterAction({...gathering,status:'paused'},[],5000),'idle');
  assert.equal(characterAction({...actor,life:{gathering:null}},[event('life_gather_cancelled')],1100),'idle');
  assert.equal(characterAction(actor,[event('life_crafted',{item_id:'turnip_soup'})],1100),'cook');
  assert.equal(characterAction(actor,[event('life_crafted',{item_id:'wooden_sword'})],1100),'craft');
  assert.equal(characterAction(actor,[event('life_consumed',{item_id:'wheat_bread'})],1100),'eat');
  assert.equal(characterAction(actor,[event('life_consumed',{item_id:'wheat_bread'})],3000),'idle');
  assert.equal(characterActionKey(gathering,[],'gather'),'gather:job');
  assert.notEqual(characterActionKey(actor,[{...event('life_crafted'),event_id:'one'}],'cook'),characterActionKey(actor,[{...event('life_crafted'),event_id:'two'}],'cook'));
});
test('pixel action follows the latest confirmed public action and expires',()=>{
  assert.equal(characterAction(actor,[event('life_planted')],1100),'plant');
  assert.equal(characterAction(actor,[event('life_planted'),event('agent_moved')],1100),'walk');
  assert.equal(characterAction(actor,[event('adventure_combat',{attacker:'monster'})],1100),'hurt');
  assert.equal(characterAction(actor,[event('adventure_combat',{attacker:'agent'})],1100),'attack');
  assert.equal(characterAction(actor,[event('life_watered')],3000),'idle');
  assert.equal(characterAction({...actor,status:'paused'},[event('adventure_combat')],1100),'idle');
});
test('plans alone do not fabricate walking, combat or sleep',()=>{
  assert.equal(characterAction({...actor,adventure:{plan:{intent:'hunt'}}},[],3000),'idle');
  assert.equal(characterAction({...actor,fatigue:{state:'tired'}},[],3000),'tired');
  assert.equal(characterAction({...actor,adventure:{plan:{intent:'rest'}}},[],3000),'rest');
  assert.equal(characterAction({...actor,position:{x:2,y:8},adventure:{plan:{intent:'rest'}}},[],3000),'idle');
  assert.equal(characterAction({...actor,fatigue:{recent_exertion:{last_kind:'attack',last_at:2900}}},[],3000),'attack');
});

test('cooperative meal animates only the confirmed chef, never acceptance, supplier or patrol',()=>{
  const receipt={event_id:'meal-result',type:'cooperation_completed',occurred_at:1000,payload:{template_id:'camp_meal',status:'completed',members:[{agent_id:'a',role_id:'cook'},{agent_id:'b',role_id:'supplier'}]}};
  assert.equal(characterAction(actor,[receipt],1100),'cook');
  assert.equal(characterActionKey(actor,[receipt],'cook'),'cook:meal-result');
  assert.equal(characterAction({...actor,agent_id:'b'},[receipt],1100),'idle');
  assert.equal(characterAction(actor,[{...receipt,type:'cooperation_started'}],1100),'idle');
  assert.equal(characterAction(actor,[{...receipt,payload:{...receipt.payload,template_id:'scout_and_guard'}}],1100),'idle');
  assert.equal(characterAction({...actor,status:'paused'},[receipt],1100),'idle');
  assert.equal(characterAction(actor,[receipt],3000),'idle');
});
test('sprite frames honor duration, nonlooping animation and static motion preference',()=>{
  const frames=[{x:0,y:0,w:48,h:48,duration:100},{x:48,y:0,w:48,h:48,duration:200}];
  const definition={animations:{idle:{frames},hurt:{frames,loop:false}}};
  assert.equal(animationFrame(definition,'idle',150).x,48);
  assert.equal(animationFrame(definition,'idle',310).x,0);
  assert.equal(animationFrame(definition,'hurt',999).x,48);
  assert.equal(animationFrame(definition,'hurt',150,false).x,0);
  assert.equal(animationFrame(null,'walk',20),null);
  assert.equal(movementFacing({x:2,y:3},{x:1,y:3}),'west');
});

test('one server combat tick shows both real attack and retaliation without inventing either',()=>{
  const hits=[event('adventure_combat',{attacker:'agent'}),event('adventure_combat',{attacker:'monster'})];
  assert.equal(characterAction(actor,hits,1100),'attack');
  assert.equal(characterAction(actor,hits,1750),'hurt');
  assert.equal(characterAction(actor,hits,3000),'idle');
  const incoming=[event('adventure_combat',{attacker:'monster'})];
  assert.equal(characterAction(actor,incoming,1100),'hurt');
  assert.notEqual(characterActionKey(actor,hits,'attack'),characterActionKey(actor,[event('adventure_combat',{attacker:'agent'},2000)],'attack'));
});

test('monster animation needs a real move or combat receipt, never just an intent',()=>{
  const monster={monster_id:'forest_slime',status:'alive',behavior:'attacking'};
  assert.equal(monsterAction(monster,[],1100),'idle');
  assert.equal(monsterAction(monster,[],1100,true),'walk');
  const hits=[event('adventure_combat',{monster_id:'forest_slime',attacker:'agent'}),event('adventure_combat',{monster_id:'forest_slime',attacker:'monster'})];
  assert.equal(monsterAction(monster,hits,1100),'hurt');
  assert.equal(monsterAction(monster,hits,1750),'attack');
  assert.equal(monsterAction(monster,hits,3000),'idle');
});
