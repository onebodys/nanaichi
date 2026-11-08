import NanaichiDomain
import NanaichiPresentation
import SwiftUI

/// メインのウィンドウ（docs/PRODUCT.md「画面」）。Web の PC と同じく、左にタイマー、右にジャーナル記入。
/// タイムラインは右の入力欄の下に出す。スタッツは別のウィンドウ（ツールバーとメニューから）、設定は ⌘, で開く
struct MainView: View {
    @Bindable var model: AppModel
    let app: AppServices
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        HStack(spacing: 0) {
            TimerPane(model: app.timer)
                .frame(minWidth: 380, idealWidth: 440, maxWidth: 520)
            Divider()
            JournalPane(app: app)
                .frame(minWidth: 360, maxWidth: .infinity)
        }
        .frame(minWidth: 760, minHeight: 560)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                TodayFocusView(today: app.timer.todayFocus)
            }
            ToolbarItem(placement: .primaryAction) {
                Button {
                    openWindow(id: reviewWindowId)
                } label: {
                    Label("スタッツ", systemImage: "chart.bar.xaxis")
                }
                .help("スタッツとジャーナル記入の見返しを開く（⌘2）")
                .accessibilityIdentifier("toolbar.stats")
            }
        }
        .alert("ログインが切れました", isPresented: $model.signedOutByExpiry) {
            Button("OK") {}
        } message: {
            Text("この Mac の記録に戻りました。同期するには、設定のアカウントからもう一度ログインしてください。")
        }
    }
}

/// ツールバーに出す今日の集中時間（GLOSSARY の「集中時間」）
private struct TodayFocusView: View {
    let today: TodayFocus

    var body: some View {
        if let text = todayFocusTextOf(today) {
            Label {
                Text("今日 \(text.focusTime)").monospacedDigit()
            } icon: {
                Image(systemName: "flame")
            }
            .labelStyle(.titleAndIcon)
            .help("今日の集中時間（完了 \(text.sets)）")
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("今日の集中時間 \(text.focusTime)、完了 \(text.sets)")
            .accessibilityIdentifier("today.focus")
            .padding(.horizontal, 8)
        }
    }
}

/// 右のペイン。ジャーナル記入の入力欄と、その下のタイムライン
private struct JournalPane: View {
    let app: AppServices

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                JournalInput(model: app.timer, tags: app.tags)
                if let message = app.timer.writeErrorMessage {
                    Text(message)
                        .font(.callout)
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("journal.error")
                }
            }
            .padding(24)
            Divider()
            TimelineList(timeline: app.timeline, tags: app.tags, now: app.timer.serverNow)
        }
        .frame(maxHeight: .infinity, alignment: .top)
    }
}
