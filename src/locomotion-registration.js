// Original and supplemental drawings use different supporting soles as their
// source origins. Register their upper body before applying the continuous
// gait pose, rather than animating that accidental source-coordinate error.
// This never changes the actor's world foot, path, facing or collision shape.
export const LOCOMOTION_REGISTRATION_LIMITS=Object.freeze({translation:6.5,rotation:.075,scale:.06});
const cache=new WeakMap();
const clamp=(value,lo,hi)=>Math.max(lo,Math.min(hi,value));
const point=value=>value&&Number.isFinite(value.x)&&Number.isFinite(value.y);
function landmarks(definition,frame){
  const scale=frame.native_scale??definition.native_scale,anchor=frame.anchor||definition.anchor;
  if(!(scale>0)||!Number.isFinite(scale)||!point(anchor)||!point(frame.attachments?.head)||!point(frame.attachments?.chest))return null;
  const points=['head','chest'].map(slot=>({x:(frame.attachments[slot].x-anchor.x)*scale,y:(frame.attachments[slot].y-anchor.y)*scale}));
  const vector={x:points[0].x-points[1].x,y:points[0].y-points[1].y},length=Math.hypot(vector.x,vector.y);
  if(length<8||length>48)return null;
  return {center:{x:(points[0].x+points[1].x)/2,y:(points[0].y+points[1].y)/2},vector,length};
}
function registrations(definition,direction){
  let directions=cache.get(definition);if(!directions){directions=new Map();cache.set(definition,directions);}
  if(directions.has(direction))return directions.get(direction);
  const frames=[...new Set(['walk','run'].flatMap(action=>(definition.animations?.[`${action}_${direction}`]||definition.animations?.[action])?.frames||[]))];
  const samples=frames.map(frame=>({frame,landmarks:landmarks(definition,frame)})).filter(sample=>sample.landmarks);
  const result=new WeakMap();directions.set(direction,result);
  // Partial or unregistered art retains its existing behavior, not a guessed pivot.
  if(samples.length!==frames.length||samples.length<4)return result;
  const average=field=>({x:samples.reduce((sum,s)=>sum+s.landmarks[field].x,0)/samples.length,y:samples.reduce((sum,s)=>sum+s.landmarks[field].y,0)/samples.length});
  const center=average('center'),vector=average('vector'),length=Math.hypot(vector.x,vector.y);
  for(const {frame,landmarks:sample} of samples){
    const difference=Math.atan2(vector.y,vector.x)-Math.atan2(sample.vector.y,sample.vector.x);
    const rotation=clamp(Math.atan2(Math.sin(difference),Math.cos(difference)),-LOCOMOTION_REGISTRATION_LIMITS.rotation,LOCOMOTION_REGISTRATION_LIMITS.rotation);
    const scale=clamp(length/sample.length,1-LOCOMOTION_REGISTRATION_LIMITS.scale,1+LOCOMOTION_REGISTRATION_LIMITS.scale),c=Math.cos(rotation),s=Math.sin(rotation);
    let x=center.x-(c*sample.center.x-s*sample.center.y)*scale,y=center.y-(s*sample.center.x+c*sample.center.y)*scale;
    const distance=Math.hypot(x,y),bound=LOCOMOTION_REGISTRATION_LIMITS.translation;
    if(distance>bound){x*=bound/distance;y*=bound/distance;}
    result.set(frame,{x,y,rotation,scale});
  }
  return result;
}

export function registerLocomotionPose(pose,definition,frame,action,facing='south'){
  if(!['walk','run'].includes(action)||definition?.render_style!=='ink'||!definition.motion_images?.length||!frame||pose.scaleX!==pose.scaleY)return pose;
  const correction=registrations(definition,facing==='west'?'east':facing).get(frame);
  if(!correction)return pose;
  const mirror=facing==='west'?-1:1,x=correction.x*mirror,y=correction.y,c=Math.cos(pose.rotation),s=Math.sin(pose.rotation);
  // Shared source registration first, then the continuously sampled body pose.
  // The same result is passed to body, armor, hair accessory and held items.
  return {x:pose.x+(c*x-s*y)*pose.scaleX,y:pose.y+(s*x+c*y)*pose.scaleY,
    rotation:pose.rotation+correction.rotation*mirror,scaleX:pose.scaleX*correction.scale,scaleY:pose.scaleY*correction.scale};
}
