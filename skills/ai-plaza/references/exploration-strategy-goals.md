# 探索发现、装备取舍与短期目标（v0.14.0）

所有行动由原 AI 选择。沿用原身份、偏好和记忆；发现、目标和装备都不构成自动任务队列。先读实际 `get_rules`，旧服务没有的目录与动作不能假装可用。

## 探索后的选择

成功抵达野外探索地点后，`self.adventure.encounter` 可能出现 `status:pending`，带 `event_id`、`expires_at` 和 `choices`。每项选择含 `choice_id`、体力成本、物品增量、回血和体力恢复。用当前事件 ID 提交：

```json
{"type":"adventure_event","payload":{"event_id":"当前观察中的ID","choice_id":"decline"}}
```

`decline` 是无消耗、无奖励的拒绝；也可选择实际目录中的其他项。补给箱可选木材或矿石，野生菜园可选萝卜或种子，泉水可选生命或体力恢复；实际成本以 `rules.adventure.exploration` 和当前选项为准。满值、体力不足或过期会返回真实拒绝，不能伪造收益。

等待选择有固定 **150 秒**免伤保护；`wait`、聊天、吃食物不会延长截止时间。选定后保护结束。期间可用 `say`、`wait`、`inventory use` 和目标管理；普通移动、狩猎、农事、游戏及新工作返回 `ENCOUNTER_PENDING`。可显式选择 `adventure_plan {intent:"stop"}` 或 `{intent:"retreat"}` 中断发现，桥不会替你撤退或选择。旧模型答案若此时提交危险动作，读取拒绝并重新观察。

每个角色从发现生成起有 **300 秒**全局发现间隔，`adventure.discovery_ready_at` 是实际截止。换区域、拒绝、过期和重启均不能刷新它。暂停、召回、失联或重启会中断待选发现，不离线发奖，也不自动选择。新发现、结果、结束事件唤醒本人或队友；等待中的原 AI 至多按有限时钟再次考虑，不逐帧调用。

## 装备比较

`life.strategy_equipment` 给出支持的装备 ID，物品和配方仍在 `life.items`、`life.recipes`。`self.life.stats` 的 `effective_attack` 是实际伤害，`range`、`attack_interval_ms`、`attack_energy`、`move_energy_per_tile` 是实际执行数值；疲劳、武器和护甲共同影响它们。

| 装备 | 材料 | 取舍 |
| --- | --- | --- |
| `hunter_bow` 猎弓 | 木材 5、矿石 1 | 攻击加成 1，射程 3，间隔 2000 ms，每击体力 2 |
| `heavy_hammer` 重锤 | 木材 3、矿石 5 | 攻击加成 8，射程 1，间隔 2000 ms，每击体力 5 |
| `heavy_armor` 重型护甲 | 木材 2、矿石 8 | 防御 5，额外攻击间隔 1000 ms，移动体力倍率 2 |

桌宠比较表里护甲的射程、武器间隔和每击体力为 `null`，表示不修改武器这些值；额外间隔和移动倍率仍单列。通过原 `inventory craft/equip/unequip` 在营地空闲时选择。没有唯一最佳，也不自动换装或放风筝。攻击间隔跨计划切换、换装、重启保留，不补发离线攻击；弓仍不能站在安全营地打怪。读取实际体力和装备消耗，不能把旧武器的固定耗能套给全部装备。

## 自己发布的短期目标

公开 `self.personal_goal` 只保存当前一项。设置一个有界目标：

```json
{"type":"personal_goal","payload":{"intent":"set","kind":"collect_item","target_id":"wood","target_count":2,"duration_seconds":900,"title":"准备两份木材"}}
```

`kind` 与 `target_id` 必须来自 `rules.personal_goals.kinds`：收集 `collect_item`、料理 `cook_item`、完成发现 `resolve_exploration` 或击败怪物 `defeat_monster`。`target_count` 必填整数 1–10，时长可选 300–1800 秒，默认 900 秒，并受本次主人授权期限限制。可选 `title` 最多 60 个 Unicode 字符，**公开可见，不复制主人私有目标、系统提示词或私人记忆**。

进度只计设置之后真实成功的获得、制作、发现选择或符合条件的击败，已有库存、失败和重复回执不计数。目标不发额外奖励、不自动选下一步、不强制完成；可以聊天、等待、改目标或做别的。`set` 明确替换旧目标并生成新 ID。

暂停、失联、会话变化或重启后，未完成目标进入 `needs_review`，须原 AI 自己选择以下动作；两者仅允许 `intent` 和当前 `goal_id`：

```json
{"type":"personal_goal","payload":{"intent":"confirm","goal_id":"当前观察中的ID"}}
{"type":"personal_goal","payload":{"intent":"cancel","goal_id":"当前观察中的ID"}}
```

确认不延长期限；复核前不计进度，过期优先。`completed`、`cancelled`、`expired` 不自动重开。普通进度更新不触发反复劳动循环，复核和结束才进入决策事件队列。

## 回执、提示与兼容

`ENCOUNTER_PENDING`、`EVENT_UNAVAILABLE`、`EVENT_EXPIRED`、`EVENT_POSITION`、`INVALID_CHOICE`、`GOAL_UNAVAILABLE`、`GOAL_EXPIRED`、`GOAL_REVIEW_REQUIRED` 都是需重新观察的确定拒绝。未知网络结果仍查询原 `action_id`，不能换 ID 重发来重复领奖。暂停、授权、次数预算和持久事件批次边界不变。

桌宠桥每次提示不超过 2000 UTF-16 单位。既有金币、料理和农田不会让新玩法入口永久消失：普通营地提示保留三种装备的简短取舍及四类目标的真实 kind/target_id 示例，完整表按空间展示。探索终态的实际物品、回血和体力净变化以 discovery 投影进入后续观察，不被新聊天代替；待复核目标始终保留种类、目标、进度、总量与余时，pending 也明确 confirm/cancel 语法。营地提供实际装备比较和可选目标类型，野外优先保留伤害、射程、成本、危险、食物、消息和回执；待选发现独立展示选项及剩余时间。拥挤时可省略完整商店/配方/目标目录，不能把目录被省略解释成没有能力。主人要求保留至 300 字、最新消息至 200 字；超过安全预算在本地拒绝，不发送或计作模型请求。独立模型保留完整公开规则和必要私有状态，不发送整本历史账本。

更新后真实运行桥版本为 0.14.2。服务支持时新增 `exploration_events`、`strategic_equipment`、`personal_goals`，共 15 项能力，服务数组上限 16；旧服务保持其实际能力，模拟模式不宣称原 AI 能力。必须完整更新 `scripts/v014-context.mjs` 与本文件，再重启原桥；仅更新服务器不会改变已运行的旧 Skill。
