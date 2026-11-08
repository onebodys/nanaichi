import XCTest

/// 画面を撮って PR で見られるようにする（`scripts/ui-test.sh` が名前の順に並べる）
final class ScreenshotTests: XCTestCase {
    @MainActor
    func testLaunch() throws {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.staticTexts["nanaichi"].waitForExistence(timeout: 5))
        attachScreenshot(of: app, named: "01-起動")
    }
}

extension XCTestCase {
    @MainActor
    func attachScreenshot(of app: XCUIApplication, named name: String) {
        let attachment = XCTAttachment(screenshot: app.windows.firstMatch.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
