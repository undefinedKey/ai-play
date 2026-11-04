import {sampleMotion, MOTION_RULES} from '../shared/motion.js';
import {gatheringWorkingAt} from './pixel-state.js';
import {registerLocomotionPose} from './locomotion-registration.js';

export const STILL_POSE = Object.freeze({x:0,y:0,rotation:0,scaleX:1,scaleY:1});
const clamp = (n, lo=0, hi=1) => Math.max(lo,Math.min(hi,Number.isFinite(n)?n:lo));
const smooth = n => { const t=clamp(n);return t*t*(3-2*t); };
const mix = (a,b,t) => a+(b-a)*t;
const distance = (a,b) => Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
const elapsed = (now,start) => Math.max(0,now-start);
const stride = action => action==='run'?1.5:1.25;
function distanceAtPoint(path,point){
  let walked=0;
  for(let i=1;i<(path?.length||0);i++){
    const a=path[i-1],b=path[i],length=distance(a,b);
    const onSegment=a.x===b.x?Math.abs(point.x-a.x)<1e-7&&point.y>=Math.min(a.y,b.y)-1e-7&&point.y<=Math.max(a.y,b.y)+1e-7:a.y===b.y&&Math.abs(point.y-a.y)<1e-7&&point.x>=Math.min(a.x,b.x)-1e-7&&point.x<=Math.max(a.x,b.x)+1e-7;
    if(onSegment)return walked+distance(a,point);
    walked+=length;
  }
  return null;
}

/** Presentation-only odometer. New snapshots/short path segments do not restart
 * the feet. A scene change, teleport or stale movement does not accrue steps.
 * Its distance never changes the server's position, speed, path or arrival. */
export function sampleGait(actor,now,previous=null){
  const movement=actor?.movement,sampled=sampleMotion(actor,now);
  if(!sampled.moving||!['active','alive'].includes(actor?.status))return {state:previous,phase:0,moving:false};
  const time=Math.min(now,(actor.position_at??movement.started_at)+MOTION_RULES.max_prediction_ms,movement.ends_at);
  const travelled=Math.max(0,time-movement.started_at)*movement.speed/1000;
  const stepLength=stride(sampled.mode);
  let base=0;
  if(previous?.scene===actor.scene_id){
    if(previous.movementId===movement.movement_id)base=previous.base;
    else if(time>=previous.time&&time-previous.time<=500&&distance(previous.position,movement.path[0])<=1){
      // A new plan may cancel at a point behind our bounded prediction. Count
      // the old path only up to that real origin; reconciliation is not a step.
      const progress=distanceAtPoint(previous.path,movement.path[0]);
      if(progress!==null)base=(previous.base+progress)*stepLength/(previous.stride||stepLength);
    }
  }
  const total=base+travelled;
  return {state:{scene:actor.scene_id,movementId:movement.movement_id,path:movement.path,base,distance:total,stride:stepLength,time,position:sampled.position},phase:(total/stepLength)%1,moving:true};
}

export function animationDuration(definition,action,facing='south'){
  const direction=facing==='west'?'east':facing;
  const animation=definition?.animations?.[`${action}_${direction}`]||definition?.animations?.[action];
  return animation?.frames?.reduce((sum,frame)=>sum+(frame.duration||240),0)||600;
}

export function gatheringCycle(actor){
  const tool=actor.life?.gathering?.tool_id;
  return tool==='pickaxe'?1220:tool==='axe'?1100:900;
}

export function actorAnimationAction(actor,action){
  // Bare hands pick close to the ground; an equipped axe/pickaxe uses standing
  // swings. This changes atlas selection only: public action remains gathering.
  return action==='gather'&&!['axe','pickaxe'].includes(actor.life?.gathering?.tool_id)?'plant':action;
}

export function gatheringFrameTime(actor,workElapsed,definition,animationAction,facing='south'){
  const cycle=gatheringCycle(actor);
  // The picking source is also used by one-shot planting. Wrap work explicitly
  // so a second picking cycle does not clamp to that source's final idle frame.
  return (Math.max(0,workElapsed)%cycle)/cycle*animationDuration(definition,animationAction,facing);
}

/** Local displacement is measured in world pixels around the measured source
 * foot. It is deliberately small: no new movement, impact or work result. */
export function actorVisualPose(actor,action,now,{facing='south',gaitPhase=0,enabled=true,definition,frame}={}){
  if(!enabled||!['active','alive'].includes(actor?.status))return STILL_POSE;
  const dx=facing==='east'?1:facing==='west'?-1:0,dy=facing==='south'?1:facing==='north'?-1:0;
  // Q art has actual limb/bob frames. Integer local battle offsets keep its
  // authored pixels crisp; they never advance the authoritative world foot.
  if(definition?.render_style==='q-pixel'){
    if(action==='attack'&&actor.action){
      const a=actor.action;if(now<a.started_at||now>=a.ends_at||a.outcome==='cancelled')return STILL_POSE;
      const resolved=a.resolved_at??a.impact_at,t=now-resolved;
      const amount=a.outcome==='hit'&&t>=0?(t<80?3:t<160?2:t<240?1:0):-1;
      return {...STILL_POSE,x:dx*amount,y:dy*amount};
    }
    if(action==='hurt'&&actor.hurt?.damage>0){
      const h=actor.hurt;if(now<h.started_at||now>=h.ends_at)return STILL_POSE;
      const amount=Math.ceil(3*(1-(now-h.started_at)/Math.max(1,h.ends_at-h.started_at)));
      return {...STILL_POSE,x:-dx*amount,y:-dy*amount};
    }
    return STILL_POSE;
  }
  const monster=actor.monster_id,slime=monster==='forest_slime',heavy=monster==='ruins_guardian';
  if(action==='walk'||action==='run'){
    if(!sampleMotion(actor,now).moving)return STILL_POSE;
    const wave=Math.sin(gaitPhase*Math.PI*2),lift=Math.sin(gaitPhase*Math.PI*2)**2,run=action==='run';
    const amplitude=heavy?.45:slime?(run?2.4:1.8):(run?1.4:.65);
    const lean=dx*(run?.035:.012),roll=wave*(heavy?.012:slime?.012:run?.022:.012);
    const pose={x:0,y:-lift*amplitude,rotation:lean+roll,scaleX:slime?1+.035*(1-lift):1,scaleY:slime?1-.035*(1-lift):1};
    return registerLocomotionPose(pose,definition,frame,action,facing);
  }
  if(action==='attack'&&actor.action){
    const a=actor.action;if(now<a.started_at||now>=a.ends_at||a.outcome==='cancelled')return STILL_POSE;
    const prep=smooth((now-a.started_at)/Math.max(1,a.impact_at-a.started_at));
    let weight=-prep*.7,turn=-prep*.045,compression=1-prep*.012;
    if(a.outcome&&now>=(a.resolved_at??a.impact_at)){
      const start=a.resolved_at??a.impact_at,t=elapsed(now,start),duration=Math.max(1,a.ends_at-start);
      if(a.outcome==='hit'){
        // A thrust is possible only after a real hit receipt. Unsettled impact
        // deadlines merely hold anticipation, however late the packet arrives.
        const peak=heavy?2.1:slime?2.5:1.65;
        if(t<55){const p=smooth(t/55);weight=mix(-.7,peak,p);turn=mix(-.045,.06,p);compression=mix(.988,1.012,p);}
        else{const p=smooth((t-55)/Math.max(1,duration-55));weight=mix(peak,0,p);turn=mix(.06,0,p);compression=mix(1.012,1,p);}
      }else{const p=smooth(t/duration);weight=-.7*(1-p);turn=-.045*(1-p);compression=mix(.988,1,p);}
    }
    return {x:dx*weight,y:dy*weight*.45,rotation:turn*(dx||1),scaleX:compression,scaleY:compression};
  }
  if(action==='hurt'&&actor.hurt){
    const h=actor.hurt;if(now<h.started_at||now>=h.ends_at)return STILL_POSE;
    const t=elapsed(now,h.started_at),duration=Math.max(1,h.ends_at-h.started_at),rise=Math.min(65,duration*.25);
    const recoil=t<rise?smooth(t/rise):1-smooth((t-rise)/Math.max(1,duration-rise));
    return {x:-dx*recoil*.9,y:-Math.abs(dy)*recoil*.35,rotation:-(dx||1)*recoil*.045,scaleX:1-recoil*.015,scaleY:1-recoil*.015};
  }
  const job=actor.life?.gathering;
  if((action==='gather'||action==='plant'&&job?.intent==='plant')&&gatheringWorkingAt(job,now)){
    const t=elapsed(now,job.work_started_at??job.started_at),phase=(t%gatheringCycle(actor))/gatheringCycle(actor);
    if(!['axe','pickaxe'].includes(job.tool_id)){
      const bend=Math.sin(phase*Math.PI)**2;
      return {x:0,y:bend*.3,rotation:(dx||1)*bend*.012,scaleX:1,scaleY:1};
    }
    // Slow preparation, brisk downward work, then a longer recovery. These
    // repeated motions show work in progress; they never award resources.
    const work=phase<.42?-smooth(phase/.42):phase<.58?mix(-1,1,smooth((phase-.42)/.16)):1-smooth((phase-.58)/.42);
    return {x:dx*work*.45,y:Math.max(0,work)*.35,rotation:work*.035*(dx||1),scaleX:1,scaleY:1};
  }
  return STILL_POSE;
}

/** End a pose without snapping the torso. Disconnection/hidden/reduced motion
 * bypasses this function in the caller and freezes immediately. */
export function settlePose(previous,action,target,now){
  if(!previous||now<previous.time)return {state:{action,pose:target,time:now,from:null,started:now},pose:target};
  const changed=previous.action!==action;
  const from=changed?previous.pose:previous.from,started=changed?now:previous.started;
  const blend=from?smooth((now-started)/110):1;
  const pose=blend>=1?target:Object.fromEntries(Object.keys(STILL_POSE).map(key=>[key,mix(from[key],target[key],blend)]));
  return {state:{action,pose,time:now,from:blend<1?from:null,started},pose};
}
