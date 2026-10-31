// Diagnostic only: draws the shipped cutouts with the same source-foot and
// attachment transforms as PixelSprite, including supplemental source sheets.
export async function drawInkContactSheet({monsters=false,id='ink-contact-sheet'}={}){
 const manifest=await(await fetch('/pixel-world/manifest.json')).json(),cache=new Map();
 async function imageFor(def,frame){const path=frame.image||def.image;if(!cache.has(path)){const img=new Image();img.src=path;await img.decode();cache.set(path,img);}return cache.get(path);}
 const actors=Object.entries(monsters?manifest.monsters:manifest.characters),rows=monsters?[['idle','south',0],['idle','north',0],['walk','east',0],['run','east',0],['attack','east',0],['attack','east',2],['hurt','east',0]]:[['idle','south',0],['idle','north',0],['idle','east',0],['idle','west',0],['walk','south',0],['run','east',0],['attack','east',0],['attack','east',2],['gather','east',1],['water','south',2],['rest','south',0],['tired','south',0]];
 const step=monsters?250:145,rowHeight=monsters?145:116,canvas=document.createElement('canvas');canvas.id=id;canvas.width=160+step*actors.length;canvas.height=65+rowHeight*rows.length;canvas.style=`position:fixed;inset:0;z-index:99999;width:${canvas.width}px;height:${canvas.height}px`;document.body.append(canvas);
 const ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=true;ctx.fillStyle='#b9ad8a';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.font='13px sans-serif';ctx.fillStyle='#272a22';ctx.fillText('v0.22 · original ink source sprites · measured feet / held-item contact',12,20);
 const getFrame=(def,action,direction,index)=>(def.animations[`${action}_${direction==='west'?'east':direction}`]||def.animations[action]||def.animations.idle).frames[index];
 async function draw(def,frame,body,bodyFrame,direction,x,y,slot){
  const img=await imageFor(def,frame),unit=frame.native_scale||def.native_scale||1,anchor=frame.anchor||def.anchor,sign=direction==='west'?-1:1;
  let rotation=0;
  if(slot){const point=bodyFrame.attachments?.[def.attachment_slot||slot],foot=bodyFrame.anchor||body.anchor,bodyUnit=bodyFrame.native_scale||body.native_scale||1;if(point){x+=(point.x-foot.x)*bodyUnit*2*sign;y+=(point.y-foot.y)*bodyUnit*2;rotation=(point.rotation||0)*sign;}}
  ctx.save();ctx.translate(x,y);ctx.rotate(rotation);ctx.scale(unit*2*sign,unit*2);ctx.drawImage(img,frame.x,frame.y,frame.w,frame.h,-anchor.x,-anchor.y,frame.w,frame.h);ctx.restore();
 }
 for(let col=0;col<actors.length;col++){
  const[name,body]=actors[col],x=120+col*step+step/2;ctx.fillStyle='#272a22';ctx.fillText(name,x-45,43);
  for(let row=0;row<rows.length;row++){
   const[action,direction,index]=rows[row],y=65+row*rowHeight+rowHeight-12,frame=getFrame(body,action,direction,index);
   if(col===0){ctx.fillStyle='#272a22';ctx.fillText(action,8,y-35);ctx.fillText(`${direction} · ${index}`,8,y-17);}
   const held=action==='gather'?manifest.tools.axe_2:action==='water'?manifest.tools.watering_can_2:manifest.equipment.iron_sword;
   if(!monsters&&direction==='north')await draw(held,getFrame(held,action,direction,index),body,frame,direction,x,y,'hand');
   await draw(body,frame,body,frame,direction,x,y);
   if(!monsters){const armor=manifest.equipment.iron_armor,accessory=manifest.accessories.leaf;await draw(armor,getFrame(armor,action,direction,index),body,frame,direction,x,y,'chest');await draw(accessory,getFrame(accessory,action,direction,index),body,frame,direction,x,y,'head');if(direction!=='north')await draw(held,getFrame(held,action,direction,index),body,frame,direction,x,y,'hand');}
   ctx.strokeStyle='#ebe3cc';ctx.beginPath();ctx.moveTo(x-4,y);ctx.lineTo(x+4,y);ctx.moveTo(x,y-3);ctx.lineTo(x,y+3);ctx.stroke();
  }
 }
 return {id,width:canvas.width,height:canvas.height,actorCount:actors.length,rows:rows.length};
}
