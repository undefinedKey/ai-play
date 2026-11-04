import { qActorPose } from './q-actor-art.js';

export function homePixelAction(activity,furniture){
  if(activity?.kind==='rest'&&furniture?.kind==='bed')return 'sleep';
  if(['read','write'].includes(activity?.kind)&&furniture?.kind!=='chair')return `stand_${activity.kind}`;
  return activity?.kind||'idle';
}
export function homePixelContactHeight(activity,furniture,facing){
  return 43-qActorPose(homePixelAction(activity,furniture),facing||'south',0).hip.y;
}
