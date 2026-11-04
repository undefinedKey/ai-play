import { qServiceArtwork } from './q-service-art.js';
// Presentation consumes only public ruin state. A clock never unlocks a door,
// repairs a bridge, takes a relic, or supplies a puzzle choice.
const symbolNames = Object.freeze({ leaf: '树叶', sun: '太阳', moon: '月亮' });
export function ruinsObjectState(ruins, object, now) {
  const id = object?.id;
  if (!ruins || !id) return { key: 'unknown', label: '状态未收到' };
  if (id === 'main_gate') return { key: ruins.gate?.open ? 'open' : 'closed', label: ruins.gate?.open ? '正门已打开' : '正门上锁' };
  if (id === 'archive_gate') return { key: ruins.runes?.solved ? 'open' : 'closed', label: ruins.runes?.solved ? '内室已打开' : '内室封闭' };
  if (id === 'broken_bridge') {
    if (ruins.bridge?.repaired) return { key: 'repaired', label: '木桥已修复' };
    const job = ruins.bridge?.job;
    if (job) {
      const elapsed = Number.isFinite(job.started_at) && Number.isFinite(job.ends_at) && job.ends_at > job.started_at ? (now - job.started_at) / (job.ends_at - job.started_at) : Number(job.progress) || 0;
      return { key: 'repairing', label: now >= job.ends_at ? '修桥计时结束，等待确认' : '木桥修复中', progress: Math.max(0, Math.min(.99, elapsed)), claimant: job.agent_id };
    }
    return { key: 'broken', label: '木桥断裂' };
  }
  if (object.kind === 'dial') {
    const symbol = ruins.runes?.orientations?.[object.dial_index];
    return { key: symbolNames[symbol] ? symbol : 'unknown', symbol, label: `当前符号：${symbolNames[symbol] || '未收到'}` };
  }
  if (object.kind === 'runes') return { key: ruins.runes?.solved ? 'solved' : 'waiting', label: ruins.runes?.solved ? '机关已解开' : '等待符文检验' };
  if (object.kind === 'key' || object.kind === 'relic') {
    const entry = object.kind === 'key' ? ruins.key : ruins.relics?.find(item => item.id === id);
    if (!entry) return { key: 'unknown', label: '状态未收到' };
    return { key: entry.claimed_by ? 'taken' : 'available', label: entry.claimed_by ? '已取走 · 空展台' : object.kind === 'key' ? '旧钥匙仍在这里' : '遗物仍在展台', claimant: entry.claimed_by, at: entry.claimed_at };
  }
  return { key: 'available', label: object.kind === 'mural' ? '刻着旧文字的壁画' : '公开场景设施' };
}

export function ruinsExecution(world, agent, now) {
  const job = agent?.ruins_job;
  if (!job || job.scene_id !== agent.scene_id || !['approaching', 'repairing'].includes(job.phase)) return null;
  const object = world.ruins?.objects?.find(item => item.id === job.object_id);
  if (job.phase === 'repairing') return { kind: 'ruins', text: Number.isFinite(job.ends_at) && now >= job.ends_at ? '正在修复木桥 · 计时结束，等待服务器确认' : `正在修复木桥${Number.isFinite(job.ends_at) ? ` · ${Math.max(0, Math.ceil((job.ends_at - now) / 1000))} 秒` : ''}` };
  return { kind: 'ruins', text: job.intent === 'enter' ? '正在前往遗迹入口' : job.intent === 'leave' ? '正在前往遗迹出口' : `正在走向${object?.name || '遗迹设施'}` };
}

const art = new Map();
function sprite(kind,state) {
  const key=`${kind}:${state}`;
  if (!art.has(key)){const source=qServiceArtwork[`ruins_${kind}`]||qServiceArtwork.ruins_mural;art.set(key,Object.freeze({...source,animations:{idle:source.animations[state]||source.animations.idle}}));}
  return art.get(key);
}
export function ruinsArtwork(object, state) {
  if(object.id==='main_gate')return sprite('gate',state.key==='open'?'open':'closed');
  if(object.id==='archive_gate')return sprite('archive_gate',state.key==='open'?'open':'closed');
  if(object.kind==='bridge')return sprite('bridge',state.key==='repaired'?'repaired':'broken');
  if(object.kind==='dial')return sprite('dial',state.symbol||'unknown');
  if(object.kind==='runes')return sprite('runes',state.key==='solved'?'solved':'waiting');
  if(object.kind==='key')return sprite('key',state.key==='taken'?'taken':'available');
  if(object.kind==='relic')return sprite(['relic_leaf','relic_bird','relic_lens'].includes(object.id)?object.id:'relic_leaf',state.key==='taken'?'taken':'available');
  return sprite('mural','idle');
}
