import test from 'node:test';
import assert from 'node:assert/strict';
import {samplePaperDollPose,PAPER_DOLL_DIMENSIONS,PAPER_DOLL_PARTS} from '../src/paper-doll-rig.js';
import {sampleGait} from '../src/actor-motion.js';
import {sampleMotion} from '../shared/motion.js';
import {FEIYU_RIG_DIMENSIONS,FEIYU_PART_GEOMETRY} from '../art/ink-world/paper-doll.mjs';

const base={agent_id:'rig',status:'active',scene_id:'plaza',position:{x:5,y:5},position_at:1000,facing:'east'};
const moving=(mode='walk',now=1100)=>({...base,position_at:now,movement:{version:2,movement_id:'path',scene_id:'plaza',path:[{x:5,y:5},{x:20,y:5}],speed:mode==='run'?3.5:2,mode,started_at:1000,ends_at:10000}});
const near=(actual,expected,epsilon=1e-7)=>assert.ok(Math.abs(actual-expected)<epsilon,`${actual} != ${expected}`);
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const endpoint=(part,length)=>({x:part.x-Math.sin(part.rotation)*length*part.scaleY,y:part.y+Math.cos(part.rotation)*length*part.scaleY});
const samePoint=(a,b)=>{near(a.x,b.x);near(a.y,b.y);};
const deepFreeze=value=>{if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))deepFreeze(child);}return value;};

test('all fifteen independently posed body parts share a real connected fixed-length skeleton',()=>{
  for(const facing of ['south','north','east','west'])for(const action of ['walk','run'])for(let step=0;step<80;step++){
    const pose=samplePaperDollPose(moving(action),action,1100,{phase:step/80,facing});
    assert.deepEqual(Object.keys(pose.parts).sort(),[...PAPER_DOLL_PARTS].sort());
    for(const part of Object.values(pose.parts))for(const value of Object.values(part))assert.ok(Number.isFinite(value));
    const {joints:j,parts:p,dimensions:d}=pose;
    for(const side of ['l','r']){
      const physical=pose.legSpace[side],span=(a,b)=>Math.hypot(a.depth-b.depth,a.height-b.height);
      near(span(physical.hip,physical.knee),d.thigh);near(span(physical.knee,physical.ankle),d.shin);
      near(distance(j[`shoulder_${side}`],j[`elbow_${side}`]),d.upperArm);near(distance(j[`elbow_${side}`],j[`wrist_${side}`]),d.forearm);
      samePoint(endpoint(p[`thigh_${side}`],d.thigh),p[`shin_${side}`]);samePoint(endpoint(p[`shin_${side}`],d.shin),p[`foot_${side}`]);
      samePoint(endpoint(p[`upper_arm_${side}`],d.upperArm),p[`forearm_${side}`]);samePoint(endpoint(p[`forearm_${side}`],d.forearm),p[`hand_${side}`]);
    }
    samePoint(endpoint(p.torso,-d.torso),p.head);
    for(const [id,part] of Object.entries(p)){
      assert.equal(part.scaleX,1);assert.ok(Math.abs(part.layer)<.02);
      if(/^(thigh|shin)_/.test(id)&&['north','south'].includes(facing))assert.ok(part.scaleY>0&&part.scaleY<=Math.SQRT2+1e-8);
      else near(part.scaleY,1);
    }
  }
});

test('a planted foot remains fixed in world space while the authoritative root advances',()=>{
  let comparisons=0;
  for(const facing of ['east','west','north','south'])for(const action of ['walk','run']){
    const stride=action==='run'?48:40,sign=['west','north'].includes(facing)?-1:1,axis=['east','west'].includes(facing)?'x':'y';
    for(let i=0;i<400;i++){
      const phase=i/400,next=phase+.001,a=samplePaperDollPose(moving(action),action,1100,{phase,facing}),b=samplePaperDollPose(moving(action),action,1100,{phase:next,facing});
      for(const side of ['l','r'])if(a.contacts[side].grounded&&b.contacts[side].grounded&&b.contacts[side].phase>a.contacts[side].phase){
        near(sign*phase*stride+a.contacts[side][axis],sign*next*stride+b.contacts[side][axis]);
        for(const pose of [a,b]){const foot=pose.parts[`foot_${side}`];samePoint(endpoint(foot,pose.dimensions.sole),pose.contacts[side]);}
        comparisons++;
      }
    }
  }
  assert.ok(comparisons>1000);
});

test('published Feiyu proportions and the real shared odometer preserve actual FK foot contact in all directions',()=>{
  for(const facing of ['east','west','north','south'])for(const mode of ['walk','run']){
    const dx=facing==='east'?1:facing==='west'?-1:0,dy=facing==='south'?1:facing==='north'?-1:0;
    let prior=null,state=null,checked=0;
    for(let time=1005;time<1800;time+=5){
      const actor=moving(mode,time);actor.movement.path=[{x:5,y:5},{x:5+dx*10,y:5+dy*10}];
      const gait=sampleGait(actor,time,state);state=gait.state;
      const root=sampleMotion(actor,time).position,pose=samplePaperDollPose(actor,mode,time,{phase:gait.phase,facing,rig:{dimensions:FEIYU_RIG_DIMENSIONS}});
      for(const side of ['l','r'])if(pose.contacts[side].grounded){
        // Check the actual bone chain's foot tip, including its current angle,
        // rather than accepting the sampler's declared ground-contact marker.
        const foot=endpoint(pose.parts[`foot_${side}`],FEIYU_RIG_DIMENSIONS.sole);
        samePoint(foot,pose.contacts[side]);
        if(prior?.pose.contacts[side].grounded&&pose.contacts[side].phase>prior.pose.contacts[side].phase){
          const old=endpoint(prior.pose.parts[`foot_${side}`],FEIYU_RIG_DIMENSIONS.sole);
          near(root.x*32+foot.x,prior.root.x*32+old.x);near(root.y*32+foot.y,prior.root.y*32+old.y);checked++;
        }
      }
      prior={root,pose};
    }
    assert.ok(checked>40);
  }
});

test('measured source limb axes reach the same distal joint after art correction and west mirroring',()=>{
  for(const facing of ['east','west','north','south']){
    const direction=facing==='west'?'east':facing,mirror=facing==='west'?-1:1;
    const pose=samplePaperDollPose(moving('run'),'run',1100,{phase:.21,facing,rig:{dimensions:FEIYU_RIG_DIMENSIONS}});
    for(const [id,lengthKey,next] of [['upper_arm','upperArm','forearm'],['forearm','forearm','hand'],['thigh','thigh','shin'],['shin','shin','foot']]){
      const [,pivot,distal]=FEIYU_PART_GEOMETRY[direction][id],dx=distal[0]-pivot[0],dy=distal[1]-pivot[1],scale=FEIYU_RIG_DIMENSIONS[lengthKey]/Math.hypot(dx,dy),rest=Math.atan2(dx,dy);
      for(const side of ['l','r']){
        const p=pose.parts[`${id}_${side}`],rotation=p.rotation,correction=rest*mirror,sx=dx*scale*mirror,sy=dy*scale;
        // Rbone * Sprojection * Rsource * mirror: projecting before correcting
        // the source bone's leaning axis detaches the distal joint.
        const x=(sx*Math.cos(correction)-sy*Math.sin(correction))*p.scaleX,y=(sx*Math.sin(correction)+sy*Math.cos(correction))*p.scaleY;
        const endpoint={x:p.x+x*Math.cos(rotation)-y*Math.sin(rotation),y:p.y+x*Math.sin(rotation)+y*Math.cos(rotation)};
        samePoint(endpoint,pose.parts[`${next}_${side}`]);
      }
    }
  }
});

test('walking keeps at least one planted foot, running has flight, and swing knees keep their bend side',()=>{
  for(const facing of ['east','north','south']){
    let flight=0,swing=0;
    for(const action of ['walk','run'])for(let i=0;i<100;i++){
      const p=samplePaperDollPose(moving(action),action,1100,{phase:i/100,facing});
      if(action==='walk')assert.ok(p.contacts.l.grounded||p.contacts.r.grounded);
      else if(!p.contacts.l.grounded&&!p.contacts.r.grounded)flight++;
      for(const side of ['l','r']){
        const physical=p.legSpace[side],a=physical.hip,b=physical.knee,c=physical.ankle;
        const cross=(c.depth-a.depth)*(-b.height+a.height)-(-c.height+a.height)*(b.depth-a.depth);
        assert.ok(cross<0,'anatomical knees bend forward in the same physical plane');
        if(facing!=='east'){near(p.joints[`hip_${side}`].x,p.joints[`knee_${side}`].x);near(p.joints[`knee_${side}`].x,p.joints[`ankle_${side}`].x);}
        if(!p.contacts[side].grounded){assert.ok(p.joints[`ankle_${side}`].y+p.dimensions.sole<=p.contacts[side].y+1e-7);swing++;}
      }
    }
    assert.ok(flight>10);assert.ok(swing>50);
  }
});

test('neutral legs are nearly extended and the pelvis joins stance and running flight continuously',()=>{
  const neutral=samplePaperDollPose(base,'idle',1100,{facing:'east'});
  for(const side of ['l','r'])assert.ok(Math.abs(neutral.parts[`thigh_${side}`].rotation-neutral.parts[`shin_${side}`].rotation)<.75,'neutral is standing, not a permanent crouch');
  for(const facing of ['east','north','south'])for(const action of ['walk','run']){
    let previous=samplePaperDollPose(moving(action),action,1100,{phase:0,facing});
    for(let i=1;i<=1000;i++){
      const next=samplePaperDollPose(moving(action),action,1100,{phase:i/1000,facing});
      assert.ok(Math.abs(previous.joints.hip.y-next.joints.hip.y)<.2,`takeoff, landing and cycle wrap cannot pop the torso: ${facing} ${action} ${i/1000} ${previous.joints.hip.y} -> ${next.joints.hip.y}`);previous=next;
    }
  }
});

test('front and back share the side-view distance cadence and do not double the head bounce',()=>{
  for(const action of ['walk','run']){
    const heights={east:[],south:[],north:[]};
    for(let i=0;i<400;i++){
      const phase=i/400,poses=Object.fromEntries(Object.keys(heights).map(facing=>[facing,samplePaperDollPose(moving(action),action,1100,{phase,facing})]));
      for(const facing of Object.keys(heights)){
        const p=poses[facing];near(p.phase,poses.east.phase);heights[facing].push(p.joints.neck.y);
        for(const side of ['l','r']){
          assert.equal(p.contacts[side].grounded,poses.east.contacts[side].grounded);near(p.contacts[side].phase,poses.east.contacts[side].phase);
          assert.deepEqual(p.legSpace[side],poses.east.legSpace[side],'physical skeleton does not depend on viewing direction');
        }
      }
    }
    const range=values=>Math.max(...values)-Math.min(...values),side=range(heights.east);
    for(const facing of ['north','south'])assert.ok(range(heights[facing])<=side+.01,'small torso roll may vary by subpixel, not double frontal bobbing');
  }
});

test('near-zero projected bones remain tiny and connected instead of expanding to a full-length fallback',()=>{
  let nearZero=0;
  for(const facing of ['north','south'])for(const action of ['walk','run']){
    let previous=null;
    for(let i=0;i<=2000;i++){
      const p=samplePaperDollPose(moving(action),action,1100,{phase:i/2000,facing});
      for(const side of ['l','r'])for(const [name,next,length] of [['thigh','shin',p.dimensions.thigh],['shin','foot',p.dimensions.shin]]){
        const bone=p.parts[`${name}_${side}`],target=p.parts[`${next}_${side}`],end=endpoint(bone,length);
        assert.ok(bone.scaleY>=1e-8);assert.ok(distance(end,target)<=length*1e-8+1e-8);
        if(bone.scaleY<.01)nearZero++;
        if(previous)assert.ok(distance(target,previous.parts[`${next}_${side}`])<.3,`visible joint endpoints remain continuous when projected direction reverses: ${facing} ${action} ${i/2000} ${next}_${side} ${distance(target,previous.parts[`${next}_${side}`])}`);
      }
      previous=p;
    }
  }
  assert.ok(nearZero>20,'exercise actual foreshortened extremities rather than only ordinary poses');
});

test('west mirrors joints, limbs and held equipment once; attachment offsets rotate with their parent',()=>{
  const actor=moving('run'),rig={attachment_offsets:{head:{x:2,y:-15},chest:{x:1,y:-7},hand:{x:0,y:1}}};
  const east=samplePaperDollPose(actor,'run',1100,{phase:.21,facing:'east',rig}),west=samplePaperDollPose(actor,'run',1100,{phase:.21,facing:'west',rig});
  for(const collection of ['parts','slots','joints','contacts'])for(const key of Object.keys(east[collection])){
    near(west[collection][key].x,-east[collection][key].x);near(west[collection][key].y,east[collection][key].y);
    if('rotation'in east[collection][key])near(west[collection][key].rotation,-east[collection][key].rotation);
  }
  near(distance(east.slots.hand,east.joints.wrist_r),1);
  const canonical=samplePaperDollPose(actor,'run',1100,{phase:.21,facing:'east'});
  samePoint(canonical.slots.hand,canonical.joints.wrist_r);
  near(distance(canonical.slots.head,canonical.joints.neck),PAPER_DOLL_DIMENSIONS.head*.75);
});

test('back-view arms and held items are occluded by the torso; side views retain a near and far arm',()=>{
  const north=samplePaperDollPose(moving('run'),'run',1100,{phase:.21,facing:'north'});
  for(const side of ['l','r'])for(const part of ['upper_arm','forearm','hand'])assert.ok(north.parts[`${part}_${side}`].layer<north.parts.torso.layer);
  assert.ok(north.slots.hand.layer<north.parts.torso.layer);
  for(const facing of ['east','west','south']){
    const pose=samplePaperDollPose(moving('run'),'run',1100,{phase:.21,facing});
    assert.ok(pose.parts.hand_l.layer<pose.parts.torso.layer);
    assert.ok(pose.parts.hand_r.layer>pose.parts.torso.layer);
    assert.ok(pose.slots.hand.layer>pose.parts.torso.layer);
  }
});

test('distance phase drives limbs rather than frame rate, server packet times or elapsed art time',()=>{
  const a=samplePaperDollPose(moving('walk',1100),'walk',1100,{phase:.33,facing:'east',elapsed:15});
  const b=samplePaperDollPose(moving('walk',1600),'walk',1600,{phase:.33,facing:'east',elapsed:9000});
  assert.deepEqual(a.parts,b.parts);
  const c=samplePaperDollPose(moving('walk'),'walk',1100,{phase:.55,facing:'east'});
  assert.notEqual(a.parts.thigh_l.rotation,c.parts.thigh_l.rotation);
  assert.notEqual(a.parts.shin_l.rotation-a.parts.thigh_l.rotation,c.parts.shin_l.rotation-c.parts.thigh_l.rotation);
});

test('stop, stale motion, a scene mismatch and reduced motion all immediately select a time-invariant neutral rig',()=>{
  const still=samplePaperDollPose(base,'idle',1100,{facing:'east'}).parts;
  for(const pose of [
    samplePaperDollPose(moving(),'walk',1100,{enabled:false,phase:.3,facing:'east'}),
    samplePaperDollPose({...moving(),status:'paused'},'walk',1100,{phase:.3,facing:'east'}),
    samplePaperDollPose(moving('walk',1000),'walk',1400,{phase:.3,facing:'east'}),
    samplePaperDollPose({...moving(),scene_id:'adventure'},'walk',1100,{phase:.3,facing:'east'}),
  ]){assert.deepEqual(pose.parts,still);assert.equal(pose.moving,false);assert.equal(pose.action,'idle');}
});

test('attack holds preparation past the deadline until a real hit, while miss and cancellation never strike',()=>{
  const actor={...base,action:{type:'attack',scene_id:'plaza',started_at:1000,impact_at:1400,ends_at:2200,resolved_at:null,outcome:null}};
  const pending=samplePaperDollPose(actor,'attack',1750,{facing:'east'}),ready=samplePaperDollPose(actor,'attack',1450,{facing:'east'});
  assert.deepEqual(pending.parts,ready.parts);assert.equal(pending.actionPhase,'prepare');
  const hit={...actor,action:{...actor.action,outcome:'hit',resolved_at:1700}};
  const before=samplePaperDollPose(hit,'attack',1650,{facing:'east'}),strike=samplePaperDollPose(hit,'attack',1790,{facing:'east'});
  assert.equal(before.actionPhase,'prepare');assert.equal(strike.actionPhase,'strike');
  assert.ok(strike.joints.wrist_r.y>pending.joints.wrist_r.y+8,'the actual forearm and hand swing down');
  const miss={...hit,action:{...hit.action,outcome:'miss'}};
  for(let now=1700;now<2200;now+=20)assert.equal(samplePaperDollPose(miss,'attack',now).actionPhase,'recovery');
  for(const outcome of ['cancelled',null]){
    const cancelled={...hit,action:{...hit.action,outcome}};
    const p=samplePaperDollPose(cancelled,'attack',2250);assert.equal(p.action,'idle');
  }
  assert.equal(samplePaperDollPose({...hit,action:{...hit.action,outcome:'cancelled'}},'attack',1790).action,'idle');
});

test('hurt is bounded by a real hurt interval and cannot move the authoritative root or modify health',()=>{
  const actor=deepFreeze({...base,hp:12,hurt:{started_at:1000,ends_at:1360,damage:3}});
  const a=samplePaperDollPose(actor,'hurt',1065,{facing:'east'});
  assert.equal(a.action,'hurt');assert.notEqual(a.parts.torso.rotation,0);
  for(const now of [999,1360,9999])assert.equal(samplePaperDollPose(actor,'hurt',now).action,'idle');
  assert.deepEqual(actor.position,{x:5,y:5});assert.equal(actor.hp,12);
});

test('only an actual working interval animates harvest; hand picking bends knees and tool work stays standing',()=>{
  const job={job_id:'harvest',phase:'working',started_at:1000,work_started_at:1100,ends_at:5000,tool_id:'axe'};
  const axe={...base,life:{gathering:job}},hand={...base,life:{gathering:{...job,tool_id:null}}};
  for(const phase of ['approaching','cancelled','complete',undefined])assert.equal(samplePaperDollPose({...axe,life:{gathering:{...job,phase}}},'gather',1650).action,'idle');
  for(const now of [1099,5000])assert.equal(samplePaperDollPose(axe,'gather',now).action,'idle');
  const cutting=samplePaperDollPose(axe,'gather',1650,{facing:'east'}),picking=samplePaperDollPose(hand,'gather',1550,{facing:'east'});
  assert.equal(cutting.actionPhase,'work_swing');assert.equal(picking.actionPhase,'pick');
  near(cutting.joints.hip.y,-PAPER_DOLL_DIMENSIONS.hipHeight);assert.ok(picking.joints.hip.y>cutting.joints.hip.y+4);
  assert.notEqual(cutting.parts.forearm_r.rotation,picking.parts.forearm_r.rotation);
  assert.deepEqual(samplePaperDollPose(axe,'gather',1650,{enabled:false}).parts,samplePaperDollPose(base,'idle',1650).parts);
});

test('calibrated lengths and attachment pivots are accepted without mutating rig or actor data',()=>{
  const rig=deepFreeze({dimensions:{upperArm:8,forearm:7,torso:14,head:23},attachment_offsets:{hand:{x:0,y:1.5}}}),actor=deepFreeze(moving());
  const p=samplePaperDollPose(actor,'walk',1100,{phase:.2,rig});
  near(distance(p.joints.shoulder_r,p.joints.elbow_r),8);near(distance(p.joints.elbow_r,p.joints.wrist_r),7);near(distance(p.joints.hip,p.joints.neck),14);
  const safe=samplePaperDollPose(actor,'walk',NaN,{phase:Infinity,rig:{dimensions:{head:Infinity,thigh:NaN}}});
  assert.equal(safe.action,'idle');assert.ok(Object.values(safe.parts).every(part=>Object.values(part).every(Number.isFinite)));
});

test('receipt-driven farming and social gestures end, and missing receipts cannot invent activity',()=>{
  for(const action of ['till','water','plant','harvest','craft','repair','upgrade','cook','eat']){
    for(const elapsed of [undefined,NaN,-1,1600,4000])assert.equal(samplePaperDollPose(base,action,1200,{elapsed}).action,'idle');
    const pose=samplePaperDollPose(base,action,1200,{elapsed:800});assert.equal(pose.action,action);assert.equal(pose.actionPhase,'receipt');
    assert.notDeepEqual(pose.parts,samplePaperDollPose(base,'idle',1200).parts);
  }
  assert.equal(samplePaperDollPose(base,'rest',1200).action,'idle');
  const resting={...base,adventure:{plan:{intent:'rest'}}};
  assert.deepEqual(samplePaperDollPose(resting,'rest',1200).parts,samplePaperDollPose(resting,'rest',9000).parts);
  const tired={...base,fatigue:{state:'tired'}};assert.equal(samplePaperDollPose(tired,'tired',1200).action,'tired');
});
