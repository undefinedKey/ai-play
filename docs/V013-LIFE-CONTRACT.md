# v0.13 和平生活接口契约

本文件是本轮实现契约，不代表完成验收。原 AI 决定行动；服务器只执行一次有限工作，不自动串联或轮换。

## 规则与动作

`rules.life.gathering.resources` 公布两个目录对象：

| id / item_id | name | x,y | radius | duration_seconds | energy_cost | yield_count | cooldown_seconds |
| --- | --- | --- | --- | --- | --- | --- | --- |
| wood | 营地拾枝处 | 10,8 | 1 | 12 | 4 | 1 | 8 |
| ore | 营地碎矿堆 | 12,8 | 1 | 18 | 6 | 1 | 12 |

两个节点均在营地安全范围内，不需要任何工具。资源供给按角色独立计时，不是共享有限库存：其他人使用不锁住节点。世界目录含 `tool_required:false`。每次成功开始预扣体力，结束才发一份材料；取消不返还已付体力，也不发材料。成功开始即设该资源最早再开工时间 `ends_at + cooldown_seconds*1000`，取消不能绕过它。

- `gather {intent:"start",resource_id:"wood"|"ore"}`：在节点交互范围内、营地、无冒险/独处/参与中的多人游戏/其他采集，且体力足够。
- `gather {intent:"cancel"}`：取消本人当前工作，不带 resource_id；无工作则 `NO_GATHERING`。
- 走路会取消采集；聊天、wait、食用补给可继续。其他劳作、制作、交易、换装、开始冒险或独处活动须先取消采集。
- 暂停、召回、授权到期、45 秒失联、服务重启取消旧工作；重连不恢复或补发旧采集。有效在线的延迟 tick 完成一次，不补做多轮。

`life.gathering` 是公开的 `null` 或 `{job_id,resource_id,item_id,quantity,started_at,ends_at}`；时间为 Unix 毫秒。`life.gather_ready_at` 公开 `{wood:number,ore:number}`。内部 run/epoch 不公开。固定站点坐标为 `x/y`，不另混用 position。

## 两种料理

沿用 `inventory {intent:"craft"|"use",item_id}`，不加新的动作类型。

| item_id | name | ingredients | heal | energy_restore |
| --- | --- | --- | --- | --- |
| turnip_soup | 萝卜浓汤 | turnip:2 | 32 | 0 |
| wheat_bread | 麦香面包 | wheat:2 | 0 | 24 |

料理 `items` 为 `kind:"food"`，同时公布 heal/energy_restore。配方在 `life.recipes` 中加 `kind:"cooking",energy_cost:2,duration_seconds:0,station_id:"kitchen"`。本版制作是瞬时动作，UI 显示真实成功效果，不虚构计时进度。

`life.cooking_place={id:"kitchen",name:"营地料理台",x:10,y:7,service_center:{x:11,y:8},radius:2}`；沿用营地服务范围。原装备配方不改变。料理使用不耗体力、不结束野外危险；目标生命/体力已满则拒绝且不消耗。原萝卜、小麦仍只恢复生命。免费营地恢复保留。

## 单一营地补给点

`life.market={place:{id:"supply",name:"营地补给柜",x:12,y:7,service_center:{x:11,y:8},radius:2},max_quantity:10,window_seconds:300,buy_limit:20,sell_limit:30,stock_policy:"per_agent_window",items:[...]}`。

| item_id | buy_price | sell_price |
| --- | --- | --- |
| wood | 4 | 1 |
| ore | 6 | 2 |
| turnip_seed | 1 | null |
| wheat_seed | 2 | null |
| turnip | null | 2 |
| wheat | null | 3 |

- `trade {intent:"buy"|"sell",item_id,quantity}`，quantity 为 1–10 的安全整数；不接受附加主人/价格/余额字段。
- 只可在营地空闲时交易。单角色每个 300 秒窗口最多买 20 件、卖 30 件，按件扣额度；无共享库存，不能称某物“被所有人买空”。窗口从本角色第一次初始化经济记录开始，重连与重启不重置。
- 本人/主人可见 `life.market={resets_at,buy_remaining,sell_remaining}`；其他角色与匿名旁观不见额度。公开目录价格不受此限制。
- 原金币继续存在 `self.adventure.gold`。不新增金币维修、不卖料理/装备、不支持逆向拆解。买卖同物必亏，作物不向商店购买，购买种子后耕作获利是有工作与时间成本的正常产出。
- 零工具/材料/金币/种子可休息→徒手采集木材→出售→买种子；继续采集修理农具，无需战斗或第二个角色。

## 私有有界账本

本人和主人可见 `life.ledger={limit:100,total_entries,entries:[{entry_id,source_id,at,reason,items,gold_delta,balances:{inventory,gold}}]}`。entries 为最近 100 条按时间升序；items 是物品增减 map，balances 是该笔后的余额。累计 total_entries 不因截断重置。

既有角色首次迁移记一条 `opening_balance`，不补造历史；新角色记真实 `initial_grant`。既有动作的收获、制作、食用、维修/升级、战斗奖励及新增采集/交易均按实际增减记录。source_id 关联真实 action_id、采集 job_id 或怪物奖励事件。无增减不造空交易；失败/重试不重复记账。

完整账本仅在本人观察和对应主人视图返回；动作回执返回当前生活状态、库存与额度，不重复携带完整历史账本，避免每角色200条回执复制100条流水。匿名/邻居/其他主人严格投影排除私有账本、库存与额度。

## 公开事件、候选与兼容

- `life_gather_started`：agent_id,name,text,job_id,resource_id,item_id,quantity,started_at,ends_at。
- `life_gather_finished`：agent_id,name,text,job_id,resource_id,item_id,quantity。
- `life_gather_cancelled`：agent_id,name,text,job_id,resource_id,reason（有限公开枚举）。
- 料理沿用 `life_crafted` / `life_consumed`，补 item_id、quantity、hp/energy 结果；交易 `life_traded`，公开 intent,item_id,quantity,total_price；不公开完整流水/库存/剩余额度。
- 新错误包含 GATHER_BUSY、NO_GATHERING、GATHER_COOLDOWN、NOT_AT_RESOURCE、FATIGUE_EXHAUSTED、FULL_ENERGY、TRADE_UNAVAILABLE、TRADE_LIMIT、INSUFFICIENT_GOLD；其他沿用现有库存/营地/动作错误。
- 候选最多 6 条，新领域可发现，采集中有取消选项；完整目录在 get_rules/observe 可查，不强制执行。
- `rules_version="0.13.0-life"`，`recommended_skill_version="0.13.0"`；保留协议 skill_version=0.1.0。新能力 `gathering` / `cooking` / `trading`，仅支持目录时报告。

所有时间/次数/金额由服务校验；动作及异步采集完成在持久状态中只结算一次。原角色、外观、预算、地块、工具、装备、生命体力保留。
