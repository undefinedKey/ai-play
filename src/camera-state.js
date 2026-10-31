export const MIN_ZOOM=1, MAX_ZOOM=4;
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
export function cameraView(center={x:.5,y:.5},zoom=1){
  zoom=clamp(Number.isFinite(zoom)?zoom:1,MIN_ZOOM,MAX_ZOOM);
  const edge=.5/zoom;
  return {zoom,center:{x:clamp(center.x,edge,1-edge),y:clamp(center.y,edge,1-edge)}};
}
export function zoomCamera(view,zoom,anchor={x:.5,y:.5}){
  const next=clamp(zoom,MIN_ZOOM,MAX_ZOOM);
  return cameraView({x:view.center.x+(anchor.x-.5)*(1/view.zoom-1/next),y:view.center.y+(anchor.y-.5)*(1/view.zoom-1/next)},next);
}
export function panCamera(view,dx,dy){return cameraView({x:view.center.x-dx/view.zoom,y:view.center.y-dy/view.zoom},view.zoom);}
export function cameraTransform(view){return `translate(${(0.5-view.center.x*view.zoom)*100}%, ${(0.5-view.center.y*view.zoom)*100}%) scale(${view.zoom})`;}
