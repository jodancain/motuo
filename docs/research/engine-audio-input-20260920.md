# Motuo：外界声音驱动 HUD

核对日期：2026-09-20。本文是 HTML 原型与后续原生实现的输入契约、官方 API 依据及验收建议，不是实车识别精度报告。

用户最新方向：动效听手机麦克风接收到的外界声音，以发动机声浪为主要使用场景；音乐保留独立控歌用途，不驱动仪表。此前“让每一程，自带配乐”的大卡片只短暂出现，随后收起为轻量入口。

## 一、可交付的声音语义

| 显示内容 | 数据意义 | 不应声称 |
| --- | --- | --- |
| 麦克风·实时 | 已获授权、输入流存活、音频上下文正在运行 | 已确认声音来自发动机 |
| 输入强度 | PCM 样本的相对 RMS/峰值，适当平滑后驱动光效 | 经校准的环境声压 dB SPL、油门开度、发动机负载 |
| 低/中/高频能量 | 固定频段内的输入频谱能量；频段边界和真实采样率参与计算 | 低频必定是发动机，高频必定是风噪 |
| 声音起伏 | 一段时间内相对强度/频谱变化 | 已测得 RPM、换挡、起步或真实加速度 |
| 麦克风未启用/不可用 | 无当前有效输入；数值显示 `—`，音频反应归零 | 用随机或正弦波伪装正在接收声音 |
| 声浪演示（若保留） | 用户显式选择的模拟输入 | 实测发动机特征、可训练真值 |

手机周围还存在风、轮胎、其他车辆、说话与扬声器声音。仅有音量/FFT 的版本不具备声源分离能力，也不能从它们唯一推出油门、挡位或 RPM。以上是本项目对测量范围的工程判断，不能把漂亮的光环当成分类器。麦克风能听到外放音乐是物理混入，不等同于直接绑定音乐播放器的节拍。

建议将“起步/匀速/减速”与“声音增强/减弱”分为两条状态：前者来自运动观测或明确的原型演示，后者来自音频。匀速而声音很强是允许的组合。未来若训练发动机分类/RPM 模型，应增加不同手机、支架、风速、排气改装与外部转速真值测试集；没有独立验证前继续显示未知。

## 二、HTML 输入链路与权限

推荐链路为 `getUserMedia → MediaStreamAudioSourceNode → AnalyserNode → RMS/频段摘要 → Canvas/CSS`。分析节点输出可不连接扬声器，避免麦克风监听回放与啸叫；频谱与时域数据由浏览器本地取得。依据：[Web Audio 规范](https://www.w3.org/TR/webaudio/#AnalyserNode)、[Mozilla AnalyserNode](https://developer.mozilla.org/en-US/docs/Web/API/AnalyserNode)。

麦克风默认关闭，仅在用户点击“启用麦克风”后请求。检查 `isSecureContext`、`navigator.mediaDevices?.getUserMedia`、`AudioContext`；本机 localhost 预览与 HTTPS 是首选，手机访问普通 LAN HTTP 地址不能视为已经支持麦克风。权限请求可能被忽略而一直不返回，因此界面必须可以取消等待。错误应按拒绝、无设备、设备占用/故障分别提示，而非统一写“浏览器不支持”。依据：[getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)、[Media Capture and Streams 规范](https://www.w3.org/TR/mediacapture-streams/)。

可请求 `echoCancellation: false`、`noiseSuppression: false`、`autoGainControl: false` 的偏好，以减少语音处理对声浪的影响。使用非强制约束并查看 `track.getSettings()`，不要因为传入了偏好就声称取得了未经处理的原始麦克风信号。不要默认选择头盔/蓝牙麦克风，也不要在只拿到系统默认输入时把设备名硬写为“手机内置麦克风”。

实现建议：

- 初始 FFT 大小 2048 或 4096，UI 频谱可合并为 24–48 档；按真实 `sampleRate` 映射频率。
- 用时域浮点样本计算 RMS；相对电平可用 `20 * log10(max(rms, epsilon))`，但避免把这种数字幅度命名为实际环境分贝。
- 用较快上升、较慢回落的包络驱动动效；只给视觉平滑，不更改原始输入语义。
- 输入确实很弱时可以保留低幅度数据；设备 mute/上下文暂停时则判为无有效测量。没有有效输入时不继续使用上一帧的高能量。
- 不使用 `MediaRecorder`，不写音频文件、不写 PCM 到 localStorage/IndexedDB、不上传音频或频谱；浏览器本地短窗口完成分析后覆盖缓冲区。

## 三、生命周期与错误状态

| 状态/触发 | 处理 | 提示与后续 |
| --- | --- | --- |
| 未启用 | 无 MediaStream/AudioContext | “启用麦克风” |
| 请求中 | 禁止重复发起；显示取消 | “等待麦克风授权” |
| 请求迟到 | 比较本次 generation 与当前意图；已取消/离开页面则立即 stop 返回的全部 tracks | 不重新点亮麦克风 |
| 用户拒绝 `NotAllowedError` | 释放已创建对象，数值无效 | “未获麦克风权限；可在浏览器设置允许后重试” |
| 无设备 `NotFoundError` | 保留完整仪表操作 | “未找到麦克风” |
| 不可读 `NotReadableError` | 释放本次资源 | “麦克风当前不可用，稍后重试” |
| 主动关闭/骑行结束 | 使请求代次失效，停止 tracks、disconnect source、close context、清空数值 | “麦克风已关闭” |
| `track.ended`/输入移除 | 同一清理路径，不自动循环申请 | “输入已中断，点击重试” |
| `track.mute` | 标记输入暂不可用，停止声音反应 | 不解释为发动机熄火 |
| `track.unmute` | 若仍有开启意图且上下文 running，恢复分析 | 按新数据重新建立平滑包络 |
| AudioContext 非 running | 清空/冻结为不可测，不再显示 LIVE | 必要时提供点击恢复，失败可重试 |
| 页面隐藏、`pagehide`、切到其他 App | 原型主动 stop 并释放音频图，取消待授权请求的使用意图 | 回来显示“已停止，点击重新启用”；不自动重开 |

主动 `track.stop()` 不会触发 `ended` 事件，因此清理函数自己负责 UI 状态。`AudioContext.close()` 也不负责停止 getUserMedia 的 track；应分别处理。依据：[track ended](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack/ended_event)、[AudioContext.close](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/close)。页面隐藏可通过 `visibilitychange` 检测，但手机系统挂起和事件调度仍须真机验证；前台 HTML 不承诺锁屏持续分析。依据：[Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API)。

## 四、原生 iOS 后续方案

这里只记录待实现方案，本次 HTML 更改不代表 iOS App 已接入。

1. 使用 `AVAudioApplication.requestRecordPermission`，在 Info.plist 设置明确的 `NSMicrophoneUsageDescription`，例如“在本机分析周围声浪，让仪表响应发动机与环境声音，不保存或上传录音”。旧 `AVAudioSession.requestRecordPermission` 已废弃，应避免新代码继续依赖。依据：[AVAudioApplication 权限](https://developer.apple.com/documentation/avfaudio/avaudioapplication/recordpermission-swift.property)、[旧权限 API 与用途说明](https://developer.apple.com/documentation/avfaudio/avaudiosession/requestrecordpermission(_:))。
2. 音频输入采用 `AVAudioEngine.inputNode` 的 tap，先确认硬件格式的 sampleRate/channelCount 非零。音频回调只做轻量缓冲/摘要，FFT 和 SwiftUI 更新分开；不要在实时回调里请求网络或写日志。依据：[inputNode](https://developer.apple.com/documentation/avfaudio/avaudioengine/inputnode)。
3. 保留音乐/导航播放时可评估 `.playAndRecord` 与 `.mixWithOthers`：前者支持输入与输出，后者允许与其他 App 的音频混音。此设置只提供机制，不证明 MusicKit、导航播报、蓝牙头盔在所有路由下都不会中断。依据：[playAndRecord](https://developer.apple.com/documentation/avfaudio/avaudiosession/category-swift.struct/playandrecord)、[mixWithOthers](https://developer.apple.com/documentation/avfaudio/avaudiosession/categoryoptions-swift.struct/mixwithothers)。
4. `.measurement` 可降低部分系统信号处理，但可能降低输出播放音量；应与 `.default` 做真实录音特征及播放体验对照后选定。不能把 measurement 模式宣传为校准仪器。依据：[measurement](https://developer.apple.com/documentation/avfaudio/avaudiosession/mode-swift.struct/measurement)。
5. 通过 availableInputs 和实际 currentRoute 确认输入，尝试选择内置麦克风后读回结果；路由变更时重新核验，不把头盔话筒误当手机话筒。依据：[availableInputs](https://developer.apple.com/documentation/avfaudio/avaudiosession/availableinputs)。
6. 来电/Siri/系统挂起按 interruption 通知停用当前特征，恢复时依据有效路由、授权、用户意图重新启动。不要为了不掉动效而抑制正常来电。依据：[Handling audio interruptions](https://developer.apple.com/documentation/avfaudio/handling-audio-interruptions)、[interruptionNotification](https://developer.apple.com/documentation/avfaudio/avaudiosession/interruptionnotification)。

## 五、验收边界

代码/模拟测试可证明：状态机、generation 竞态处理、输入断开、关闭后计时器释放、没有录制/上传路径、无数据不填假值、频段公式和归一化。模拟流必须记录为合成输入测试，不能充作真实手机拾音证据。

浏览器实测至少包括：

- 首次允许、拒绝、忽略授权后取消、取消后迟到授权、快速重复点启停、错误后重试。
- 普通说话/拍手产生实时变化，安静时回落，关掉麦克风后系统指示灯和页面状态同步结束；本机实声测试不能声称已验证发动机识别。
- 退后台/锁屏、关闭页签、返回页面、设备移除、系统撤销权限、输入 mute/unmute；均不遗留采集和虚假的 LIVE 标记。
- 音乐按钮操作不改变任何声浪特征或 FX 系数；若外放音乐被麦克风拾到，按环境混合声处理。
- 无麦克风/拒绝权限时，开始、暂停、继续、结束、模式切换和复盘仍可操作。
- 375×667、390×844、844×390 下麦克风入口、关闭入口与状态可见，短暂介绍卡不占据长期仪表空间。

原生真机额外记录：iPhone 型号/OS、安装位置、实际音频路由、耳机连接、MusicKit 共存、来电、60 分钟发热与帧率。发动机相关学习另需实车与独立真值；本轮 UI 或浏览器测试不能越过该验收层级。
