import {WORLD_MAP} from '../shared/world-layout.js';
// Screen-sized crowded-character offsets are converted once into the native
// world plane. The CSS camera transform then moves both canvas and controls.
export function renderSpace(position,{depth=0,anchor=[24,43],offset={x:0,y:0},alpha=1,screenSize,viewportScale=1}={}) {
  const scale=Number.isFinite(viewportScale)&&viewportScale>0?viewportScale:1;
  const x=(position.x+.5)*32,y=(position.y+.5)*32;
  const dx=Math.max(12-x*scale,Math.min(offset.x||0,WORLD_MAP.width*32*scale-12-x*scale))/scale;
  return{x:x+dx,y:y+(offset.y||0)/scale,depth,anchor,alpha,scale:screenSize?screenSize/scale:1};
}
export function sameRenderPacket(a,b) {
  return !!a&&!!b&&a.definition===b.definition&&['x','y','originX','originY','depth','scale','alpha','flip','action','rotation','poseRotation','poseScaleX','poseScaleY','attachmentImage'].every(key=>a[key]===b[key])&&a.anchor[0]===b.anchor[0]&&a.anchor[1]===b.anchor[1]&&['x','y','w','h','image'].every(key=>a.frame[key]===b.frame[key]);
}

const point = value => value && Number.isFinite(value.x) && Number.isFinite(value.y);
const finite=(value,fallback)=>Number.isFinite(value)?value:fallback;
/** Visual poses never mutate the authoritative foot/space supplied by the world. */
export function spriteVisualPose(pose){
  return {x:finite(pose?.x,0),y:finite(pose?.y,0),rotation:finite(pose?.rotation,0),scaleX:Number.isFinite(pose?.scaleX)&&pose.scaleX>0?pose.scaleX:1,scaleY:Number.isFinite(pose?.scaleY)&&pose.scaleY>0?pose.scaleY:1};
}
/** High-resolution art keeps its measured source-frame foot, not its padding. */
export function spriteNativeScale(definition,frame){
  const scale=frame?.native_scale??definition?.native_scale;
  return Number.isFinite(scale)&&scale>0?scale:1;
}
export function spriteGeometry(definition,frame,spaceAnchor=[24,43],facing='south',attachment,visualPose) {
  const unit=spriteNativeScale(definition,frame);
  const authored=point(frame?.anchor)?frame.anchor:definition?.anchor_mode==='source'&&point(definition.anchor)?definition.anchor:null;
  const sourceAnchor=authored?[authored.x,authored.y]:spaceAnchor.map(n=>n/unit);
  const anchor=[facing==='west'?frame.w-sourceAnchor[0]:sourceAnchor[0],sourceAnchor[1]];
  const pose=spriteVisualPose(visualPose),localRotation=finite(attachment?.rotation,0);
  const local=point(attachment)?[attachment.x-spaceAnchor[0],attachment.y-spaceAnchor[1]]:[0,0];
  const cos=Math.cos(pose.rotation),sin=Math.sin(pose.rotation);
  const target=[spaceAnchor[0]+pose.x+cos*pose.scaleX*local[0]-sin*pose.scaleY*local[1],spaceAnchor[1]+pose.y+sin*pose.scaleX*local[0]+cos*pose.scaleY*local[1]];
  // Parent body pose then local held-item rotation then authored facing. This
  // exact matrix also handles nonuniform recoil without detaching the grip.
  const c=Math.cos(localRotation),s=Math.sin(localRotation),flip=facing==='west'?-1:1;
  const matrix=[(cos*pose.scaleX*c-sin*pose.scaleY*s)*flip,(sin*pose.scaleX*c+cos*pose.scaleY*s)*flip,-cos*pose.scaleX*s-sin*pose.scaleY*c,-sin*pose.scaleX*s+cos*pose.scaleY*c];
  return {unit,anchor,domAnchor:sourceAnchor,offset:{x:target[0]-sourceAnchor[0]*unit,y:target[1]-sourceAnchor[1]*unit},target,rotation:pose.rotation+localRotation,localRotation,scaleX:pose.scaleX,scaleY:pose.scaleY,matrix,pose};
}

export function spriteAttachment(definition,frame,slot,facing='south',spaceAnchor=[24,43]){
  const target=frame?.attachments?.[slot];if(!point(target))return null;
  const unit=spriteNativeScale(definition,frame),anchor=frame.anchor||definition.anchor;
  if(!point(anchor))return null;
  const direction=facing==='west'?-1:1;
  return {x:spaceAnchor[0]+(target.x-anchor.x)*unit*direction,y:spaceAnchor[1]+(target.y-anchor.y)*unit,rotation:(target.rotation||0)*direction,image:frame.image||definition.image};
}

export function spriteRenderPacket(definition,frame,space,{facing='south',action='idle',layer=0,ground=false,attachment,pose}={}) {
  if(!definition||!frame||(!ground&&!space))return null;
  const geometry=spriteGeometry(definition,frame,space?.anchor,facing,attachment,ground?null:pose);
  return {definition,frame,x:ground?0:space.x+(geometry.target[0]-space.anchor[0])*space.scale,y:ground?0:space.y+(geometry.target[1]-space.anchor[1])*space.scale,originX:ground?0:space.x,originY:ground?0:space.y,attachmentImage:attachment?.image,depth:ground?-100:space.depth+layer,
    anchor:ground?[0,0]:geometry.anchor,scale:ground?geometry.unit:space.scale*geometry.unit,
    alpha:ground?1:space.alpha,flip:facing==='west',action,rotation:geometry.localRotation,poseRotation:geometry.pose.rotation,poseScaleX:geometry.pose.scaleX,poseScaleY:geometry.pose.scaleY};
}

export function rendererSampling(assets){
  const smooth=assets?.render_style==='ink';
  return {pixelArt:!smooth,antialias:smooth,roundPixels:false};
}

// Ink contours benefit from a denser buffer on hardware-rendered desktops.
// Phones and explicit software rasterizers use native resolution for fill rate.
export function isSoftwareRenderer(description){
  return typeof description==='string'&&/swiftshader|llvmpipe|softpipe|software\s+rasterizer|microsoft\s+basic\s+render\s+driver/i.test(description);
}
export function rendererResolution(assets,viewportWidth=1536,software=false){
  return assets?.render_style==='ink'&&viewportWidth>=900&&!software?2:1;
}

export function requiredSpriteImages(assets,sceneId,packets){
  return [...new Set([assets.scenes?.[sceneId]?.image,...Array.from(packets,packet=>[packet.definition.image,packet.frame.image,packet.attachmentImage,...(packet.definition.motion_images||[])]).flat()].filter(Boolean))];
}
