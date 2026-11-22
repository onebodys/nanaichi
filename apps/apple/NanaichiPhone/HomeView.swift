import NanaichiPresentation
import SwiftUI
import UIKit

/// iPhone のホーム（docs/PRODUCT.md「画面」）。Web のスマホと同じく、上にタイマー、その下にジャーナル記入。
/// タイムラインは出さない（Issue #70 のやらないこと）。iPad でも同じ画面を、読みやすい幅にして中央に置く
struct HomeView: View {
    let timer: TimerModel
    /// アカウントの画面を開く
    let openAccount: () -> Void

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 0) {
                        TimerPane(model: timer)
                            .id(timerAnchor)
                        Divider()
                        JournalComposer(model: timer)
                            .padding(20)
                            .id(journalAnchor)
                    }
                    .frame(maxWidth: 640)
                    .frame(maxWidth: .infinity)
                }
                .scrollDismissesKeyboard(.interactively)
                // ジャーナルのフェーズに入って入力欄にカーソルを置いたら、キーボードに隠れないところまで送る。
                // ジャーナルが終わったら、フェーズと残り時間が見えるようタイマーへ戻す
                .onChange(of: timer.view.journalPhase) { _, phase in
                    withAnimation {
                        if phase != nil {
                            proxy.scrollTo(journalAnchor, anchor: .bottom)
                        } else {
                            proxy.scrollTo(timerAnchor, anchor: .top)
                        }
                    }
                }
            }
            .navigationTitle("nanaichi")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(action: openAccount) {
                        Label("アカウント", systemImage: "person.crop.circle")
                    }
                    .accessibilityIdentifier("toolbar.account")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    TodayFocusView(today: timer.todayFocus)
                }
            }
        }
        // セッション中は画面の自動消灯を防ぐ（docs/PRODUCT.md「タイマー」）
        .onChange(of: timer.view.isInSession, initial: true) { _, inSession in
            UIApplication.shared.isIdleTimerDisabled = inSession
        }
    }
}

private let timerAnchor = "timer"
private let journalAnchor = "journal"

/// 記録先が替わったら、ホームを作り直す（Web でページを読み込み直すのと同じ、ADR 0019）。前の記録先の画面の状態
/// （`@State` を含む）を次の記録先に持ち越さない。アカウントの画面と知らせは作り直さずに出し続ける
struct PhoneRootView: View {
    let model: PhoneModel
    @State private var showsAccount = false

    var body: some View {
        HomeView(timer: model.services.timer) { showsAccount = true }
            .id(ObjectIdentifier(model.services))
            .sheet(isPresented: $showsAccount) { AccountScreen(model: model) }
            // アカウントの画面からログインしたときは、そちらで確かめる
            .importPrompt(model.importer, enabled: !showsAccount)
            .alert(
                "ログインが切れました",
                isPresented: Binding(
                    get: { !showsAccount && model.signedOutByExpiry }, set: { model.signedOutByExpiry = $0 })
            ) {
                Button("OK") {}
            } message: {
                Text("\(model.thisDevice.name) の記録に戻りました。同期するには、アカウントからもう一度ログインしてください。")
            }
    }
}

/// アカウントの画面。ログインとログアウト、この端末に残っている記録の取り込み（Mac の設定のアカウントのタブと同じ欄）
private struct AccountScreen: View {
    let model: PhoneModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                AccountSection(model: model)
                if let importer = model.importer { DeviceRecordsSection(importer: importer) }
            }
            .navigationTitle("アカウント")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("閉じる") { dismiss() }
                        .accessibilityIdentifier("account.close")
                }
            }
        }
        .importPrompt(model.importer)
    }
}
