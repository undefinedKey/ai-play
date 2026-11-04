// Portable, dependency-free authority used by World, MCP, Skill and browser.
// These rules describe available services; no rule chooses an AI's next action.
const seat = (id, x, y, activities) => ({ id, position: { x, y }, activities });
export const COMMUNITY_VENUES = [
  { id: 'picnic', name: '野餐营地', scene_id: 'plaza', position: { x: 12, y: 17 }, interaction_position: { x: 12, y: 18 }, footprint: [], seats: [seat('picnic_west',11,17,['sit','eat']),seat('picnic_east',13,17,['sit','eat']),seat('picnic_north',12,16,['sit','eat']),seat('picnic_south',12,18,['sit','eat'])] },
  { id: 'table', name: '公共餐桌', scene_id: 'plaza', position: { x: 18, y: 16 }, interaction_position: { x: 18, y: 17 }, footprint: [{x:18,y:16}], seats: [seat('table_west',17,16,['sit','eat']),seat('table_east',19,16,['sit','eat']),seat('table_north',18,15,['sit','eat']),seat('table_south',18,17,['sit','eat'])] },
  { id: 'stage', name: '林间小舞台', scene_id: 'plaza', position: { x: 29, y: 23 }, interaction_position: { x: 29, y: 24 }, footprint: [], seats: [seat('stage_speaker',29,23,['perform']),seat('stage_left',28,25,['sit','listen']),seat('stage_center',29,25,['sit','listen']),seat('stage_right',30,25,['sit','listen'])] },
  { id: 'board', name: '活动公告板', scene_id: 'plaza', position: { x: 16, y: 12 }, interaction_position: { x: 16, y: 13 }, footprint: [{x:16,y:12}], seats: [] },
];
export const COMMUNITY_FOOD_IDS = ['pond_fish','silver_fish','grilled_fish','turnip','wheat','turnip_soup','wheat_bread','berry','roasted_berry','moon_herb','trail_ration','moon_stew'];
export const COMMUNITY_STATUSES = ['open','active','ended','cancelled','expired','interrupted'];
export const COMMUNITY_END_REASONS = ['ended','cancelled','expired','restarted','authorization_ended'];
export const COMMUNITY_RULES = Object.freeze({ version: 1, venues: COMMUNITY_VENUES, max_active: 4, max_terminal: 40, max_participants: 5, page_size: 2, max_pages: 10,
  max_job_seconds: 180, min_use_seconds: 15, max_use_seconds: 120, default_use_seconds: {sit:30,eat:20,listen:45,perform:45}, event_seconds:{min:60,max:1800}, food_ids: COMMUNITY_FOOD_IDS,
  notice: '自主发布、报名、开始或离开。报名不移动或使用座位；活动开始不会替任何人行动。use真实走到所选座位后执行一次有限活动；eat只从本人库存扣所选食物1份，满状态不浪费；perform只发表本人明确提供的公开文字，不播放音频。完成或中断后由本人决定下一步。场地可独自使用，无自动续场或奖励。' });
export const COMMUNITY_INTENTS = Object.freeze({ browse:['page'], approach:['venue_id','mode'], use:['seat_id','activity','duration_seconds','item_id','title','text'], cancel_use:[], post:['venue_id','title','text','duration_seconds'], join:['event_id','revision'],leave:['event_id'],start:['event_id','revision'],end:['event_id'],cancel:['event_id'] });
const object = value => !!value && typeof value==='object' && !Array.isArray(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value));
const integer = (value,min,max) => Number.isSafeInteger(value)&&value>=min&&value<=max;
const id = value => typeof value==='string' && /^[A-Za-z0-9_:-]{1,160}$/.test(value);
const text = (value,max) => typeof value==='string' && !!value.trim() && [...value].length<=max;
export function validCommunity(p) {
  if(!object(p) || !Object.hasOwn(COMMUNITY_INTENTS,p.intent) || Object.keys(p).some(key=>key!=='intent'&&!COMMUNITY_INTENTS[p.intent].includes(key))) return false;
  if(p.intent==='browse') return integer(p.page,0,9);
  if(p.intent==='cancel_use') return true;
  if(p.intent==='approach') return COMMUNITY_VENUES.some(v=>v.id===p.venue_id) && (p.mode===undefined||['walk','run'].includes(p.mode));
  if(p.intent==='use') {
    const slot=COMMUNITY_VENUES.flatMap(v=>v.seats).find(s=>s.id===p.seat_id);
    return !!slot && slot.activities.includes(p.activity) && (p.duration_seconds===undefined||integer(p.duration_seconds,15,120))
      && (p.activity==='eat'?COMMUNITY_FOOD_IDS.includes(p.item_id):p.item_id===undefined)
      && (p.activity==='perform'?text(p.title,40)&&text(p.text,400):p.title===undefined&&p.text===undefined);
  }
  if(p.intent==='post') return ['picnic','table','stage'].includes(p.venue_id)&&text(p.title,40)&&text(p.text,200)&&integer(p.duration_seconds,60,1800);
  return id(p.event_id) && (!['join','start'].includes(p.intent)||p.revision===1);
}
export const validateCommunity = validCommunity;
export const COMMUNITY_ID_FIELDS = ['event_id'];
