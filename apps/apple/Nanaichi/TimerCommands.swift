import NanaichiDomain
import NanaichiPresentation
import SwiftUI

/// メニューバーの「タイマー」。どの操作もキーボードでできるようにし、押せない操作は押せなくする。
/// ショートカットはここにだけ付ける（ボタンにも付けると、同じキーが2つに割り当たる）
struct TimerCommands: Commands {
    let model: TimerModel

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

/// 操作のキーボードショートカット。文字の入力欄と重ならないよう、どれも ⌘ と組み合わせる。
/// 矢印キーは入力欄のカーソル移動に使うので避ける
func shortcutOf(_ kind: SessionOperationKind) -> KeyboardShortcut {
    switch kind {
    case .pause: KeyboardShortcut("p")
    case .resume: KeyboardShortcut("r")
    // ⌘. は macOS で「取り消す」の決まったキー
    case .abort: KeyboardShortcut(".")
    case .restartFocus: KeyboardShortcut("r", modifiers: [.command, .shift])
    case .advance: KeyboardShortcut("]")
    case .skipBreak: KeyboardShortcut("]", modifiers: [.command, .shift])
    // 押し間違えて閉じないよう、⇧ も要る
    case .end: KeyboardShortcut("e", modifiers: [.command, .shift])
    }
}
