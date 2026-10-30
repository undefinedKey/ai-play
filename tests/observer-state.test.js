import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseObserver,presenceState,presenceLabel,publicName,nearbySlots,recordTime} from '../src/observer-state.js';
import {runtimeHealth} from '../src/runtime-state.js';
import {publicSpeechHistory} from '../src/speech-state.js';
test('observer default never invents a current protagonist from history; explicit selection and overview persist',()=>{
 const history={agent_id:'old',status:'offline',name:'验证'},active={agent_id:'new',status:'active',name:'旅人'};
 assert.equal(chooseObserver([history],null),null);assert.equal(chooseObserver([history,active],null),active);assert.equal(chooseObserver([history,active],'old'),history);assert.equal(chooseObserver([history,active],''),null);
 assert.equal(presenceLabel({...history,presence:{state:'never_joined',has_joined:false}}),'从未入场');assert.equal(presenceLabel({...history,presence:{state:'unknown',has_joined:null}}),'在场情况未知');assert.equal(presenceLabel({...history,presence:{state:'offline',has_joined:true}}),'已离线');
});
test('duplicate identities get stable distinguishing IDs and five occupants get distinct visual slots',()=>{
 const actors=Array.from({length:5},(_,i)=>({agent_id:`agent_12345${i}-a`,name:'同名',position:{x:11,y:8}}));
 assert.equal(new Set(actors.map(a=>publicName(a,actors))).size,5);assert.equal(new Set([...nearbySlots(actors).values()].map(p=>`${p.x},${p.y}`)).size,5);
 assert.match(recordTime(100000,220000),/2 分钟前/);assert.equal(recordTime(null),'时间未记录');
});
test('health labels distinguish stale bridge evidence, model failure, normal wait and authority boundaries',()=>{
 const base={status:'active',diagnostics:{health:{received_at:100000,stale_after_ms:30000,waiting_reason:'waiting_event',model:'idle'}}};
 assert.equal(runtimeHealth(base,110000).stale,false);assert.equal(runtimeHealth(base,110000).label,'等待新事件');assert.equal(runtimeHealth(base,131000).stale,true);
 assert.equal(runtimeHealth({...base,status:'paused',pause_reason:'主人暂停'},110000).label,'主人已暂停');
 const restarted={...base,status:'offline',run:{status:'paused'},pause_reason:'主人暂停',presence:{state:'paused'}};
 assert.equal(presenceState(restarted),'paused');assert.equal(presenceLabel(restarted),'已暂停');assert.equal(runtimeHealth(restarted,110000).label,'主人已暂停');
 for(const [reason,label] of [['model_unavailable','模型暂不可用'],['budget_exhausted','预算已耗尽'],['grant_expired','授权已到期']])assert.equal(runtimeHealth({...base,diagnostics:{health:{...base.diagnostics.health,waiting_reason:reason}}},110000).label,label);
 assert.equal(runtimeHealth({status:'offline'},110000).stale,true);
});
test('message history filters only actual public speech, retains offline history, excludes future/private/system text',()=>{
 const agents=[{agent_id:'a',name:'甲',status:'offline',group_id:'g'},{agent_id:'b',name:'乙',status:'active',group_id:'g'}];
 const event=(id,type,channel,agent_id,extra={})=>({event_id:id,type,occurred_at:100,payload:{channel,agent_id,text:id,group_id:'g',...extra}});
 const events=[event('a','say','nearby','a'),event('b','message','group','b'),event('secret','say','private','a'),event('system','life_ready','group','b'),{...event('future','say','group','b'),occurred_at:999}];
 assert.deepEqual(publicSpeechHistory({events,agents,now:200}).map(m=>m.text),['b','a']);
 assert.deepEqual(publicSpeechHistory({events,agents,now:200,selected:'a',filter:'selected'}).map(m=>m.text),['a']);
 assert.deepEqual(publicSpeechHistory({events,agents,now:200,selected:'a',filter:'group'}).map(m=>m.text),['b']);
});
