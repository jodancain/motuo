# Motuo 实施状态

更新：2026-09-20。源码、模拟器、本机真实 HTTP、NAS、公网、Apple 分发和实车是独立验收层。已形成完整本机工程与主要交互；**0.1.0 (1) 已分发至TestFlight内部组，本人可接受邀请安装；实际iPhone/Watch安装和实车内测尚未验收。**

## 9/20 反馈后的本轮交付

独立交互原型：[`prototypes/motuo-v2/index.html`](../prototypes/motuo-v2/index.html)。用户本轮进一步明确：核心是玩乐，简单速度环仍不够，需要更丰富的仪表、不断出现的元素和多种特效。日常模式保留仪表＋音乐，运动模式无地图。最新 HTML 增加多层 HUD、霓虹赛道/频谱星环/极光矩阵三种特效、状态弹条和面板装配入场、最近20秒模拟速度曲线与事件历史，以及明确标为未连接的 Watch/HUD/TPMS 面板。点击播放后，频谱与波形来自本页 Web Audio 原创合成音频的实时分析；这不是对 Apple Music 等第三方歌曲的音频分析。启动普通界面，开始后页面沉浸，暂停保持，结束复盘并恢复导航。

本轮完成13个仪表/音乐视觉项目的官方资料与许可证调研，见 [赛车/摩托仪表](research/dashboard-projects-20260920.md) 和 [音乐HUD/特效](research/music-hud-projects-20260920.md)。当前特效独立实现，没有引入这些项目的代码或新增第三方依赖；“资料可见/免费”不等于开源授权。**本轮本机浏览器回归已完成**：1280×800三主题与合成音频实时FFT、844×390和375×667按钮/布局、GPS缺测、暂停冻结、结束与空态恢复、减少动态和日常地图均通过；JS语法、控制台和diff检查通过。具体读回证据见 [本轮浏览器回归](../prototypes/motuo-v2/README.md#本轮浏览器回归)。前轮检查仍作为历史基线保留；本机回归不代表手机、实车或原生性能验收，原生系统栏隐藏仍须真机检查。

新增起步、加速、巡航、右转、减速停稳模拟，以及“匀速·全油门”示例；该示例明确标为模拟 TPS 100%，默认油门仍未知。稳定速度不意味着小油门或低负载，手机运动信号不得被当成油门、转速或发动机负载。见 [RIDE_STATES](RIDE_STATES.md)。速度、车辆状态、设备和示意路线仍为演示，不依赖 NAS。

用户已批准“先看 HTML 效果再改 App”的顺序：本轮没有修改 SwiftUI，也未发布新 TestFlight，等待原型反馈后再落地原生。导航方向改为全开源：MapLibre + 区域 OSM/Martin + Valhalla motorcycle + Ferrostar，中文地点搜索复用 PostgreSQL；旧的高德集成计划被替代。**当前 0.1.0 (1) 仍是外部高德版本，开源地图/算路服务尚未实现或上线。** 首个实测地区仍待确认，不能承诺中国摩托禁限行覆盖。

## 能力与实际证据

| 项目 | 实现及已取得的证据 | 尚缺的验收 |
|---|---|---|
| iPhone / Watch 原生工程 | iOS 18+、watchOS 11+；完整嵌入 Watch 的签名模拟器工程可编译、安装和启动；9/20最终e轮 **31单测＋2 UI，零失败** | 真实 iPhone / Watch 安装、权限、功耗和后台表现 |
| HUD 与交互 | 横竖屏仪表、车库、出发/暂停/继续/结束、回放、复盘、设置；演示数据明确标注 | 60分钟实车并行导航/音乐/记录；热状态与帧率实测 |
| 离线记录 | SwiftData + 串行 JSONL 分块、SHA-256、原始采样时间、传感器流/记录片段、崩溃尾部恢复；磁盘写入失败保留恢复入口、原manifest SHA检查、强杀/竖屏恢复UI通过 | 隧道、拒绝定位、锁屏、来电、低存储及后台 IMU 连续性真机验收 |
| 车辆感知 | 有效速度、静止/移动、加减速、左右转向、疑似换挡；未知值保留未知 | 事件实车真值对照；当前无 N/1–6 猜测、无精确车辆倾角承诺 |
| 个人学习 | 同校准实测、人工原时间窗口、遥测 SHA 验证、整次骑行 holdout、候选显式启用/回退；7项学习测试通过 | 无实车训练样本或识别准确率结论 |
| Apple Music | MusicKit 授权、订阅检查、搜索、歌单、播放控制、音频中断处理；9/20 App ID MusicKit 服务已启用并回读 | 订阅账号与真机实际播放/来电/耳机断开 |
| 导航 | 已发布 0.1.0 (1) 仍为地点搜索和外部高德交接；新 HTML 为示意地图 | 原型反馈后用 MapLibre/OSM/Martin/Valhalla/Ferrostar 替换；首区数据、中文搜索、真实摩托路线/偏航与禁限行覆盖待验 |
| Watch | 状态/摘要、可达与活动条件、触觉去重/过期/冷却、事件开关；Watch 模拟器已启动 | 真表垂腕/锁屏/断连/重连及实际触觉；不承诺持续后台振动 |
| 配件 | BLE GATT、Wi-Fi/Bonjour、状态协议、选择连接；本机 HUD fixture 收到实际 App 帧，暂停省略速度，断开状态回显 | 实际 HUD、胎压、外置 IMU、转速/挡位传感器逐个驱动与真硬件验收 |
| Fastify / PostgreSQL | 9/20 类型检查、真实 PostgreSQL/HTTP/文件系统测试 **36/36，无 skip**，构建通过 | 当前 NAS 新镜像切换后的同链路复验 |
| 手册抽取与受控重试 | 9/20 worker 新增17项重试测试后 **38/38，无 skip**，含真实 PostgreSQL/OCR；重试经独立代码审查；原件616页重建、41/41出处检查通过 | 重试工具尚未部署/在 NAS 执行；正式导入失败恢复、OCR/图形低质页原页复核仍待完成 |
| 手册引用问答 | 9/14本机34块 HTTP 原件上传、616页入库；41/41证据通过、41/41引用完整；严格页号40/41＋1题复核替代原文；4边界与3自然胎压问法通过 | NAS 同题复测；这不是收费模型回答或实车维修效果验证 |
| AI 骑后总结 | 本地摘要立即可用、报告绑定数据版本、网关异步总结/回退；9/14 NAS 合成报告与 provider canary 成功 | 9/20重新验证当前 AI 可用性和正式数据链路 |

## 发布门禁与当前阻塞

1. **NAS 离线与手册失败。** 9/20初次读取 a4 API/PG 健康、a5镜像已构建；原手册记录失败，已提交175页，错误 `PDF_EXTRACTION_FAILED:PdfminerException`。此后 Mac/上海到 NAS 连接超时，Tailscale peer `Online=false`。本轮没有切换镜像、删 owner 或替换原件。本机已保留被解析器包装的超时原因，并为真正解析失败提供逐页 OCR/需复核降级；NAS根因尚未复现，不能把本机通过写成 NAS ready。修复必须使用新release部署。14:26–14:29 CST 再次只读核验：Tailscale LastSeen 为 `2026-09-20T03:00:00.1Z`；直连、上海跳板与已知 LAN 22/5001 均超时。现有项目资料及 Synology Drive 连接元数据未找到 QuickConnect/DDNS 替代入口；等待用户提供另一个远程网址或恢复联网，不能据此判断 NAS 关机。

2. **公网 DNS/TLS。** 14:27 CST 从上海查询公共 DNS `119.29.29.29`，`motuo.yundongyl.cn` 仍为 NXDOMAIN；现有 DNS 凭据无该域操作权限。上海 HTTP Host 返回 `503 https_pending`，TLS还未签发和验收；NAS离线也会阻断后续源站核验。
3. **Apple 分发已完成，真机安装待验。** 用户9/20完成网页登录，已创建 App Store Connect App `6814048230`；独立 App ID/描述文件存在，MusicKit已启用，iPhone profile重建为ACTIVE，签名Keychain已解锁。`0.1.0 (1)` iPhone＋Watch签名IPA已生成并严格校验，2026-09-20 11:37:33 Apple `UPLOAD SUCCEEDED`、无错误；Delivery UUID `4dac7de5-ebd3-4398-bb4c-84394ccf9187`。Apple回读 `processingState=VALID`、`internalBuildState=IN_BETA_TESTING`；内部 `Motuo Internal` 组1构建、1名本人测试员，简体中文WhatToTest已保存并回读，网页显示2026年9月20日已邀请。本人可接受邀请安装；实际手机/手表安装仍待验收。最新详细状态由 [APPLE_RELEASE](APPLE_RELEASE.md) 维护。
4. **原型反馈、地图与硬件。** HTML 原型确认后才修改 SwiftUI 和发新版 TestFlight；全开源地图真实服务及地区数据尚未接入。MusicKit真机授权播放、真实Watch触觉、实际配件、实车60分钟和独立倾角参考均未通过；倾角数值继续关闭。

## 可复跑证据

- 9/20 iOS完整测试：`/tmp/motuo-final-tests-20260920e.xcresult`，31单元＋2 UI，零失败，11:33:06完成。涵盖演示流程、学习、强杀/磁盘失败恢复、原manifest SHA拒绝损坏、异步身份隔离与竖屏固定底栏。此前d轮竖屏恢复失败保留为失败证据，未计入通过。临时目录可能被清理，命令见 [ios/README](../ios/README.md)。
- 9/20签名IPA：2158486字节，SHA-256 `ec7875ae8254a01d4306416105dec61e4ac060b63dc6a43a3a90786087a55c16`；Apple处理VALID、内部测试IN_BETA_TESTING及本人邀请已分别回读；实际设备安装不由这些平台回执替代。
- 9/20 server：`npm run check`、`npm run test:integration`、`npm run build`，36项全部通过。
- 9/20 worker：原21项通过后，受控重试新增17项，合计38项全部通过。`python -m motuo_worker.retry` 默认 dry-run，显式 `--apply` 仅重排通过 owner/源文件SHA/连续已提交页校验的 failed 原任务；重复、并发和删除互斥已测试，尚未部署到 NAS。原手册抽取证据：`/tmp/motuo-manual-reference-20260920.jsonl`，616页，126.705秒；与同锁版依赖修复前抽取字节相同，SHA-256 `9db0f06e91fac68745abe5b3634ee7d6a2e76a32410c1c50c3223e60ed831242`。物理176页本机仍为native，无warning，不能由此判断NAS失败原因。
- 本机手册 HTTP 回执：`.private/manual-e2e-20260914T160920-bf22d7/api-acceptance-06.json`；摘要与逐题结果：[manual-api-acceptance](manual-api-acceptance.md)。私有状态含设备令牌，禁止输出其内容。
- NAS 9/14历史smoke/canary与9/20恢复检查点：[nas-acceptance](nas-acceptance.md)；公开路由：[edge-acceptance](edge-acceptance.md)。备份/回滚脚本已交付，但包含完整616页的真实恢复/回滚尚未执行。
- 真机验收模板：[PHYSICAL_ACCEPTANCE](PHYSICAL_ACCEPTANCE.md)。当前没有真实骑行通过记录。

## 保留的产品约束

实测、推断、人工确认和模拟数据分开；AI不改原始测量，也不把自己的输出作为训练真值。报告迟到只能绑定原数据版本。手册不能改变权限或执行工具。凭据仅放私有配置/Keychain，原件与轨迹不入仓库。Lottie依赖和Metal Toolchain尚未就绪，当前视觉使用Canvas/SwiftUI，不能宣称已接入这两个运行时效果。
