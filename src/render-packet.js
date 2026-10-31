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
  return !!a&&!!b&&a.definition===b.definition&&['x','y','depth','scale','alpha','flip','action','rotation'].every(key=>a[key]===b[key])&&a.anchor[0]===b.anchor[0]&&a.anchor[1]===b.anchor[1]&&['x','y','w','h','image'].every(key=>a.frame[key]===b.frame[key]);
}

const point = value => value && Number.isFinite(value.x) && Number.isFinite(value.y);
/** High-resolution art keeps its measured source-frame foot, not its padding. */
export function spriteNativeScale(definition,frame){
  const scale=frame?.native_scale??definition?.native_scale;
  return Number.isFinite(scale)&&scale>0?scale:1;
}
export function spriteGeometry(definition,frame,spaceAnchor=[24,43],facing='south',attachment) {
  const unit=spriteNativeScale(definition,frame);
  const authored=point(frame?.anchor)?frame.anchor:definition?.anchor_mode==='source'&&point(definition.anchor)?definition.anchor:null;
  const sourceAnchor=authored?[authored.x,authored.y]:spaceAnchor.map(n=>n/unit);
  const anchor=[facing==='west'?frame.w-sourceAnchor[0]:sourceAnchor[0],sourceAnchor[1]];
  const target=point(attachment)?[attachment.x,attachment.y]:spaceAnchor;
  return {unit,anchor,domAnchor:sourceAnchor,offset:{x:target[0]-sourceAnchor[0]*unit,y:target[1]-sourceAnchor[1]*unit},rotation:attachment?.rotation||0};
}

export function spriteAttachment(definition,frame,slot,facing='south',spaceAnchor=[24,43]){
  const target=frame?.attachments?.[slot];if(!point(target))return null;
  const unit=spriteNativeScale(definition,frame),anchor=frame.anchor||definition.anchor;
  if(!point(anchor))return null;
  const direction=facing==='west'?-1:1;
  return {x:spaceAnchor[0]+(target.x-anchor.x)*unit*direction,y:spaceAnchor[1]+(target.y-anchor.y)*unit,rotation:(target.rotation||0)*direction};
}

export function spriteRenderPacket(definition,frame,space,{facing='south',action='idle',layer=0,ground=false,attachment}={}) {
  if(!definition||!frame||(!ground&&!space))return null;
  const geometry=spriteGeometry(definition,frame,space?.anchor,facing,attachment);
  return {definition,frame,x:ground?0:space.x+(attachment?attachment.x-space.anchor[0]:0)*space.scale,y:ground?0:space.y+(attachment?attachment.y-space.anchor[1]:0)*space.scale,depth:ground?-100:space.depth+layer,
    anchor:ground?[0,0]:geometry.anchor,scale:ground?geometry.unit:space.scale*geometry.unit,
    alpha:ground?1:space.alpha,flip:facing==='west',action,rotation:geometry.rotation};
}

export function rendererSampling(assets){
  const smooth=assets?.render_style==='ink';
  return {pixelArt:!smooth,antialias:smooth,roundPixels:false};
}

// Ink contours need a denser drawing buffer when the desktop camera zooms in.
// Keep phones at one native world buffer to limit GPU memory and fill rate.
export function rendererResolution(assets,viewportWidth=1536){
  return assets?.render_style==='ink'&&viewportWidth>=900?2:1;
}

export function requiredSpriteImages(assets,sceneId,packets){
  return [...new Set([assets.scenes?.[sceneId]?.image,...Array.from(packets,packet=>packet.frame.image||packet.definition.image)].filter(Boolean))];
}
