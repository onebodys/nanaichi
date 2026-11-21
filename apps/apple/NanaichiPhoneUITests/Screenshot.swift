import XCTest

extension XCTestCase {
    /// 画面全体（ステータスバー・キーボード・通知のバナーを含む）を撮って PR で見られるようにする
    /// （`scripts/ui-test.sh` が名前の順に並べる）
    @MainActor
    func attachScreenshot(named name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
