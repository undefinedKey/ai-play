export const waitingLabels={idle:'正常等待',plan_running:'正在执行计划',activity_running:'正在参与活动',waiting_event:'等待新事件',reconnecting:'正在重连',host_unavailable:'原宿主不可用',model_unavailable:'模型暂不可用',rules_incompatible:'规则不兼容',local_error:'本地校验失败',budget_exhausted:'预算已耗尽',owner_paused:'主人已暂停',paused:'活动已暂停',grant_expired:'授权已到期',grant_missing:'尚无有效授权',revoked:'授权已撤销',room_paused:'世界已暂停',room_full:'房间已满',controller_busy:'控制端正在占用',processing:'正在处理事件'};
const remedies={reconnecting:'保持桥运行，检查它到世界服务的连接，等待有上限的重试。',host_unavailable:'在原 AI 所在机器启动原宿主，并检查桥能否找到同一只 AI。',model_unavailable:'检查原宿主的模型服务；恢复后由桥重试未完成的决定。',rules_incompatible:'更新完整 Skill，重新启动同一身份的接入桥。',local_error:'查看接入端的具体错误，修复配置或输入后重试。',budget_exhausted:'当前预算已耗尽。主人决定继续时，再调整授权与预算。',owner_paused:'保持暂停；只有主人决定继续时，才使用下方恢复操作。',grant_expired:'授权已到期。需要继续时由主人重新允许。',grant_missing:'确实没有有效授权；准备好后由主人允许开始。',revoked:'授权已撤销，桥不会自行恢复。',room_paused:'等待世界管理员恢复；无需重复注册角色。',room_full:'等待空位后使用同一身份重试。',controller_busy:'检查是否已有另一个桥控制同一角色，避免重复启动。'};
export function runtimeHealth(agent,now=Date.now()){
 const health=agent?.diagnostics?.health;
 const timestamp=Number(health?.received_at);
 const stale=!health||!Number.isFinite(timestamp)||timestamp<=0||now-timestamp>(health.stale_after_ms||30000);
 const paused=agent?.status==='paused'||agent?.run?.status==='paused'||agent?.presence?.state==='paused';
 const serverReason=({'主人暂停':'owner_paused','房间暂停':'room_paused','授权时间已到':'grant_expired'})[agent?.pause_reason];
 const reason=serverReason||(paused?(['budget_exhausted','grant_expired','revoked'].includes(health?.waiting_reason)?health.waiting_reason:'paused'):health?.waiting_reason);
 const label=waitingLabels[reason]||'等待原因尚未核实';
 return {health,stale,reason,label:stale&&health&&reason!=='owner_paused'?`最近上报：${label}`:label,next:stale&&reason!=='owner_paused'?'接入状态尚未核实或已经过时。先检查桥是否仍运行，并让它重新上报；旧记录不能确认当前情况。':remedies[reason]||'当前没有需要主人处理的问题；等待、独处也是有效决定。'};
}
