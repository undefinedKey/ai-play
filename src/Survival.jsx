import React,{useContext,useEffect,useMemo,useRef,useId} from 'react';
import {Flame,Sun,Utensils,X,ShieldAlert} from 'lucide-react';
import {PixelSprite,usePixelManifest} from './PixelWorld.jsx';
import {RenderSpace} from './world-render-context.jsx';
import {projectMapPoint} from './map-projection.js';
import {ResourceSelection} from './Wilderness.jsx';
import {sceneFireLights,survivalStatus} from './survival-state.js';
import {WORLD_MAP} from '../shared/world-layout.js';
import {SURVIVAL_RULES} from '../shared/survival-rules.js';
import {fireArtwork,artworkAnchor} from './scene-art.js';

const fireNames={campfire:'篝火',firepit:'石围火塘'};
export function FireLayer({world,sceneId,map,live}){
 const assets=usePixelManifest(),selection=useContext(ResourceSelection);
 const logs=useMemo(()=>fireArtwork(assets,false),[assets]);
 return <div className="fire-sites" aria-label="真实宿营地">{(world.survival?.sites||[]).filter(s=>s.scene_id===sceneId).map(site=>{
  const fire=world.survival.fires.find(f=>f.site_id===site.id),lit=fire?.lit&&fire.fuel_seconds>0,id=`fire:${site.id}`,definition=lit?assets?.effects?.campfire:logs,anchor=artworkAnchor(definition,lit?[16,43]:[16,5]);
  return <button key={site.id} className={`fire-site ${lit?'lit':fire?'unlit':'vacant'} ${selection.selected===id?'selected':''}`} data-testid={`fire-site-${site.id}`} data-lit={!!lit} data-fuel={fire?.fuel_seconds??0} data-fire-id={fire?.fire_id} style={{...projectMapPoint(site.position,map),zIndex:100+site.position.y*10}} aria-label={`查看${site.name}，${lit?`${fireNames[fire.kind]}燃烧中` :fire?'火已熄灭':'尚未建造'}，只读`} aria-pressed={selection.selected===id} onClick={()=>selection.select(id)}>
   {fire&&<RenderSpace position={site.position} depth={100+site.position.y*10} anchor={anchor}><span className={`fire-art ${lit?'flaming':'ashes'}`} style={{'--fire-anchor-x':`${anchor[0]}px`,'--fire-anchor-y':`${anchor[1]}px`}}><PixelSprite definition={definition} animate={live&&!!lit}/></span></RenderSpace>}
   <span className={`fire-bed ${fire?.kind==='firepit'?'stone-ring':''}`} aria-hidden="true"/>
   <span className="fire-site-mark" aria-hidden="true">{lit?'♨':fire?'◌':'⌑'}</span><span className="fire-label">{site.name}<small>{lit?`${Math.ceil(fire.fuel_seconds)}秒燃料` :fire?'已熄灭':'宿营空地'}</small></span>
  </button>;
 })}</div>;
}
export function FireInspector({world,selected,onClose,live}){
 const title=useRef(null),id=selected?.startsWith('fire:')?selected.slice(5):null,site=world.survival?.sites?.find(s=>s.id===id),fire=world.survival?.fires?.find(f=>f.site_id===id);
 useEffect(()=>{if(site)title.current?.focus();},[id]);if(!site)return null;
 return <section className="resource-inspector fire-inspector" data-testid="fire-inspector" aria-labelledby="fire-heading" onKeyDown={e=>{if(e.key==='Escape'){onClose();document.querySelector(`[data-testid="fire-site-${id}"]`)?.focus();}}}>
  <div className="resource-inspector-title"><Flame size={22}/><div><h3 id="fire-heading" ref={title} tabIndex={-1}>{site.name}</h3><span>{site.scene_id==='plaza'?'生活广场':'林地冒险'} · ({site.position.x}, {site.position.y})</span></div><button aria-label="关闭宿营地详情" onClick={onClose}><X size={18}/></button></div>
  {!live&&<p>最近记录 · 连接恢复后更新燃料与光照</p>}
  {fire?<><div className="resource-facts"><strong>{fireNames[fire.kind]} · {fire.lit?'燃烧中':'已熄灭'}</strong><span>燃料 {Math.ceil(fire.fuel_seconds)} / {fire.max_fuel_seconds} 秒</span><span>照明半径 {fire.light_radius} 格</span></div><progress aria-label="篝火剩余燃料" value={fire.fuel_seconds} max={fire.max_fuel_seconds}/><p>{fire.lit?'同场景圆形范围内共享火光，怪物仍可能靠近。':'当前不提供照明，是否添柴由 AI 决定。'}</p></>:<p>这里是可建造的宿营空地，目前没有火，也不提供免费照明。</p>}
  <details><summary>建造与添柴目录</summary>{SURVIVAL_RULES.structures.map(s=><p key={s.id}>{s.name}：{Object.entries(s.ingredients).map(([id,n])=>`${({wood:'木材',grass:'草',ore:'矿石'})[id]||id} ×${n}`).join('、')}。</p>)}<p>{Object.entries(SURVIVAL_RULES.fuels).map(([id,n])=>`${({wood:'木材',grass:'草',pine_cone:'松果'})[id]||id}每份增加${n}秒`).join('、')}；须由AI本人抵达后执行。</p></details><small>旁观只读 · 不代替 AI 建造、添柴或选择路线。</small>
 </section>;
}
export function SurvivalStatus({agent,world,live}){
 const state=survivalStatus(agent,world.day_cycle?.phase),s=agent?.survival;
 if(!agent)return null;if(!state)return <p className="survival-unavailable">生存状态暂不可用</p>;
 return <section className={`survival-status ${state.danger?'dark-risk':''} ${s.satiety_state}`} data-testid="survival-status" aria-label="角色生存状态">
  <div><Utensils size={16}/><strong>{!live?'最近记录 · ':''}{state.satietyLabel}</strong><span>{state.satiety} / {s.max_satiety||100}</span><progress aria-label="饱食度" value={s.satiety} max={s.max_satiety||100}/></div>
  <div><Sun size={16}/><strong>{state.light}</strong>{state.danger&&<span>暗处已累计 {Math.floor(s.darkness_seconds)} 秒</span>}{s.torch&&<span>个人火把{ s.torch.lit?'燃烧中':'已熄灭'} · {Math.ceil(s.torch.fuel_seconds)} 秒</span>}</div>
  {state.warning&&<p role="status"><ShieldAlert size={16}/>{state.warning}</p>}{s.travel&&<p>正在前往{world.survival?.sites?.find(site=>site.id===s.travel.site_id)?.name||'宿营地'}，到达后仍由 AI 决定是否建火。</p>}
  {(state.danger||s.satiety_state==='starving')&&<small>休息恢复需要光源和食物补给；不会自动替 AI 行动。</small>}
 </section>;
}

export function NightLighting({phase,survival,sceneId}){
 const key=useId().replace(/:/g,''),lights=sceneFireLights(survival,sceneId),night=phase==='night',tone={day:'transparent',dusk:'rgba(135,92,64,.16)',night:'rgba(18,31,47,.48)',dawn:'rgba(173,157,139,.1)'}[phase]||'transparent';
 return <svg className="night-lighting" viewBox={`0 0 ${WORLD_MAP.width*32} ${WORLD_MAP.height*32}`} aria-hidden="true"><defs><radialGradient id={`light-${key}`}><stop offset="0" stopColor="black"/><stop offset=".7" stopColor="#333"/><stop offset="1" stopColor="white"/></radialGradient><mask id={`night-${key}`}><rect width="100%" height="100%" fill="white"/>{night&&lights.map(l=><circle key={l.id} cx={l.x} cy={l.y} r={l.radius} fill={`url(#light-${key})`}/>)}</mask></defs><rect width="100%" height="100%" fill={tone} mask={`url(#night-${key})`}/>{night&&lights.map(l=><circle key={l.id} cx={l.x} cy={l.y} r={l.radius} fill="none" stroke="#e9c47e" strokeWidth="1.5" strokeOpacity=".55"/>)}</svg>;
}
