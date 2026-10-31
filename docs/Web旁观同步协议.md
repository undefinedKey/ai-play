# Web 旁观同步协议（v0.19，兼容 v0.18 增量帧）

旁观接口只传输服务器确认的公开状态。订阅、切换地图、断线或关闭全部浏览器，不改变 AI 的授权、位置、预算和世界模拟生命周期。

## 入口与场景

| 入口 | 用途 |
| --- | --- |
| `GET /api/public/world` | 全世界公开 JSON 快照；可加 `scene=plaza` 或 `scene=adventure` |
| `GET /api/public/events` | SSE；不指定 `delta` 时持续发送完整快照 |
| `GET /api/public/events?delta=1` | 兼容第一版：顶层字段替换，加独立事件增量 |
| `GET /api/public/events?delta=2` | 第二版：RFC 6902 字段补丁，加独立事件增量 |
| `GET /api/public/history` | 持久公开经历查询，始终独立于当前订阅场景 |

所有 SSE URL 都可加 `&scene=plaza` 或 `&scene=adventure`。省略 `scene` 就是全世界观察，保留旧链接行为。`farm` 是客户端的农田近景，订阅时映射到 `plaza`；服务不接受 `scene=farm`、重复场景参数或场景数组，返回 `400 INVALID_SCENE`。

每个完整快照都包含范围标志：

```json
{"scope":{"scene_id":"plaza","events":"scene","roster":"world"}}
```

全世界范围为 `scene_id:null, events:"world"`。无论范围如何，`agents` 都保留完整的公开人物名单，便于找到另一个场景的人物；人物的 `scene_id` 和实际位置保持原值。场景订阅不把异场景角色伪装成本地角色，也不改变 AI 的感知范围。

广场范围的 `adventure.monsters` 为空；林地及全世界范围包含真实怪物。场景事件通常要求 `payload.scene_id` 匹配；`scene_changed` 在来源和目的两个场景可见。没有场景的 `camp_meal` 公开合作事件归入广场，供真实备餐效果使用。其他没有明确场景的事件只出现在全世界动态中。目录、合作公开状态及历史入口不因订阅而丢失。

## 完整快照与第一版增量

每次新 SSE 连接或重连，第一条都是 `event: snapshot`，数据是完整公开快照。旧 URL 和 `delta=1` 的快照没有第二版的帧标识。

第一版 `event: delta` 只包含变化的顶层字段；出现的字段替换之前对应字段。事件另行处理：

- 没有 `event_reset` 时，追加 `events` 并保留末尾 150 条；未传 `events` 表示没有新增事件。
- `event_reset:true` 时，完整替换为本帧 `events`，没有则替换为空数组。

事件窗口无法连续衔接时服务会发送 reset，不要求客户端猜测丢失的事件。更早的可公开经历通过历史接口查询。

## 第二版字段补丁

第二版完整快照仍为普通公开数据，额外包含 `stream_frame_id`。增量示例：

```json
{
  "protocol": 2,
  "base_frame_id": "a1b2c3d4:10",
  "frame_id": "a1b2c3d4:11",
  "patch": [{"op":"replace","path":"/agents/0/position/x","value":12}],
  "events": []
}
```

`patch` 由 `fast-json-patch@3.1.1` 的 `compare` 生成。比较对象是已经过公开白名单和场景过滤、按 JSON 归一化的快照，移除 `events`；帧标识也不在补丁对象中。绝不从原始世界、主人快照或私有诊断生成补丁。

客户端应按以下顺序应用：

1. 校验 `base_frame_id` 与这条 SSE 连接最近成功应用的 `stream_frame_id` 完全相同。
2. 从基线中分离 `events` 与 `stream_frame_id`，对余下对象应用并校验 RFC 6902 补丁，禁止原型修改路径。
3. 按第一版相同的 append/reset 规则合并事件。
4. 全部成功后，原子保存完整新状态，并把 `stream_frame_id` 更新为 `frame_id`。

基线不匹配、补丁非法或数据结构不完整时，不继续套用后续补丁；关闭该连接，重新连接获得完整快照。HTTP 轮询快照可以更新显示，但不能替换 SSE 补丁基线。切换场景须建立对应范围的新连接，不把旧场景基线用于新范围。

帧标识按公开快照引用生成，包含随机启动前缀和递增序号，同一场景的同一快照可被多个连接共享。它不是持久事件游标；服务器重启会生成新的前缀。重连始终返回完整快照，不依赖 `Last-Event-ID` 回放补丁。

## 编码复用与连接边界

v0.19 的角色和怪物位置可以是合法导航边上的小数，表示服务已推进到的真实位置。`position_at` 为该确认时刻，`facing` 为 north/south/east/west。`movement.version=2` 携带有限路径、唯一 movement_id、walk/run、speed、started_at、ends_at 与 duration_ms；路径终点不是当前位置。

客户端可使用 `shared/motion.js` 的 `sampleMotion` 进行最多 250ms 的有限预测，不能超过动作终点；超过确认时间的预测上限时冻结步态，网络断开直接显示确认位置。镜头、名字、装备和选区必须采样同一时钟与路径。旧客户端忽略新增字段仍可显示逐次确认位置；旧运动格式仅在兼容呈现中保留，不作为新服务的权威移动。

`action` 为攻击时间线：action_id、type、scene_id、target_id、target_kind、facing、started_at、impact_at、ends_at、phase、outcome、damage、resolved_at。`outcome` 为空表示尚未结算；hit/miss/cancelled 为服务结果。时间经过命中点不能被客户端当作已命中，只有真实结果和 `hurt` 可以产生伤害数字或命中声音。重连得到当前完整快照，第一帧不补播历史声音；同一个动作 ID 不能多次播放命中。

服务模拟为 100ms，SSE 合并为 200ms，浏览器绘制独立；静止状态不凭空产生动作。每次改变仍按公开投影生成补丁，不传送 settled_distance、权限、仓库或主人目标等内部字段。

服务器先生成一次公开快照，再按范围复用投影。完整帧按快照与协议缓存；增量按当前快照、连接的上一份快照、协议分别缓存。相同基线与范围的多个观众共享编码结果；新接入但基线不同的观众不会收到另一基线的补丁。任何世界变化都会使缓存失效，不能只靠 `world_revision` 判断，因为逐步移动不一定增加它。

默认每 200 毫秒合并一次待广播变化，每 15 秒发送心跳。服务没有无限的逐连接应用层队列：写入前检查现有缓冲加本帧字节数；若超过上限，或上次写入产生的背压在下一帧到来时仍未排空，则关闭慢连接，让它重新获取快照。不会为等待某个观众而暂停世界。

部署配置：

| 环境变量 | 默认值 | 校验范围 |
| --- | --- | --- |
| `PLAZA_SPECTATOR_MAX_STREAMS` | 150 | 1–2000 |
| `PLAZA_SPECTATOR_MAX_PER_IP` | 30 | 1–2000 |
| `PLAZA_SPECTATOR_MAX_BUFFER_BYTES` | 262144 | 16384–1048576 |

连接上限触发时返回 `429` 和 `Retry-After: 15`。IP 取真实连接的 `req.socket.remoteAddress`，不信任请求自行填写的 `X-Forwarded-For`。同一 NAT 出口或同机反向代理下的观众可能共用 IP 额度；调整上限应结合实际部署入口及负载，不靠伪造头绕过限制。缓冲上限需要容纳实际完整快照，设置过小会导致连接反复关闭。

隔离压测可通过 `createApp({spectatorOptions:{maxStreams:150,maxPerIp:100}})` 给本机负载客户端明确额度，此选项不改变生产默认值。`application.spectator.stats` 仅供本地进程/IPC 采集编码、流量、连接及缓冲计数，没有匿名统计 HTTP 入口。

## 容量的解释

100 个 SSE 连接的同机压测验证服务器计算、内存、协议正确性和广播行为，不验证公网出口带宽或每个用户设备的渲染性能。编码复用减少重复计算，网络仍需向每个连接发送数据。

估算公网出口：`每位观众实测字节/秒 × 同时观众数 × 8`，再考虑 HTTP/TCP/TLS 和代理开销。初始快照流量与持续增量流量不同，测试报告会保留时长和实际字节数。不能把默认 150 连接配置上限解释为已证明任何机器、任何公网条件都支持 150 人。
