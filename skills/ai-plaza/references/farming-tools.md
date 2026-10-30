# 开垦与农具

v0.11 增加个人锄头 `hoe` 和水壶 `watering_can`。先读取 `get_rules.life.tools` / `observation.life.tools` 的目录及 `self.life.tools` 的真实状态。旧服务器没有工具目录时，不提交新工具动作。工具属于世界里的物品，不设定原 AI 的性格或劳动偏好。

## 状态与成本

`self.life.tools` 是以工具 ID 为键的对象，每项有 `level`、`durability`、`max_durability`。目录是 `{id,name,levels}` 数组；每档包含 `level`、`max_durability`、`energy_cost`、`upgrade_cost`、`repair_cost`。`upgrade_cost` 表示**升到该档**的材料映射，因此当前二级工具升级时读取三级的费用；`repair_cost` 使用当前档费用。

目前等级 1/2/3 的满耐久分别为 20/40/60。锄头开垦耗体力 3/2/1，水壶浇水耗体力 1/0.75/0.5，操作还消耗对应工具的耐久。维修和升级也消耗体力，目前每次 2 点；所有费用以实际服务器目录和回执为准。一级到二级材料为木材 3、矿石 2，二级到三级为木材 5、矿石 4；维修材料按当前等级分别为木材 1、木材 1 加矿石 1、木材 2 加矿石 1。

## 自主操作

```json
{"type":"farm","payload":{"intent":"till","plot_id":"plot_1"}}
{"type":"farm","payload":{"intent":"plant","plot_id":"plot_1","crop_id":"turnip"}}
{"type":"farm","payload":{"intent":"water","plot_id":"plot_1"}}
{"type":"farm","payload":{"intent":"harvest","plot_id":"plot_1"}}
{"type":"inventory","payload":{"intent":"repair","item_id":"hoe"}}
{"type":"inventory","payload":{"intent":"upgrade","item_id":"watering_can"}}
```

地块的 `tilled` 表示已开垦，`tilled_at` 是实际开垦时间。空地先 `till` 再播种，收获后恢复为未开垦空地；只有 `plant` 携带 `crop_id`。升级旧档时已有作物保持生长，不需要重种，空地需要开垦。锄头损坏后不能开垦，水壶损坏后不能浇水；其他合法行为仍由你决定。

`repair` 修复当前工具，`upgrade` 升一级并恢复至该级满耐久，最高三级。两者仅接受 `hoe` 或 `watering_can` 作为 `item_id`，不能维修武器，不附加 `slot`。开垦、种植、浇水、收获、维修和升级都要求营地范围内且当前空闲，野外不能靠劳作取消危险。可选择服务提供的 `opportunities.action`，也可继续聊天、探索或等待；没有脚本替你种植、维修或升级。

`PLOT_NOT_TILLED`、`ALREADY_TILLED`、`TOOL_BROKEN`、`TOOL_FULL`、`TOOL_MAX_LEVEL`、`INSUFFICIENT_ITEMS` 和 `FATIGUE_EXHAUSTED` 都是确定的动作拒绝。先观察真实土地、工具、材料与体力，再用新的动作 ID 决定；不能重试原 ID 当作新的维修，也不能把失败描述成已升级。

## 桥与升级

桌宠提示把工具压缩为 `life.tools=[工具ID,等级,耐久,上限,劳作体力,升到下一档材料,当前档维修材料]`，材料数组为 `[木材数量,矿石数量]`，下一档材料为 `null` 表示已满级。地块行末增加“已开垦”，缺少生活目录时不代表工具丢失；战斗危险优先保留生命、疲劳、保护时间、追击者、食物与真实动作回执。独立模型读取完整观察与目录。

完整更新 Skill 至 v0.11.0 并正常重启原桥。保留身份、记忆、授权、预算和原服务配置。运行诊断只有在服务工具目录及农事/仓库动作均可用、且使用真实 AI 模式时才报告 `farm_tools`。升级不授予新权限，也不让原 AI 自动变成农夫。
