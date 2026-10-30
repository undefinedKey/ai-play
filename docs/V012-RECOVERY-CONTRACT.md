# v0.12 恢复与诊断协议

本协议只恢复仍有效的同一授权，不赋予新权限。暂停、撤销、授权到期、预算耗尽和控制权转交均是权限边界。原 AI 决定行为；重连后刷新规则、观察当前世界，不自动重播已中断的计划。

## 桥与服务

`report_status` 保留原有会话要求，新增可选 `health`。
可选工具 `report_connection({run_id?, runtime_version?, mode?, capabilities?, health})` 不要求活动会话，允许等待宿主或暂停时报告。
服务仍鉴权；有当前 run 时仅该 run 的控制端可报告，传入的 run_id 必须匹配。报告不续租、不入场、不变更授权或预算。旧服务没有该工具时桥仍可安全工作。

health 结构：

```js
{
  world: 'connected' | 'reconnecting' | 'incompatible' | 'unknown',
  host: 'ready' | 'unavailable' | 'discovering' | 'not_applicable' | 'unknown',
  model: 'idle' | 'requesting' | 'ready' | 'unavailable' | 'unknown',
  waiting_reason: 'idle' | 'plan_running' | 'activity_running' | 'waiting_event' |
    'reconnecting' | 'host_unavailable' | 'model_unavailable' | 'rules_incompatible' |
    'local_error' | 'budget_exhausted' | 'owner_paused' | 'grant_expired' |
    'grant_missing' | 'revoked' | 'room_paused' | 'room_full' | 'controller_busy' | 'processing',
  last_model_success_at: null, // 可选；毫秒时间戳或 null，下同
  last_request_at: null,
  last_host_success_at: null,
  last_world_success_at: null,
  error_code: null, // 可选；仅大写 ASCII 下划线错误码，最长 64 字符
  counters: {requests: 0, replies: 0, retries: 0, local_failures: 0}, // 可选
  pending_events: 0, // 可选；本地队列与正在处理批次总数
  dropped_events: 0, // 可选；本地队列超过上限的累计丢弃数，不能伪称消息全保留
  token_usage: null // 可选；只有上游实际报告时为 {input_tokens,output_tokens,source:'provider'}
}
```

服务添加 `received_at`、`stale_after_ms:30000`、`source:'bridge'`。所有 health 都是主人私有诊断；时间表示桥报告的证据，不能当成直接观测到的 systemd 或模型健康。超过 30 秒未收到报告标为过时。一般至多每 15 秒报告，重要状态变更可立即报告。

`calls_used` 继续是请求前持久化的保守预算累计。实际 `requests` 在 onRequest 钩子触发时计数；本地 prompt 校验失败单独统计，不等于真实请求。网络结果不明的请求仍占预算，不自动退还。费用无可靠价格和 usage 时未知。

从旧版升级会保留原 calls_used，但新细分计数只包含升级后可验证的记录；不能从旧预算反推历史请求成功率或 token 用量。

## 公共在场信息

`agent.presence = {state,has_joined,first_joined_at,last_seen_at,last_departed_at}`。
state 是 active/paused/offline/never_joined/unknown；has_joined 是布尔值或 null；时间是毫秒或 null。新角色明确 never_joined；旧存档只有证据时判定曾入场，否则 unknown，不能把缺字段解释为从未入场，不能把最早保留事件伪称第一次入场。重启不清除历史事实，暂停授权仍映射 paused。公开投影不包含详细 health、预算、目标或凭据。

## 决策、消息和动作

待处理事件先持久化为批次，模型失败保留；合法 wait 或动作回执确定后 ACK。动作结果未知时查询旧 action_id；只有确认未执行且会话有效才重试原请求，不生成新 ID 重放。跨 run/暂停的迟到结果失效。规则更新重握手和刷新能力；宿主重发现仍校验同一个 pet。

可靠批次保护已经下载的待处理消息，并不等于无限离线收件箱。现有队列最多 100 条，溢出会计数；服务事件最多保留 3000 条，补取窗口 10 分钟。超出保留窗口只能恢复当前快照，不能重建已经被清除的旧消息。主人应结合待处理数、溢出数及连接时间判断是否缺少历史。

## 验证层级

分别记录可控模型规则测试、真实 HTTP/持久桥恢复、原宿主连通、授权内真实模型决定。进程 active 不是端到端成功。负载使用隔离数据与可控模型时必须说明，不能混入生产角色。
