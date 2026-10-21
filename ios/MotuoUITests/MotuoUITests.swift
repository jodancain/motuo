import XCTest

/// v3 comic cockpit flows on the simulator. With TEST_RUNNER_MOTUO_SHOWCASE=1 the same flows pause at key moments
/// (used for the screen recordings in artifacts/); assertions are identical either way.
final class MotuoUITests:XCTestCase {
    private let showcase = ProcessInfo.processInfo.environment["MOTUO_SHOWCASE"] == "1"
    override func setUpWithError() throws { continueAfterFailure=false; XCUIDevice.shared.orientation = .portrait }
    override func tearDown() { XCUIDevice.shared.orientation = .portrait; super.tearDown() }

    @MainActor func testDemoRidePauseFinishComicShareAndDetail() throws {
        let app=launch()
        let start=app.buttons["进入演示骑行"]
        XCTAssertTrue(start.waitForExistence(timeout:15))
        // The cockpit reports document.fonts: bundled faces must load in-App, not fall back to system fonts.
        XCTAssertTrue(app.staticTexts["座舱字体已加载 3/3"].waitForExistence(timeout:10), app.debugDescription)
        XCTAssertTrue(app.buttons["tab.garage"].exists, "standby keeps the single native tab bar")
        hold(2); addScreenshot("standby-portrait")
        assertFullBleed("standby-portrait", corners: [.topLeft, .topRight])
        start.tap()
        // The departure countdown runs before recording; the tab bar is already hidden.
        XCTAssertTrue(app.staticTexts["倒计时 · 出发后开始记录"].waitForExistence(timeout:3))
        XCTAssertFalse(app.buttons["tab.garage"].exists, "countdown is immersive"); addScreenshot("countdown")
        let pause=app.buttons["暂停"];XCTAssertTrue(pause.waitForExistence(timeout:10))
        XCTAssertTrue(app.staticTexts["路上见"].waitForExistence(timeout:5), "status title follows the native riding phase")
        XCTAssertFalse(app.buttons["tab.garage"].exists, "riding hides the native tab bar")
        assertSpeedVisible(app,"riding")
        sleep(1); assertFullBleed("riding-portrait")
        XCTAssertTrue(app.staticTexts["突破剧场播放中"].waitForExistence(timeout:20), "a milestone act plays on a real crossing")
        addScreenshot("theatre-portrait"); hold(6)
        pause.tap();XCTAssertTrue(app.buttons["继续骑行"].waitForExistence(timeout:5)); hold(3); addScreenshot("paused")
        app.buttons["继续骑行"].tap();XCTAssertTrue(pause.waitForExistence(timeout:5)); hold(4)
        app.buttons["结束"].tap()
        let confirm=app.buttons["结束并生成复盘"];XCTAssertTrue(confirm.waitForExistence(timeout:5))
        hold(1); addScreenshot("finish-dialog-open")
        confirm.tap()
        let save=openComic(app)
        XCTAssertFalse(app.staticTexts["好好收尾，下次见"].exists, "native detail waits for the comic")
        hold(3); addScreenshot("comic-portrait")
        XCTAssertTrue(app.staticTexts["座舱脚本正常"].exists, scriptError(app))
        save.tap()
        XCTAssertTrue(waitForShareSheet(app), "保存图片 opens the system share sheet"); hold(2); addScreenshot("share-sheet")
        dismissShareSheet(app)
        let detail=app.buttons["查看详细复盘"];XCTAssertTrue(detail.waitForExistence(timeout:5));detail.tap()
        XCTAssertTrue(app.staticTexts["好好收尾，下次见"].waitForExistence(timeout:10), app.debugDescription)
        hold(2); addScreenshot("native-detail")
        app.buttons["完成"].firstMatch.tap()
        XCTAssertTrue(app.buttons["tab.garage"].waitForExistence(timeout:5), "tab bar returns after the recap")
        app.buttons["tab.garage"].tap()
        XCTAssertTrue(app.staticTexts["认识你的机器"].waitForExistence(timeout:5))
        let learning = app.buttons["garage.learning"].firstMatch
        XCTAssertTrue(learning.waitForExistence(timeout: 5)); if !learning.isHittable { app.swipeUp() }; learning.tap()
        XCTAssertTrue(app.staticTexts["从你确认的片段学习"].waitForExistence(timeout: 5))
        app.buttons["完成"].firstMatch.tap()
        app.buttons["tab.settings"].tap()
        XCTAssertTrue(app.staticTexts["按你的节奏设定"].waitForExistence(timeout:5))
    }

    @MainActor func testInterruptedRideRequiresExplicitResume() throws {
        let app=launch()
        XCTAssertTrue(app.buttons["进入演示骑行"].waitForExistence(timeout:15))
        app.buttons["进入演示骑行"].tap()
        XCTAssertTrue(app.buttons["暂停"].waitForExistence(timeout:10))
        app.terminate();app.launch()
        XCTAssertTrue(app.buttons["继续骑行"].waitForExistence(timeout:15))
        XCTAssertFalse(app.buttons["暂停"].exists)
        app.buttons["继续骑行"].tap()
        let resumed = app.buttons["暂停"].waitForExistence(timeout:5)
        if !resumed { addScreenshot("recovery-resume-failure") }
        XCTAssertTrue(resumed, app.debugDescription)
        app.buttons["结束"].tap();app.buttons["结束并生成复盘"].tap()
        _ = openComic(app)
        app.buttons["完成"].firstMatch.tap()
        XCTAssertTrue(app.buttons["tab.garage"].waitForExistence(timeout:5))
    }

    /// Rotation while riding and while a milestone act plays: speed stays readable, recording time keeps counting, no crash.
    @MainActor func testRotationDuringRideAndMilestoneTheatre() throws {
        let app=launch()
        let start=app.buttons["进入演示骑行"];XCTAssertTrue(start.waitForExistence(timeout:15));start.tap()
        // Rotate during the countdown too: it keeps going and still hands over to recording.
        XCTAssertTrue(app.staticTexts["倒计时 · 出发后开始记录"].waitForExistence(timeout:3))
        rotate(app, .landscapeLeft)
        XCTAssertTrue(app.buttons["暂停"].waitForExistence(timeout:12), "countdown survived rotation")
        rotate(app, .portrait)
        assertSpeedVisible(app,"riding-portrait")
        let first=clock(app)
        XCTAssertTrue(app.staticTexts["突破剧场播放中"].waitForExistence(timeout:20))
        for (i,o) in [UIDeviceOrientation.landscapeLeft,.landscapeRight,.portrait].enumerated(){
            rotate(app, o)
            assertSpeedVisible(app,"theatre-\(i)")
            sleep(1); assertFullBleed("riding-\(o.rawValue)")
            XCTAssertTrue(app.staticTexts.matching(NSPredicate(format:"label BEGINSWITH %@",o == .portrait ? "布局 竖屏":"布局 横屏")).firstMatch.waitForExistence(timeout:3),"web relaid out for \(o.rawValue)")
            addScreenshot("theatre-rotate-\(i)-\(o == .portrait ? "portrait":o == .landscapeLeft ? "landscapeLeft":"landscapeRight")"); hold(1.5)
        }
        // A second act, rotated while it plays.
        XCTAssertTrue(app.staticTexts["突破剧场播放中"].waitForExistence(timeout:20))
        for o in [UIDeviceOrientation.landscapeRight,.landscapeLeft,.portrait]{ rotate(app, o); assertSpeedVisible(app,"theatre-2-\(o.rawValue)"); hold(1) }
        XCTAssertTrue(app.staticTexts["座舱脚本正常"].exists, scriptError(app))
        XCTAssertTrue(app.staticTexts["突破剧场空闲"].waitForExistence(timeout:12), "acts end cleanly after rotation (no stuck layer): \(scriptError(app))")
        let later=clock(app)
        XCTAssertGreaterThan(later,first,"recording time keeps counting through rotations")
        XCTAssertFalse(app.buttons["tab.garage"].exists, "still immersive")
        // Paused, then rotate.
        app.buttons["暂停"].tap();XCTAssertTrue(app.buttons["继续骑行"].waitForExistence(timeout:5))
        rotate(app, .landscapeLeft); assertSpeedVisible(app,"paused-landscape"); addScreenshot("paused-landscapeLeft")
        rotate(app, .portrait)
        XCTAssertEqual(app.state, .runningForeground)
        app.buttons["继续骑行"].tap(); XCTAssertTrue(app.buttons["暂停"].waitForExistence(timeout:5))
        app.buttons["结束"].tap();app.buttons["结束并生成复盘"].tap()
        _ = openComic(app)
        app.buttons["完成"].firstMatch.tap()
    }

    /// Standby and the comic page in both landscapes; garage “外观与配色” opens the cockpit's comic garage and persists.
    @MainActor func testStandbyAndComicRotationAndGarageAppearance() throws {
        let app=launch()
        let start=app.buttons["进入演示骑行"];XCTAssertTrue(start.waitForExistence(timeout:15))
        for (name,o) in [("landscapeLeft",UIDeviceOrientation.landscapeLeft),("landscapeRight",.landscapeRight),("portrait",.portrait)]{
            rotate(app, o)
            XCTAssertTrue(start.waitForExistence(timeout:5)); XCTAssertTrue(waitHittable(start), "start reachable in \(name)")
            XCTAssertTrue(app.buttons["tab.garage"].isHittable, "one tab bar in \(name)")
            hold(2); addScreenshot("standby-\(name)")
        }
        // Garage → 外观与配色 → the cockpit's comic garage sheet; choose 曜石黑; the native garage shows it after.
        let appearance=app.buttons["garage.appearance"].firstMatch
        // Right after the last rotation the tab bar may still be settling; retry the tap once.
        for _ in 0..<3 where !appearance.exists { _ = waitHittable(app.buttons["tab.garage"]); app.buttons["tab.garage"].tap(); _ = appearance.waitForExistence(timeout:3) }
        XCTAssertTrue(appearance.exists)
        if !appearance.isHittable { app.swipeUp() }; appearance.tap()
        XCTAssertTrue(app.staticTexts["外观与配色"].waitForExistence(timeout:6), "comic garage sheet opened in the cockpit")
        hold(1); addScreenshot("comic-garage")
        let stealth=swatch(app,"曜石黑");XCTAssertTrue(stealth.waitForExistence(timeout:5));stealth.tap(); hold(2); addScreenshot("comic-garage-stealth")
        swatch(app,"冰川蓝").tap(); hold(2); stealth.tap(); hold(1)
        app.buttons["关闭"].firstMatch.tap()
        app.buttons["tab.garage"].tap()
        XCTAssertTrue(appearance.waitForExistence(timeout:5))
        XCTAssertTrue(appearance.label.contains("曜石黑"), "appearance persisted natively: \(appearance.label)")
        app.buttons["tab.cockpit"].tap()
        // Ride briefly, finish, then rotate the comic page.
        XCTAssertTrue(start.waitForExistence(timeout:5)); start.tap()
        XCTAssertTrue(app.buttons["暂停"].waitForExistence(timeout:12)); hold(8)
        app.buttons["结束"].tap();app.buttons["结束并生成复盘"].tap()
        let save=openComic(app)
        for (name,o) in [("landscapeLeft",UIDeviceOrientation.landscapeLeft),("landscapeRight",.landscapeRight),("portrait",.portrait)]{
            rotate(app, o)
            XCTAssertTrue(waitHittable(save), "保存图片 reachable in \(name)"); XCTAssertTrue(app.buttons["查看详细复盘"].isHittable)
            hold(1.5); addScreenshot("comic-\(name)")
        }
        app.buttons["完成"].firstMatch.tap()
        XCTAssertTrue(app.buttons["tab.garage"].waitForExistence(timeout:5))
    }

    // MARK: helpers
    @MainActor private func launch()->XCUIApplication{
        let app=XCUIApplication();app.launchArguments=["-demoMode","YES"];app.launch()
        finishInterruptedDemoIfPresent(app); return app
    }
    @MainActor private func finishInterruptedDemoIfPresent(_ app: XCUIApplication) {
        // A previous failed UI run can leave its explicitly simulated ride interrupted.
        // Keep its recording and finish through the real UI before creating this test's ride.
        guard app.buttons["继续骑行"].waitForExistence(timeout:6) else { return }
        app.buttons["结束"].tap(); app.buttons["结束并生成复盘"].tap()
        _ = openComic(app)
        app.buttons["完成"].firstMatch.tap()
    }
    /// After a native finish the cockpit plays its comic first; returns its 保存图片 button.
    @MainActor @discardableResult private func openComic(_ app: XCUIApplication)->XCUIElement{
        let save=app.buttons["保存图片"]
        XCTAssertTrue(save.waitForExistence(timeout:12), "comic recap did not appear: \(app.debugDescription)")
        XCTAssertTrue(app.buttons["查看详细复盘"].exists); XCTAssertTrue(app.buttons["完成"].exists)
        XCTAssertFalse(app.buttons["tab.garage"].exists, "comic is full screen")
        return save
    }
    @MainActor private func assertSpeedVisible(_ app: XCUIApplication,_ name:String){
        let speed=app.descendants(matching:.any).matching(NSPredicate(format:"label BEGINSWITH %@","速度 ")).firstMatch
        XCTAssertTrue(speed.waitForExistence(timeout:3), "speed missing (\(name))")
        let frame=speed.frame,window=app.windows.firstMatch.frame
        XCTAssertTrue(frame.width>20 && frame.height>20 && window.intersects(frame) && window.insetBy(dx:-2,dy:-2).contains(CGPoint(x:frame.midX,y:frame.midY)), "speed off screen (\(name)): \(frame) in \(window)")
    }
    /// Rotate and wait until the app window really has the new orientation. A request issued while the previous
    /// rotation is still animating can be ignored by the simulator, so retry instead of racing it.
    @MainActor private func rotate(_ app: XCUIApplication, _ o: UIDeviceOrientation, file: StaticString = #filePath, line: UInt = #line) {
        let landscape = o.isLandscape
        for attempt in 0..<4 {
            if attempt > 0 { XCUIDevice.shared.orientation = .faceUp; usleep(300_000) }
            XCUIDevice.shared.orientation = o
            let end = Date().addingTimeInterval(3)
            while Date() < end {
                let f = app.windows.firstMatch.frame
                if f.width > 0, (f.width > f.height) == landscape { usleep(250_000); return }
                usleep(150_000)
            }
        }
        XCTFail("app did not rotate to \(o.rawValue)", file: file, line: line)
    }
    @MainActor private func swatch(_ app: XCUIApplication,_ name:String)->XCUIElement{
        // Swatches are aria-pressed toggles, which WebKit exposes as switches.
        let toggle=app.switches[name].firstMatch
        return toggle.waitForExistence(timeout:3) ? toggle:app.buttons.matching(NSPredicate(format:"label CONTAINS %@",name)).firstMatch
    }
    @MainActor private func scriptError(_ app: XCUIApplication)->String{
        app.staticTexts.matching(NSPredicate(format:"label BEGINSWITH %@","座舱脚本")).firstMatch.label
    }
    @MainActor private func clock(_ app: XCUIApplication)->Int{
        let label=app.staticTexts.matching(NSPredicate(format:"label BEGINSWITH %@","骑行计时")).firstMatch.label
        return Int(label.filter(\.isNumber)) ?? -1
    }
    @MainActor private func waitHittable(_ element: XCUIElement,timeout:Double=4)->Bool{
        let end=Date().addingTimeInterval(timeout); while Date()<end { if element.exists && element.isHittable { return true }; usleep(200_000) }; return false
    }
    @MainActor private func waitForShareSheet(_ app: XCUIApplication)->Bool{
        let end=Date().addingTimeInterval(8)
        while Date()<end { if app.otherElements["ActivityListView"].exists || app.buttons["关闭"].exists || app.buttons["Close"].exists || app.navigationBars["UIActivityContentView"].exists { return true }; usleep(250_000) }
        return false
    }
    @MainActor private func dismissShareSheet(_ app: XCUIApplication){
        for label in ["关闭","Close"] where app.buttons[label].exists { app.buttons[label].firstMatch.tap(); return }
        app.swipeDown(velocity:.fast)
    }
    /// Full-bleed scene: the screenshot's corners must not be the beige paper margin (#f3ead6).
    private enum Corner { case topLeft, topRight, bottomLeft, bottomRight }
    private func assertFullBleed(_ name:String, corners:[Corner] = [.topLeft,.topRight,.bottomLeft,.bottomRight], file:StaticString = #filePath, line:UInt = #line){
        guard let image=XCUIScreen.main.screenshot().image.cgImage else { XCTFail("no screenshot"); return }
        let w=image.width,h=image.height
        guard let data=image.dataProvider?.data,let bytes=CFDataGetBytePtr(data) else { XCTFail("no pixels"); return }
        let bpp=image.bitsPerPixel/8,row=image.bytesPerRow,bgra=image.bitmapInfo.contains(.byteOrder32Little)
        for corner in corners {
            let x = corner == .topLeft || corner == .bottomLeft ? 6 : w-7, y = corner == .topLeft || corner == .topRight ? 6 : h-7
            let p=bytes+y*row+x*bpp
            let (r,g,b)=bgra ? (Int(p[2]),Int(p[1]),Int(p[0])) : (Int(p[0]),Int(p[1]),Int(p[2]))
            XCTAssertFalse(abs(r-243)<14 && abs(g-234)<14 && abs(b-214)<14, "\(name): beige paper margin at \(corner) rgb(\(r),\(g),\(b))", file:file, line:line)
        }
    }
    private func hold(_ seconds:Double){ if showcase { usleep(UInt32(seconds*1_000_000)) } }
    private func addScreenshot(_ name:String) { let attachment=XCTAttachment(screenshot:XCUIScreen.main.screenshot());attachment.name=name;attachment.lifetime = .keepAlways;add(attachment) }
}
