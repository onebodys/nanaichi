import XCTest

extension XCTestCase {
    /// 画面を撮って PR で見られるようにする（`scripts/ui-test.sh` が名前の順に並べる）
    @MainActor
    func attachScreenshot(of app: XCUIApplication, named name: String) {
        attachScreenshot(ofElement: app.windows.firstMatch, named: name)
    }

    /// ウィンドウ以外（メニューバーの表示やパネル）を撮る
    @MainActor
    func attachScreenshot(ofElement element: XCUIElement, named name: String) {
        let attachment = XCTAttachment(screenshot: element.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
