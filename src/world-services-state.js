import { presenceState } from './observer-state.js';
import { homeActivity, homeActivityNames, homeLocation } from './home-state.js';
import { fishingState } from './fishing-view-state.js';
import { encounterState } from './journey-state.js';
import { ruinsExecution } from './ruins-state.js';

const actionNames = Object.freeze({ move: '移动', wait: '等待', gather: '采集', trade: '交易', peer_market: '集市操作', farm: '农作', inventory: '物品操作', home: '小屋操作', fish: '垂钓', survival: '生存操作', ruins: '遗迹操作', adventure_plan: '冒险计划', adventure_event: '探索选择', start_activity: '开始活动', finish_activity: '结束活动' });
const errorNames = Object.freeze({ FATIGUE_EXHAUSTED: '体力不足', INSUFFICIENT_ITEMS: '物品不足', INSUFFICIENT_GOLD: '金币不足', NOT_AT_CAMP: '不在服务范围内', NOT_AT_MARKET: '尚未到达集市', MARKET_UNAVAILABLE: '公告已结束或不可用', MARKET_STALE: '公告版本已变化', MARKET_TARGET: '收礼人当前不可用', MARKET_LIMIT: '已达公告数量上限', MARKET_RETURN_PENDING: '尚有物品待领回', MARKET_RETURN: '没有这笔待领物品', MARKET_PAGE: '公告页码不可用', ACTIVITY_BUSY: '活动进行中', GATHER_BUSY: '采集进行中', FISHING_BUSY: '垂钓进行中', HOME_BUSY: '小屋行动进行中', HOME_USE_BUSY: '家具使用进行中', MOVEMENT_BUSY: '移动进行中', GAME_BUSY: '游戏进行中', GATHER_UNAVAILABLE: '资源当前不可用', RESOURCE_BUSY: '资源已被预约', RESOURCE_DEPLETED: '资源未成熟或已耗尽', RESOURCE_PHASE: '不在可采时段', NOT_PLANTABLE: '当前地块不可种植', TRADE_UNAVAILABLE: '物品当前不可交易', TRADE_LIMIT: '达到交易限额', FULL_ENERGY: '体力已满', FULL_HEALTH: '生命已满', INVALID_ACTION: '请求不符合动作规则', RUINS_BUSY: '遗迹行动进行中', RUINS_OCCUPIED: '已有角色正在修桥', RUINS_ALREADY_OPEN: '通路已经打开', RUINS_ALREADY_CLAIMED: '实物已经被取走', SCENE_REQUIRED: '不在所需场景', UNREACHABLE: '道路尚未接通', OUT_OF_RANGE: '尚未到达交互位置', NO_RUINS_JOB: '没有进行中的遗迹行动', INSUFFICIENT_TIME: '剩余活动时间不足' });
const remaining = (end, now) => Number.isFinite(end) ? Math.max(0, Math.ceil((end - now) / 1000)) : null;
const timed = (label, end, now) => remaining(end, now) === 0 ? `${label} · 计时结束，等待服务器确认` : `${label}${remaining(end, now) === null ? '' : ` · ${remaining(end, now)} 秒`}`;
const result = (kind, text) => ({ kind, text });

// Only public server jobs establish execution. A receipt (including a rejected
// request) never creates a current job, and elapsed timers never finish one.
export function observerExecution(world, agent, now) {
  if (!agent) return null;
  if (presenceState(agent) === 'paused') return result('paused', '活动已暂停');
  if (agent.status !== 'active') return result('inactive', '暂无执行中的行动');
  if (agent.home_presence) {
    const use = homeActivity(agent, now);
    if (use) return result('home', use.phase === 'approaching' ? `正在走向家具 · ${homeActivityNames[use.kind]}` : timed(`正在${homeActivityNames[use.kind]}`, use.ends_at, now));
    if (agent.home_presence.movement) return result('home_move', timed('正在屋内移动', agent.home_presence.movement.ends_at, now));
    return result('idle', '暂无执行中的行动');
  }
  if (agent.home_travel) return result('home_travel', timed(homeLocation(agent, world.homes), agent.home_travel.expires_at, now));
  const ruins = ruinsExecution(world, agent, now);
  if (ruins) return ruins;
  const fishing = fishingState(agent, now);
  if (fishing) return result('fish', fishing.working ? timed('正在垂钓', fishing.ends_at, now) : '正在前往垂钓位置');
  const gather = agent.life?.gathering;
  if (gather && gather.scene_id === agent.scene_id && ['approaching', 'working'].includes(gather.phase)) {
    const node = world.resources?.nodes?.find(item => item.id === gather.node_id);
    const item = world.life?.items?.find(item => item.id === (gather.item_id || gather.resource_id));
    const name = node?.name || item?.name || '资源点';
    return result('gather', gather.phase === 'approaching' ? `正在前往${name}` : timed(gather.intent === 'plant' ? '正在种树' : `正在采集 · ${name}`, gather.ends_at, now));
  }
  const site = world.survival?.sites?.find(item => item.id === agent.survival?.travel?.site_id && item.scene_id === agent.scene_id);
  if (site) return result('survival_travel', timed(`正在前往${site.name}`, agent.survival.travel.expires_at, now));
  const discovery = agent.scene_id === 'adventure' ? encounterState(agent, now) : null;
  if (discovery?.pending) return result('encounter', `${discovery.title} · ${discovery.label}`);
  const plan = agent.adventure?.plan;
  if (plan && (agent.scene_id === 'adventure' || plan.destination_scene_id === agent.scene_id || plan.phase === 'to_portal')) {
    const label = plan.phase === 'to_portal' ? '正在前往场景入口' : ({ explore: '正在探索', hunt: '正在讨伐', rest: plan.phase === 'resting' ? '正在营地休息' : '正在前往营地休息', retreat: '正在返回营地' })[plan.intent];
    if (label) return result('adventure', timed(label, plan.expires_at, now));
  }
  const game = world.game;
  if (agent.scene_id === 'plaza' && ['recruiting', 'active'].includes(game?.status) && game.participants?.includes(agent.agent_id)) {
    const name = world.games?.find(item => item.id === game.game_type)?.name || ({ word_chain: '词语接龙', rock_paper_scissors: '石头剪刀布', story_chain: '故事接力' })[game.game_type] || '多人游戏';
    if (game.status === 'recruiting') return result('game', `已报名${name} · 等待开始`);
    const turn = game.game_type === 'rock_paper_scissors' ? game.submitted_agent_ids?.includes(agent.agent_id) ? '本轮已提交，等待揭晓' : '本轮尚未提交' : game.current_agent_id === agent.agent_id ? '当前为该角色的回合' : game.current_agent_id ? '等待其他参与者的回合' : '进行中';
    return result('game', `正在参加${name} · ${turn}`);
  }
  const movement = agent.movement;
  if (movement?.scene_id === agent.scene_id) return result('move', timed(movement.mode === 'run' ? '正在奔跑' : '正在行走', movement.ends_at, now));
  if (agent.scene_id === 'plaza' && agent.activity?.name) return result('activity', timed(`正在参加${agent.activity.name}`, agent.activity.ends_at, now));
  return result('idle', '暂无执行中的行动');
}

export function observerActionResult(agent) {
  const receipt = agent?.action_status;
  if (!receipt || !['applied', 'rejected'].includes(receipt.status) || !Number.isFinite(receipt.at)) return null;
  const name = Object.hasOwn(actionNames, receipt.type) ? actionNames[receipt.type] : '操作';
  const reason = receipt.status === 'rejected' && Object.hasOwn(errorNames, receipt.error_code) ? errorNames[receipt.error_code] : null;
  return { at: receipt.at, status: receipt.status, text: `${name}${receipt.status === 'applied' ? '已受理' : '未执行'}${reason ? ` · ${reason}` : ''}` };
}

export function observerConditions(world, agent) {
  const facts = [];
  if (agent?.fatigue?.energy === 0) facts.push('体力为 0');
  if (agent?.survival?.satiety === 0) facts.push('饱食度为 0');
  if (world.day_cycle?.phase === 'night' && agent?.survival?.light?.lit === false) facts.push('夜间当前位置无光源');
  return facts;
}

// The public catalog declares offers and shared resources. It is deliberately
// independent of the selected resident's private inventory or trading balance.
export function worldFoodServices(world) {
  const items = world.life?.items || [], market = world.life?.market;
  const food = id => items.find(item => item.id === id && item.kind === 'food');
  const offers = (market?.items || []).flatMap(entry => {
    const item = food(entry.item_id);
    return item && Number.isFinite(entry.buy_price) && entry.buy_price >= 0 ? [{ item, price: entry.buy_price }] : [];
  });
  const forage = (world.resources?.nodes || []).filter(node => node.energy_cost === 0 && !!food(node.item_id)).map(node => ({ node, item: food(node.item_id) }));
  return { market, offers, forage };
}

export function foodEffects(item) {
  return [['satiety_restore', '饱食'], ['energy_restore', '体力'], ['heal', '生命']].filter(([key]) => Number.isFinite(item?.[key]) && item[key] > 0).map(([key, label]) => `${label} +${item[key]}`).join(' · ');
}
