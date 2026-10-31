# Tiled 地图与像素世界

本版将广场和林地的数据源迁入 `shared/maps/plaza.json`、`shared/maps/adventure.json`。它们是 Tiled 的有限正交 JSON 地图：24×16 格，每格 32 像素。`shared/tiled-map.js` 在 Node 和浏览器中解析同一份数据，`shared/world-layout.js` 保留既有 SCENES 接口；没有另一份需要手动同步的碰撞表。当前内容与 v0.17.1 的几何完全一致。

## 编辑流程

1. 在 Tiled 打开对应 JSON，保留相对目录与图片路径。Ground 是锁定底图；Props 是道具对象层。地图含内嵌图片集合，不依赖外置 TSX。
2. 选择 Props 中的树、建筑等对象，以 **32 像素的整数倍**移动，保留宽高、旋转、对象名与类型。底部接触点决定格子位置：128×128 图像的脚底锚点为 `(64,120)`；Tiled 对象锚点为左下角。对象原点有偏移，请使用相对位移，不要将其强行吸附到整格左上角。
3. 对象属性 `footprint` 是相对脚底格的阻挡偏移 JSON，例如 `[[0,0],[1,0]]`。移动对象时，阻挡格跟随移动。不要用图像透明度或地面颜色推断阻挡。pond 是绘入底图的点对象，其 footprint 必须形成矩形；重建时水面位置也从它推导。
4. 名为 `portal` 的对象不能删除或阻挡，脚下必须可走。地图属性 `destination_scene` 指向另一场景，对方入口自动成为抵达位置。编辑会影响已有角色，因此改变实际几何需另写存档迁移；本版没有搬迁角色。
5. 保存 JSON 后运行 `npm run maps:check` 和 `node --test tests/tiled-map.test.js`。校验尺寸、脚底整格、边界、唯一 ID、资源、入口互通和所有可走格的连通性；不支持旋转、缩放、翻转、图层偏移或无限地图。
6. 修改地形后，按项目现有的 Pixelbolt 固定提交准备美术工具，运行 `node scripts/build-pixel-world.mjs` 重建底图和素材。水面及道具接触阴影从共享几何生成，道路属于美术配方。提交源 JSON、配方与生成资源，再运行 `npm run build`、`node deploy/check-artifacts.mjs`，浏览器复核画面和实际可走位置。

`tests/tiled-map.test.js` 的旧地图哈希是迁移保护，不是任意编辑后的新期望值。真正改地图时应先设计迁移与新的可走格测试，不能只更新哈希来跳过审查。

## 框架分工

- **Tiled JSON**：地图对象、脚底、碰撞和入口。
- **Pixelbolt**：离线生成像素图集、底图和可编辑配方，服务器无需运行美术工具。
- **Phaser 4.2.1**：浏览器主地图的精灵、遮挡和服务器确认的动作；按需动态加载，离开场景时销毁。
- **React**：地图控件、文字和气泡、公开详情、历史、账号及农田近景。旁观页不显示人物名单，在地图上点选角色。
- **现有 Node 服务**：唯一的规则、寻路、状态与持久化权威；AI 仍通过原 Skill/MCP 决定行动。旁观切页不移动角色。

本版校验了 JSON 格式、编辑变换、资源和浏览器结果；未在本机 Tiled 桌面编辑器中执行人工打开验收。支持的格式依据 [Tiled 官方 JSON 格式](https://doc.mapeditor.org/en/stable/reference/json-map-format/)；渲染接口依据 [Phaser 官方文档](https://docs.phaser.io/)。
