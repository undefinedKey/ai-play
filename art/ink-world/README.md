# v0.22 墨线荒野资产

本目录是游戏中实际使用的原创高分辨率手绘资源：粗而不规则的墨线、克制的土色、夸张而彼此不同的人物剪影，参考《饥荒》的荒野纸片美学。官方截图仅用于视觉研究，不进入项目发布资源。

所有 PNG 均由内置 `image_gen` 生成；源文件和 `public/pixel-world/ink_*.png` 保持字节一致。构建只产生采样矩形、脚点、动作和持物元数据，不改变原图像素。各图集不严格等分，使用实测裁切与接触点。RGBA 预览可能有深色底，实际透明性以 alpha 为准。

- 人物、怪物及补充动作：`actor-prompts.json`、`actor-supplement-prompt.txt`、`actor-geometry.json`、`actors.mjs`。
- 工具、装备、饰品与物品：`inventory-prompts.json`、`inventory.mjs`。
- 农场、作物、火焰、发现物、长凳和石柱：`farm-effects-prompts.md`、`farm-effects-provenance.json`、`farm-effects.mjs`。
- 环境、建筑、地表：`environment.png`、`buildings.png`、`ground.png`，采样和出版由 `manifest.mjs` 定义。

首批环境的制作规格：透明 4×3 原创墨线荒野物件，包含松树、阔叶树、矿脉、浆果、树桩、月光草、草簇、枝条、散石、树苗、幼树、枯树；建筑包括书屋、小屋、棚屋、水井、座椅、桌子、木拱门、石拱门、石柱、残墙、炊事架和补给柜。地表为 1536×1024 安静的灰橄榄与赭土色，留空行走区，不烘焙角色、道路、农田或资源状态。本段是保存的制作规格摘要；后续批次文件保存完整提示词。

身份 ID、地图坐标、碰撞、动作时间和世界规则由原有协议决定。资产更换不产生角色，不让旁观操作控制 AI，也不替 AI 选择活动。人物方向与装备共用确认的动作时序，西向镜像东向，持物连接点随真实姿势变化。

运行 `node scripts/build-pixel-world.mjs` 可重建资产清单；只更新手绘采样时也可执行各 `applyInk*` 模块。`tests/ink-art.test.js` 与 `deploy/check-pixel-assets.mjs` 检查透明性、边界、来源、实际引用覆盖及协议兼容。风格、留白、动作和持物效果另行在浏览器实景验收，不能由这些程序检查替代。
