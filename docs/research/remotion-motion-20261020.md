# 动效语言：参考 Remotion 视频

2026-10-20。用户要求“动画交互参考网上炫酷的 Remotion 视频”。本轮只借用动效语言，落点仍是 `prototypes/motuo-v2/` 的 HTML 驾驶舱原型，未变更原生 App 或发布流程。

## 1. 背景与边界

- **许可**：Remotion 不是 MIT。[LICENSE.md](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md) 写明个人、最多 3 名员工的营利组织、非营利组织以及尚未商用的评估可用 Free License；其余主体须取得 Company License。`remotion.dev/license` 与 `docs/license` 页本轮抓取不到正文，以仓库 LICENSE 为准。GSAP 许可本轮未在线核对，按约定同样不引入。
- **做法**：不加 Remotion／GSAP／Lottie 依赖，不复制其源码（含 GitHub Unwrapped 组件，仅看目录名与公开文档描述）。弹簧、插值、错峰、时钟均在 `motion-kit.js` 自写。
- **实时 HUD 与离线视频的差异**：
  - 视频按帧确定性渲染，可多帧采样做运动模糊；HUD 只有当前帧，不能“回放修正”，掉帧时动画要按时间而非帧数推进。
  - 视频不会被打断；HUD 的出发、暂停、结束、后台、旋转、模式切换随时发生，所有转场必须可取消且落到确定终态。
  - 视频里数字可以随意滚动；HUD 的速度、加速度、声学阶段是读数，动效不得制造中间值、延迟或夸大读数。
  - 减少动态（系统偏好或页面开关）必须有设计过的替代路径，而不是只关掉。

## 2. 动效语言清单

| # | 名称 | 来源 | 原视频／文档中的效果 | 映射到 Motuo | 结论 |
| --- | --- | --- | --- | --- | --- |
| 1 | 弹簧 + 插值 | [spring()](https://www.remotion.dev/docs/spring)、[interpolate()](https://www.remotion.dev/docs/interpolate) | 物理弹簧默认 mass 1／damping 10／stiffness 100，可 `overshootClamping`、`durationInFrames` 拉伸、`delay`；interpolate 多关键帧、分段 easing、`clamp/extend/wrap/identity` 外推 | `motion-kit.js` 统一预设，出发、开场、滚轮、复盘共用 | **采用**。自写数学，按毫秒驱动 |
| 2 | 错峰入场 stagger | spring 的 `delay` 参数；本地 Lottie 时序表、GSAP stagger 规则 | 同一曲线、仅起始时间递增 | 待机 HUD 组装（驾驶表、页头、底栏）与复盘卡片 | **采用**。总时长封顶 480 ms |
| 3 | 动态字体 kinetic typography | [Fireship：This video was made with code](https://www.youtube.com/watch?v=deg8bOoziaE)（源码 [wcandillon/remotion-fireship](https://github.com/wcandillon/remotion-fireship)，简介 “Fireship video made with React”）；[模板页](https://www.remotion.dev/templates) TikTok 逐词字幕 | 大字逐字／逐词弹入，标题即画面主体 | 闲置标题 “MOTUO”、待机主标题逐字弹簧入场；运动模式事件词 | **采用**。仅装饰文字，读数字不做逐字动画 |
| 4 | 数字滚轮／七段数字 | [GitHub Unwrapped](https://githubunwrapped.com/)（[仓库](https://github.com/remotion-dev/github-unwrapped) 有 `SevenSegment`、`Contributions` 等场景目录）；模板 Stargazer 星标计数 | 年度统计以计数／七段数码形式呈现 | 速度数字只在两个**真实整数读数**之间滚动，不插入伪造中间值，class 标记为过渡态；复盘统计仅对已结束、已记录的汇总做 count-up，并标“模拟” | **部分采用**。count-up 是展示已知终值，不是测量 |
| 5 | 场景转场 wipe／clockWipe／slide | [wipe](https://www.remotion.dev/docs/transitions/presentations/wipe)（8 个方向）、[clockWipe](https://www.remotion.dev/docs/transitions/presentations/clock-wipe)（时钟指针式圆形擦除）；仓库 [presentations 目录](https://github.com/remotion-dev/remotion/tree/main/packages/transitions/src/presentations) | 新场景覆盖旧场景；`TransitionSeries` 中转场重叠两段 | 主题／模式切换：主题色 clip-path 擦除或钟面擦除叠层；出发光扫 + 遮罩擦除 | **采用**。叠层只遮装饰，结束移除；速度区不被遮住超过一次擦除时长 |
| 6 | 光扫 + 描边生长 | [evolvePath()](https://www.remotion.dev/docs/paths/evolve-path)（返回 `strokeDasharray/strokeDashoffset`）；GitHub Unwrapped `ShineEffect`（圆角矩形边框上旋转渐变） | 路径从 0 到 1 画出；边框流光 | 出发时扫过 HUD 的光带；速度环描边生长 | **采用**。描边进度只表示“启动中”，不表示速度大小 |
| 7 | 镜头推拉／视差 | GitHub Unwrapped `Opening/TakeOff` 场景（目录名可见，火箭起飞开场）；presentations 中 `zoom-in-out`、`cross-zoom` | 大幅缩放推入营造速度感 | 出发时背景 fx canvas scale 1.12→1；主题擦除时 1.07→1 | **部分采用**。只推背景层，读数层不缩放；减少动态时取消 |
| 8 | 运动模糊／拖影 | [Trail 与 CameraMotionBlur](https://www.remotion.dev/docs/motion-blur)（Trail：`layers`、`lagInFrames`、`trailOpacity`） | 多帧叠加或复制历史位置形成拖影 | 速度数字滚动时短暂纵向模糊；加速冲击条纹 | **部分采用**。不做多帧采样，只在单元素过渡期用短 filter，静止时必须清晰 |
| 9 | 音频节拍 | [visualizeAudio()](https://www.remotion.dev/docs/visualize-audio)（0–1 数组，左低频右高频）；[template-audiogram](https://github.com/remotion-dev/template-audiogram) | 低频平均值驱动缩放／透明度 | 声音趋势阶段（抬升／平稳／回落）变化时节拍脉冲 | **部分采用**。只来自有效麦克风或显式 DEMO；不做“低频驱动读数缩放” |
| 10 | 粒子爆发 | GitHub Unwrapped `Poof`、`StarSprite` 目录 | 星点、烟团爆开 | 加／减速冲击粒子 + 屏幕边缘辉光 | **部分采用**。与读数同源的已校验加速度驱动，未知时关闭；纯装饰 |
| 11 | HUD 微字／扫描线／噪点 | [noise2D()](https://www.remotion.dev/docs/noise/noise-2d)（种子化，返回 −1～1）；GitHub Unwrapped `Noise.tsx` | 可复现的噪声纹理与抖动 | 性能档位徽标、转场标签；暂停“时间冻结”：去饱和、扫描线、冻结帧 | **部分采用**。扫描线为静态 CSS 纹理，本轮未实现噪声抖动；冻结态读数保持可读 |
| 12 | 形状连续／变形 | [@remotion/shapes](https://www.remotion.dev/docs/shapes)（MIT，生成 SVG 形状） | 同一形状在场景间延续 | 待机车卡 → HUD 区块的共享元素飞行（glide） | **部分采用**。只做位置／缩放／圆角连续，不做任意路径 morph |
| 13 | 漏光 light leaks | 本地 `light-leaks.md`（`@remotion/effects` 的 `lightLeak()`，常放在 `TransitionSeries.Overlay`） | 剪辑点上的暖色漏光 | 无 | **不采用**。整屏泛光会冲淡读数，且依赖视频渲染效果库 |
| 14 | 其他视频转场 | presentations 目录：`flip`、`book-flip`、`film-burn`、`ripple`、`dreamy-zoom`、`iris` 等 | 翻页、胶片灼烧、水波 | 无 | **不采用**。整屏翻转／扭曲是前庭诱因，HUD 不能整页离场 |

已检索但未观看或未能展开：[Remotion Showcase](https://www.remotion.dev/showcase) 抓取只见说明（“Products, campaigns, launch videos, tutorials and creative tools made with Remotion”，暂停收录），条目卡片未渲染，无法逐条列出；官方频道 [Remotion 4.0 Keynote](https://www.youtube.com/watch?v=S3C9wlPNhkQ)、[Data-Driven Videos](https://www.youtube.com/watch?v=JrxL3mYY22c) 只检索到标题；“Remotion 2.0 trailer” 未找到可核实结果；Fireship 页面正文本轮未读到描述，Remotion 关联依据为检索摘要和上述仓库。高星项目：`remotion-dev/remotion` 约 65.4k 星，`Vincentwei1021/video-shotcraft` 约 12.6k 星（2026-10-20 `gh search`），后者未阅读。不能据此声称逐帧还原任何视频。

## 3. 来自参考 Skill 的实时 HUD 规则

本地目录 `/tmp/motuo-ezr/skills-ref/`，第三方只读，未执行脚本。`MiniMax-AI_skills/skills/shader-dev` 不存在；remotion-interactivity 有 `inline-effects.md`、`timeline-structure.md`，但内容面向 Studio 编辑，未提取规则。

**属性与性能**
- 主运动只用 transform 与 opacity；不动 width／height／top／left／margin／padding。[gsap-performance] [Lottie quality-checklist] [MiniMax frontend-dev]
- clip-path、color 属“Good”档，同屏 10–15 个以内；box-shadow、border-radius、filter 属“Avoid”档，同屏 1–3 个。[Lottie context-adaptation] → 擦除用 clip-path，模糊只给单个数字。
- `will-change` 只给正在动的元素，动画结束撤掉，不“以防万一”全加。[gsap-performance] [MiniMax frontend-dev]
- 同屏动画元素 <20；60fps 为目标，每帧逻辑 <10 ms，氛围层可降到 30fps。[Lottie context-adaptation／quality-checklist] → 对应 `createClock` 的 normal／eco 档。
- 先批量读布局再批量写；离屏或不活跃动画暂停或销毁。[gsap-performance]
- 高频更新属性复用同一个补间而不是每次新建（quickTo 思路）。[gsap-performance] → 速度滚轮每次读数变化取消上一次滚动再开始，不叠加补间。

**时序与缓动**
- 时长档：微反馈 80–180 ms、卡片 200–350 ms、页面转场 400–600 ms、戏剧性揭示 600–1200 ms；退场为入场的 65–75%；移动端时长 ×0.8、错峰预算减 30%。[Lottie timing-easing-tables／context-adaptation]
- 入场 ease-out、退场 ease-in、屏内 ease-in-out、循环 sine、旋转与进度 linear；空间移动不用 linear。[Lottie timing-easing-tables]
- 缩放若线性插值，大尺度时感知偏小，用感知缩放补偿。[remotion timing.md 的 `output: 'perceptual-scale'`]
- 默认不钳制外推，需要显式 clamp。[remotion timing.md] → motion-kit 默认钳制，读数映射一律 clamp。
- 错峰：同一缓动族只改起始时间；总预算 <500 ms；元素 1 落定时元素 3 才开始，同时活跃不超过 1/3。[Lottie choreography／timing-easing-tables]
- 多步序列用时间线和标签，不用层层 delay。[gsap-timeline] → `createTimeline`。

**编排与层级**
- 主角位移最大，配角在各维度都更弱；同方向或同一原点入场。[Lottie choreography]
- Setup 20–30% → Action 30–40% → Resolution 30–40%，结束后留 100–200 ms 静止。[Lottie choreography]
- 一次编排好的出场胜过处处淡入上移；只在一处放胆量，其余克制。[anthropics frontend-design]
- 氛围层能量不超过主运动的 20%，脉冲缩放超过 ±5% 就会抢注意力。[Lottie ambient-continuous]
- 重要状态不能只靠透明度变化，关键信息不能只靠运动传达。[Lottie quality-checklist]

**可打断与无障碍**
- 动画句柄要保存以便暂停、反转、销毁；重叠补间需明确覆盖策略。[gsap-core] → 新转场先取消旧转场再落位。
- 减少动态：去空间移动、保留透明度、去弹簧、时长减半以上、不自动循环；视差改静态，复杂编排改单次淡入。[Lottie context-adaptation] [gsap-core matchMedia]
- 前庭诱因：大幅缩放、整屏位移、>100px 旋转、>2 层视差、快速换向。[Lottie context-adaptation]
- 超过 5 s 的动画要能暂停；同一交互每次同一动画。[Lottie quality-checklist]
- 用最轻的运行时；复杂叙事动画留给视频工具。[frankxai web-motion-auditor／site-motion-excellence-gate]

## 4. motion-kit 预设建议

**本地 `timing.md` 原文给出的只有**：
- `interpolate(frame, [0, 0.3 * fps], [0, 1])` 线性，默认不钳制，可设 `extrapolateLeft/Right: "clamp"`。
- `Easing.spring({damping: 200})`：“A nice push movement with no bounce”。
- `Easing.bezier(0.16, 1, 0.3, 1)`；缩放加 `output: 'perceptual-scale'`；多关键帧传 n−1 个 easing；`posterize: 3` 抽帧。
- 本地 `transitions.md`：`linearTiming({durationInFrames: 15|20})`、`springTiming({config: {damping: 200}, durationInFrames: 25})`；不给 `durationInFrames` 时按弹簧落定时间计算，随 fps 变化。
- **timing.md 未列 snappy／bouncy／heavy 等命名预设**；仓库其他 Remotion skill 文件也只出现 `damping: 200`。

Remotion 默认弹簧 mass 1／damping 10／stiffness 100（阻尼比约 0.5，超调约 16%）。`damping: 200` 是强过阻尼，纯物理落定约 11 s，只有配合 `durationInFrames` 拉伸才实用，实时 HUD 不能直接照搬。Lottie 弹簧表：很硬 400+／25–30、标准 250–350／18–24、弹 150–250／10–15、很弹 100–200／5–10、柔和 100–150／20–25；Apple Spring 300／20。

`motion-kit.js` 当前预设（落定按 |x−1|<0.004 粗算，与 `springSettle` 同口径）：

| 名称 | stiffness／damping／mass | 用途 | 阻尼比 | 超调 | 落定 |
| --- | --- | --- | --- | --- | --- |
| smooth | 140／24／1 | 镜头推拉、遮罩 | 1.01 | 0 | ~670 ms |
| glide | 120／22／1.1 | 共享元素飞行 | 0.96 | 0 | ~650 ms |
| snappy | 260／26／1 | HUD 区块到位、错峰入场 | 0.81 | ~1% | ~460 ms |
| pop | 320／18／0.9 | 节拍／冲击点缀、事件词 | 0.53 | ~14% | ~490 ms |
| roll | 520／40／0.8 | 数字滚轮 | 0.98 | 0 | ~290 ms |
| heavy | 80／15／2 | 冻结／解冻的重量感 | 0.59 | ~10% | ~1480 ms |

建议：读数相关（roll）保持无超调，避免数字越过真实值再回弹；pop 的 14% 超调只用于装饰词和粒子，符合“庆祝 15–25%、反馈 2–5%、错误 0%”的超调预算 [Lottie]。heavy 落定偏长，实现中暂停冻结以 `maxMs` 截到 700 ms。

**时长档**（与当前 `durations` 一致）：micro 140 ms（按钮、徽标）、short 260 ms（卡片、标签）、medium 480 ms（模式／主题擦除）、long 900 ms（冻结、复盘揭示）、departure 1550 ms（上限 1600 ms）。退场取入场的 65–75%。

**错峰**：micro 28 ms、standard 55 ms、dramatic 90 ms；单次级联总延迟封顶 480 ms，元素多时自动压缩步长；方向用 start（阅读顺序）、center（主标题逐字）、end（退场）。

**缓动**：入场 `cubic-bezier(0.16, 1, 0.3, 1)`（timing.md 示例）或 MD3 Emphasized `(0.05, 0.7, 0.1, 1)`；退场 MD3 Accelerate `(0.3, 0, 1, 1)`；屏内 MD3 Standard `(0.2, 0, 0, 1)`；氛围循环 sine；进度条与光扫 linear。CSS 侧用 `linear()` 采样弹簧，不支持时退回贝塞尔。

## 5. 质量评分表

来源：frankxai `rubrics/motion-quality-rubric.md`（7 项 × 0–3 分，满分 21；公开演示 15+、品牌／产品发布 18+、高端界面 20+）与 `site-motion-excellence-gate.md`（12 项 × 1–5 分，高端发布目标 45+，另有自动不通过项）。每个转场用前者自评，再过 Motuo 否决项。

| 维度 | 0 | 1 | 2 | 3 |
| --- | --- | --- | --- | --- |
| 目的 Purpose | 装饰噪音 | 略相关 | 帮助理解 | 让界面更清楚或更难忘 |
| 时序 Timing | 卡顿或拖沓 | 不一致 | 基本流畅 | 干脆、有意图、跟手 |
| 层级 Hierarchy | 与内容抢 | 分散注意 | 引导注意 | 优雅编排注意力 |
| 品牌 Brand Fit | 通用 | 弱相关 | 可辨认 | 自有动效语言 |
| 无障碍 Accessibility | 无减少动态 | 部分回退 | 有减少动态路径 | 减少动态是设计过的 |
| 性能 Performance | 掉帧 | 移动端吃力 | 可接受 | 目标设备流畅 |
| 实现 Implementation | 脆弱 hack | 能用但易碎 | 可维护 | 令牌化、可复用、可测 |

Gate 补充维度（可选，1／3／5）：Intent、Still Frame（静止帧也能交付）、Product Specificity、Choreography（setup／reveal／support／hold／resolve）、Restraint、Usability（可读、可打断）、Runtime Fit、Evidence（浏览器／移动端／减少动态／录屏证据）。

**Motuo 否决项**（任一不满足即不通过，不计分）：
1. 读数真实：动效未产生伪造中间值、未延迟或夸大速度／加速度／声学阶段；模拟数据有标记。
2. 可打断：暂停、结束、后台、旋转、模式切换中途触发后，无残留叠层，状态落到确定终态。
3. 减少动态：有替代路径，状态文字仍可见，且不被页面开关绕过系统偏好。
4. 控件不被遮挡、无布局位移；静止帧本身可用。
5. 有实际检查证据；浏览器结果不代表原生帧率或实车验收。

## 6. 不采用与风险

- **不采用**：Remotion／GSAP／Lottie 运行时依赖；Remotion 源码与 GitHub Unwrapped 组件代码；light leaks；flip／film-burn／ripple 等整屏扭曲转场；`HtmlInCanvasMotionBlur` 式多帧采样模糊（需 Chrome flag，且是离线帧平均）；低频驱动读数缩放；文字随音频跳动。
- **风险**：
  - 数字滚轮与 count-up 最容易被理解为“测量值”，需过渡态 class 与“模拟”标签，测试读回终值。
  - filter 模糊、clip-path 擦除在低端设备上贵，需随 eco 档降级或关闭。
  - 背景推拉与粒子是前庭诱因，减少动态必须取消，不只缩短。
  - 动效多了会稀释出发这一处“签名动作”；按 Restraint 原则，常驻层保持安静。
  - 弹簧按真实时间推进，后台返回时要重置时钟，防止一次性跳到终态之外。
  - 本文所有效果描述来自公开文档与目录名，未逐帧观看视频；不声称复刻任何视频镜头。

## 7. 实现落点（2026-10-20）

| 动效 | 文件 | 说明 |
| --- | --- | --- |
| 统一底座 | `motion-kit.js` | 解析弹簧、interpolate、bezier、stagger、`linear()` 采样、共享时钟（单 rAF、60/30 档、隐藏即停）、时间线 |
| 开场 | `hud-motion.js` `intro()` | MOTUO 逐字弹簧、HUD 错峰组装、一次扫描线；控件全程不透明 |
| 出发 | `departure-transition.js` | 原 FLIP 共享元素改为 glide 弹簧与 40 ms 错峰；背景推近、光扫擦除、速度冲击环、能量弧描边；全部 ≤1.6 s |
| 骑行 | `hud-motion.js` `speed()/feedback()/beat()/kinetic()` | 速度逐位滚轮（只在两个真实整数间）、加减速边缘光与粒子、声浪阶段节拍、事件词遮罩弹入 |
| 主题／模式 | `hud-motion.js` `scene()` | 主题钟面擦除、模式横向擦除，半透明叠层 |
| 暂停／继续 | `hud-motion.js` `freeze()` + `hud-motion.css` | 冻结闪光、去饱和、扫描线、粒子原地停住；继续时光扫 |
| 复盘 | `hud-motion.js` `recap()` | 卡片翻入错峰，统计“汇总动画”计数并精确落回记录文本 |
| 性能档位 | `index.html` `renderPerfTier()` | 页头显示 60 FPS · 标准／30 FPS · 节能／减少动态，控制中心可切自动／固定 |

## 8. 返工（同日）：推翻“克制”规则，改为游戏 / MV 级夸张

用户审看后反馈“效果不满意，不够夸张，要大改”。上文第 3 节“编排与层级”“前庭诱因”中的克制规则（氛围能量≤主运动 20%、脉冲 ±5%、不做整屏转场、错峰≤480ms、只推背景层）**本轮作废**，方向改为《双影奇境》摩托段落、赛车游戏 HUD、节奏游戏判定和炫技片头式的“第一眼就哇”。上文对 Remotion 等的许可与“只借鉴语言、不引入依赖”结论不变；自写的 `motion-kit.js` 继续作为底座。

保留的只有硬约束：数据语义（无数字 RPM、不伪造挡位／油门／倾角，速度只显示真实读数，游戏分／连击／评级明示为游戏分）；声浪特效只来自有效麦克风或显式 DEMO；骑行中速度任何时刻可读（被遮挡不超过 150ms）；整屏闪烁每秒不超过 3 次（实现取 2 次余量，红色同计）；减少动态有替代路径；页面隐藏即停；性能档位与发热降档保留；不加依赖。

| 新语言 | 落点 | 说明 |
| --- | --- | --- |
| 整屏 WebGL 世界与后期 | `game-world.js` | 单 pass 程序化着色器：日常为流体光浪；运动四主题为霓虹隧道、落日公路、冰晶六棱隧道、紫夜极光城。速度越快穿行越呈超线性（曲速），附径向条纹、深度模糊、色差、暗角呼吸、扫描线、虹膜揭幕 |
| 追尾视角 | `vehicle-garage.js`／`vehicle-viewer.js` | 同一个 3D canvas 在骑行中挂到 `#chase-host`，正后方机位；车身倾斜只随转向状态做装饰，不显示倾角数字；尾灯光迹 |
| 电影化出发 | `departure-transition.js`（`cinematic`） | 黑场 → 车灯点亮 → 车模俯冲越过镜头 → 闪白与冲击波 → HUD 带超调砸入 → 世界虹膜展开 → 巨字 ROLL OUT；约 2.3s，可点“跳过”或点击任意处 |
| 游戏事件 | `game-events.js`＋`game-fx.js` | LAUNCH／BOOST／BRAKE／CORNER／速度里程碑（30/40/60/100）触发巨字、粒子、冲击波、镜头震动；平顺动作累积 COMBO 与游戏分；声浪节拍按 120 BPM 网格判 PERFECT／GREAT／GOOD |
| 速度数字 | `game-fx.css` | 加大 1.36×（夸张）、冷→热变色、辉光与色差、读数变化冲击缩放与旧值拖尾（旧值在新值背后飞散，新值立即完整显示）、高速能量环与火星 |
| 场景转场 | `game-fx.js` `transition()` | 玻璃碎裂、故障、虹膜、曲速拉伸四种轮换 |
| 暂停／继续 | `game-fx.js` `pause()` | 子弹时间慢放到冻结、碎片悬停、去饱和、巨字 PAUSED；继续时短暂倒带再爆发 GO! |
| 复盘 | `game-fx.js` `wrappedRecap()` | Wrapped 式一屏一个数据（里程、时长、最高速度、游戏事件、最高连击）＋可截图战绩卡（游戏评级） |
| 特效强度 | 控制中心 | 克制／标准／夸张（默认夸张），与性能档位、减少动态独立；“克制”保留上一轮的弹簧方案 |

上一轮的逐位速度滚轮在本轮被判定为违反可读性：滚动中途新旧两位数字都只露出一半约 290ms。标准／夸张强度下已关闭，改为“新值立即完整 + 旧值背后拖尾”；克制强度仍可用。另发现旧的 `.assembling` 会把速度区淡到 0.15 透明度约 250ms，已对速度区取消。
