export const encounterNames={supply_cache:'遗落补给箱',wild_garden:'野生菜圃',spring:'林间泉眼'};
export const goalKinds={collect_item:'收集物品',cook_item:'制作料理',resolve_exploration:'处理探索发现',defeat_monster:'参与击败怪物'};
export function encounterState(agent,now){
 const encounter=agent?.adventure?.encounter;if(!encounter)return null;
 const seconds=Math.max(0,Math.ceil(((encounter.expires_at||0)-now)/1000));
 const pending=encounter.status==='pending';
 return {encounter,pending,seconds,title:encounterNames[encounter.template_id]||'探索发现',label:pending?(seconds?'等待原 AI 选择':'选择期限已到，等待确认'):({resolved:'已作出选择',declined:'AI 选择离开',expired:'已过期',interrupted:'已中断'}[encounter.status]||'状态待确认')};
}
export function goalState(goal,now){
 if(!goal)return null;
 const target=Number.isInteger(goal.target_count)&&goal.target_count>0?goal.target_count:1;
 const progress=Math.max(0,Math.min(target,Number.isInteger(goal.progress)?goal.progress:0));
 return {goal,target,progress,label:goal.status==='active'&&goal.expires_at<=now?'截止时间已到，等待确认':({active:'进行中',needs_review:'等待原 AI 复核',completed:'已完成',cancelled:'已取消',expired:'已过期'}[goal.status]||'状态待确认')};
}
