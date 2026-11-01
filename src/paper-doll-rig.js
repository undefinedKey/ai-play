import {sampleMotion} from '../shared/motion.js';

// Canonical world pixels, independent of atlas padding and camera zoom. Limb
// artwork points down from its proximal pivot. Torso/head point up from hip/neck.
export const PAPER_DOLL_DIMENSIONS=Object.freeze({hipHeight:21.8,hipWidth:3.2,shoulderWidth:5.3,torso:12,head:20,upperArm:7,forearm:6,hand:3,thigh:10,shin:10,sole:3});
export const PAPER_DOLL_PARTS=Object.freeze(['hip','torso','head','upper_arm_l','forearm_l','hand_l','upper_arm_r','forearm_r','hand_r','thigh_l','shin_l','foot_l','thigh_r','shin_r','foot_r']);
const TAU=Math.PI*2;
const finite=(n,fallback=0)=>Number.isFinite(n)?n:fallback;
const clamp=(n,lo=0,hi=1)=>Math.max(lo,Math.min(hi,finite(n,lo)));
const wrap=n=>((finite(n)%1)+1)%1;
const smooth=n=>{const t=clamp(n);return t*t*(3-2*t);};
const mix=(a,b,t)=>a+(b-a)*t;
const point=(x,y)=>({x,y});
const add=(a,b)=>point(a.x+b.x,a.y+b.y);
const rotate=(p,angle)=>point(p.x*Math.cos(angle)-p.y*Math.sin(angle),p.x*Math.sin(angle)+p.y*Math.cos(angle));
const down=(length,angle)=>rotate(point(0,length),angle);
const angle=(a,b)=>Math.atan2(-(b.x-a.x),b.y-a.y);
const inWindow=(value,now)=>Number.isFinite(value?.started_at)&&Number.isFinite(value?.ends_at)&&now>=value.started_at&&now<value.ends_at;

function dimensions(rig){
  const supplied=rig?.dimensions||rig||{};
  return Object.fromEntries(Object.entries(PAPER_DOLL_DIMENSIONS).map(([key,value])=>[key,clamp(finite(supplied[key],value),.5,64)]));
}

// Fixed-length two-bone IK. The signed bend branch is anatomical: north/south
// never reverse a knee merely because travel direction changes. Out-of-reach
// artistic targets are clamped, never stretched into a new world position.
function limb(root,target,a,b,bend){
  const dx=target.x-root.x,dy=target.y-root.y,length=Math.hypot(dx,dy);
  const ux=length>1e-8?dx/length:0,uy=length>1e-8?dy/length:1;
  const reach=clamp(length,Math.abs(a-b)+1e-5,a+b-1e-5);
  const along=(a*a-b*b+reach*reach)/(2*reach),height=Math.sqrt(Math.max(0,a*a-along*along));
  const middle=point(root.x+ux*along+uy*height*bend,root.y+uy*along-ux*height*bend);
  const end=point(root.x+ux*reach,root.y+uy*reach);
  return {root,middle,end,upper:angle(root,middle),lower:angle(middle,end)};
}

function footCycle(phase,run){
  const p=wrap(phase),duty=run?.36:.52;
  // sampleGait's distance cycles are 1.25/1.5 tiles, each tile 32px. Every
  // direction has the same cadence; depth foreshortening belongs to projection.
  const stride=run?48:40,half=stride*duty/2;
  if(p<duty)return {travel:half-stride*p,lift:0,rotation:0,grounded:true,phase:p};
  const q=(p-duty)/(1-duty),q2=q*q,q3=q2*q,tangent=-stride*(1-duty);
  const travel=(2*q3-3*q2+1)*-half+(q3-2*q2+q)*tangent+(-2*q3+3*q2)*half+(q3-q2)*tangent;
  return {travel,lift:Math.sin(q*Math.PI)**2*(run?7:4),rotation:Math.sin(q*TAU)*.22,grounded:false,phase:p};
}

function workAt(actor,now){
  const job=actor?.life?.gathering,start=job?.work_started_at??job?.started_at;
  return job?.phase==='working'&&Number.isFinite(start)&&Number.isFinite(job.ends_at)&&now>=start&&now<job.ends_at?{job,elapsed:now-start}:null;
}

/** Pure presentation rig. `phase` comes from sampleGait's travelled distance,
 * not an animation timer. No pose changes position, damage, loot or AI intent.
 * Returned transforms are GLOBAL relative to the authoritative foot (0,0).
 * Legs have fixed physical lengths in forward-depth/height space. Projected
 * scaleY is image foreshortening, not stretching the physical skeleton. Apply
 * source-axis correction BEFORE this scale, then the global bone rotation.
 * West already mirrors x/rotation; the renderer additionally mirrors artwork.
 * Callers must pass enabled=false for pause, disconnection or reduced motion.
 */
export function samplePaperDollPose(actor,action,now,{phase=0,enabled=true,facing='south',elapsed,rig={}}={}){
  const d=dimensions(rig),direction=['north','south','east','west'].includes(facing)?facing:'south';
  const vertical=direction==='north'||direction==='south',mirror=direction==='west';
  const active=!!enabled&&['active','alive'].includes(actor?.status)&&Number.isFinite(now);
  const motion=active&&['walk','run'].includes(action)?sampleMotion(actor,now):null;
  const moving=!!motion?.moving,run=moving&&motion.mode==='run';
  const attack=active&&action==='attack'&&actor.action?.type==='attack'&&inWindow(actor.action,now)&&actor.action.outcome!=='cancelled'&&(!actor.action.scene_id||actor.action.scene_id===actor.scene_id)?actor.action:null;
  const hurt=active&&action==='hurt'&&inWindow(actor.hurt,now)?actor.hurt:null;
  const work=active&&['gather','plant'].includes(action)?workAt(actor,now):null;
  const receipt=active&&Number.isFinite(elapsed)&&elapsed>=0&&elapsed<1600&&['till','water','harvest','plant','craft','repair','upgrade','cook','eat'].includes(action);
  const resting=active&&action==='rest'&&(actor.adventure?.plan?.intent==='rest'||actor.activity?.activity_id==='relax');
  const tired=active&&action==='tired'&&['tired','exhausted'].includes(actor.fatigue?.state);
  let kind=moving?(run?'run':'walk'):attack?'attack':hurt?'hurt':work?'gather':receipt?action:resting?'rest':tired?'tired':'idle';
  let stage=kind==='idle'?'rest':kind,cycle=wrap(phase);
  let hip=point(0,-d.hipHeight),torsoRotation=0,headRotation=0;
  let arms={l:{upper:.08,lower:-.10},r:{upper:-.08,lower:-.18}},armTargets=null;
  let feet={l:{travel:0,lift:0,rotation:0,grounded:true,phase:0},r:{travel:0,lift:0,rotation:0,grounded:true,phase:.5}};

  if(moving){
    feet={l:footCycle(cycle,run),r:footCycle(cycle+.5,run)};
    const reach=d.thigh+d.shin-(run?.8:.35);
    const supportHeight=travel=>Math.max(-d.hipHeight,-d.sole-Math.sqrt(Math.max(0,reach*reach-travel*travel)));
    const planted=Object.values(feet).filter(foot=>foot.grounded);
    if(!run){
      // Double support does not vanish in a single frame. The leaving foot's
      // pelvis constraint eases out, and the next landing is anticipated.
      const half=40*.52/2;
      hip.y=Math.max(...Object.values(feet).map(foot=>foot.grounded?supportHeight(foot.travel):foot.phase<.64?mix(-d.hipHeight,supportHeight(-half),1-smooth((foot.phase-.52)/.12)):foot.phase>.88?mix(-d.hipHeight,supportHeight(half),smooth((foot.phase-.88)/.12)):-d.hipHeight));
    }else if(planted.length)hip.y=Math.max(...planted.map(foot=>supportHeight(foot.travel)));
    else{
      // Flight joins the exact takeoff/landing heights, rather than snapping
      // the pelvis back to standing height when the last toe leaves the floor.
      const q=(wrap(cycle*2)/2-.36)/.14,half=48*.36/2;
      hip.y=mix(supportHeight(-half),supportHeight(half),smooth(q))-Math.sin(q*Math.PI)**2*2.1;
    }
    // The swinging leg must also retain some knee flexion. Letting its late
    // forward reach hit the straight-leg IK singularity makes the knee whip
    // abruptly even though the foot target itself is continuous.
    hip.y=Math.max(hip.y,...Object.values(feet).map(foot=>-d.sole-foot.lift-Math.sqrt(Math.max(0,reach*reach-foot.travel*foot.travel))));
    torsoRotation=vertical?Math.sin(cycle*TAU)*.018:run?.075:.025;
    headRotation=-torsoRotation*.55;
    for(const side of ['l','r']){
      const swing=Math.cos(wrap(cycle+(side==='r'?.5:0))*TAU),spread=side==='l'?1:-1;
      arms[side]=vertical?{upper:spread*(.16+(run?.15:.08)*swing),lower:spread*(.08+(run?.27:.12)*swing)}:{upper:swing*(run?.85:.55),lower:swing*(run?.85:.55)-(run?.95:.28)};
    }
  }else if(attack){
    const preparation=smooth((now-attack.started_at)/Math.max(1,finite(attack.impact_at,attack.ends_at)-attack.started_at));
    const resolved=Number.isFinite(attack.resolved_at)?attack.resolved_at:attack.impact_at;
    let raised=preparation,strike=0;
    stage='prepare';
    if(attack.outcome&&Number.isFinite(resolved)&&now>=resolved){
      const t=now-resolved,duration=Math.max(1,attack.ends_at-resolved);
      if(attack.outcome==='hit'){
        const downTime=Math.min(100,duration*.28),returnTime=Math.max(1,duration-downTime);
        strike=t<downTime?smooth(t/downTime):1-smooth((t-downTime)/returnTime);
        raised=t<downTime?1:1-smooth((t-downTime)/returnTime);
        stage=t<downTime?'strike':'recovery';
      }else{raised=1-smooth(t/duration);stage='recovery';}
    }
    arms.r={upper:mix(-.08,-2.55,raised)+strike*2.05,lower:mix(-.18,-2.90,raised)+strike*2.7};
    arms.l={upper:mix(.08,-1.8,raised)+strike*1.1,lower:mix(-.1,-2.2,raised)+strike*1.4};
    torsoRotation=(vertical?.035:.09)*strike-(vertical?.01:.035)*raised;
    headRotation=-torsoRotation*.5;
  }else if(hurt){
    const t=now-hurt.started_at,duration=hurt.ends_at-hurt.started_at,rise=Math.min(70,duration*.25);
    const recoil=t<rise?smooth(t/rise):1-smooth((t-rise)/Math.max(1,duration-rise));
    hip.x=vertical?0:-recoil*.8;hip.y+=recoil*.7;
    torsoRotation=-(vertical?.035:.12)*recoil;headRotation=-torsoRotation*.4;
    armTargets={l:point(-2,-d.hipHeight-d.torso*.4),r:point(3,-d.hipHeight-d.torso*.55)};
    stage='hurt';
  }else if(work){
    const tool=work.job.tool_id,toolWork=['axe','pickaxe'].includes(tool),duration=tool==='pickaxe'?1220:tool==='axe'?1100:900;
    const p=(work.elapsed%duration)/duration;
    if(toolWork){
      const raise=p<.42?smooth(p/.42):1,cut=p<.42?0:p<.58?smooth((p-.42)/.16):1-smooth((p-.58)/.42);
      const hold=p<.58?raise:1-smooth((p-.58)/.42);
      arms.r={upper:mix(-.08,-2.55,hold)+cut*2.15,lower:mix(-.18,-2.85,hold)+cut*2.75};
      arms.l={upper:mix(.08,-1.6,hold)+cut*.8,lower:mix(-.10,-2.0,hold)+cut*1.3};
      torsoRotation=(vertical?.025:.07)*cut;headRotation=-torsoRotation*.4;
      stage=p<.42?'work_prepare':p<.58?'work_swing':'work_recover';
    }else{
      const bend=Math.sin(p*Math.PI)**2;
      hip.y+=bend*4.5;torsoRotation=(vertical?.08:.3)*bend;headRotation=-torsoRotation*.35;
      armTargets={l:point(vertical?-4:3,-9+4*bend),r:point(vertical?4:6,-9+4*bend)};
      stage='pick';
    }
  }else if(receipt){
    // elapsed is supplied only from an observed receipt by actionPose. An
    // absent receipt must not create an endless local work animation at t=0.
    const t=elapsed/1600,envelope=Math.sin(t*Math.PI)**2;
    if(['plant','harvest'].includes(action)){
      hip.y+=envelope*5;torsoRotation=(vertical?.08:.28)*envelope;headRotation=-torsoRotation*.35;
      armTargets={l:point(vertical?-4:3,-10+5*envelope),r:point(vertical?4:6,-10+5*envelope)};
    }else if(action==='water'){
      arms.r={upper:-.7*envelope,lower:-1.4*envelope};arms.l={upper:-.2*envelope,lower:-.8*envelope};torsoRotation=(vertical?.02:.06)*envelope;
    }else if(action==='eat'){
      const neutral=point(vertical?d.shoulderWidth:1.5,-d.hipHeight+2),mouth=point(vertical?2:5,-d.hipHeight-d.torso-4);
      armTargets={l:point(-3,-d.hipHeight-3),r:point(mix(neutral.x,mouth.x,envelope),mix(neutral.y,mouth.y,envelope))};
    }else if(['till','repair','upgrade'].includes(action)){
      const pulse=Math.sin(t*TAU)**2*envelope;
      arms.r={upper:-1.4*envelope+pulse*.9,lower:-1.9*envelope+pulse*1.8};arms.l={upper:-.5*envelope,lower:-1.0*envelope};
      torsoRotation=(vertical?.02:.075)*pulse;
    }else{
      const pulse=Math.sin(t*TAU*2)*envelope;
      armTargets={l:point(-2,-d.hipHeight-3-pulse),r:point(3,-d.hipHeight-3+pulse)};
    }
    stage='receipt';
  }else if(resting){
    hip.y+=5;torsoRotation=vertical?0:.04;armTargets={l:point(-3,-8),r:point(4,-8)};stage='rest';
  }else if(tired){
    hip.y+=.8;torsoRotation=vertical?.025:.07;headRotation=.04;stage='tired';
  }

  const parts={},joints={hip},contacts={},legSpace={};
  const part=(name,p,rotation,layer,scaleY=1)=>{parts[name]={x:p.x,y:p.y,rotation,scaleX:1,scaleY,layer};};
  part('hip',hip,0,0);part('torso',hip,torsoRotation,.002);
  const neck=add(hip,rotate(point(0,-d.torso),torsoRotation));joints.neck=neck;
  const headAngle=torsoRotation+headRotation;part('head',neck,headAngle,.008);
  for(const side of ['l','r']){
    const sign=side==='l'?-1:1,foot=feet[side],lateral=sign*(vertical?d.hipWidth:1.25);
    // Solve in the same sagittal plane for all views. Projecting a bent knee
    // into the front/back view shortens the raster limb; bending it outward in
    // screen x instead would produce a frog kick and a direction-specific gait.
    const project=p=>point(lateral+(vertical?0:p.x),p.y+(vertical?(direction==='north'?-1:1)*p.x:0));
    const ground=point(lateral+(vertical?0:foot.travel),vertical?(direction==='north'?-1:1)*foot.travel:0);
    const leg=limb(point(vertical?0:hip.x,hip.y),point(foot.travel,-d.sole-foot.lift),d.thigh,d.shin,1);
    const projected={root:project(leg.root),middle:project(leg.middle),end:project(leg.end)};
    legSpace[side]=Object.fromEntries([['hip',leg.root],['knee',leg.middle],['ankle',leg.end]].map(([name,p])=>[name,{depth:p.x,height:-p.y}]));
    joints[`hip_${side}`]=projected.root;joints[`knee_${side}`]=projected.middle;joints[`ankle_${side}`]=projected.end;
    const layer=side==='l'?-.006:-.001;
    const thighScale=Math.hypot(projected.middle.x-projected.root.x,projected.middle.y-projected.root.y)/d.thigh;
    const shinScale=Math.hypot(projected.end.x-projected.middle.x,projected.end.y-projected.middle.y)/d.shin;
    part(`thigh_${side}`,projected.root,angle(projected.root,projected.middle),layer,Math.max(1e-8,thighScale));
    part(`shin_${side}`,projected.middle,angle(projected.middle,projected.end),layer+.0001,Math.max(1e-8,shinScale));
    part(`foot_${side}`,projected.end,foot.rotation,layer+.0002);
    contacts[side]={...ground,grounded:foot.grounded,phase:foot.phase};

    const shoulder=add(hip,rotate(point(sign*(vertical?d.shoulderWidth:1.5),-d.torso+2.5),torsoRotation));
    let elbow,wrist,upper,lower;
    if(armTargets){const solved=limb(shoulder,armTargets[side],d.upperArm,d.forearm,vertical?sign:-1);elbow=solved.middle;wrist=solved.end;upper=solved.upper;lower=solved.lower;}
    else{upper=arms[side].upper+torsoRotation;lower=arms[side].lower+torsoRotation;elbow=add(shoulder,down(d.upperArm,upper));wrist=add(elbow,down(d.forearm,lower));}
    joints[`shoulder_${side}`]=shoulder;joints[`elbow_${side}`]=elbow;joints[`wrist_${side}`]=wrist;
    // Looking at the back, hands and their held object must pass behind the
    // coat wherever they overlap it. Side views retain a far/near arm pair.
    const armLayer=side==='l'?-.007:direction==='north'?-.006:.005;
    part(`upper_arm_${side}`,shoulder,upper,armLayer);part(`forearm_${side}`,elbow,lower,armLayer+.0001);part(`hand_${side}`,wrist,lower,armLayer+.0002);
  }
  const defaults={head:point(0,-d.head*.75),chest:point(0,-d.torso*.55),hand:point(0,0)};
  const parents={head:parts.head,chest:parts.torso,hand:parts.hand_r},slots={};
  for(const name of ['head','chest','hand']){
    const override=rig?.attachment_offsets?.[name],offset=point(finite(override?.x,defaults[name].x),finite(override?.y,defaults[name].y)),parent=parents[name];
    const p=add(parent,rotate(offset,parent.rotation));slots[name]={...p,rotation:parent.rotation,scaleX:1,scaleY:1,layer:parent.layer+.001};
  }
  if(mirror){
    for(const value of [...Object.values(parts),...Object.values(slots)]){value.x=-value.x;value.rotation=-value.rotation;}
    for(const value of [...Object.values(joints),...Object.values(contacts)])value.x=-value.x;
  }
  return {parts,slots,joints,contacts,legSpace,dimensions:d,action:kind,actionPhase:stage,phase:moving?cycle:0,moving,enabled:active,facing:direction,artDirection:mirror?'east':direction,mirror};
}
