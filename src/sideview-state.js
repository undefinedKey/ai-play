import { confirmedPosition } from './scene-state.js';

export const JOURNEY_TILE = 64;
export const JOURNEY_LENGTH = 48;
export const JOURNEY_GROUND = 16;
export const journeyPoint = position => ({ x: (Number(position?.x) + .5) * JOURNEY_TILE, lane: (Number(position?.y) - JOURNEY_GROUND) * 28 });

export function journeyActors(world) {
  return (world.agents || []).filter(actor => actor.scene_id === 'journey' && !actor.home_presence && ['active', 'paused'].includes(actor.status));
}

export function journeyCamera({ actor, now, live, width, center = 7, zoom = 1 }) {
  const position = actor && journeyActors({ agents: [actor] }).length ? confirmedPosition(actor, now, live) : null;
  const target = (position?.x ?? center) + .5;
  return Math.max(0, Math.min(JOURNEY_LENGTH * JOURNEY_TILE * zoom - width, target * JOURNEY_TILE * zoom - width * .36));
}

export function journeyExecution(actor, now) {
  const job = actor?.journey_job;
  if (!job || !['plaza', 'journey'].includes(actor.scene_id)) return null;
  const active = now < Math.min(job.ends_at ?? Infinity, job.expires_at ?? Infinity);
  if (!active) return { kind: 'journey', text: '旅途行动等待服务器确认' };
  const title = job.phase === 'fighting' ? '正在交战' : job.phase === 'resting' ? '正在营地休息' : job.intent === 'enter' ? '正在前往森林入口' : job.intent === 'leave' ? '正在返回广场' : job.route === 'bypass' ? '正在沿下方小径绕行' : job.intent === 'hunt' ? '正在接近所选怪物' : '正在沿林间小路行进';
  return { kind: 'journey', text: title };
}

export function journeyMonsterLabel(monster, live) {
  if (!live) return '最近记录';
  if (monster.status !== 'alive') return '已被击败 · 等待重生';
  return monster.behavior === 'attacking' ? '正在交战' : '守在这里';
}
