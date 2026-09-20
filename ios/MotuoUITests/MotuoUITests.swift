import XCTest

final class MotuoUITests:XCTestCase {
    override func setUpWithError() throws { continueAfterFailure=false }
    @MainActor func testDemoRidePauseFinishAndGarage() throws {
        let app=XCUIApplication();app.launchArguments=["-demoMode","YES"];app.launch()
        finishInterruptedDemoIfPresent(app)
        let start=app.buttons["进入演示骑行"]
        XCTAssertTrue(start.waitForExistence(timeout:15))
        if !start.isHittable { app.swipeUp() };start.tap()
        let pause=app.buttons["暂停"];XCTAssertTrue(pause.waitForExistence(timeout:5))
        addScreenshot("portrait-hud")
        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertTrue(pause.waitForExistence(timeout:5))
        addScreenshot("landscape-hud")
        pause.tap();XCTAssertTrue(app.buttons["继续骑行"].waitForExistence(timeout:5))
        app.buttons["继续骑行"].tap();app.buttons["结束"].tap()
        app.buttons["结束并生成复盘"].tap()
        XCTAssertTrue(app.staticTexts["好好收尾，下次见"].waitForExistence(timeout:10))
        addScreenshot("ride-recap")
        app.buttons["完成"].firstMatch.tap()
        XCUIDevice.shared.orientation = .portrait
        app.buttons["tab.garage"].tap()
        XCTAssertTrue(app.staticTexts["认识你的机器"].waitForExistence(timeout:5))
        addScreenshot("garage")
        let learning = app.buttons["garage.learning"].firstMatch
        XCTAssertTrue(learning.waitForExistence(timeout: 5)); if !learning.isHittable { app.swipeUp() }; learning.tap()
        XCTAssertTrue(app.staticTexts["从你确认的片段学习"].waitForExistence(timeout: 5))
        app.buttons["完成"].firstMatch.tap()
        app.buttons["tab.settings"].tap()
        XCTAssertTrue(app.staticTexts["按你的节奏设定"].waitForExistence(timeout:5))
        addScreenshot("settings")
    }
    @MainActor func testInterruptedRideRequiresExplicitResume() throws {
        let app=XCUIApplication();app.launchArguments=["-demoMode","YES"];app.launch()
        finishInterruptedDemoIfPresent(app)
        XCTAssertTrue(app.buttons["进入演示骑行"].waitForExistence(timeout:10))
        app.buttons["进入演示骑行"].tap()
        XCTAssertTrue(app.buttons["暂停"].waitForExistence(timeout:5))
        app.terminate();app.launch()
        XCTAssertTrue(app.buttons["继续骑行"].waitForExistence(timeout:10))
        XCTAssertFalse(app.buttons["暂停"].exists)
        app.buttons["继续骑行"].tap()
        let resumed = app.buttons["暂停"].waitForExistence(timeout:5)
        if !resumed { addScreenshot("recovery-resume-failure") }
        XCTAssertTrue(resumed, app.debugDescription)
        app.buttons["结束"].tap();app.buttons["结束并生成复盘"].tap()
        XCTAssertTrue(app.staticTexts["好好收尾，下次见"].waitForExistence(timeout:10))
        app.buttons["完成"].firstMatch.tap()
    }
    @MainActor private func finishInterruptedDemoIfPresent(_ app: XCUIApplication) {
        // A previous failed UI run can leave its explicitly simulated ride interrupted.
        // Keep its recording and finish through the real UI before creating this test's ride.
        guard app.buttons["继续骑行"].exists, app.staticTexts["DEMO · 模拟数据"].exists else { return }
        app.buttons["结束"].tap(); app.buttons["结束并生成复盘"].tap()
        XCTAssertTrue(app.staticTexts["好好收尾，下次见"].waitForExistence(timeout:10), app.debugDescription)
        app.buttons["完成"].firstMatch.tap()
    }
    private func addScreenshot(_ name:String) { let attachment=XCTAttachment(screenshot:XCUIScreen.main.screenshot());attachment.name=name;attachment.lifetime = .keepAlways;add(attachment) }
}
