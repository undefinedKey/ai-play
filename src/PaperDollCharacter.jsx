import React, {useEffect,useState} from 'react';
import {samplePaperDollPose} from './paper-doll-rig.js';
import {paperDollImages,paperDollLayers} from './paper-doll-render.js';

/** Keep the complete legacy character visible until every rig texture is
 * available. A failed/partial prototype never turns the original AI invisible. */
export function usePaperDollReady(selection){
  const rig=selection?.rig;
  const [loaded,setLoaded]=useState(null);
  useEffect(()=>{
    if(!rig)return;
    let cancelled=false,remaining=paperDollImages(rig).length,failed=false;
    const images=[];
    const settle=ok=>{
      if(cancelled)return;
      if(!ok)failed=true;
      if(--remaining===0)setLoaded({rig,ready:!failed});
    };
    for(const url of paperDollImages(rig)){
      const image=new Image();images.push(image);
      image.onload=()=>settle(true);image.onerror=()=>settle(false);image.src=url;
    }
    return ()=>{cancelled=true;for(const image of images){image.onload=null;image.onerror=null;}};
  },[rig]);
  return !!rig&&loaded?.rig===rig&&loaded.ready;
}

export function PaperDollCharacter({selection,agent,assets,action,now,facing,timeline,tool,toolLevel,handsBusy,portrait=false,Sprite}){
  const sample=samplePaperDollPose(agent,action,now,{phase:timeline.gaitPhase||0,enabled:timeline.playing,facing,elapsed:timeline.actionElapsed,rig:selection.rig});
  const layers=paperDollLayers(selection.rig,sample,assets,agent,{facing,tool,toolLevel,handsBusy,portrait});
  return <span className="paper-doll-rig" data-rig-id={selection.id} data-facing={facing} data-action={action} data-playing={timeline.playing?'true':'false'} style={{display:'contents'}}>
    {layers.map(layer=><Sprite key={layer.key} definition={layer.definition} sourceFrame={layer.frame} visualPose={layer.pose} sourceRotation={layer.sourceRotation} layer={layer.layer} rigPart={layer.part} attachmentSlot={layer.slot} textureDependency={layer.textureDependency} className={layer.className} itemId={layer.itemId} toolLevel={layer.toolLevel} action={action} facing={facing}/>) }
  </span>;
}
