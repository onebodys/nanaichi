import NanaichiDomain
import NanaichiPresentation
import SwiftUI

/// メニューバーの「タイマー」。どの操作もキーボードでできるようにし、押せない操作は押せなくする。
/// ショートカットはここにだけ付ける（ボタンにも付けると、同じキーが2つに割り当たる）
struct TimerCommands: Commands {
    let app: AppModel
    /// 記録先が替わると、そのときの画面の状態を指す
    private var model: TimerModel { app.services.timer }

    init(model: AppModel) {
        app = model
    }

    var body: some Commands {
        // 「新規ウインドウ」の代わりに置く。ウィンドウは1つなので、新しく作るのはセッション
        CommandGroup(replacing: .newItem) {
            Button("セッションを開始") { model.start() }
                .keyboardShortcut("n")
                .disabled(!model.canStart)
        }
        CommandMenu("タイマー") {
            ForEach(menuOperations, id: \.self) { kind in
                Button(menuTextOf(kind)) { model.operate(kind) }
                    .keyboardShortcut(shortcutOf(kind))
                    .disabled(!model.canOperate(kind))
            }
            Divider()
            Button("ジャーナル記入へ移動") { model.focusJournal() }
                .keyboardShortcut("j")
                .disabled(model.view.writableSession == nil)
        }
    }
}

/// メニューに並べる順。止める・進める・閉じるの順にまとめる
private let menuOperations: [SessionOperationKind] = [
    .pause, .resume, .abort, .restartFocus, .advance, .skipBreak, .end,
]

/// メニューの項目名。「終了」だけではアプリの終了と紛らわしいので、セッションを閉じると言う
private func menuTextOf(_ kind: SessionOperationKind) -> String {
    switch kind {
    case .end: "セッションを終了"
    case .pause, .resume, .abort, .restartFocus, .skipBreak, .advance: operationTextOf(kind)
    }
}
