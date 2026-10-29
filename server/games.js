export const GAMES = [
  { id: 'word_chain', name: '词语接龙', description: '按固定词库轮流接词，完成 10 次有效接词。', min_players: 2, max_players: 5 },
  { id: 'rock_paper_scissors', name: '石头剪刀布', description: '共 3 轮同时暗选；每轮与其他参与者逐一比较，每赢一位得 1 分。全部提交后一起揭晓；超时结束本局。', min_players: 2, max_players: 5 },
  { id: 'story_chain', name: '故事接力', description: '轮流写 1–200 字，接住前一位的故事；完成 6 段后保存本局故事。内容由参与者自己创作。', min_players: 2, max_players: 5 },
];

export const GAME_END_REASONS = new Set(['服务重启，活动已中断', '房间暂停', '完成 10 次有效接词', '词库没有未使用的后继词', '报名人数不足 2 人', '剩余参与者不足 2 人', '一整轮参与者均超时', '完成 3 轮石头剪刀布', '完成 6 段故事', '出拳超时，本局结束', '参与者离场，本局结束']);
export const gameName = type => GAMES.find(game => game.id === type)?.name || '词语接龙';
const string = value => typeof value === 'string' ? value : null;
const number = value => Number.isFinite(value) ? value : null;
const ids = value => Array.isArray(value) ? value.filter(id => typeof id === 'string') : [];
const scores = (value, agentIds) => Object.fromEntries(Object.entries(value || {}).filter(([id, score]) => (!agentIds || agentIds.has(id)) && Number.isFinite(score)));
export const publicChoices = (choices, agentIds) => Array.isArray(choices) ? choices.filter(item => item && typeof item.agent_id === 'string' && (!agentIds || agentIds.has(item.agent_id)) && ['rock', 'paper', 'scissors'].includes(item.choice)).map(item => ({ agent_id: item.agent_id, choice: item.choice })) : [];

/** A single whitelist for every game read path. Pending RPS choices never leave state. */
export function publicGame(game, { spectator = false, agentIds } = {}) {
  if (!game) return null;
  const type = GAMES.some(item => item.id === game.game_type) ? game.game_type : 'word_chain';
  const result = { game_id: string(game.game_id), group_id: string(game.group_id), game_type: type, status: string(game.status), participants: ids(game.participants),
    current_agent_id: string(game.current_agent_id), deadline: number(game.deadline), scores: scores(game.scores, agentIds), end_reason: GAME_END_REASONS.has(game.end_reason) ? game.end_reason : null };
  if (!spectator) {
    result.turn_id = string(game.turn_id);
    result.responses = Object.fromEntries(Object.entries(game.responses || {}).filter(([id, accepted]) => (!agentIds || agentIds.has(id)) && typeof accepted === 'boolean'));
  }
  if (type === 'word_chain') Object.assign(result, { last_word: string(game.last_word), words: ids(game.words), valid_count: number(game.valid_count), word_version: string(game.word_version) });
  if (type === 'rock_paper_scissors') Object.assign(result, { round: number(game.round), max_rounds: 3, submitted_agent_ids: ids(game.submitted_agent_ids),
    rounds: (game.rounds || []).map(round => ({ round: number(round.round), choices: publicChoices(round.choices, agentIds), scores: scores(round.scores, agentIds) })) });
  if (type === 'story_chain') Object.assign(result, { max_segments: 6, segments: (game.segments || []).filter(segment => segment && typeof segment.agent_id === 'string' && typeof segment.text === 'string').map(segment => ({ agent_id: segment.agent_id, text: segment.text })) });
  return result;
}

export const RIDDLES = [
  { prompt: '谜面：千条线，万条线，落到水里看不见。（打一种天气现象）', answers: ['雨', '下雨', '雨水'] },
  { prompt: '谜面：有面没有口，有脚没有手，虽有四只脚，自己不会走。（打一件家具）', answers: ['桌子', '桌', '书桌', '餐桌'] },
  { prompt: '谜面：小小一座房，有门没有窗，能装瓜果菜，通电保新鲜。（打一种家电）', answers: ['冰箱', '电冰箱'] },
  { prompt: '谜面：一个圆球挂天边，晚上出现白天藏，有时圆来有时弯。（打一天体）', answers: ['月亮', '月球', '月'] },
  { prompt: '谜面：身穿绿衣裳，肚里水汪汪，生的子儿多，个个黑脸膛。（打一种水果）', answers: ['西瓜'] },
];
