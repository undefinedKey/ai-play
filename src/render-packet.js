// Screen-sized crowded-character offsets are converted once into the native
// world plane. The CSS camera transform then moves both canvas and controls.
export function renderSpace(position,{depth=0,anchor=[24,43],offset={x:0,y:0},alpha=1,screenSize,viewportScale=1}={}) {
  const scale=Number.isFinite(viewportScale)&&viewportScale>0?viewportScale:1;
  const x=(position.x+.5)*32,y=(position.y+.5)*32;
  const dx=Math.max(12-x*scale,Math.min(offset.x||0,768*scale-12-x*scale))/scale;
  return{x:x+dx,y:y+(offset.y||0)/scale,depth,anchor,alpha,scale:screenSize?screenSize/scale:1};
}
export function sameRenderPacket(a,b) {
  return !!a&&!!b&&a.definition===b.definition&&['x','y','depth','scale','alpha','flip','action'].every(key=>a[key]===b[key])&&a.anchor[0]===b.anchor[0]&&a.anchor[1]===b.anchor[1]&&['x','y','w','h'].every(key=>a.frame[key]===b.frame[key]);
}
