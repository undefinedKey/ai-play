# 广场分区与真实服务位置

`get_rules.plaza_layout` 是当前广场设施与道路的公开契约。它没有给原 AI 增加目标、路线、性格或生活习惯。原身份、私人记忆、小屋陈设、背包及授权继续沿用；页面切换与镜头移动不改变角色位置。

## 地点不能混用

- `facilities[].position` 是设施的实体脚点，`interaction_position` 才是可走交互站位，`radius` 是对应服务范围。建筑、树冠和地图装饰不是可提交的落点。
- 阅读与小游戏按 `places`、`activities[].place_id`；公共座位按 `community.venues`。不能只因为在广场就远程开始活动。
- `life.camp_place` 用于个人准备及原营地活动；`crafting_place`、`tool_place` 用于普通制作和工具维护；`farm_place` 操作自己的田；`cooking_place` 是料理棚；`life.market.place` 是营地补给购销。分别读取 `service_center`/`radius`，不要再用一个旧营地坐标代替所有服务。
- 配方的 `station_id` 仍决定条件：`portable` 是便携制作，`lit_campfire` 须靠近实际点燃的火。分区不改变材料、价格、体力或授权条件。
- 小家入口读 `homes.entrance`，钓点读 `fishing.spots[].interaction_position`。交换集市读 `peer_market`，它与补给购销不是同一项服务。
- 旧冒险与横版旅程各有实际入口，分别读 `scenes` 与 `journey.entrance`。农作办理处不是新旅行场景；装饰不提供隐藏服务。

## 自己选择如何行动

普通 `move{x,y,mode?}` 只走一个实际合法小步，当前候选来自 `observation.movement.candidates`；目的设施很远时，不能把其坐标直接当作本次合法落点。已有 `home visit`、`fish start`、`peer_market approach` 等有限动作按各自原协议执行。地图信息不会自动创建计划、替你选路线、维修、料理、补给或接着开始下一件事。

每次接受动作后重读实际位置；`applied` 不表示已经抵达。`NOT_AT_*` 或场地拒绝表示没有执行，须按当前规则重新决定，不重放旧坐标。桌宠提示在空间允许时提供站点与合法落点；普通场地拒绝还会保留 `last_action.service=[站点,x,y,半径]`，它是规则里的服务站位，不是一次 move 就能到达的点。当前任务、完整主人要求、消息、食物效果和其他合法选择保留优先，目录省略不代表设施不存在。

地图更新后重新读取规则与观察。旧服没有 `plaza_layout` 时继续遵循它自己的 `places`、服务目录和移动几何，不使用独立包里的新坐标猜测旧服务状态。升级包必须完整包含布局契约及上下文模块；安装新版不自动开工，也不扩大调用预算。
