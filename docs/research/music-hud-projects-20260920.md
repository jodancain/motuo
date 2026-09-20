# 音乐游戏仪表与特效项目调研

核验日期：2026-09-20。范围：作者仓库、作者文档及原始许可证；未安装这些依赖、未跑其移动端基准。本记录区分可复用代码、视觉借鉴和 Motuo 的设计建议。本文建议不等于现有 App 已接入。

## 推荐组合

HTML 原型继续用独立 Canvas/SVG 呈现，先把“起步、巡航、转向、减速、停车”变成有层次的演出：后景透视光轨，中景多环仪表，前景事件卡与粒子。原生确认后优先试 **Inferno + Vortex + 自绘 Canvas 仪表**。这比直接把 WebGL 网页塞进核心骑行页更贴合现有 SwiftUI 工程。

最值得借鉴的是 **Arwes 的面板编排、Hyperspeed 的纵深光轨、audioMotion 的环形频谱**。最适合直接进入原生技术验证的是 **Inferno 与 Vortex**。下面的选型和适配判断是针对 Motuo 的工程建议，不是原作者的性能保证。

## 七个具体项目

| 项目与官方入口 | 能给仪表带来什么 | 已核实许可证 | 复用建议与 iOS 边界 |
|---|---|---|---|
| **[Inferno](https://github.com/twostraws/Inferno)** | `circleWave` 做起步冲击环；`lightGrid` 做电路流光；`shimmer` 做章节扫光；`colorPlanes` 做短暂色散 | [MIT，含原 shader 作者归属](https://github.com/twostraws/Inferno/blob/main/LICENSE) | **原生优先**。可选取 `.metal` 文件及对应调用，不必搬入演示工程。SwiftUI shader 示例要求 iOS 17+，符合 Motuo iOS 18 基线；包清单没有 watchOS，不能把 iPhone 效果直接承诺给 Watch。 |
| **[Vortex](https://github.com/twostraws/Vortex)** | 起步碎光、转向侧向尾迹、节拍散射、停车收束、结算星屑；支持按事件触发 burst 和吸引点 | [MIT](https://github.com/twostraws/Vortex/blob/main/LICENSE) | **原生粒子优先**。Swift Package / SwiftUI，可用自定义形状做粒子；[Package.swift](https://github.com/twostraws/Vortex/blob/main/Package.swift) 包含 iOS 与 watchOS。平台支持不代表真表可持续高帧率，Watch 仍以简化卡片和短反馈验收。 |
| **[tsParticles](https://github.com/tsparticles/tsparticles)** / [作者演示](https://particles.js.org/) | 节拍粒子、烟花式结算、流星、边缘发射器、带方向的光屑 | [MIT](https://github.com/tsparticles/tsparticles/blob/main/LICENSE) | **HTML 可复用**。按需加载引擎与插件，控制粒子数量；不必导入整个 all bundle。它是浏览器 JS 方案，SwiftUI 不能直接 import，原生优先重建同类效果或换 Vortex。 |
| **[Butterchurn](https://github.com/jberg/butterchurn)** / [作者演示](https://butterchurnviz.com/) | MilkDrop 式流体、镜像、隧道、音频反馈纹理；适合音乐封面背景或停驻“音乐空间” | [引擎 MIT](https://github.com/jberg/butterchurn/blob/master/LICENSE)；[官方预设包 MIT](https://github.com/jberg/butterchurn-presets/blob/master/LICENSE) | **演示/停驻模式候选**。需要 WebGL 2 与可连接的 Web Audio 音源；可混合预设转场。不是 SwiftUI 包。移植 Metal 或 WKWebView 集成均需另外做生命周期、热量和音频链路测试；不作为常驻全屏核心仪表首选。 |
| **[Arwes](https://github.com/arwes/arwes)** / [Frames 文档](https://next.arwes.dev/docs/develop/fundamentals/frames) | HUD 边框逐段绘制、卡片错峰展开、文字渐显、面板拆装、短提示声，最适合让“各种东西出现”有顺序 | [MIT](https://github.com/arwes/arwes/blob/next/LICENSE) | **视觉/状态编排借鉴**。作者仓库当前明确说明已停止维护；React 层针对 React 18，并有 Strict Mode 等限制。无需给现有单文件 HTML 或 SwiftUI 引入整个旧框架；可采用其分层、进场时序，用自绘 SVG/SwiftUI 实现。 |
| **[React Bits / Hyperspeed](https://reactbits.dev/backgrounds/hyperspeed)** / [源码](https://github.com/DavidHDev/react-bits/blob/main/src/content/Backgrounds/Hyperspeed/Hyperspeed.jsx) | 霓虹道路纵深、穿梭光轨、起步视野展开；适合运动模式的抽象节拍通道 | [MIT + Commons Clause](https://github.com/DavidHDev/react-bits/blob/main/LICENSE.md)，**不是纯 MIT** | **视觉借鉴优先**。源码依赖 React、Three.js、postprocessing，包含 bloom 等处理。许可允许作为应用/网站/产品组成部分，但限制组件自身或移植组件包再分发。保持自绘光轨可避免把大套 WebGL 后处理带入原型；原生须重建，不能直接复制 JSX。 |
| **[audioMotion-analyzer](https://github.com/hvianna/audioMotion-analyzer)** / [作者演示](https://audiomotion.dev/demo/) | 环形频谱、镜像频带、峰值保持、LED 柱、频段能量驱动外圈，比随机跳动更有音乐感 | [AGPL-3.0-or-later](https://github.com/hvianna/audioMotion-analyzer/blob/master/LICENSE)（README 明示 or later） | **作为视觉与分析参照**。基于 Web Audio + Canvas，支持频段能量接口；不是宽松许可组件，不直接混入当前发布链路。若以后使用其代码，先明确 Motuo 对应代码的分发/开源安排。独立实现自有音源 FFT 渲染是另一路径。 |

## 对 Motuo 的具体落点

下面是自有设计映射，不是复制某个项目的成品仪表：

| 层级 | 日常模式 | 运动模式 |
|---|---|---|
| 速度核心 | 大字速度，外围音乐呼吸环；速度来源始终可识别 | 同一速度核心，增加反向旋转分段环、跟拍刻度、空间光轨；数值区保持清晰 |
| 音乐 | 唱片、可用音源的真实频谱、低频/中频/高频层次 | 低频驱动圆环扩张，中频驱动边缘条，高频驱动细小粒子；仅作为视听演出 |
| 事件登场 | 小型状态卡，轻量起步展开 | 起步：面板解锁＋向外冲击环；转向：同侧光带聚拢；减速：光轨缩短＋收束；停车：背景沉降 |
| 配件面板 | 已接入设备、剩余电量等真实可用信息 | 同一事实层，允许面板动态装配；没有胎压/转速/挡位/油门信号的面板显示未连接或未知 |
| 结算 | 行程卡与音乐章节 | 收束粒子、章节展开、路线回放入口与摘要；不伪造驾驶分数 |

事件触发应去重、冷却并设有效期，多个状态同时发生时给主要事件优先级。背景、粒子、短事件卡的动画周期各不相同，避免整屏所有元素同时闪烁。真实骑行的动效强度需要真机确认；“效果更多”可以通过空间层次与事件变化实现，不能用一张静态截图代表动画已验收。

## 音乐与车辆数据的实现边界

- 音乐可视化库处理的是它实际拿到的音频。Butterchurn 官方示例要求连接 `audioNode`；接入这个库本身不会提供 Apple Music 流的原始音频或节拍数据权限。当前合成节拍能做真实同源联动，MusicKit 曲目能否给出可分析数据仍要按官方可用接口验证，不能把估算频谱标成实测。无分析数据时使用明确标注的氛围动画。
- 车辆状态与油门开度分开。GPS/IMU 可以支持“起步、加速、匀速、减速、转向”等运动状态估计；匀速不等于小油门。没有可信油门/ECU 信号时开度保持未知，演示里的“匀速＋全油门”只用于说明两者独立。
- 任何光环、粒子密度、动画强度都不能冒充 RPM、发动机功率、真实倾角或已验证驾驶能力。演示状态和真实记录继续分开。
- 前端依赖一旦实际引入，要固定版本/提交、保留对应许可证及作者归属；本次只形成调研与视觉方向，尚未宣称安装、移植或性能验收。

## 下一步验证重点

1. 原型先验证面板进场、节拍层次、事件切换及横竖屏，不更改当前原生数据链路。
2. 原生只做 Inferno 的一个环形/光流 shader 与 Vortex 的一个受控 emitter，和无特效仪表比较帧率、功耗和温度；达到目标再叠加。
3. 保持一个动画时钟和有限粒子预算；暂停/不可见/减少动态效果时降载。高频传感器记录不依赖渲染帧率。
