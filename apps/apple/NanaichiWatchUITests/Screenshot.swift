import XCTest

extension XCTestCase {
    /// Watch の画面全体を撮って PR で見られるようにする（`scripts/ui-test.sh` が名前の順に並べる）
    @MainActor
    func attachScreenshot(named name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
