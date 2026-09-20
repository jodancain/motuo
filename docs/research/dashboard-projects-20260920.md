# 赛车仪表、摩托伴侣与游戏 HUD 项目调研

核验日期：2026-09-20。范围是作者 GitHub、README、源码目录与实际许可证；搜索结果只用于发现。以下是模块和交互研究，尚未把这些项目代码引入 Motuo，也未实车验证其能力。

结论：**irDashies 最适合参考“丰富仪表＋按事件出现的组件”；iKawa 最能说明真实油门、发动机与手机运动数据为何要分开；SteedPilot 适合后续 HUD 配件协议。** 没有找到一个同时满足 SwiftUI、真实摩托感知、音乐游戏特效且可直接套用的完整底座。

## 六个主要候选

| 项目 | 作者资料确认的实际范围 | Motuo 可借鉴的部分 | 许可证与采用判断 |
|---|---|---|---|
| [irDashies](https://github.com/tariknz/irdashies) | React/Electron 的 iRacing 遥测叠加界面；有输入轨迹、分段转速灯、LED 旗帜、按会话显示组件、布局配置 | LED 事件卡、多通道短时波形、发光/脉冲/边框三种状态反馈；日常/运动使用不同组件组合 | [MIT](https://github.com/tariknz/irdashies/blob/main/LICENSE)。可作为优先模块参考；真实数据来自游戏 SDK，不能直接给摩托提供油门或雷达能力 |
| [ShfonicDash](https://github.com/shfonic/ShfonicDash) | Pygame/Raspberry Pi 赛车仪表；UDP 接收、不同车型/会话布局、回放和会话复盘；各游戏字段验证程度不同 | 主仪表＋侧边小表、状态颜色、骑后章节和片段回放；设备端与复盘共用数据模型 | [GPL-3.0](https://github.com/shfonic/ShfonicDash/blob/main/LICENSE)。以当前许可证为准，不能沿用旧帖子里 MIT 的说法；先研究布局与数据边界，不直接混入 Motuo 源码 |
| [iKawa](https://github.com/gabrielerandazzo/iKawa) | ESP32 辅助仪表，经 K-Line 读取 Kawasaki ECU；通过 ANCS/AMS 接 iPhone 通知与媒体。作者已验证车型是 2006 ER-6n | 发动机/车辆真值与手机状态分层；未来配件上显示音乐并控歌 | [MIT](https://github.com/gabrielerandazzo/iKawa/blob/main/LICENSE)。这是配件固件，不是一个可直接换皮的 iOS App；不能由 Kawasaki 验证推导 GSX250R 兼容 |
| [SteedPilot](https://github.com/deanthecoder/SteedPilot) | iPhone＋ESP32 圆形导航 HUD 原型；有 SwiftUI 发送器、状态/增量/心跳协议、模拟夹具 | 外设重连/过期处理、事件回放、圆环进度；已在原计划选为配件参考 | [MIT](https://github.com/deanthecoder/SteedPilot/blob/main/LICENSE)。适合小型 HUD，视觉方向偏简洁，不能单靠它满足本轮“更多特效” |
| [MOTO-HUB](https://github.com/vincenzobpt/MOTO-HUB) | 当前公开 CORE 管理 Android 投屏、EasyConn/Carbit 连接与车把按钮。丰富骑行仪表已拆到 ADV-SOLO；iOS 有另一个发布仓库 | 多面板轮播、车把切模式、手机和外接屏分工，作为产品交互对照 | CORE 是 [AGPL-3.0](https://github.com/vincenzobpt/MOTO-HUB/blob/main/LICENSE)；[iOS 仓库](https://github.com/vincenzobpt/MOTO-HUB-IOS-releases)明确仅发布 IPA、没有源码。不能把整套骑行仪表和 iOS 都列为已获得的开源模块 |
| [Lovely Dashboard](https://github.com/Lovely-Sim-Racing/lovely-dashboard) | SimHub 仪表/叠加界面，有完整插件生态和高密度赛车呈现 | 只观察信息密度、阶段性提示与主次层级，自己设计 Motuo 造型 | README 明确 UI 在商业/宣传材料中的使用需要许可，并指向 [Software License](https://lsr.gg/license)。此次许可页加载失败，仓库根无开源 LICENSE；不可因“免费/GitHub 可见”当成可复制开源皮肤 |

## 可以直接定位的研究入口

- irDashies：[`Flag`](https://github.com/tariknz/irdashies/tree/main/src/frontend/components/Flag)、[`InputTrace`](https://github.com/tariknz/irdashies/tree/main/src/frontend/components/Input/InputTrace)、[`rendererDataVisibility.ts`](https://github.com/tariknz/irdashies/blob/main/src/app/rendererDataVisibility.ts)。组件目录已核实存在；尚未逐行审计或执行上游代码。
- iKawa：[`AncsAmsClient.cpp`](https://github.com/gabrielerandazzo/iKawa/blob/main/ikawa/AncsAmsClient.cpp)，作为媒体配件路线研究入口。
- SteedPilot：[`protocol.md`](https://github.com/deanthecoder/SteedPilot/blob/main/docs/protocol.md) 和 [`fixtures`](https://github.com/deanthecoder/SteedPilot/tree/main/fixtures)，适合拆出可回放的事件协议研究。
- ShfonicDash：[`widgets`](https://github.com/shfonic/ShfonicDash/tree/main/src/dashboard/widgets) 与 [`telemetry_model.py`](https://github.com/shfonic/ShfonicDash/blob/main/src/core/telemetry_model.py)，适合研究仪表组件和数据契约。

另核查了 [OpenDash](https://github.com/openDsh/dash)：Qt/Linux 车机、OpenAuto、OBD-II/SocketCAN，GPL-3.0，偏车载信息娱乐系统，与本轮音乐游戏视觉距离较远，不选为主要底座。PiDash 一名对应多个不同项目，未找到比上述候选更适合且身份/许可都明确的实现，暂不推荐。

## 本轮原型设计建议（Motuo 自主设计，非上游能力声明）

“东西不断出现”可以来自事件编排，而不只是所有读数一直堆在一张表上。建议运动模式组合五层：

1. **空间层**：透视光轨、稀疏粒子、弧形扫描，烘托纵深；暂停时冻结行进感。
2. **速度核心**：多段外环、轨道节点、数字切换、环形频谱；速度数字和结束按钮保持固定位置。
3. **运动侧表**：加减速波形、转向方向/强度、最近数秒运动轨迹。用短时记录产生变化，不放假发动机转速。
4. **音乐层**：节拍灯带、音频频谱和当前曲目变化。原型合成音频能驱动真实频谱；真实音乐平台是否能提供音频分析需分别核验。
5. **事件层**：起步展开、稳定片段卡、转向侧翼、减速收束、里程章节。每个事件只短暂出现，设队列、去重、冷却，旧事件不补播。完整烟花/章节动画留在预览与结束状态。

日常模式保留仪表和音乐，可减少空间特效但保留卡片和音乐反馈；运动模式不显示地图。平稳片段的奖励来自平顺程度或持续记录，不用更快速度、更大倾斜作为分数条件。

## 传感器与玩法的映射

| 输入/状态 | 可用触发方式 | 不应作出的推断 |
|---|---|---|
| 起步 | 有效 GPS 速度从静止跨过阈值并持续，结合已校准 IMU 确认运动；保存置信度 | 不由这一次变化断言已挂 1 挡或离合完全结合 |
| 匀速 | 有效速度窗口内变化小 | 不等于小油门；上坡、逆风、负载下可以保持匀速同时大油门 |
| 油门 | 独立 ECU/TPS 或经验证的外设通道；字段应区分把手开度、节气门位置、目标扭矩 | 不把手机加速度直接换算成油门百分比；电子油门车型的把手与节气门也不自动等同 |
| 减速 | 速度下降＋运动信号支持 | 不自动说“捏了刹车”，发动机制动同样可能减速 |
| 转向 | 有效航向变化＋校准角速度；只呈现方向/强度 | 没有验证前不显示准确倾角；更不能推断轮胎抓地极限 |
| GPS 缺失 | 速度、轨迹停止推算并显示未知；音乐和纯装饰仍可继续 | 不靠动画节奏制造继续行驶的假里程 |

HTML 中可以有“匀速＋100% 油门”输入样本，但必须明确是演示外设真值；进入真实记录后，油门没有来源就显示未知。动画数据应带 `source`、`timestamp`、`validity`，与骑行原始测量分开保存。

## 采用顺序

先独立完成 HTML 的事件层与仪表组合，确认视觉；之后参考 MIT 项目的模块设计迁移到 SwiftUI Canvas/Metal。任何实际复制的文件都固定上游提交、保存许可证与来源，重新核验其依赖和素材条款。GPL/AGPL 或专有 UI 不因为“只是界面代码”就自动并入现有 App。当前没有为调研安装软件、授权账户或连接车辆。
