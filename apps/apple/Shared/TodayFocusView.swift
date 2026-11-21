import NanaichiPresentation
import SwiftUI

/// ツールバーに出す今日の集中時間（GLOSSARY の「集中時間」）
struct TodayFocusView: View {
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
