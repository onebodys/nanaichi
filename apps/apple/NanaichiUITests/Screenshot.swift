import XCTest

extension XCTestCase {
    /// 画面を撮って PR で見られるようにする（`scripts/ui-test.sh` が名前の順に並べる）
    @MainActor
    func attachScreenshot(of app: XCUIApplication, named name: String) {
        let attachment = XCTAttachment(screenshot: app.windows.firstMatch.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
