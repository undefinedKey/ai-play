export const phaseNames={day:'白昼',dusk:'黄昏',night:'夜晚',dawn:'黎明'};
export function resourceState(node,agents=[],now=0){
  if(node.stock<=0)return {key:'depleted',label:'等待恢复',seconds:node.regrow_at?Math.max(0,Math.ceil((node.regrow_at-now)/1000)):null};
  const worker=node.reservation&&agents.find(a=>a.agent_id===node.reservation.agent_id);
  if(node.reservation)return {key:worker?.life?.gathering?.phase==='working'?'working':'reserved',label:worker?.life?.gathering?.phase==='working'?'正在采集':'已预约 · 正在前往',worker};
  if(node.available===false)return {key:'dormant',label:'当前时段不可采'};
  return {key:'available',label:'可以采集'};
}
export function cycleState(cycle,now){
  if(!cycle||!phaseNames[cycle.phase])return null;
  return {phase:cycle.phase,label:phaseNames[cycle.phase],day:cycle.day_index,seconds:Math.max(0,Math.ceil((cycle.next_at-now)/1000))};
}
