# Motuo 路谱格式（schema v1）

路谱（roadlog）是一次**真实骑行**的手机传感器全量记录，给以后在 Mac 上做车辆相关的定制开发用。格式按“自描述、可校验、能从崩溃中恢复、Python 标准库就能读”设计。写入端：`ios/Motuo/Roadlog/`；读取端：[`tools/roadlog/`](../tools/roadlog/README.md)。本文是规范；如果和代码不一致，以 `RoadlogFormat.swift` 的流定义和 `RoadlogManifest.swift` 的 manifest 生成为准，并应修正本文。

- **何时生成：** 控制中心“路谱采集模式”（默认开启）打开时，每次真实骑行自动生成一个包。**DEMO / 演示骑行不生成路谱**；`provenance: "simulated"` 只出现在合成测试包里，上传队列拒绝上传这类包。
- **一次骑行可能有多个包：** App 在骑行中被终止，下次启动会把旧包恢复封好；继续这次骑行会用同一个 `rideId` 开新包（目录名的开始时间不同）。
- **隐私：** 包含精确轨迹；可选的原始声音会录下周围所有声音。只保存在本机和用户自己的 iCloud Drive，不进 Git、不发第三方。

## 目录结构

```
Roadlog/<开始UTC YYYY-MM-DDTHH-MM-SSZ>_<rideUUID 大写>/
  manifest.json        封包时生成（可由下列文件重建）
  manifest.sha256      "<manifest.json 的 SHA-256 十六进制>  manifest.json\n"
  session.json         开始时写下的元数据：rideId、provenance、App/设备、车辆、标定、设置、能力
  README.md            包内自带的字段说明与 Python 读取示例
  index.jsonl          只追加、每行后 fsync：每个已封好的数据块/音频段一行，重建 manifest 的依据
  clock.jsonl          时钟映射：开始、每 10 s、墙钟变化、继续骑行、结束
  events.jsonl         骑行状态、推断事件、缺口、降级、流状态、生命周期
  device.jsonl         电池、热状态、低电量、方向、前后台、内存占用、剩余存储（每 30 s + 变化时）
  accessory.jsonl      配件原始帧（base64 + 可解析的 JSON）；没有配件时一条 {"type":"none"}
  streams/<流>/<序号 6 位>.csv.gz     已封好的块：完整 gzip 成员，UTF-8 CSV，首行表头
  streams/<流>/<序号 6 位>.csv.part   正在写的块（明文 CSV），只在录制中或崩溃后存在
  audio/<序号 4 位>.m4a               可选原始声音（AAC-LC 单声道 16 kHz 约 32 kbps，每段 5 分钟）
```

本机位置：App 的 `Documents/Roadlog/`（`UIFileSharingEnabled`，可在“文件”App → 我的 iPhone → MOTUO → Roadlog 看到）。iCloud：容器 `iCloud.cn.yundongyl.motuo` 的 `Documents/Roadlog/`，在 Mac 上是 `~/Library/Mobile Documents/iCloud~cn~yundongyl~motuo/Documents/Roadlog/`。

**JSON Lines：** UTF-8，一行一个对象，以 `\n` 结尾；读取时忽略最后一条没有换行的半行（崩溃尾巴）。每条记录都有 `t_mono`、`t_unix`、`type`、`source`。

## 时间与对齐

- `t_mono`：秒，基准是 iPhone 的 `ProcessInfo.systemUptime`。CoreMotion（`CMLogItem.timestamp`）与 CMAltimeter 的时间戳本来就是这个基准，所有流都用它对齐。CSV 中保留 6 位小数。
- `clock.jsonl`：`{"t_mono", "t_unix", "reason": start|periodic|wallclock_change|resume|end}`，两个值是背靠背读的。换算：取最近一条，`t_unix = t_unix0 + (t_mono - t_mono0)`（`tools/roadlog` 的 `ClockMap`）。
- 定位和航向（`CLLocation.timestamp`、`CLHeading.timestamp`）本身是墙钟：写入时用最近的映射换成 `t_mono`，同时在 `t_unix` 列保留原始墙钟值。
- 同一流内 `t_mono` 不倒退：比上一条更早的样本直接丢弃，不重排。跨流不保证按回调顺序。

## CSV 流

空字段表示没有该值，**绝不用 0 代替**。数字为普通十进制（不受地区设置影响）：时间 6 位小数，经纬度 8 位小数，其他最多 7 位有效数字。整数和标志列（`int`、`0/1`）写整数。每个流的列名、单位、说明也写在 manifest 里。

| 流 | 来源 | 列（单位） | 目标采样率 |
|---|---|---|---|
| `motion` | measured · CMDeviceMotion | `t_mono` · `user_acc_x/y/z`（g，已去重力）· `gravity_x/y/z`（g）· `rot_x/y/z`（rad/s，校准后）· `q_w,q_x,q_y,q_z`（姿态四元数）· `mag_x/y/z`（µT，校准磁场；未校准且全零时空）· `mag_accuracy`（-1 未校准，0 低，1 中，2 高）· `heading_deg`（deg，仅参考系支持时） | 100 Hz |
| `accel_raw` | measured · CMAccelerometerData | `t_mono, x, y, z`（g，含重力） | 100 Hz |
| `gyro_raw` | measured · CMGyroData | `t_mono, x, y, z`（rad/s，未去零偏） | 100 Hz |
| `mag_raw` | measured · CMMagnetometerData | `t_mono, x, y, z`（µT，未校准） | 50 Hz |
| `batched_accel` / `batched_motion` | — | 同 `accel_raw` / `motion` | iPhone 上始终 `unsupported`，原因见下 |
| `altimeter` | measured · CMAltimeter 相对高度 | `t_mono, rel_alt_m`（m，相对本流开始）`, pressure_kpa`（kPa） | 由设备决定（约 1 Hz） |
| `abs_altitude` | measured · CMAltimeter 绝对高度 | `t_mono, altitude_m, accuracy_m, precision_m`（m） | 由设备决定 |
| `location` | measured · CLLocation | `t_mono, t_unix, lat, lon`（deg WGS84，未做 GCJ-02 偏移）`, alt_m`（m，海拔）`, ellipsoidal_alt_m`（m，WGS84 椭球高）`, h_acc_m, v_acc_m`（m）`, speed_mps, speed_acc_mps`（m/s）`, course_deg, course_acc_deg`（deg，真北顺时针）`, floor`（int）`, sim_by_software, from_accessory`（0/1，`sourceInformation`） | 约 1 Hz（由设备决定） |
| `heading` | measured · CLHeading | `t_mono, t_unix, magnetic_deg, true_deg, accuracy_deg`（deg）`, raw_x, raw_y, raw_z`（µT） | 由设备决定（`headingFilter` 为 none） |
| `acoustic` | measured · 麦克风特征 | `t_mono, rms_dbfs, peak_dbfs`（dBFS）`, clipped`（0/1，\|x\|>0.98）`, band_00 … band_15`（dBFS） | 每 1024 个采样一帧（48 kHz 时约 47 Hz） |
| `inferred_imu_speed` | inferred · InertialVelocityBridge | `t_mono, speed_mps, uncertainty_mps`（m/s，1σ）`, anchor_age_s`（s） | 约 10 Hz，仅 GPS 缺失且估计有效时 |
| `inferred_signal` | inferred · RideEngine | `t_mono, longitudinal_trend`（1 加速 / -1 减速 / 0）`, turn_direction`（-1…1）`, acceleration_intensity, rotation_intensity`（0…1，仪表用） | 1 Hz |

定位里无效的负值（速度、航向、各种精度小于 0）写空；垂直精度无效时 `alt_m`、`ellipsoidal_alt_m` 也写空。

**声学：** Hann 窗、1024 点 FFT，16 个对数频带，边界从 31.5 Hz 到 24 kHz（数值写在 `manifest.streams.acoustic.bandEdgesHz`）。频带值是该频带内的能量（Parseval 归一，满量程正弦约 -3 dBFS），落在奈奎斯特频率以上的频带写空。这是手机麦克风收到的混合环境声，**不是发动机转速**。只有用户按原有规则在座舱里开了麦克风才有数据；App 进后台时麦克风自动停止。没开时流状态为 `disabled` 并写明原因。

**原始声音：** 另一个开关“保存原始声音”，默认关闭；打开时 App 会明确提示会录下周围所有声音（包括对话）。录制同样只在麦克风已开启时进行，与声学特征来自同一路音频。存储低于第 1 级阈值时自动停止。如果 App 在录制中途被终止，这一段 m4a 可能缺少容器尾部，无法播放（index 中标 `recovered: true`）。

### 坐标系

- **设备坐标（CoreMotion）：** x 指向屏幕右侧，y 指向屏幕顶部，z 垂直屏幕朝外（右手系）。数据和手机在支架上的安装方向有关，换成车辆坐标见 `manifest.calibration`。
- **姿态参考系：** 设备有磁力计时用 `xMagneticNorthZVertical`（四元数相对磁北和竖直方向），否则用 `xArbitraryCorrectedZVertical`；实际使用的写在 `manifest.settings.attitudeReferenceFrame`。原有的 50 Hz 记录只用用户加速度和角速度，与参考系无关。
- **标定：** `calibration.matrix` 的三行依次是车辆右、前、上方向在设备坐标中的单位向量（来自 SensorCalibrationService 静止采样），车辆向量 = matrix × 设备向量。用户加速度要先换成 m/s²，再减去 `accelerationBiasMps2`。动态倾角的准确度没有经过验证。
- **定位：** WGS84，轨迹不做国内坐标偏移。

### 分块与封块

一个块的 `t_mono` 跨度满 60 s，或者未压缩 CSV 满 4 MiB，就封块（取先到者）；骑行结束时所有块都封。封块步骤：gzip 压缩 `.part`，写入临时文件，原子改名为 `.csv.gz`，计算 `.gz` 的 SHA-256，追加一行 index 并 fsync，删除 `.part`。

index 行（manifest 每个流的 `chunks` 与此相同，只是没有 `type`）：

```json
{"type":"chunk","stream":"motion","seq":3,"file":"streams/motion/000003.csv.gz","rows":6000,"t_start":…,"t_end":…,"bytes":…,"uncompressed_bytes":…,"sha256":"…","recovered":false}
{"type":"audio","seq":1,"file":"audio/0001.m4a","t_start":…,"t_end":…,"bytes":…,"sha256":"…","recovered":false}
```

## 崩溃与强杀恢复

App 每次启动（以及 BG 任务里）会检查所有没有 manifest 或者 manifest `status` 为 `recording` 的包（正在录制的那个除外）：

1. index 和各 JSONL 文件截掉末尾的半行。
2. 每个 `.part`：如果对应的 `.gz` 已经在 index 里，说明封块已完成，直接删除 `.part`；如果 `.gz` 存在但 index 里没有，说明封块被打断，删掉这个 `.gz`，以 `.part` 为准。然后把 `.part` 截到最后一个完整行；有数据行就封块并标 `recovered: true`，没有就删除。临时文件 `.tmp` 一律删除。
3. 还没写进 index 的音频段补登记（标 `recovered`）。
4. events 里追加 `recovered_after_termination`；manifest 全部从磁盘内容重建，`status: "recovered"`、`manifestRebuilt: true`，结束时间取最后观察到的时间。

正常封包走的也是同一个“从磁盘重建”流程，所以任何时候都能用 index、session 和 events 重新生成 manifest。原有的骑行记录（TelemetryJournal / SwiftData）有自己独立的恢复逻辑，两者互不影响。

## manifest.json

顶层字段：`schema`（`"motuo.roadlog"`）、`schemaVersion`（1）、`schemaMinor`（1.1 起为 1；1.0 包没有该字段，按 0 读）、`packageId`、`rideId`、`status`（`sealed` / `recovered` / `recording`）、`provenance`（`measured` / `simulated`）、`simulated`、`startedAtUTC`、`endedAtUTC`、`durationS`、`clock`（`monotonicBase`、`mappingFile`、`samples`、`start`、`end`）、`app`（`bundleId`、`version`、`build`）、`device`（`model` 即 hw.machine、`systemName`、`systemVersion`、`isSimulator`）、`vehicle`（档案与最近 10 条保养摘要：日期、里程、类别；**不含车牌**）、`settings`（请求的采样率、定位精度 BestForNavigation、`activityType`（automotiveNavigation，与原记录一致）、不自动暂停、`headingFilter`、姿态参考系、`rawAudioEnabled`、旧遥测说明）、`calibration`、`capabilities`、`streams`、`files`（各 JSONL 和 session 的行数、字节数、SHA-256）、`audio`、`gaps`、`degradations`、`storagePolicy`（1.1：降级依据与阈值）、`integrity`（`algorithm`、`chunksVerified`、`problems`）、`manifestRebuilt`、`dataVolume`（`totalBytes`、`uncompressedBytes`、`bytesPerHourEstimate`）、`upload`（说明上传状态只记录在手机上，不进入校验和）。

`streams.<名称>`：`source`、`status`（`recorded` / `unsupported` / `unavailable` / `disabled` / `degraded`）、`reason`、`requestedHz`、`measuredHz`（(rows-1)/(tEnd-tStart)）、`rows`、`tStart`、`tEnd`、`columns[{name,unit,description}]`、`frame`、`chunks[…]`；`acoustic` 另有 `bandEdgesHz`，`acoustic_lf` 另有 `frequenciesHz`；时间戳不在单调时钟上的流标 `clockSuspect: true`（见 1.1 修复）。每个流都会出现，即使这次没有数据，也会写明原因。

## 缺口、降级与事件

- **缺口：** IMU 流相邻样本间隔超过该流阈值（0.5 s）记为 `sensor_stall`，定位超过 3 s 记为 `gps_lost`；暂停期间整段记一条 `{"stream":"*","reason":"paused"}`，继续后的第一个样本不再算缺口。另外有 `gps_lost` / `gps_recovered` 事件（超过 4 s 没有定位回调）。
- **存储不足降级**（依据 `volumeAvailableCapacityForImportantUsage`，开始时和每 30 s 检查一次；一次骑行内级别只升不降）。1.1 起按**剩余可录时长**而不是固定字节数：剩余时长 = (可用空间 − 200 MB 保留) / ((路谱速率 + 旧遥测 65 MB/h) × 1.5 余量)，路谱速率取 60 MB/h（开原始声音再加 15 MB/h）与本包实测速率（录满 5 分钟后）的较大者：
  1. 剩余 < 3 小时：停止原始声音（`raw_audio_stopped`）。
  2. 剩余 < 1.5 小时：`motion` 降到 25 Hz，停止 `accel_raw` / `gyro_raw` / `mag_raw`（`imu_rate_reduced`）。
  3. 剩余 < 0.5 小时（或可用空间进入 200 MB 保留）：停止路谱并立即封包（`roadlog_stopped`）；原有的基础骑行记录照常继续。开始时就到这一级的话，这次骑行不生成路谱，并在设置页说明原因。
  每一级都写进 `degradations`（含 `freeBytes`、`remainingHours`）和事件，受影响的流状态改为 `degraded`；阈值写在 `storagePolicy`。按旧规则，剩 1.07 GB 的骑行一开始就停了原始声音、30 s 后降到 25 Hz；按新规则约 4.6 小时可录，不降级。
- **events.jsonl 的 `type`：** `ride_start`、`ride_pause`、`ride_resume`、`ride_finish`、`roadlog_stopped_low_storage`、`gps_lost`、`gps_recovered`、`location_error`、`app_background`、`app_foreground`、`memory_warning`、`degradation`、`stream_status`、`gap`、`signal_event`（source inferred；`kind` 为 turn / suspectedShift 等，附带 confidence、eventId、windowStart/End）、`microphone_on` / `microphone_off`、1.1 起的 `vehicle_state`（`field` motion/engine/turn、`from`、`to`、`confidence`）/ `vehicle_corner`（`dir`、`t_start`、`t_end`、`angle_deg`、`peak_deg_s`）/ `vehicle_suspectedShift`（`dip_g`、`sound_dip_db`）/ `vehicle_mountReset` / `vehicle_mount_recalibrate`（source 为 inferred，用户操作为 user）、`raw_audio_segment` / `raw_audio_stopped` / `raw_audio_error`、`recovered_after_termination`。
- **用户标注：** 骑后在 App 里确认或否定事件，结果保存在 App 的骑行记录里（`eventId` 与 `signal_event` 对应）。已封好的路谱不再改写，用 `rideId` / `eventId` 关联。

## 测量、推断、模拟

测量值只在 `source: "measured"` 的流里；App 推断的只在 `inferred_*` 流或 `source: "inferred"` 的事件里；合成包里所有流和事件都是 `simulated`。原有遥测（TelemetryJournal）仍然以 50 Hz 记录 deviceMotion：路谱开启时，共用的 CMMotionManager 以 100 Hz 运行，旧链路按时间戳降采样回 50 Hz，所以旧记录、事件启发式和惯导估速的输入频率都不变。

## 数据量与性能（合成数据实测，见 docs/STATUS.md）

- 模拟器上跑了 10 分钟合成骑行（各流按目标频率，带噪声，不含原始声音）：9.0 MB，**约 54 MB/小时**；其中 motion 占一半，声学特征约 12 MB/小时。打开原始声音约再加 14 MB/小时（32 kbps）。真实传感器噪声与合成数据不同，压缩率可能有差异。
- 写入与声学特征的 CPU：在模拟器（用的是 Mac 的 CPU）上，每小时数据约 47 CPU 秒（约占单核 1.3%）。60 秒实时节奏下，整个测试进程（包括座舱 WebView 和数据生成）约占单核 11%，主线程最大延迟 37 ms。真机需要另测。

## 已知局限

- **没有 800 Hz / 200 Hz 批量传感器：** iOS SDK 26.5 中 `CMBatchedSensorManager` 只标注了 watchOS 10+，iPhone 上没有这个 API。`batched_*` 流在 manifest 里写为 `unsupported`。
- **采样率：** CoreMotion 的 100 Hz 是请求值，实际以 `measuredHz` 为准；GPS 约 1 Hz，速度为多普勒测量，有延迟。
- **系统休眠：** `systemUptime` 在设备休眠时暂停；骑行中 App 靠定位后台模式保持运行，周期性的时钟映射可以发现时间跳变。
- **后台：** App 在后台时，CoreMotion 能否持续取决于 App 是否在运行（有定位后台模式时通常会持续），需要真机确认；声学特征和原始声音在后台不采集（麦克风按原有规则停止）。
- **轴向：** 轴向取决于手机安装方向，换算前先看 `calibration`。手机的运动信号推断不出挡位、转速、油门或倾角真值；`suspectedShift` 只是候选事件。
- **iCloud：** 上传由系统在后台完成，没有完成时间保证。只有 App 签名包含 iCloud Documents 能力时才会上传；否则仅保存在本机，可在“文件”App 查看或分享导出（见 docs/APPLE_RELEASE.md）。

## schema 1.1（2026-10-23）

读取规则：`schemaVersion` 仍为 1；`schemaMinor` 缺省视为 0。1.0 读者遇到 1.1 包只会多看到两个流和几类事件，不受影响；`tools/roadlog` 两种都读。

- **`vehicle_state`（inferred，10 Hz）：** `VehicleStateEstimator` 的输出——`engine`（0 未知 1 熄火 2 怠速 3 运转 4 原地轰油门）、`motion`（0 静止 1 起步 2 加速 3 巡航 4 刹车 5 急刹 6 滑行）、`long_g`、`accel_intensity`、`brake_intensity`、`turn`（1 左 −1 右 0 无）、`yaw_deg_s`（绕真实竖直轴，左正）、`lean_visual_deg`（atan(v·ω/g)，**只用于驱动画面，不是倾角测量，App 不显示数字**）、`corner_phase`（0 无 1 入弯 2 弯心 3 出弯）、`speed_mps`、`mount_status`（0 学习中 1 人工校准初值 2 已收敛）与各置信度、`vibration_g`、`sound_db`。状态切换另记在 events。算法与真实回放验证见 docs/STATUS.md。
- **`acoustic_lf`（measured，约 4 帧/秒）：** 手机麦克风 20–500 Hz 低频细分谱，每 4 Hz 一列（121 列，dBFS/Hz）。降采样到约 4 kHz 后做 1024 点 Hann FFT，分辨率约 3.9 Hz，再线性插值到 4 Hz 网格。供以后研究发动机阶次；本版本只采集和在座舱里显示“声浪”，**不推断、不显示转速**。
- **`acoustic` 频带修复：** 1024 点帧的频点间隔约 46.9 Hz，1.0 里 band_01（47.7–72.2 Hz）一个频点都没有，恒为空。1.1 起宽度不足两个频点的频带（band_00…band_04）取频带几何中心处插值后的功率 × 频带宽度（以频点计），不再为空；更细的低频看 `acoustic_lf`。
- **绝对高度时钟修复：** iOS 26 上 `CMAbsoluteAltitudeData.timestamp` 不是开机时钟，而是以 2001-01-01 为起点的秒数（约 8.14e8）。1.0 里它被原样写进 `t_mono`，manifest 再把它当作最新数据时间，于是 `endedAtUTC` 变成 2052 年、`durationS` 错。1.1 起这类时间戳经墙钟映射换回单调时钟（其他不可信值退回接收时刻）；manifest 的结束时间只取落在时钟样本范围内（+1 小时恢复余量）的时间，范围外的流标 `clockSuspect` 并写入 `integrity.problems`。
- **`accel_raw` 误报修复：** 1.0 每次开头都写一条 `accel_raw` “未接入运动管理器”，原因是写静态状态时还没接上运动管理器；1.1 先接管理器再写。
