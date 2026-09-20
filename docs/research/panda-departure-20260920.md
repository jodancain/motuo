# 熊猫配色与连续出发动画

2026-09-20。用户要求开始骑行动画更自然，车辆改成黑白熊猫配色。本轮范围是本地 HTML 原型的待机、出发与车库展示；原生 iOS／watchOS 工程及 TestFlight 未随此记录变更。

## 已核对的参考

- [Google Codelabs：Material Motion for Flutter](https://codelabs.developers.google.com/codelabs/material-motion-flutter)：本轮已打开正文。Container Transform 用连续变换连接有关联的容器；Shared Axis 用共同空间方向表达页面之间的关系。借鉴的是可追踪的空间连续性：让用户看到车辆与仪表如何交接，而不是在两个完整画面之间突然切换。原型不引入 Flutter，也不复制教程代码。
- [Paul Lewis：FLIP Your Animations](https://aerotwist.com/blog/flip-your-animations/)：本轮已打开原文。先测量布局前后位置，再以反向位移／缩放暂时保持旧视觉位置，最后播放到新位置；尽量使用 transform 和 opacity，减少逐帧布局工作。原文同时提醒动画互相覆盖和内容缩放失真。该文发表于 2015 年，采用其方法思路，不据旧文中的浏览器兼容性描述作当前能力承诺。

以上是原始资料中的设计与实现原则。下面的场景映射、配色和取消策略是 Motuo 的项目决策，不是资料原作者对本项目的建议。

## 当前问题与代码证据

本轮开始时核对 `index.html`、`vehicle-stage.css`、`motion-ui.css` 和 `drive-ui.css`，发现两处不连续来源：

1. `start()` 先加入 `immersive`，随后骑行状态令 `renderVehicle()` 移除 `vehicle-rest`。车体和表卡所处布局先发生变化，出发动画再开始，视觉起点已经不是用户点击前的位置。需要在布局切换前保留起点。
2. `start()` 同时调用 `beginDeparture()` 和 `sceneIntro()`。`departing` 与 `assembling` 都为仪表相关元素设置动画；前者结束、类名移除后，仍存在的旧动画规则可能重新显现，造成第二段入场。需要为开始骑行保留单一转场控制入口。

以上属于代码诊断；修复后是否无跳位、无二次播放，仍以实际浏览器检查为准。

## 实施决策

| 部分 | 处理方式 | 目的 |
| --- | --- | --- |
| 车辆图层 | 使用共享展示层；在沉浸布局切换前记录车辆位置，切换后通过 FLIP 连续接续 | 车辆从点击前的位置出发，不先跳到另一个位置 |
| 速度与表卡 | 分别记录和过渡各自的布局位置，避免把整组文字当作一张图片大幅缩放 | 保留阅读锚点，减少文字拉伸和整屏滑动 |
| 车辆与 HUD 交接 | 车辆退场与仪表出现有短暂重叠 | 避免先空屏、再重新组装仪表 |
| 动画归属 | 开始骑行取消调用 `sceneIntro()`；出发转场独立清理临时类名与样式 | 一次操作只播放一次，结束后不露出旧入场动画 |
| 中断处理 | 减少动态、窗口尺寸变化、页面隐藏和暂停时取消出发过渡，并落到当前状态的稳定布局 | 避免旧坐标、残留透明度或回到页面后补播 |
| 骑行数据 | 转场只控制视觉，不改速度、加速度、声音来源和会话数据 | 装饰运动与测量／推断保持分离 |

实际实现：表卡780ms、速度900ms、车辆1150ms，同时启动并重叠；车辆在旧坐标保持片刻后轻移24px、上移16px、等比缩至0.98并淡出。速度使用独立包装层，避免覆盖原有定位transform。动画由Web Animations统一管理，取消和旧回调隔离，完成后重新缓存Canvas保护区域。

## 熊猫车辆资产

- 原资产：`prototypes/motuo-v2/assets/gsx250r-studio-v1.png`，保留作原始版本。
- 已使用内置 imagegen 基于该资产编辑：珍珠白大面积整流罩配黑色护板、下包围及结构件，维持车辆主体、视角和展示用途。
- 输出资产：[`prototypes/motuo-v2/assets/gsx250r-panda-v1.png`](../../prototypes/motuo-v2/assets/gsx250r-panda-v1.png)。PNG 1536×1024、RGBA含透明通道；已在车库与待机检查黑白配色及整车裁切。
- 车库与待机展示共用同一配色资产，使车辆身份连续。生成图片用于界面表现，不作为车辆实拍、真实改装配置、零件尺寸或维修依据。

## 验收与记录边界

- 浏览器检查普通开始、动效预演、日常／运动模式及横竖屏：点击前后的车辆位置接续，表卡移动可追踪，车辆与 HUD 没有空白断层。
- 出发结束后继续观察，确认 `assembling` 不再补播；连续开始／暂停／继续、结束后再次开始不残留动画状态。
- 出发过程中改变尺寸、切后台、暂停和启用减少动态，确认中断后布局和按钮可用。
- 图像检查黑白配色、裁切和边缘，确认车库与待机引用一致；不把图像生成成功等同于视觉验收。
- 最终实际时长、浏览器结果及未验证事项写入原型 README 和项目状态。HTML 检查不代表原生动画表现、真机帧率或实车验收。

## 实际验证

87项本地测试全部通过，新增7项转场控制器几何／生命周期测试。浏览器检查横竖屏车辆与HUD重叠、结束无二次动画、暂停／旋转清理、减少动态跳过、车库共用图，具体读回见 [原型README](../../prototypes/motuo-v2/README.md#最新反馈熊猫配色与连续出发)。没有原生或真实手机帧率结论。

## 内置 imagegen 提示词

参考输入：`prototypes/motuo-v2/assets/gsx250r-studio-v1.png`。只以此已显示的本地原图做编辑，保留原件。

```text
Edit the supplied Motuo motorcycle render. Change ONLY its paint scheme to a premium black-and-white PANDA colorway. Replace every saturated blue painted body panel (fuel tank, front nose, large upper and lower side fairings, front fender and tail painted trims) with glossy pearl white. Keep the existing graphite/black inserts, seat, chassis, engine, tires, black wheels, mirrors and windscreen structure black or their original neutral material. Wheel trim is subtle silver/white, no blue stripes. Clear graphic separation between porcelain/pearl white bodywork and deep gloss/satin black inserts, approximately 60 percent white visible body panels, 40 percent black. Remove blue paint hue entirely; extremely subtle neutral cool studio edge reflections are okay, but the motorcycle must unmistakably read BLACK AND WHITE, not blue. Preserve the EXACT SAME motorcycle silhouette, component positions, 3/4 front-side view with front wheel on the right, camera angle, 3:2 composition, scale and padding, both wheels intact, all details and realistic materials. Maintain transparent alpha background. No ground plane, cast shadow or solid background. No UI, labels, logos, text, people, decals, panda drawings, or added parts. This is the same visual concept vehicle recolored, not a technical diagram.
```
