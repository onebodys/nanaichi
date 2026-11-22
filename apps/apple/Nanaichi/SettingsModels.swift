import AppKit
import Foundation
import NanaichiDomain
import NanaichiPresentation
import Observation

/// フェーズの進め方（GLOSSARY、ADR 0016）。記録先ごとの設定なので、記録先に置いて読み書きする（Web の use-advance-mode.ts）。
///
/// 変えたら、押した見た目がすぐ変わるよう先に手元を替え、変えられなければ元に戻す。
/// 変えるとセッションの状態が変わりうるが、それは記録先がセッションの変更として送るのでタイマーが受け取る
@Observable
@MainActor
final class AdvanceModeModel {
    private(set) var mode: Loadable<AdvanceMode> = .loading
    private(set) var errorMessage: String?

    @ObservationIgnored private let backend: any Backend

    init(backend: any Backend) {
        self.backend = backend
    }

    func run() async {
        for await event in await backend.subscribe() {
            switch event {
            case .connected: mode = mode.replacing(with: await backend.getAdvanceMode())
            case .message(.advanceModeChanged(let changed)): mode = .loaded(changed)
            case .message(.sessionChanged), .message(.journalEntrySaved), .message(.journalEntryDeleted),
                .message(.tagDeleted), .message(.taskSaved), .message(.taskDeleted), .message(.taskSettingChanged),
                .message(.recordsImported):
                break
            }
        }
    }

    func change(_ transition: PhaseTransition, to choice: AdvanceChoice) {
        guard var next = mode.value else { return }
        let before = mode
        next[transition] = choice
        mode = .loaded(next)
        errorMessage = nil
        Task {
            switch await backend.changeAdvanceMode(next) {
            case .success(let changed): mode = .loaded(changed)
            case .failure(let error):
                mode = before
                errorMessage = advanceModeErrorMessageOf(error)
            }
        }
    }
}

/// 画面の明るさを、好みに合わせてアプリのすべてのウィンドウに当てる。Mac に合わせるならシステムの設定に従う
@MainActor
func applyTheme(_ preference: ThemePreference) {
    switch preference {
    case .system: NSApp.appearance = nil
    case .light: NSApp.appearance = NSAppearance(named: .aqua)
    case .dark: NSApp.appearance = NSAppearance(named: .darkAqua)
    }
}

/// UserDefaults のキー。`@AppStorage` で読む値をまとめておく
enum PreferenceKey {
    static let submitKey = "submitKey"
    static let theme = "theme"
    /// メニューバーにタイマーを出すか。初めは出す
    static let showsMenuBarExtra = "showsMenuBarExtra"
    /// 最後のウィンドウを閉じても終了せず、メニューバー（と Dock）に残るか。初めは残る
    static let keepsRunningWithoutWindows = "keepsRunningWithoutWindows"

    /// `@AppStorage` の外（AppDelegate）でも、まだ選んでいない設定を初めの値で読めるようにする
    static var initialValues: [String: Any] { [showsMenuBarExtra: true, keepsRunningWithoutWindows: true] }
}
