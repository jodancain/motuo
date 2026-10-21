# Motuo v3 · 骑行即漫画 MV

> 整块屏幕就是一格正在连载的漫画：你的车是主角，速度是这一格的标题。

独立 HTML 评审版，与 v2 并存可对比（v2 文件未改）。没有卡片、没有面板栏：一个活的多层视差世界、一辆占画面一半的 2D 漫画摩托、一个高度 ≥ 35% 屏高的速度巨字，其余信息是页角小字注释。设计说明见 [DESIGN.md](DESIGN.md)。

## 启动

在仓库根目录：

```sh
# 首次运行：复制本机 GLB（用户素材，被 .gitignore 忽略，不进 Git）
mkdir -p prototypes/motuo-v3/assets/models/suzuki-gsx-r1000
cp prototypes/motuo-v2/assets/models/suzuki-gsx-r1000/model.glb prototypes/motuo-v3/assets/models/suzuki-gsx-r1000/
# 没有 v2 的 GLB 时，先按 v2 README 用 python3 scripts/prepare-suzuki-model.py 生成；
# 缺 GLB 也能运行，会自动改用 2D 矢量漫画车（不会白屏）。

python3 -m http.server 8766 --bind 127.0.0.1 --directory prototypes/motuo-v3
```

打开 `http://127.0.0.1:8766/`。v3 以自身目录为根，全部离线：无 CDN；字体、Three.js r186、GLB 都在本目录内。麦克风需要 localhost 或 HTTPS。

## 画面与交互

| 状态 | 内容 |
|---|---|
| 待机 | 场景巡游、天气粒子；**点车**轰油门（火焰、烟、“轰！”）、**上滑**抬头 wheelie、**长按**烧胎蓄力（烟团、蓄力环、集中线，松开冲出画面再从左侧追回）、**左右拖拽**换角度，快速甩动 = 甩尾（胎痕、SKRRT!）。|
| 出发 | READY → 3 → 2 → 1 → GO!!，原地烧胎冒烟、漫画集中线、倒计时音；GO 冲击白闪（限流）+ 冲刺，世界开始滚动。“跳过 ›”。|
| 骑行 | 世界按读数滚动（远景/楼群/护栏/路面不同视差）；纵向加速度 → 速度线密度与画面倾斜（≤4°）；声浪 → 楼群高度像均衡器 + 车身震动；高速时轮速圈。车 12fps 步进、背景 60fps（“一拍二”）。|
| 分镜 cut-in | LAUNCH / BOOST / BRAKE / CORNER / 30·40·60 km/h 里程碑：0.7–1.1s，画面裂成 2–4 个斜切格（后轮烟、排气火焰、前轮火花、车头光、压弯、路面），首拍墨白冲击帧（限流），拟声字 VROOM! 轰！吱——！SWOOSH! ZOOM!；**速度格**把真实速度带进分镜。|
| 关卡 | 4 个世界：第1话 霓虹都市夜（雨）、第2话 落日海岸（海鸥、复古落日）、第3话 雪山隧道（雪、周期隧道顶灯）、第4话 紫夜宇宙公路（星轨、环行星、霓虹网格路）。翻页转场。|
| 暂停 | 漫画定格：画面泛黄、缩成一页上的一格，右下 “TO BE CONTINUED →”；继续时翻页恢复 + “GO!”。|
| 结束 | FIN. → 生成「今日骑行漫画」：一页 4–6 斜切格（起步、最高速、最强加速、过弯、急减速、结束），每格是当时世界的场景重绘 + 当时姿态的车 + 拟声字 + 记录值旁白框，逐格砸入；“保存图片” 导出 1080×1528 PNG。|
| 车库 | 熊猫白 / 曜石黑 / 冰川蓝 / 熔岩红 / 电光紫 + 亮面/缎面，沿用 v2 `vehicle-paint.js` 的蓝色色素遮罩，实时反映到 2D 漫画车。|
| 声浪 | 麦克风（点击后授权，本机分析，不录音/回放/上传）或 声浪 DEMO（合成特征）；演示驾驶自动使用声浪 DEMO 并标注。|
| 设置 | 性能档位 自动/高/中/低；界面音效 开/关（Web Audio 本地合成，默认开）；减少动态 跟随系统/开启。|

一键 **演示驾驶**：约 60 秒（倒计时 4s + 骑行 52.5s，其中暂停 4s）：起步 → 加速过 30/40/60 → 过弯 → 换到下一关 → 77 km/h → 急刹到停 → 暂停 → 继续 → 再起步 → 停 → 结束 → 漫画。

## 模块

| 文件 | 作用 |
|---|---|
| `app.js` | 状态机、单 rAF 任务编排、手势、转场、漫画生成、测试钩子 `window.__motuoV3` |
| `core/loop.js` | 单一 rAF 主时钟（隐藏即停、按 fps 步进）+ 三档性能调度（滞回、手动固定、热压力封顶） |
| `core/demo-script.js` | 演示剧本（1Hz 离散读数帧）与播放器 |
| `core/ride-model.js` | 读数 → 显示文本、差分加速度、积分里程、游戏事件、骑行记录 |
| `core/director.js` | 事件 → cut-in/字幕、统一闪光限流、留速度格的斜切版式 |
| `core/comic-layout.js` | 关键时刻挑选、页面斜切版式、只取记录值的注释 |
| `core/layout.js` · `core/geometry.js` | 横/竖屏舞台版式、速度巨字适配、车屏幕映射；半平面裁切与命中 |
| `render/scene.js` · `render/worlds.js` | Canvas 2D 世界画师（网点、套印残影、楼群均衡器、天气、速度线、集中线）与 4 个世界 |
| `render/bike.js` · `render/comic-pass.js` · `render/bike-vector.js` | GLB 正交侧视 + 漫画后期（12fps、真实轮轴节点转动、快照）；矢量回退车 |
| `render/fx.js` · `render/cutin.js` · `render/comic-render.js` | 烟/火/火花/轮速圈/拟声字；分镜渲染；漫画页渲染与 PNG 导出 |
| `audio/sfx.js` · `audio/sound.js` | UI 音效合成；麦克风 / 声浪 DEMO 特征 |
| `native-adapter.js` | `MotuoNativeReceive(state)` 适配层（见下） |
| `shared/*.js` | 复制自 v2（2026-10-20，未改动）：`drive-signals` `inertial-speed` `sound-trend` `motion-kit` `game-events` `vehicle-paint` `vehicle-resources` |
| `assets/fonts/` | 复制自 v2 的 OFL 子集字体与许可（MotuoNum/MotuoDisplay/MotuoHan）；v3 文案限定在子集内，测试解析 woff2 cmap 校验 |
| `vendor/three/` | 复制自 v2 的 Three.js r186（MIT，许可在目录内） |

## 数据真实性边界

- 速度数字 = 最新一条有效读数取整；无读数 `—`；惯导短时估计前缀 `≈`；暂停为 `—`（与原生一致）。不插值、不平滑后显示；新读数整体替换。动画（滚动速度、轮速）可以缓动，但不显示。
- 不显示数字 RPM、挡位、油门、倾角；车身抬头/点头/甩尾/画面倾斜都是装饰，不输出数值。
- 加速度只来自连续同源速度读数差分（v2 `drive-signals.js`）；未知即关闭相关效果。
- 声浪只在麦克风授权或显式声浪 DEMO 下驱动楼群与震动；不能识别发动机或转速。
- 演示驾驶全部标 DEMO（速度巨字旁 DEMO 印章、页角“DEMO 模拟读数”），里程由读数积分。游戏分 / 连击标“游戏分 · 非驾驶评价”。
- 漫画每格的时刻、速度、加速度、时长、里程、最高速都取自本次记录；测试会剔除记录值后检查注释里不剩任何数字。
- 展示车为 GSX-R1000 近似外观，非准确 GSX250R。

## 接入原生（10/20 时的说明，已于 10/21 接入，见文末）

`installNativeAdapter(app)` 在存在 `window.webkit.messageHandlers.motuo` 时注册 `window.MotuoNativeReceive(state)`，输入形状与 `ios/Motuo/Cockpit/native-runtime.js` 相同：`phase, seconds, distanceM, speedKmh, sampleTime, speedSource, uncertaintyKmh, motion, simulated, reduced, thermal, modal, sound{live,level,spectrum[32]}, finishedRide{id,distanceM,durationS,maxSpeedKmh,simulated}`。

- 每个新的 `sampleTime` 记一条读数帧（同一时刻不重复计入）；超过 1.5s 无快照显示 `—`。
- `speedSource=inertial` → `≈`；`unavailable` → `—`。`thermal` 时自动档不高于“中”；`modal` 时游戏事件暂停；`reduced` 走减少动态。
- `finishedRide` 到达后用原生汇总（里程、时长、最高速）生成漫画并回传 `wrappedShown`；按钮动作 `primary` / `finish` 发回原生。
- 迁移时需要：把 `prototypes/motuo-v3` 打包为原生资源、在 `CockpitWebView` 白名单中确认动作、以及真机性能验收。

## 验证

见下方「本轮验证结果」（由 `artifacts/motuo-v3-20261020/` 录制脚本生成）。

## 本轮验证结果（2026-10-20，第二轮审核修复后重录，本机）

- 单测：`node --test prototypes/motuo-v3/tests/*.test.mjs` **42/42 通过**（含审核修复回归：暂停时速度元素有文本且可见、拟声字缩字号不横向压扁、倒计时巨字 55–80% 屏高且不出画、横竖屏两个车轮完整入画、冲刺不推出车头）。v2 回归 `node --test prototypes/motuo-v2/tests/*.test.mjs` **177/177 通过**。
- 浏览器：Chrome for Testing（headless，`--use-angle=metal`）以真实按钮跑完横屏 844×390 全流程、竖屏 390×844 交互（点车、上滑、长按松开、拖拽、甩动）+ 车库熊猫 + 雪山/宇宙两个世界 + 声浪 DEMO + 全流程，另一遍不录屏只测量。三遍控制台 error/warn 为 0；骑行中 3,916 帧逐帧命中测试，速度最长不可读 **0ms**；暂停 299/299 帧速度可读（定格最后读数）；闪光每秒最多 **1** 次；页面隐藏后 rAF 帧数 0；“保存图片”得到 1080×1528 PNG（签名校验通过）。车库 5 个预设对比图：`frames/garage-presets-*-compare.png`。
- 性能（桌面 headless，仅参考）：本轮录制时本机被其他进程占满（load average 7–12），连几乎不渲染的暂停阶段帧间隔也约 40ms，自动档按设计降到“低”；车每次渲染的 CPU 提交约 0.2ms（不含 GPU 异步）。同一代码前一轮低负载时骑行帧间隔均值约 13ms、p95 约 27ms。都不是手机结论。
- 漫画着色：改为“反照率遍 + 无贴图光照遍”的两遍 cel 着色（暗/中/高光三阶、暗部规则网点、高光平涂、墨线取自深度/轮廓/光照折痕/强颜色边界），不再经 AgX 色调映射；车漆在 2D 漫画渲染里除 v2 蓝色色素遮罩外，同一车壳贴图上的银白中性色整流罩也取主色（仅漫画渲染的扩展，v2 写实遮罩未改）。
- 产物在 `artifacts/motuo-v3-20261020/`（不入 Git）：`video/*.mp4`、`frames/`、`comic-*.png`、`report.json`、脚本 `scripts/record.mjs`；历轮截图在 `round*/` 供对比。
- 未做：真机帧率/发热、真实麦克风授权流程（headless 未授权）、原生集成、VoiceOver 逐项检查。

## 速度突破剧场（2026-10-21）

用户反馈“速度突破太单一”。现在每次突破是一段 1–2.4 秒的迷你漫画剧场，由“剧目 × 世界反应 × 等级 × 镜头 × 数字变形”组合，带种子随机、连续不重复。完整的剧目表、世界反应表、阶梯与防刷规则见 [DESIGN.md 第 9 节](DESIGN.md#9-速度突破剧场2026-10-21)。

- 17 种剧目：破纸墙、冲线横幅、音障锥、数字赛跑、分镜三连、编辑盖章、成就解锁（游戏）、趣味弹幕（非真实用户）、速度对比（约值 + 来源）、烟花写字、希区柯克变焦、甩镜、子弹时间、数字着火、碎裂重组、冻住震碎、霓虹灯管；另有“回归”（减速后再次突破）、“今日新高”、“100 KM/H 大事件”（三幕串联）。
- 世界专属反应：霓虹广告牌翻牌成数字 / 海鸥惊飞与浪花 / 冰线横飞与雪崩 / 行星连珠与流星雨。
- 阶梯 20/30/40/50/60/80/100/120…；只用真实 GPS 读数；滞回 8 km/h、同阈值冷却 20s；今日新高每次骑行最多一次；历史存 `localStorage['motuo.v3.milestone-history']`（v1），演示、画廊、估速都不写。
- 对比表 `data/speed-comparisons.js`：12 项，每项有来源 URL（维基百科 / 吉尼斯 / 世界田联，2026-10-21 访问核对）与口径，显示为“约”。家猫、狮子没有找到权威来源，未收录。
- 骑行漫画：最精彩的一次突破（今日新高优先）占一格，画该剧目的定格画面，注释取自记录。
- 画廊：`http://127.0.0.1:8766/?gallery=milestones` 或 设置 →“突破画廊”。
- 演示驾驶改为 53.5s 骑行：依次突破 20/30/40/50/60/80/100，暂停继续后再次突破 20/30（回归）；原有起步、过弯、换关、急刹、暂停、继续、结束、漫画剧情保留。数据仍是 1Hz 离散 DEMO 读数。
- 里程碑不再走单一的分镜 cut-in（游戏分照常累计）；其他事件的分镜在剧场进行时让位、结束后补上排队的一个（排队有效期从 0.9s 调到 1.2s）。

视觉返工（10/21 审核后）：剧目改用整屏（速度区挖空）、道具按屏高 30–60% 取尺寸、每个剧目都有“起—冲突—爆点—余韵”四拍和车的动作（后退/冲刺/抬头/压扁/甩尾/残影），一次只突出一个主文字；编辑盖章、烟花写字、趣味弹幕、速度对比（11 种平涂动物）、音障锥、冲线横幅、破纸墙、三个镜头花活和 100 大事件逐一重做；画廊控制条收成底部细条；GLB 加载期间显示 LOADING 卡片。见 [DESIGN.md 第 9 节](DESIGN.md#9-速度突破剧场2026-10-21)。

验证（2026-10-21，本机，视觉返工后）：`node --test prototypes/motuo-v3/tests/*.test.mjs` **61/61 通过**（新增 4 项：17 种剧目都让车动且幅度有界、道具尺寸与不进入速度区、一次一个主文字、画廊细条与加载过场）；v2 **177/177**。Chrome for Testing headless 录了横屏演示、横屏画廊（20 项全播）、竖屏演示，并导出横屏 20 条 + 竖屏 6 条四格分镜条与动物对照图：五遍控制台 0 error/warn，14,889 帧速度命中测试，最长不可读 0ms，闪光每秒最多 2 次。本轮录制时本机 load average 约 5–11.5，骑行帧间隔均值约 13–14ms、剧场期间 p95 约 26ms，只能作参考。产物在 `artifacts/motuo-v3-20261021-milestones/`。

## 原生接入（2026-10-21）

`python3 scripts/prepare-native-cockpit.py` 把本目录打包进 App（`ios/Motuo/Resources/Cockpit/`，gitignore），并注入 `ios/Motuo/Cockpit/v3/native-runtime.css`（原生专属版式）。浏览器预览不受影响：没有 `webkit.messageHandlers.motuo` 时原生分支不生效。

| 模块 | 作用 |
|---|---|
| `native-adapter.js` | 原生运行层：快照映射（1Hz 读数身份 `speedSampleTime`、骑行计时时基、发热/低电量封顶、外观、面板请求、复盘时间线）与带参数校验的动作发送 |
| `core/native-record.js` | 用原生保存的时间线、汇总与事件生成漫画记录；网页实时记录只补世界、剧目与游戏分 |
| `core/resize.js` | 旋转两段式：每帧 DOM 版式 → 稳定 160ms 后重建缓冲 |

- **一套导航**：原生 TabBar 是唯一导航；场景里“关卡 / 配色 / 声浪 / 设置”为左上角小贴纸。“配色”即漫画车库，里面的“车辆档案 · 手册 · 保养 →”回到原生车库；原生车库的“外观与配色”打开这里。外观由原生持久化。
- **出发**：原生模式下“开始骑行 / 进入演示骑行 / 演示骑行”先播倒计时，走完（或“跳过”）才发 `primary` / `demoStart`；原生开始记录后放 GO!!。演示数据来自原生演示骑行（1Hz，DEMO 由原生 `simulated` 决定），网页不跑脚本。
- **复盘**：原生结束 → FIN. → 漫画（原生时间线）→“保存图片”发 `share`（PNG 数据，原生弹系统分享面板）/“查看详细复盘”发 `rideDetail` /“完成”发 `wrappedDone`。
- **旋转**：任何状态都可旋转；分镜与突破剧目按新版式继续，倒计时继续，暂停定格不变，漫画页横竖两种排法。速度巨字始终在最上层。
- **无障碍读数**：视觉隐藏的 `#font-status`、`#ax-theatre`、`#ax-clock`、`#ax-layout`、`#ax-error`，供 VoiceOver 与原生 UI 测试读取。

验证：`node --test prototypes/motuo-v3/tests/*.test.mjs` **78/78**；浏览器旋转回归 `tests/browser/native-rotation.pw.mjs`（先 `python3 -m http.server 8767 --bind 127.0.0.1 --directory ios/Motuo/Resources/Cockpit`）Chromium、WebKit 各 57/57；模拟器结果见 `docs/STATUS.md`。

## 审核返工 fix1（2026-10-21）

- **全出血（原生）**：打包进 App 时 `<html class="native-host">`，`ios/Motuo/Cockpit/v3/native-runtime.css` 去掉浏览器预览的纸边与墨线框，世界铺满整屏；页角 HUD、按钮按 `env(safe-area-inset-*)` 内缩；`core/layout.js` 的 `stageLayout(W, H, safe)` 在安全区内排车与速度巨字（安全区由 `#safe-probe` 读出）。浏览器预览保持原来的纸边版式。
- **剧场给车让位**：`render/milestone-player.js` 在速度区之外再挖空车身核心区；`clampBikeShift` 让剧目位移与镜头平移下车出画 ≤15%；竖屏主文字在车下方路面带、注释在速度与车之间。回归：`tests/theatre-portrait.test.mjs`（结构性，全部剧目 × 三种视口）与 `tests/browser/gallery-portrait.pw.mjs`（390×844 真实像素，爆点前后截图）。
- **横屏漫画**：`PAGE_LANDSCAPE`（1400×820）横版页 + `render/comic-view.js`（两张页缓存，旋转时整页上屏）；导出 / 分享仍是竖版 PAGE。`#ax-comic` 报告“漫画 横版/竖版 完整/揭示中”。
- **启动**：页面内联深色背景；原生按钮在首份快照后才显示。

验证：node **91/91**；`native-rotation.pw.mjs` Chromium / WebKit 各 64/64；`gallery-portrait.pw.mjs` 20/20（先 `python3 -m http.server 8766 --bind 127.0.0.1 --directory prototypes/motuo-v3`）。注意：`data/speed-comparisons.js` 被仓库 `.gitignore` 的 `data/` 规则忽略，全新检出缺这个文件，见 docs/STATUS.md。
