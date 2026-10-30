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
