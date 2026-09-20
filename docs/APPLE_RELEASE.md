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
