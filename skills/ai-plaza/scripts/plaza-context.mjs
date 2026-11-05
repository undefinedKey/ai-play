// Read-only wayfinding facts. The bridge never chooses a destination or turns
// a location into a route, service request, personal goal or automatic task.
import { PLAZA_LAYOUT_VERSION } from './plaza-layout.mjs';
import { movementContext } from './movement.mjs';

export const supportsPlazaLayout = rules => rules?.plaza_layout?.version === PLAZA_LAYOUT_VERSION && Array.isArray(rules.plaza_layout.facilities);
export const PLAZA_GUIDANCE = 'rules.plaza_layout是当前广场真实设施/站位，不沿用旧营地坐标。实体position与可走interaction_position不同；places关联阅读/游戏地点。life.camp_place供休息和个人准备，crafting_place/tool_place供普通制作维修升级，farm_place供本人农作，cooking_place供厨房配方，market.place供补给购销；各按自己的service_center/radius，不能用一个点冒充全部服务。portable/lit_campfire仍按配方原条件。home入口读homes.entrance，钓点读fishing.spots，交换集市读peer_market，两个远行门读scenes/journey。普通move只走服务返回的本场景合法候选；已有visit/approach/start仍只执行原本那一次明确意图，不新增自动路线或到站后自动操作。农作办理不是新场景入口，装饰没有服务。';
const point = value => value && Number.isSafeInteger(value.x) && Number.isSafeInteger(value.y);
export function plazaServiceLocations(rules = {}) {
  if(!supportsPlazaLayout(rules))return [];
  const layout=rules.plaza_layout, map=layout.map, rows=[],seen=new Set();
  const add=(id,p,radius=0)=>{
    if(typeof id!=='string'||!point(p)||!map||p.x<0||p.y<0||p.x>=map.width||p.y>=map.height||!Number.isFinite(radius)||radius<0||seen.has(id))return;
    seen.add(id);rows.push([id,p.x,p.y,radius]);
  };
  for(const f of layout.facilities.slice(0,24))if(f.scene_id==='plaza'&&f.service)add(f.id,f.interaction_position,f.radius);
  for(const spot of (rules.fishing?.spots||layout.fishing_spots||[]).slice(0,4))if(spot.scene_id==='plaza')add(spot.id||spot.spot_id,spot.interaction_position,0);
  return rows;
}

function currentService(context) {
  const a=context.lastActionFeedback, p=a?.requested||{}, life=context.observation?.life||context.rules?.life;
  if(a?.status!=='rejected')return null;
  if(a.type==='farm')return 'farm';
  if(a.type==='trade')return 'supply';
  if(a.type==='home')return p.intent==='build'?'camp':'home';
  if(a.type==='wardrobe')return 'camp';
  if(a.type==='inventory') {
    if(['repair','upgrade'].includes(p.intent))return 'tools';
    if(['equip','unequip'].includes(p.intent))return 'camp';
    const recipe=life?.recipes?.find(r=>r.item_id===p.item_id);
    if(recipe&&['portable','lit_campfire'].includes(recipe.station_id))return null;
    if(p.intent==='craft')return recipe?.kind==='cooking'?'kitchen':'tools';
  }
  return null;
}
export function plazaRejectedService(context = {}) {
  if(context.observation?.self?.scene_id!=='plaza'||!['NOT_AT_CAMP','NOT_AT_SERVICE'].includes(context.lastActionFeedback?.code))return undefined;
  const id=currentService(context);
  return plazaServiceLocations(context.rules).find(row=>row[0]===id);
}
export function plazaPromptNotice(context = {}, compact = false) {
  const o=context.observation||{},s=o.self||{},rules=context.rules||{};
  if(!supportsPlazaLayout(rules)||s.scene_id!=='plaza'||s.home_presence||s.home_travel||s.activity||s.movement||s.life?.gathering||s.fishing||s.survival?.travel||s.adventure?.in_field||s.adventure?.plan||s.adventure?.encounter?.status==='pending'||s.community_job||s.journey_job||s.ruins_job||
    o.cooperation&&!['completed','ended'].includes(o.cooperation.status)||o.cooperation_invitations?.length||o.invitations?.length||
    o.game&&!['finished','ended'].includes(o.game.status)&&o.game.participants?.includes(s.agent_id)||
    ['community','peer_market','wardrobe','aquarium','journey','ruins'].includes(context.lastActionFeedback?.type))return '';
  let locations=plazaServiceLocations(rules);if(!locations.length)return '';
  const relevant=currentService(context);
  if(compact) {
    if(!relevant)return '';
    locations=locations.filter(row=>row[0]===relevant);if(!locations.length)return '';
  }
  const movement=movementContext(o,rules), candidates=movement?.candidates.map(p=>[p.x,p.y]);
  return '广场站位[id,x,y,服务半径]='+JSON.stringify(locations)+'；'+
    (!compact?'camp会客/个人准备，tools制作维修，farm农作，kitchen料理，supply补给，peer_market交换，home小家；reading阅读/play独玩。':'')+
    (candidates?.length?'本次合法move落点='+JSON.stringify(candidates)+'；':'')+
    '站位不是瞬移落点；自选move一步或原有有限意图，抵达后仍自己决定，不自动补给/开工。\n';
}

// A map is optional reading. Never pay for it by dropping an already exposed
// food effect, complete action, goal, game reply, invitation or social message.
export function preservesPlazaContext(before, after, expand) {
  const read=value=>{const parts=value.text.split('公开数据：');if(parts.length!==2)return null;try{return JSON.parse(parts[1]);}catch{return null;}};
  const a=read(before),b=read(after);if(!a||!b)return false;
  const encoded=(value,prompt)=>expand(JSON.stringify(value),prompt.references||{});
  const arrayKept=key=>(a[key]||[]).every(row=>(b[key]||[]).some(next=>encoded(next,after)===encoded(row,before)));
  for(const key of ['food','events','invitations'])if(!arrayKept(key))return false;
  for(const key of ['personal_goal','game','group','life','supply','gear','goals','combat','energy','movement','gathering','task','activities','places','games','leisure'])if(a[key]&&encoded(a[key],before)!==encoded(b[key],after))return false;
  // Some optional catalogs are expressed in prose rather than in JSON. A map
  // cannot silently remove an existing goal, social or game action grammar.
  const grammars=prompt=>prompt.text.slice(0,prompt.text.indexOf('公开数据：')).match(/[a-z_]+\{[^{}\n]*\}/g)||[];
  const available=grammars(after);if(grammars(before).some(grammar=>!available.includes(grammar)))return false;
  const actions=value=>(value.opportunities||value.options||[]).map(row=>row.action||row);
  const offered=actions(b).map(row=>encoded(row,after));
  return actions(a).every(row=>offered.includes(encoded(row,before)));
}
