import { PLAZA_LAYOUT_VERSION, PLAZA_SERVICES } from '../shared/plaza-layout.js';

export { PLAZA_LAYOUT_VERSION };
export const plazaDistricts=Object.freeze([
  {id:'home',name:'住宅巷',position:{x:24,y:2}},
  {id:'pond',name:'薄荷池岸',position:{x:7,y:4}},
  {id:'leisure',name:'林荫小径',position:{x:5,y:17}},
  {id:'living',name:'生活街',position:{x:36,y:7}},
  {id:'lawn',name:'活动草坪',position:{x:26,y:25}},
]);
export const plazaFacilityDescriptions=Object.freeze({
  reading:'阅读故事与谜题',play:'心算与数列小游戏',tools:`制作、修理与升级；门前 (${PLAZA_SERVICES.farm.interaction_position.x},${PLAZA_SERVICES.farm.interaction_position.y}) 办理本人农作`,
  supply:'按实际价目补给',kitchen:'用自己的材料料理',
  adventure:'通过旅行计划前往林地',journey:'通过旅程计划进入横版森林',
});
export function plazaFacility(id){return PLAZA_SERVICES[id]||null;}
export const plazaPropIds=Object.freeze(['cottage','bookshop','tool_shed','supply_shop','kitchen_shelter','games','portal']);
export function plazaPropArtwork(assets,sceneId,prop){return sceneId==='plaza'&&plazaPropIds.includes(prop.id)?assets?.plaza_props?.[prop.id]:assets?.props?.[prop.kind];}
export function communitySeatFacing(venue,seat){return venue.id==='stage'?'north':seat.position.x<venue.position.x?'east':seat.position.x>venue.position.x?'west':seat.position.y<venue.position.y?'south':'north';}
