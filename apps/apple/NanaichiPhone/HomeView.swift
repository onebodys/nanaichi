import NanaichiPresentation
import SwiftUI
import UIKit

/// iPhone のホーム（docs/PRODUCT.md「画面」）。Web のスマホと同じく、上にタイマー、その下にジャーナル記入。
/// タイムラインは出さない（Issue #70 のやらないこと）。iPad でも同じ画面を、読みやすい幅にして中央に置く
struct HomeView: View {
    let timer: TimerModel

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 0) {
                        TimerPane(model: timer)
                        Divider()
                        JournalComposer(model: timer)
                            .padding(20)
                            .id(journalAnchor)
                    }
                    .frame(maxWidth: 640)
                    .frame(maxWidth: .infinity)
                }
                .scrollDismissesKeyboard(.interactively)
                // ジャーナルのフェーズに入って入力欄にカーソルを置いたら、キーボードに隠れないところまで送る
                .onChange(of: timer.view.journalPhase) { _, phase in
                    if phase != nil { withAnimation { proxy.scrollTo(journalAnchor, anchor: .bottom) } }
                }
            }
            .navigationTitle("nanaichi")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
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

private let journalAnchor = "journal"
