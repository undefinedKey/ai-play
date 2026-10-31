# Pixelbolt 像素素材

本目录保存可编辑配方；`public/pixel-world` 是随项目发布的 PNG 图集、atlas 和前端 manifest。服务运行时只发送静态文件，不启动 Pixelbolt，也不在服务器实时生成图像。

生成工具是 [Pixelbolt](https://github.com/skulitom/Pixelbolt)，固定提交 `ce12f75cc524e63e90d4bd183aecc3a46a6b44ee`。需要 Node.js 22：

```sh
git clone https://github.com/skulitom/Pixelbolt.git data/tools/Pixelbolt
git -C data/tools/Pixelbolt checkout ce12f75cc524e63e90d4bd183aecc3a46a6b44ee
node scripts/build-pixel-world.mjs --inspect
```

已有另一份工具时可设置 `PIXELBOLT_ROOT`。脚本实际调用官方 CLI `validate`、`render`、`inspect`；篝火先调用 `compile`。每次渲染保留独立输出目录，尺寸、图集帧数和工具导出检查失败时立即停止。`--only=wanderer_3 --inspect` 可复查单个资产，最终完整构建才能更新 manifest。

美术原点、调色板与动作意图见 [brief.md](brief.md)。人物、地图、怪物、农作物和装备由本项目原创绘制，没有复制桌宠角色。八种人物基底结合服务端持久化配饰/识别色分配身份；角色外观不决定其性格或活动。

`recipes/campfire.fluid.json` 来自 Pixelbolt 的 MIT 示例，仅改名称后编译。其授权全文保存在 [PIXELBOLT-LICENSE.txt](PIXELBOLT-LICENSE.txt)，公开静态资产目录也附相同授权。Pixelbolt 作为构建工具使用，其源码无须部署到服务器。

图像数据不包含玩家、凭据、AI 对话或运行时数据。网站中的姿势由真实公开回执与状态选择；休息、战斗、种田均不由美术循环自主触发。

v0.11.0 共发布 36 组图像：新增独立农作区背景、三种等级的锄头/水壶及对应图标，人物与配饰、装备图集补齐开垦、维修、升级姿势。大地图的田块已移除；农作区按真实地块状态展示荒地、已开垦、播种、生长和成熟。只有真实公开回执才播放工具动作，不用循环动画代替实际劳作。

v0.13.0 共发布 49 组图像，所有 PNG 合计约 181 KiB。保留原八种人物身份与装备叠层，补充徒手采集、料理、食用三种姿势；九种材料、种子、作物、料理和金币图标；四处拾枝、碎矿、料理与补给设施。设施位置来自服务器生活目录，按场景原生比例放置，不把静态树木当成可采节点。森林采用松树、阔叶树、桦树三种轮廓，营地暖土、森林冷绿、遗迹灰石区分地面，湿田垄仅在服务已浇水的状态使用。

采集循环仅持续真实 `life.gathering` 的有限时间；结束等待服务器确认，取消、暂停、断线时停止。料理与食用是短暂的成功回执姿势，未制造第二条制作倒计时。新增公开目录不包含个人库存、额度或流水；这些只在主人自己的仓库中显示。

v0.14.0 共发布 55 组 PNG，合计 200,564 字节。猎弓、重锤和重型护甲使用与人物同步的 74 帧装备层；三类探索发现拥有静态等待姿态和由真实结算触发的短效果。发现实例位置来自服务器，重叠实例在地图合并计数，选中对象的详情仍独立。装备有实际服务数值，像素造型不推导伤害、射程或冷却。旧人物与素材身份保留。
