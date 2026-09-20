# 车辆待机、声浪趋势与起步转场

后续更新：黑白熊猫配色与连续转场已替换本页初版蓝车/1.5秒方案，见 [最新记录](../research/panda-departure-20260920.md)。以下保留初版设计与来源，信号契约仍适用。

2026-09-20。本轮依据用户反馈调整本地 HTML 原型：取消数字 RPM，GPS 失锁时展示有条件的短时 IMU 速度估计，静止时展示车辆精细渲染图，开始骑行时完成车辆到仪表的转场。范围为 `prototypes/motuo-v2`；不表示原生 App 或实车能力已经验收。

## 声浪显示契约

- 原数字转速表改为没有 RPM 数字、转速刻度或单位的声浪趋势。相对强弱驱动光带，文本使用“待采声”“轻声”“抬升”“回落”“平稳”。
- 输入来自有效的麦克风采样或用户明确开启的声浪演示。音乐播放不进入声浪分析链，装饰波浪可独立运动。
- 当前算法对声音强弱与频谱幅值做平滑并提取变化趋势，尚不能区分发动机、风噪、其他车辆或环境声，也不估计发动机 RPM、油门开度、负载或挡位。“平稳”只描述声学变化，不表示低转速或小油门。
- 关闭输入、无效输入和暂停时，声浪模块不保留旧值作为当前采样；模拟输入保持来源标识。相关实现见 [`sound-trend.js`](../../prototypes/motuo-v2/sound-trend.js)。

## GPS 失锁后的速度契约

[`inertial-speed.js`](../../prototypes/motuo-v2/inertial-speed.js) 只承担一维速度的短时积分，输入时间单位为单调秒，GPS 速度及精度为 m/s，IMU 前向加速度为 m/s²。

1. 必须有先前有效 GPS 速度锚点。锚点帧及之后的 IMU 必须连续有效，并已完成去重力、手机安装方向校准和车辆前向投影；没有锚点不凭空给出初始速度。
2. GPS 失锁后按实际时间间隔对前后两个 IMU 加速度样本做梯形积分，输出估计年龄，界面显示 `≈`、惯导估计来源和误差预算。当前输入为演示数据时同时标注 `DEMO`。
3. 默认从最后 GPS 锚点起最多 15 秒，单次 IMU 间隔最多 0.5 秒；误差预算随积分过程增长，默认上限 25 km/h。负速度限制为零，明显超出配置速度范围则使估计无效。
4. 缺测、未校准、超时、时间回退或误差预算过大时停止提供当前速度，保留失效原因并等待新 GPS；不能将过期数字继续当作实时速度。新 GPS 到达时直接切回其原始速度并重建锚点。
5. 暂停、后台中断和重新开始需要清理旧积分状态。低振动或零加速度不能单独证明静止；只有外部明确确认的静止信息才可触发零速修正，且不延长原 GPS 锚点的有效期。

误差模型的参数是原型中的保守预算示例，不是经过实车标定的统计置信区间。界面中的误差和可信程度不可用于声称固定定位精度、长期惯导精度或隧道通过能力。

本轮 HTML 向积分器传入的是**模拟 GPS 和声明已校准的模拟 IMU**，用于检查速度保持、积分、失效及恢复的完整交互。浏览器原型没有完成原生 GPS、CoreMotion、安装校准或去重力采集，不能据此认定真实手机已经实现惯导测速。估计结果不生成地图坐标，不给路线或里程补点。

## 待机车辆与开始转场

- 待机仪表和车库页面共用 [`assets/gsx250r-studio-v1.png`](../../prototypes/motuo-v2/assets/gsx250r-studio-v1.png)，保持同一辆车的视觉连续性；渲染图表示车辆外观概念，不表示实时姿态或已验证配置。
- 点击“开始骑行”后执行约 1.5 秒的车辆到骑行仪表转场。转场是视觉层，不应中断或伪造采样时间。
- 开启“减少动态效果”时跳过这段转场。暂停、结束和再次开始应能取消上一段转场，避免旧计时器影响当前界面。

## 图像资产与生成来源

| 项目 | 记录 |
| --- | --- |
| 输出资产 | `prototypes/motuo-v2/assets/gsx250r-studio-v1.png` |
| 文件格式 | PNG，1536 × 1024，RGBA |
| 生成方式 | 内置 imagegen，以现有车库截图为视觉参考生成 |
| 参考资产 | `ios/Screenshots/garage-iceblue.png`，1206 × 2622 |
| 用途 | HTML 待机车辆与车库共用的视觉概念图 |

生成提示摘要：蓝黑配色的 Suzuki GSX250R，以三分之四前侧视角展示，前轮朝向画面右侧；加强车漆、轮胎、金属等材质细节，冰蓝色前缘光配合紫色后缘光；要求透明背景，不包含 UI 或文字。

<details>
<summary>内置 imagegen 实际提示词</summary>

```text
Use case: product-mockup. Create one premium, finely detailed 3D product-render asset for the Motuo motorcycle app. Reference image is the app's current garage: its selected vehicle is Suzuki GSX250R, and the icy blue outline drawing is only an identity and palette cue. Do not reproduce any UI, text, meters, screenshot frame or line-art style. Render a believable fully-faired Suzuki GSX250R sport motorcycle alone, metallic graphite and deep Suzuki blue bodywork, restrained icy cyan reflections, realistic tires with tread, visible detailed wheel spokes and brake discs, engine casing, chain and exhaust, precise glass windscreen and mirrors. Three-quarter front-side view with the front wheel on the right, both wheels complete and all bodywork visible, centered with comfortable 12% padding. Realistic premium studio automotive visualization, exquisite materials and clean silhouette, low camera, 85mm product photography feeling. White headlight subtly illuminated, delicate violet rim light on rear, cool cyan rim light on front. Transparent background with actual alpha, no backdrop, no ground plane or cast shadow (the app draws its own floor), no rider or people, no text overlay, no watermark, no added logos, no impossible futuristic modifications. Wide 3:2 composition. This is a visual concept asset, not a technical vehicle-configuration diagram.
```

</details>

上述提示记录的是生成要求，**不代表车型忠实度校验结果**。资产为 AI 视觉概念，并非官方车型渲染、实车照片、精确年款结构图或维修依据；年份、ABS、灯组、制动和改装等配置仍需与用户实车独立核对。原参考截图和手册不因本次图像生成而成为可改写的车辆事实。

## 验证边界

- 积分器有 16 项本地合约测试，覆盖真实时间间隔、锚点、连续性、边界、误差增长、失效和 GPS 恢复；这些结果属于算法与输入契约验证。
- 声浪、待机及转场的浏览器可视化检查和完整测试结果由本轮交付记录统一记录。
- 真实麦克风噪声环境、发动机区分、手机安装校准、隧道积分误差与原生动态性能需要单独验收。
