import Phaser from 'phaser';

// Retained Phaser objects: React sends confirmed geometry/atlas frames. No DOM
// measurements in the render loop and no independent copy of world simulation.
export function createWorldRenderer({parent,assets,registry,sceneId,onReady,onPartial,onError}) {
  let game,disposed=false,scene,dirty=true,ready=false,scheduled;
  const images=new Map(),definitions=new Map();
  function visit(value){if(!value||typeof value!=='object')return;if(value.image)definitions.set(value.image,value);for(const child of Object.values(value))visit(child);}
  visit(assets);
  const key=image=>`world:${image}`;
  const fail=()=>{if(!disposed){onError();destroy();}};
  function draw(){
    if(disposed||!scene||!dirty)return;
    dirty=false;
    for(const[id,sprite]of images)if(!registry.entries.has(id)){sprite.destroy();images.delete(id);}
    for(const[id,packet]of registry.entries){
      const textureKey=key(packet.definition.image);
      if(!scene.textures.exists(textureKey))continue;
      const texture=scene.textures.get(textureKey),frame=packet.frame;
      const frameKey=`${frame.x||0},${frame.y||0},${frame.w},${frame.h}`;
      if(!texture.has(frameKey))texture.add(frameKey,0,frame.x||0,frame.y||0,frame.w,frame.h);
      let sprite=images.get(id);
      if(!sprite){sprite=scene.add.image(0,0,textureKey,frameKey);images.set(id,sprite);}
      sprite.setTexture(textureKey,frameKey).setOrigin(packet.anchor[0]/frame.w,packet.anchor[1]/frame.h).setPosition(packet.x,packet.y).setScale(packet.scale).setDepth(packet.depth).setAlpha(packet.alpha).setFlipX(packet.flip);
      sprite.setData({packet_id:id,action:packet.action,source:packet.definition.image});
    }
    parent.dataset.renderedObjects=String(images.size);
    parent.dataset.registeredObjects=String(registry.entries.size);
    parent.dataset.textureCount=String(scene.textures.getTextureKeys().length);
  }
  function invalidate(){dirty=true;if(disposed||!ready||document.hidden)return;if(!scheduled)scheduled=requestAnimationFrame(()=>{scheduled=null;if(disposed)return;game.loop.wake();});}
  const visibility=()=>{if(document.hidden){game?.loop.sleep();if(scheduled)cancelAnimationFrame(scheduled);scheduled=null;}else invalidate();};
  function destroy(){if(disposed)return;disposed=true;cancelAnimationFrame(scheduled);document.removeEventListener('visibilitychange',visibility);if(game){game.destroy(true,false);if(game.loop.started)game.loop.wake();}images.clear();}
  try {
    game=new Phaser.Game({type:Phaser.AUTO,parent,width:768,height:512,transparent:true,pixelArt:true,antialias:false,roundPixels:false,banner:false,loader:{imageLoadType:'HTMLImageElement'},audio:{noAudio:true},input:{keyboard:false,mouse:false,touch:false,gamepad:false},render:{preserveDrawingBuffer:true},fps:{target:30},scene:{
      preload(){scene=this;this.load.on('loaderror',file=>{if(file.key===key(assets.scenes?.[sceneId]?.image))fail();else onPartial();});for(const image of definitions.keys())this.load.image(key(image),image);},
      create(){if(disposed)return;if(!this.textures.exists(key(assets.scenes?.[sceneId]?.image))){fail();return;}if(this.textures.getTextureKeys().length<definitions.size)onPartial();ready=true;this.game.canvas.setAttribute('data-testid','phaser-canvas');this.game.canvas.setAttribute('aria-hidden','true');this.game.canvas.addEventListener('webglcontextlost',fail);draw();this.game.events.once('postrender',()=>{if(!disposed)onReady();});},
      update(){draw();if(!dirty)this.game.events.once('postrender',()=>{if(!disposed)this.game.loop.sleep();});}
    }});
    document.addEventListener('visibilitychange',visibility);
  }catch{fail();}
  return{invalidate,destroy};
}
