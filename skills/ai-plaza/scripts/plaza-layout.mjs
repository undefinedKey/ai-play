// Single portable authority for the v036 town. Services retain their existing
// actions and costs; reading a location never authorizes movement or work.
export const PLAZA_LAYOUT_VERSION = 'plaza-036-v1';
export const PLAZA_MAP = Object.freeze({ width: 48, height: 32 });
const p = (x,y) => ({x,y});
const rect = (x,y,width,height) => Array.from({length:width*height},(_,i)=>p(x+i%width,y+Math.floor(i/width)));
const facility = (id,name,x,y,ix,iy,radius,service) => ({id,name,scene_id:'plaza',position:p(x,y),interaction_position:p(ix,iy),radius,service});
export const PLAZA_SERVICES = Object.freeze({
  camp: facility('camp','中央会客地',24,16,24,16,2,'rest_and_personal_preparation'),
  home: facility('home','住宅巷入口',24,5,24,6,0,'home_visit'),
  reading: facility('reading','林荫阅读亭',9,13,9,14,2,'read_and_riddle'),
  play: facility('play','林荫游戏桌',9,19,9,20,2,'solo_game_and_sequence'),
  tools: facility('tools','工具工坊',10,26,10,27,1,'craft_repair_upgrade'),
  farm: facility('farm','农作办理处',10,26,10,28,1,'personal_farm'),
  supply: facility('supply','生活补给柜',36,11,36,12,1,'trade'),
  kitchen: facility('kitchen','公共料理棚',36,17,36,18,1,'kitchen_recipes'),
  market: {...facility('peer_market','交换集市',36,23,36,24,1,'peer_market'),footprint:rect(34,22,5,2)},
  pond: facility('pond','薄荷池岸',7,7,7,8,3,'watch_pond'),
  adventure: {...facility('adventure','林地入口',46,13,46,13,0,'adventure_portal'),footprint:[p(45,12),p(47,12)]},
  journey: {...facility('journey','横版森林入口',46,20,46,20,0,'journey_enter'),footprint:[p(45,19),p(47,19)]},
});
export const PLAZA_PLACES = Object.freeze([
  ['pond','pond'], ['garden','camp'], ['reading','reading'], ['play','play'],
].map(([id,service])=>{const f=PLAZA_SERVICES[service];return {id,scene_id:'plaza',name:f.name,...f.interaction_position,radius:f.radius};}));
export const PLAZA_ROADS = Object.freeze([
  {id:'main_ring',width:3,points:[p(16,10),p(31,10),p(31,23),p(16,23),p(16,10)]},
  {id:'central_cross',width:3,points:[p(16,16),p(31,16)]},
  {id:'central_axis',width:3,points:[p(24,10),p(24,30)]},
  {id:'home_lane',width:2,points:[p(24,6),p(24,10)]},
  {id:'pond_south',width:2,points:[p(7,8),p(7,10),p(16,10)]},
  {id:'pond_east',width:2,points:[p(11,5),p(13,5),p(13,10)]},
  {id:'reading_lane',width:2,points:[p(9,14),p(16,14)]},
  {id:'game_lane',width:2,points:[p(9,20),p(16,20)]},
  {id:'workshop_lane',width:2,points:[p(10,28),p(16,28),p(16,23)]},
  {id:'supply_lane',width:2,points:[p(31,12),p(36,12)]},
  {id:'kitchen_lane',width:2,points:[p(31,18),p(36,18)]},
  {id:'market_lane',width:2,points:[p(31,24),p(36,24)]},
  {id:'forest_lane',width:2,points:[p(31,13),p(46,13)]},
  {id:'journey_lane',width:2,points:[p(31,20),p(46,20)]},
  {id:'lawn_rear',width:2,points:[p(16,30),p(33,30),p(33,24)]},
]);
export const PLAZA_PAVING = Object.freeze([{id:'central_meeting',x:18,y:12,width:12,height:9}]);
const seat=(id,x,y,activities)=>({id,position:p(x,y),activities});
export const PLAZA_COMMUNITY_VENUES = Object.freeze([
  {id:'picnic',name:'草坪野餐地',scene_id:'plaza',position:p(19,26),interaction_position:p(19,27),footprint:[],seats:[seat('picnic_west',18,26,['sit','eat']),seat('picnic_east',20,26,['sit','eat']),seat('picnic_north',19,25,['sit','eat']),seat('picnic_south',19,27,['sit','eat'])]},
  {id:'table',name:'草坪餐桌',scene_id:'plaza',position:p(18,20),interaction_position:p(18,21),footprint:[p(18,20)],seats:[seat('table_west',17,20,['sit','eat']),seat('table_east',19,20,['sit','eat']),seat('table_north',18,19,['sit','eat']),seat('table_south',18,21,['sit','eat'])]},
  {id:'stage',name:'草坪小舞台',scene_id:'plaza',position:p(29,27),interaction_position:p(29,28),footprint:[],seats:[seat('stage_speaker',29,27,['perform']),seat('stage_left',28,29,['sit','listen']),seat('stage_center',29,29,['sit','listen']),seat('stage_right',30,29,['sit','listen'])]},
  {id:'board',name:'活动公告板',scene_id:'plaza',position:p(28,8),interaction_position:p(28,9),footprint:[p(28,8)],seats:[]},
]);
export const PLAZA_FISHING_SPOTS = Object.freeze([
  {id:'plaza_pond_south',spot_id:'plaza_pond_south',name:'薄荷池南岸',scene_id:'plaza',position:p(7,7),interaction_position:p(7,8),duration_seconds:30},
  {id:'plaza_pond_east',spot_id:'plaza_pond_east',name:'薄荷池东岸',scene_id:'plaza',position:p(10,5),interaction_position:p(11,5),duration_seconds:30},
]);
export const PLAZA_RESOURCE_POSITIONS = Object.freeze(Object.fromEntries([
  ['camp_branches',13,26,14,26],['camp_stones',13,29,14,29],['camp_fallen_berries',19,16,20,16],
  ['orchard_berries',40,7,39,7],['east_pine',43,4,42,4],['south_pine',39,28,38,28],
  ['meadow_grass',4,22,5,22],['planting_plaza',4,26,5,26],
  ['village_tree_0',2,17,3,17],['village_tree_1',5,29,6,29],['village_tree_2',3,10,4,10],['village_tree_3',5,20,4,20],
  ['village_tree_6',30,3,29,3],['village_tree_8',42,16,41,16],['village_tree_9',40,25,39,25],['village_tree_11',44,28,43,28],
].map(([id,x,y,ix,iy])=>[id,{position:p(x,y),interaction_position:p(ix,iy)}])));
export const PLAZA_CAMP_SITES = Object.freeze([
  {id:'plaza_hearth',name:'会客地火塘',scene_id:'plaza',position:p(28,18),interaction_position:p(27,18),biome:'meadow',radius:1},
  {id:'orchard_hearth',name:'草坪边火塘',scene_id:'plaza',position:p(21,28),interaction_position:p(20,28),biome:'woodland',radius:1},
]);
const prop=(id,kind,x,y,footprint,service_id=null)=>({id,kind,position:p(x,y),footprint,interactive:!!service_id,...(service_id?{service_id,interaction_position:PLAZA_SERVICES[service_id].interaction_position}:{})});
export const PLAZA_PROPS = Object.freeze([
  prop('pond','pond',7,7,rect(4,3,7,5),'pond'),
  prop('cottage','cottage',24,5,rect(22,3,5,3),'home'),
  prop('bookshop','bookshop',9,13,rect(7,11,5,3),'reading'),
  prop('games','game_table',9,19,rect(8,18,3,2),'play'),
  prop('tool_shed','shed',10,26,rect(8,24,5,3),'tools'),
  prop('supply_shop','cottage',36,11,rect(34,9,5,3),'supply'),
  prop('kitchen_shelter','shed',36,17,rect(34,15,5,3),'kitchen'),
  ...['village_tree_0','village_tree_1','village_tree_2','village_tree_3','village_tree_6','village_tree_8','village_tree_9','village_tree_11','east_pine','south_pine'].map((id,i)=>{const v=PLAZA_RESOURCE_POSITIONS[id];return {...prop(id,i>=8?'pine':['oak','birch','apple'][i%3],v.position.x,v.position.y,[v.position]),interactive:true,resource_id:id,interaction_position:v.interaction_position};}),
  prop('north_tree_west','birch',19,4,[p(19,4)]),prop('north_tree_east','oak',33,4,[p(33,4)]),
  prop('south_tree','apple',35,29,[p(35,29)]),prop('west_tree','oak',3,15,[p(3,15)]),
  ...[[2,1],[6,1],[13,2],[38,2],[1,11],[1,24],[46,3],[46,28]].map(([x,y],i)=>prop('edge_tree_'+i,i%2?'birch':'oak',x,y,[p(x,y)])),
  prop('portal','portal_plaza',46,13,[],'adventure'),
]);
export const PLAZA_LAYOUT = Object.freeze({version:PLAZA_LAYOUT_VERSION,map:PLAZA_MAP,roads:PLAZA_ROADS,paving:PLAZA_PAVING,
  facilities:Object.values(PLAZA_SERVICES),places:PLAZA_PLACES,props:PLAZA_PROPS,community_venues:PLAZA_COMMUNITY_VENUES,fishing_spots:PLAZA_FISHING_SPOTS,
  resource_positions:PLAZA_RESOURCE_POSITIONS,camp_sites:PLAZA_CAMP_SITES,
  notice:'公共道路连接已有服务，坐标表示真实站点，不替AI选择行动。农作办理仍操作本人私有田地，并非独立旅行场景入口。两个远行入口对应不同场景。装饰不提供操作。'});
export const plazaServicePlace = id => {const f=PLAZA_SERVICES[id];return {id:f.id,name:f.name,scene_id:f.scene_id,...f.position,service_center:{...f.interaction_position},interaction_position:{...f.interaction_position},radius:f.radius};};
