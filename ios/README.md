# MOTUO native app

iOS 18+ / watchOS 11+ native SwiftUI app. Entry point `Motuo/MotuoApp.swift`; XcodeGen specification `project.yml`. UIKit lifecycle, SwiftData metadata, CoreLocation, CoreMotion, MusicKit, WatchConnectivity and PDFKit are used directly.

## Build and verification

```sh
cd ios
xcodegen generate
xcodebuild -project Motuo.xcodeproj -scheme Motuo -configuration Debug -destination 'generic/platform=iOS Simulator' build
xcodebuild -project Motuo.xcodeproj -scheme Motuo -destination 'platform=iOS Simulator,name=iPhone 17' test
```

The complete app embeds its Watch companion. Xcode requires the corresponding watchOS platform/runtime component even for the complete iPhone simulator scheme. Debug uses automatic signing, including simulator builds: disabling code signing omits the simulator application identifier and prevents Keychain pairing. Do not substitute insecure token storage. Release uses the separately provisioned `Motuo App Store` and `Motuo Watch App Store` profiles for Team `7NUGZ3A48C`.

Earlier 2026-09-14 evidence: the complete iPhone + embedded Watch XcodeGen scheme compiled, installed and passed 6 unit tests plus an end-to-end UI flow on iPhone 17 / iOS 26.5 after installing the watchOS 26.5 runtime. Result bundle: `/tmp/motuo-full-tests-2.xcresult`. A second UI test forcibly terminates an active demo ride, relaunches, verifies explicit resume is required, resumes and finishes successfully (`/tmp/motuo-recovery-tests.xcresult`). The tests cover invalid speed versus measured standstill, millisecond timestamp encoding, bounded atomic telemetry chunks, truncated-tail recovery, haptic TTL/deduplication/cooldown, candidate-event counterexamples, and demo start/pause/resume/finish with portrait/landscape HUD, recap, garage and settings. The Watch companion also installed and launched on the paired Apple Watch Ultra 3 simulator. Screenshots under `Screenshots/` contain clearly marked simulated data. Physical-device sensor continuity, physical Watch haptic output, real accessory compatibility, NAS API acceptance and distribution remain separate gates.

The app renders its road grid with SwiftUI Canvas and GPU-backed gradients. `ShaderExperiments/EnergyGlow.metal` preserves the custom shader experiment but is outside the app target: this Xcode installation lacks Metal Toolchain and Apple's component catalog download failed. Lottie integration is guarded by `canImport(Lottie)`; its official 4.6.1 binary download failed TLS verification in the current network, so the package is not a mandatory build dependency. Neither dependency failure is represented as an app feature success.

## Data and lifecycle

- Live measurements and demo data never share a ride. No RPM, neutral, exact gear or calibrated vehicle lean-angle number is generated from phone motion.
- CoreLocation update cadence is observed, not promised. Invalid, stale and imprecise speeds remain absent; `validSpeedSamples` distinguishes unknown speed from measured standstill.
- IMU sampling targets 50 Hz, UI publishing 10 Hz, visual rendering 60 fps / 30 fps under thermal limits. Telemetry includes stream and segmentId. Only elapsed time within the recording segment leaves the phone; raw system uptime stays in memory. Motion is mapped from hardware elapsed time to a wall anchor; GPS retains CLLocation capture time and derives relative segment time from that timestamp. Cross-stream callback ordering is unrestricted; per-stream duplicates/pre-segment samples are rejected. Rendering never creates telemetry.
- `TelemetryJournal` writes JSONL through one serial queue, syncs periodically, commits bounded chunks with SHA-256 and an atomic manifest, and recovers only complete lines from an interrupted tail. Metadata is saved during a ride. A reopened unfinished ride is marked interrupted until explicitly resumed or finished.
- Pause/resume uses monotonic active duration and does not bridge GPS distance across missing or paused intervals. App termination recovery is a local recording gate, not proof of uninterrupted background IMU.
- Finished rides receive an immediate local summary. NAS upload uses ride/sequence/hash idempotency; AI reports are applied only to the matching data version. Event feedback retains the original inference and time window; it never automatically becomes sensor-measured truth. Human labels can generate a conservative personal candidate threshold under the collection and holdout requirements below; they are not claimed to establish real-world shift-detection accuracy.
- Vehicle profiles, local maintenance notes, ride metadata and telemetry persist independently of NAS availability. Existing NAS vehicles are restored after pairing without overwriting edited local profiles. A pristine, unused seeded GSX250R can adopt its matching NAS identity.
- PDF uploads are streamed in bounded blocks. An interrupted upload ticket is keyed by server, vehicle and original SHA-256, so selecting the same PDF retries the same upload. Quotes link to physical PDF page numbers and open the authenticated original with PDFKit after its initial layout; the reader displays the actual physical page index.
- Device credentials belong to the parent-owned `Integrations/APIClient` and remain in Keychain. No PDF, credential or measured route is bundled with the app.

## Hardware and service boundaries

Navigation currently searches places and opens AMap for the rider to choose a motorcycle route; no external navigation instruction is invented or read back into the HUD. Apple Music supports authorization, catalogue search, library playlists and playback when the account/service allows it. The accessory UI exposes actual BLE/Wi-Fi discovery and the documented HUD transport, not universal TPMS or ECU compatibility.

Watch haptic events are immediate, expiring and deduplicated. Start, finish and milestone events have separate preferences under the master toggle. A finished ride retains a Watch summary with distance/time; external navigation shows the selected destination and an AMap handoff message without fabricated turns. An inactive/unreachable watch skips feedback; a transport ACK is not proof of physical vibration. No HealthKit or extended-runtime session is used to keep the motorcycle app alive.

## Local integration evidence (2026-09-14)

The signed simulator UI paired with the isolated local API on port 59819, restored its explicitly named TEST vehicle, loaded the 616-page GSX250R manual, asked a natural-language tyre-pressure question, and opened physical PDF page 359 / printed page 2D-17. The test revealed and fixed the initial PDF layout jump and an overly broad first search hit. A relaunch retained Keychain credentials. This local test database is separate from deployed NAS acceptance. Original manual page screenshots stay under `.private/ui-verification/`, outside source control.

The compiled `scripts/HUDSimulator.swift` fixture was discovered through Bonjour and connected by selecting Wi-Fi. Actual received frames were emitted about once a second, marked simulated, with kmh units. Pausing omitted the speed field; stopping the fixture produced the App's disconnected state. See `Screenshots/wifi-hud-evidence.json`. This tests the local protocol fixture, not a physical HUD or BLE sensor.

A 63-point demo ride using the new stream/segment format was uploaded and accepted through the native sync UI. Signed sensor/time/Watch-summary/calibration unit tests passed 11/11 in `/tmp/motuo-sensor-tests.xcresult`. The final 2026-09-20 run below supersedes this test count.


## Personal learning and deletion (2026-09-20)

The garage's **车辆学习与版本** screen collects only manually confirmed/rejected `suspectedShift` windows from finished measured rides with the same installation calibration UUID. It verifies committed chunk SHA-256, filters simulated/AI/unconfirmed samples, uses original event timestamps, and refuses to bridge a jerk calculation across recording segments or missing samples. Changed labels invalidate any version that used that ride; deleting a ride removes dependent learning versions.

A candidate requires at least four rides and twelve eligible windows. The newest complete ride is held out before fitting. The training partition needs at least three positive and three negative labels; the holdout needs both labels. Training chooses a bounded jerk threshold (18–40 m/s³, default 22); a holdout regression or absent class leaves the default in place. A generated candidate is inactive until explicitly selected, and defaults or previous valid versions can be restored. The selected version ID is recorded on the ride and its threshold is used by `RideSignalProcessor`; simulation never uses it. Vehicle/calibration mismatches cannot activate a version.

The displayed vibration baseline is the median acceleration RMS of the *training event windows*, including manually rejected candidates. This is a selected-window reference, not a whole-ride or healthy-vehicle vibration standard. Because labels originate from candidate detection, the dataset cannot measure missed events or general riding prevalence. These consistency checks are not a real-world accuracy claim; independent hardware-labelled ride validation remains open.

Account deletion clears local learning versions, calibration profiles and in-memory calibration samples, ride/summary memory, navigation destination/search state and pending Watch summary. An empty Watch context is persisted for delivery if WatchConnectivity is not active; a later active session replaces the previous application context. This is a transport cleanup mechanism, not evidence of a disconnected physical Watch having received it.

## Pre-review simulator regression (2026-09-20)

Normal Debug automatic signing built the complete iPhone app with its embedded Watch app. The final run passed **18 unit tests and 2 UI tests, zero failures** in `/tmp/motuo-final-tests-20260920c.xcresult` (log: `/tmp/motuo-final-tests-20260920c.log`). It covers the earlier sensor/time/calibration/telemetry/Watch gates plus checksum rejection, calibration/source isolation, original-window features, whole-ride holdout, insufficient labels, failed candidate checks, activation/rollback/invalidation/deletion and the detector's actual threshold path. UI regression opens the garage learning screen and exercises portrait/landscape demo recording, pause/resume/finish and force-quit recovery. The app's simulated entitlement contains `7NUGZ3A48C.cn.yundongyl.motuo`; code signing was not disabled.

The obsolete `MotuoWatch/Info 2.plist` duplicate was preserved under `.private/stale-project-files/` and removed from build resources. This local test gate does not establish TestFlight processing, account subscription playback, physical sensor accuracy, physical Watch output, real HUD compatibility or the 60-minute road test.

## Release review hardening (2026-09-20)

The release review found and fixed two persistence paths that could announce a finished ride after storage failure. Metadata-save or telemetry-flush failure now keeps the ride interrupted with its `activeRideID` and existing journal. No completion recap, completion haptic or automatic finish sync occurs until persistence succeeds. Explicit retry verifies the previously committed blocks and recovers complete trailing JSONL rows; an incomplete final row remains a documented data gap. Resume also completes persistence before starting sensors. The tests inject a metadata save failure and provoke a real manifest write failure, then verify that a second finish actually succeeds while preserving committed checksums and complete rows.

Fresh journal recovery now reads and verifies existing manifest bytes/SHA-256 before using confirmed blocks. Missing or altered confirmed blocks, invalid manifests, noncontiguous blocks and malformed unconfirmed rows stop recovery with the original files preserved. A complete trailing block moved before an interrupted manifest write can still be recovered. Checksums are not silently regenerated for already-confirmed data.

API operations capture a connection identity. Changing the service, beginning a new pairing attempt or unpairing makes earlier responses stale. Stale responses cannot write credentials under another service, recreate a cleared PDF cache or apply a previous server's result. Pairing writes its token to the fixed request account without suspension, and stale/error PDF temporary files are removed. Tests use controlled asynchronous transports without contacting external services or writing real Keychain secrets.

The intermediate `d` run passed 27 unit tests but failed the portrait force-quit/resume UI step. Its original video and accessibility hierarchy showed the resume control overlapping the ScrollView hit-test region with no persistence error alert. The portrait controls now occupy a separate fixed VStack region outside the ScrollView. Test coordinates and wait limits were not changed; the final regression below must pass before publication.


## Final release gate (2026-09-20, 11:33)

The superseding final run **passed 31 unit tests and 2 UI tests, zero failures**, with `TEST SUCCEEDED` in `/tmp/motuo-final-tests-20260920e.log` and result bundle `/tmp/motuo-final-tests-20260920e.xcresult`. This run includes all release-review fixes, the correct 0.1.0 version configuration, the bundled MIT notice, normal Debug signing and the embedded Watch application. The original portrait resume tap coordinates and timeout remained unchanged and now pass after moving the controls outside the scrolling hit-test area. The final `Screenshots/*-iceblue.png` files are exported from this run; they contain only labelled simulated riding screens, garage and settings, never original manual pages.

The intermediate failing run remains at `/tmp/motuo-final-tests-20260920d.xcresult`; the extracted failure evidence remains `/tmp/motuo-recovery-failure.mp4`, `/tmp/motuo-recovery-ui-hierarchy.txt` and `/tmp/motuo-recovery-frame24.png`. Only the `e` result represents the final local regression gate. Release Archive/Export, App Store Connect processing and physical-device acceptance are separately reported in the root project status.
