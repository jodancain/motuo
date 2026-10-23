# tools/roadlog — Mac 端路谱工具

读取、校验、汇总和导出 Motuo App 的路谱包（schema v1，规格见 [docs/ROADLOG_FORMAT.md](../../docs/ROADLOG_FORMAT.md)）。只依赖 Python 3.9+ 标准库；有 `pyarrow` 时导出 Parquet，有 `matplotlib` 时示例脚本出图。

> **隐私：** 路谱含精确轨迹，开启“保存原始声音”后还有环境原声。只放在本机和你自己的 iCloud；不要提交进 Git（仓库 `.gitignore` 已忽略包目录、导出物和 `*.parquet`），也不要发给第三方。

## 数据从哪来

骑行结束后 App 封包校验，把包复制进 iCloud Drive 的 Motuo 文档容器，系统在后台上传，之后自动同步到这台 Mac：

```
~/Library/Mobile Documents/iCloud~cn~yundongyl~motuo/Documents/Roadlog/<开始UTC>_<rideUUID>/
```

在 Finder 里位于 iCloud 云盘 → Motuo → Roadlog。这个版本若没有 iCloud 能力（签名没开 iCloud），App 只在本机保存：可以在 iPhone“文件”App → 我的 iPhone → MOTUO → Roadlog 找到，或在 App 的“控制中心 → 路谱包与上传”里分享导出 `.zip`，解压后用 `--root` 指向所在目录。

## 用法

```sh
python3 tools/roadlog/roadlog.py list                       # 列出（默认 iCloud 目录）
python3 tools/roadlog/roadlog.py verify --all               # 全部校验；有失败时退出码 1
python3 tools/roadlog/roadlog.py summary --all [--json]     # 每次骑行摘要
python3 tools/roadlog/roadlog.py export <包名或路径> [--format parquet|csv] [--streams motion,location] [--out DIR]
python3 tools/roadlog/roadlog.py --root ~/Downloads/roadlog list   # 其他目录
python3 tools/roadlog/examples/align_speed_accel.py <包路径> [--out x.png]
```

- `verify`：manifest.sha256、每个块与音频的 SHA-256 和字节数、gzip 能完整解压、CSV 表头与 manifest 列定义一致、行数与时间范围一致、每个流 `t_mono` 不倒退、index.jsonl 与 manifest 一致、JSONL 可解析（末尾半行只警告）。
- `summary`：时长、GPS 里程（规则：跳过 `h_acc_m` 缺失或 > 50 m 的点、间隔 > 10 s 或隐含速度 > 70 m/s 的段）、最高/平均 GPS 速度、GPS 与气压高度范围、每个流的行数和采样率（总体与中位间隔）、p95/最大间隔、缺口（manifest 记录的 + 工具按规格自己检测的）、降级、事件计数、电量和热状态、数据量。
- `export`：每个流合并成一张表并追加 `t_unix`（按 clock.jsonl 最近一条映射换算），有 pyarrow 写 Parquet，否则写 CSV；events/device/accessory 另存 CSV。默认输出到 `tools/roadlog/out/<包名>/`（已忽略）。
- 示例脚本：用 GPS 速度差分和 1 秒窗口的 IMU 用户加速度做最小二乘，**估计**手机安装下的“前进方向”并给出相关系数；画速度、纵向加速度（GPS 差分对比 IMU 投影）、高度（GPS 对比气压）、声学 RMS 四张图。结论是推断，不是测量。

## 判断包是否同步完整

- App 最后才写 `manifest.json` 和 `manifest.sha256`；两者都在且 `verify` 通过，包就完整。
- `list` 的状态：`sealed`（正常封包）、`recovered`（App 被终止后在下次启动时恢复，最后不到一秒的数据可能缺失）、`incomplete-sync`（manifest 缺失或有文件没到）、`not-downloaded`（存在 iCloud 占位文件）。
- iCloud 可能只在 Mac 上放占位文件 `.<文件名>.icloud`。下载：`brctl download "<包路径>"`，或在 Finder 里右键“立即下载”；也可在“系统设置 → Apple 账户 → iCloud → iCloud 云盘”关闭“优化 Mac 储存空间”。

## 自带的合成数据与测试

```sh
python3 tools/roadlog/synth.py --out /tmp/roadlog-demo --seconds 600 [--audio] [--fault bad_sha]
python3 -m unittest discover -s tools/roadlog/tests
```

`synth.py` 生成 provenance=simulated 的包，可注入故障：`bad_sha`、`half_jsonl`、`missing_chunk`、`part_left`、`no_manifest`、`icloud_placeholder`。没有 pyarrow / matplotlib 时，相关测试跳过或走降级路径，不算失败。

## 读取示例（只用标准库）

```python
import sys; sys.path.insert(0, "tools/roadlog")
import roadlog_lib as rl
pkg = rl.Package("~/Library/Mobile Documents/iCloud~cn~yundongyl~motuo/Documents/Roadlog/<包名>")
header, rows = pkg.read_stream("motion")          # rows: [t_mono, user_acc_x, ...]，缺测为 None
clock = pkg.clock(); print(clock.to_unix(rows[0][0]))
print(pkg.manifest["streams"]["motion"]["measuredHz"], rl.verify(pkg)["ok"])
```
