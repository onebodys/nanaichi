import NanaichiDomain
import NanaichiPresentation
import SwiftUI

/// メインのウィンドウ（docs/PRODUCT.md「画面」）。Web の PC と同じく、左にタイマー、右にジャーナル記入。
/// タイムラインは右の入力欄の下に、スタッツと設定はツールバーから開く（#143）
struct MainView: View {
    let model: TimerModel

    var body: some View {
        HStack(spacing: 0) {
            TimerPane(model: model)
                .frame(minWidth: 380, idealWidth: 440, maxWidth: 520)
            Divider()
            JournalPane(model: model)
                .frame(minWidth: 360, maxWidth: .infinity)
        }
        .frame(minWidth: 760, minHeight: 560)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                TodayFocusView(today: model.todayFocus)
            }
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

/// 右のペイン。ジャーナル記入の入力欄
private struct JournalPane: View {
    let model: TimerModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            JournalInput(model: model)
            if let message = model.writeErrorMessage {
                Text(message)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("journal.error")
            }
            Spacer(minLength: 0)
        }
        .padding(24)
        .frame(maxHeight: .infinity, alignment: .top)
    }
}
