# v0.22 墨线荒野资产

本目录是游戏中实际使用的原创高分辨率手绘资源：粗而不规则的墨线、克制的土色、夸张而彼此不同的人物剪影，参考《饥荒》的荒野纸片美学。官方截图仅用于视觉研究，不进入项目发布资源。

所有 PNG 均由内置 `image_gen` 生成；源文件和 `public/pixel-world/ink_*.png` 保持字节一致。构建只产生采样矩形、脚点、动作和持物元数据，不改变原图像素。各图集不严格等分，使用实测裁切与接触点。RGBA 预览可能有深色底，实际透明性以 alpha 为准。

从 v0.22.1 起，正式构建还用固定 Sharp 版本产生 `dist/*.png.webp` 传输副本：Q90 RGB 有损编码、alphaQuality100，尺寸与透明通道逐像素校验，保留所有原 PNG。此步骤仅压缩发布格式，不重绘、裁切或缩放图像；完整报告写入 `dist/static-transfer-manifest.json`。不支持或未明确接受 WebP 的请求仍取得原 PNG。

- 人物、怪物及补充动作：`actor-prompts.json`、`actor-supplement-prompt.txt`、`actor-geometry.json`、`actors.mjs`。
- 工具、装备、饰品与物品：`inventory-prompts.json`、`inventory.mjs`。
- 农场、作物、火焰、发现物、长凳和石柱：`farm-effects-prompts.md`、`farm-effects-provenance.json`、`farm-effects.mjs`。
- 环境、建筑、地表：`environment.png`、`buildings.png`、`ground.png`，采样和出版由 `manifest.mjs` 定义。

首批环境的制作规格：透明 4×3 原创墨线荒野物件，包含松树、阔叶树、矿脉、浆果、树桩、月光草、草簇、枝条、散石、树苗、幼树、枯树；建筑包括书屋、小屋、棚屋、水井、座椅、桌子、木拱门、石拱门、石柱、残墙、炊事架和补给柜。地表为 1536×1024 安静的灰橄榄与赭土色，留空行走区，不烘焙角色、道路、农田或资源状态。本段是保存的制作规格摘要；后续批次文件保存完整提示词。

身份 ID、地图坐标、碰撞、动作时间和世界规则由原有协议决定。资产更换不产生角色，不让旁观操作控制 AI，也不替 AI 选择活动。人物方向与装备共用确认的动作时序，西向镜像东向，持物连接点随真实姿势变化。

运行 `node scripts/build-pixel-world.mjs` 可重建资产清单；只更新手绘采样时也可执行各 `applyInk*` 模块。`tests/ink-art.test.js` 与 `deploy/check-pixel-assets.mjs` 检查透明性、边界、来源、实际引用覆盖及协议兼容。风格、留白、动作和持物效果另行在浏览器实景验收，不能由这些程序检查替代。

## v0.23 动作补帧

`motion-wanderer_1.png` 至 `motion-wanderer_8.png` 是引用各自原角色、通过内置 `image_gen` 编辑生成的透明动作副图，均为 1024×1536、三列五行。列为南、北、东（西向沿用镜像）；行依次为两侧过步、反侧腾空奔跑、站姿受击、站立下挥收势。原始生成文件保留像素与 alpha，完整提示词、引用及修正历史在 `motion-prompts-*.json` 和 `motion-spacing-prompt-5.txt`。

`measure-motion.py` 只读 PNG 并生成 `motion-geometry.json`：同一身份所有补帧使用同一尺度，脚底、手、胸、头锚点分别测量。人工手点校准绑定源图 SHA，换图后必须重新审看。执行 `python art/ink-world/measure-motion.py --diagnostics artifacts/v023-motion-measurements.json` 可复现。极少轮廓交界像素的采样收紧在测量报告中明确记录，不改变源文件。

实际播放使用四个不同的步行/奔跑关键姿势配合连续重心变化，属于手绘逐帧与姿态变换组合，不宣称完整骨骼或高帧数手绘动画。人物受击不再借用蹲地采集图；挥斧/镐不再每轮跪下。只预取当前可见身份的副图，保持按场景加载。
