# Apple 构建与内测接续

项目标识为 `cn.yundongyl.motuo`，Watch 标识为 `cn.yundongyl.motuo.watchkitapp`，Team `7NUGZ3A48C`。2026-09-14 已通过 Apple API 注册两个 Bundle ID 并创建独立 ACTIVE App Store 描述文件：`Motuo App Store`、`Motuo Watch App Store`。使用已安装的有效分发证书；没有撤销或替换其他项目证书。

## 构建

```sh
python3 scripts/apple-release.py --archive --export --env /absolute/path/to/private-signing.env --keychain-env /absolute/path/to/private-keychain.env
python3 scripts/apple-release.py --status --env /absolute/path/to/private-signing.env
python3 scripts/apple-release.py --upload --env /absolute/path/to/private-signing.env
```

私有环境提供 `APPLE_TEAM_ID`、`ASC_KEY_ID`、`ASC_ISSUER_ID`、`ASC_KEY_PATH`。本机沿用用户授权参考的 WorkChat 签名配置来源，私钥不复制进应用或仓库。脚本输出只含构建路径、校验和及 Apple 状态。默认构建目录 `~/Library/Developer/MotuoBuilds`，避免 Documents 的 FileProvider 自动附加 FinderInfo 导致 codesign 失败；可用 `--build-dir` 覆盖。新上传时用 `--build-number` 增加构建号，Archive 和 Export 完成后再执行 Upload。上传成功、Apple 处理完成和测试者可安装是三个独立状态。

Bundle ID 列表检索可能返回前缀相同的 Watch 项目，必须对 identifier 作完整相等核对。初次 iPhone 描述文件的错误关联已修正，当前文件内的 application-identifier 与 iPhone/Watch 两个目标各自匹配。

## 当前平台前置条件

- 2026-09-20 登录后已创建 App 记录 `6814048230`，名称 Motuo、SKU `motuo-ios`、主要语言简体中文；API 按完整 bundle ID 回读成功。
- 2026-09-20 网页已登录。Apple 提示须于 10 月 2 日前接受更新的 Developer Program License Agreement；此次未代签新协议，现有 App ID 服务和 API 仍可使用。
- 2026-09-20 已在 App ID 的 App Services 启用 MusicKit，保存后重新打开页面确认为已勾选。旧 iPhone 描述文件随之失效，已重建同名独立 ACTIVE 文件 `63D62CYGB6`（UUID `b463f61d-57a5-481b-923b-ec4d816567c0`），Watch 文件维持原有有效配置。MusicKit 是运行时服务，不能添加虚构的 entitlement 代替。[Apple MusicKit 服务说明](https://developer.apple.com/help/account/services/musickit)
- 已创建内部测试组 `Motuo Internal`（`c8cf437a-46c0-4246-b64f-d18300dacea4`），仅手动分发选定构建；网页已回读只含账户持有人 1 名测试员。最终构建已处理为 `VALID`、内部状态 `IN_BETA_TESTING`，组内回读 1 个构建与本人 1 名测试员；网页显示本人「已邀请」、0.1.0 (1)「正在测试」。没有创建外部公开测试链接。

## 隐私声明

应用使用自己的 UserDefaults、应用/用户所选文件的元数据，以及事件间隔/绝对采样时间。`PrivacyInfo.xcprivacy` 已按实际用途声明；系统开机时长不作为上传遥测。轨迹、个人设备标识、手册和骑行动态仅用于应用功能，无广告或跨应用追踪。[Apple 必需理由 API 说明](https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api)

Apple Music 授权、订阅和实际播放，以及真实手机与 Watch 的安装和触觉，需要对应设备验收；模拟器构建不能替代。

## 9 月 20 日发布验证进度

已生成 iPhone + Watch 签名 Archive / IPA，严格签名、精确 bundle ID、隐私清单和资源校验通过。构建号绑定 `CURRENT_PROJECT_VERSION`，版本绑定 `MARKETING_VERSION`，避免 XcodeGen 默认静态 Info 值导致重传仍使用旧号。已内嵌 SteedPilot MIT 声明。

最终复查补修存储不足时的骑行结束恢复、原校验和核对、配对身份切换时的异步响应隔离，以及竖屏操作栏与滚动内容重叠的命中问题。最终 e 轮 31 项单元测试与 2 项 UI 测试全部通过后，已重新 Archive、Export 并上传最终包。

2026-09-20 11:37:33（北京时间），Apple 返回 `UPLOAD SUCCEEDED`、无错误。最终 IPA 为 2,158,486 字节，SHA-256 `ec7875ae8254a01d4306416105dec61e4ac060b63dc6a43a3a90786087a55c16`，Delivery/Build ID `4dac7de5-ebd3-4398-bb4c-84394ccf9187`。随后 Apple 处理完成，已添加简体中文测试说明并回读一致、将构建加入 `Motuo Internal`，API 与网页均确认正在内部测试。分发回执见 [apple-release-receipt.json](apple-release-receipt.json)。

安装：在 iPhone 上打开 TestFlight，使用被邀请的本人 Apple 账号接受 Motuo 邀请，安装 0.1.0 (1)。若未显示，在邀请邮箱中打开 Apple 的测试邀请。包内包含 watchOS 伴侣应用，需在兼容的配对 Watch 上另行确认安装。此次验证达到「内部测试已分发且已邀请本人」，不代表手机/手表已经完成真实安装或实车验收。

`--keychain-env` 只解锁既有签名钥匙串，不改变访问 ACL；支持 `MOTUO_SIGNING_KEYCHAIN` / `MOTUO_SIGNING_KEYCHAIN_PASSWORD`（本机沿用原已授权媒体项目变量）。签名私钥、密码、配对码均不在包或版本库中。

状态脚本分别输出 Apple `processingState` 和 `internalBuildState`。仅 `VALID` 不足以证明已分发；需内部构建可测状态、群组关联和本人测试者可见共同核验。参考 [Apple 内部测试状态](https://developer.apple.com/documentation/appstoreconnectapi/internalbetastate)。本轮内测说明见 `docs/TESTFLIGHT_NOTES.zh-Hans.txt`。

## 9 月 21 日：分发证书钥匙串密码丢失、重新签发、`0.2.0 (2)` 发布

原分发证书私钥保存在独立的 `aipodcast-signing.keychain-db`；密码遗忘导致 `codesign` 持续返回 `errSecInternalComponent`（钥匙串无法解锁，不是签名身份错误）。已通过 App Store Connect API 用新生成的 CSR 撤销旧证书（序列号 `68FB7E83D7869DF8FD3E9BFA594FCBB8`）并签发新证书（序列号 `A98QZV5PK3`，SHA-1 指纹 `A7D26436BC208B93EE6D43001E088A56386C77FF`），私钥/证书对已导入默认 `login.keychain-db`（不再依赖独立钥匙串或密码）。旧证书失效后两个描述文件自动 `INVALID`；已重新生成同名 `Motuo App Store`（UUID `ccc21920-ca3a-4827-98ee-172b142552b5`）和 `Motuo Watch App Store`（UUID `223a3169-5a02-4801-965f-c6b309cb3568`），均 `ACTIVE`，已安装到本机 Provisioning Profiles。

本轮同时把审阅过的 HTML 座舱迁移进原生 `NativeCockpitView`/`CockpitWebView`（沙箱 `motuo://` 资源方案，录制/凭据/音频不进入 WebKit），加入 `InertialVelocityBridge`（15 秒上限、GPS 锚定 IMU 短时估速，带显式误差，不进入记录或学习真值）与 `EngineSoundService`（本机 RMS/FFT，不上传不回放）；修复了 demo 预演按钮与主按钮 aria-label 冲突、以及 `RootView` 沉浸模式条件误判（空闲态误隐藏 tab bar）两个真实 UI bug。35 项单测＋2 项 UI 测试在 iPhone 17 模拟器全部通过；`server` 36/36 集成测试无回归。

签名脚本沿用 WorkChat 项目的 App Store Connect API key（`ASC_KEY_ID`/`ASC_ISSUER_ID`，账户级而非 app 级，已确认对 motuo 有效）；私钥路径为本机 `~/.appstoreconnect/private_keys/` 下的 `.p8` 文件（不进仓库，具体 Key ID 不在此记录）。`0.2.0 (2)` iPhone+Watch 签名 IPA：8,772,952 字节，SHA-256 `ab343d91e01f9e3fa53ce3d753beb861a2a59a9f9a02d63c56057fede16dd2ce`。Apple 处理 `VALID`；已手动加入 `Motuo Internal` 测试组，内部状态回读 `IN_BETA_TESTING`。真机安装仍需你本人在 iPhone/Watch 上通过 TestFlight 接受并安装，本轮未做（无物理设备连接本机）。

开源地图（MapLibre/OSM/Martin/Valhalla/Ferrostar）与真机/硬件验收仍是独立未完成项，见 `docs/OPEN_MAPS.md` 与 `docs/PHYSICAL_ACCEPTANCE.md`。

## 10 月 21 日：`0.3.0 (3)` v3 漫画座舱发布

分支 `feature/v3-comic-cockpit`（未合并 main）。签名 IPA 来自独立构建目录 `~/Library/Developer/MotuoBuilds/0.3.0-3-fix1/`（不覆盖 0.2.0 (2) 归档）：9,459,363 字节，SHA-256 `f871796cdf48b275a45b65120168b1bf453a80fcbf2c62a7d95b7fd8c8c28d44`。2026-10-21 07:50（北京时间）Apple 返回 `UPLOAD SUCCEEDED`，Delivery/Build ID `d395e002-a87b-4ff4-936a-695d36f2f965`；约 4 分钟后处理为 `VALID`，`usesNonExemptEncryption=false`，已写入简体中文测试说明，手动加入 `Motuo Internal` 后回读 `IN_BETA_TESTING`，组内构建 3/2/1。未创建外部测试或公开链接。

包内含 C5913 GSX-R1000 近似 GLB（0.2.0 (2) 亦含），其再分发授权未核验，仅限本人内部测试；外部测试或公开发布前须取得授权或替换模型。真机安装、旋转手感、帧率、发热未验收。
