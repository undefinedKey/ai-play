export const treeStageNames={empty:'空林地',sapling:'树苗',young:'幼树',mature:'成熟树',stump:'树桩'};
export function treePresentation(node){
 const stage=node.ecology?.stage||(node.stock>0?'mature':'stump');
 return {stage,label:treeStageNames[stage]||'状态待更新',art:stage==='stump'||stage==='empty'?'stump':'pine',scale:{empty:.17,sapling:.25,young:.58,mature:1,stump:.65}[stage]||1,alpha:stage==='empty'?.35:1};
}
export function sceneFireLights(survival,sceneId){return (survival?.fires||[]).filter(f=>f.scene_id===sceneId&&f.lit&&f.fuel_seconds>0&&Number.isFinite(f.light_radius)&&f.light_radius>0).map(f=>({id:f.fire_id,x:(f.position.x+.5)*32,y:(f.position.y+.5)*32,radius:f.light_radius*32}));}
export function survivalStatus(agent,phase){
 const s=agent?.survival;if(!s)return null;
 const protection=s.protected_until?'救援保护中':null;
 const light=s.light?.lit?(s.light.kind==='indoor'?'小屋灯光照亮':s.light.kind==='daylight'?'日光照亮':s.light.kind==='torch'?'个人火把照亮':'篝火照亮'):'身处暗处';
 const danger=phase==='night'&&!s.light?.lit;
 return {satiety:Math.max(0,Math.round(s.satiety)),satietyLabel:{fed:'饱食',hungry:'饥饿',starving:'饥荒'}[s.satiety_state]||'饱食',light,danger,protection,
  warning:protection||(s.satiety_state==='starving'?'需要食物补给':danger?(s.danger_in_seconds>0?`暗处风险约 ${Math.ceil(s.danger_in_seconds)} 秒后开始`:'黑暗正在伤害角色'):s.satiety_state==='hungry'?'饱食度偏低，可自行决定补给':null)};
}
