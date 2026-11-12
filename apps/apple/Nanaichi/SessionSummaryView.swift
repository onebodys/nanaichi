import NanaichiDomain
import NanaichiPresentation
import SwiftUI

/// 終了した直後のタイマーに出す、セッションのまとめ（GLOSSARY の「セッションのまとめ」）
struct SessionSummaryView: View {
    let model: TimerModel
    let summary: SessionSummary

    var body: some View {
        VStack(spacing: 6) {
            Text(endedMessageOf(summary.endedBy))
                .font(.callout)
                .foregroundStyle(.secondary)
            Text("おつかれさまでした")
                .font(.title.bold())
                .accessibilityIdentifier("summary.title")
            Text(sessionSpanTextOf(startedAt: summary.startedAt, endedAt: summary.endedAt, timeZone: deviceTimeZone()))
                .font(.callout)
                .foregroundStyle(.secondary)
                .monospacedDigit()
        }
        GroupBox {
            VStack(spacing: 16) {
                HStack {
                    SummaryStat(
                        value: focusTimeTextOf(milliseconds: summary.focusTimeMs), label: "集中", identifier: "focusTime")
                    SummaryStat(value: String(summary.completedSets), label: "完了セット", identifier: "completedSets")
                    SummaryStat(value: entryCountTextOf(summary.entries), label: "記入", identifier: "entries")
                }
                if !summary.sets.isEmpty {
                    SetSequence(sets: summary.sets)
                }
                if let note = abortedSetsNoteOf(summary.abortedSets) {
                    Text(note)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(12)
        }
        .frame(maxWidth: 400)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("セッションのまとめ")
        .accessibilityIdentifier("summary")
        StartButton(title: "次のセッションを開始", model: model)
    }
}

private struct SummaryStat: View {
    let value: String
    let label: String
    let identifier: String

    var body: some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.title2)
                .monospacedDigit()
                .accessibilityIdentifier("summary.\(identifier)")
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }
}

/// セットの並び。ラウンドごとに間をあけ、不成立セットは点線で出す
private struct SetSequence: View {
    let sets: [SetOutcome]

    var body: some View {
        let rounds = sets.map(round).uniquedInOrder()
        HStack(spacing: 10) {
            ForEach(rounds, id: \.self) { round in
                HStack(spacing: 4) {
                    ForEach(Array(sets.filter { self.round($0) == round }.enumerated()), id: \.offset) { _, set in
                        mark(set)
                    }
                }
            }
        }
        .accessibilityHidden(true)
    }

    private func round(_ set: SetOutcome) -> Int {
        switch set {
        case .completedSet(let round, _, _), .abortedSet(let round, _, _): round
        }
    }

    @ViewBuilder
    private func mark(_ set: SetOutcome) -> some View {
        let shape = RoundedRectangle(cornerRadius: 3)
        switch set {
        case .completedSet:
            shape.fill(PhaseStyle.focus.color).frame(width: 22, height: 8)
        case .abortedSet:
            shape.strokeBorder(.secondary, style: StrokeStyle(lineWidth: 1.5, dash: [3, 2])).frame(width: 22, height: 8)
        }
    }
}

extension Array where Element: Hashable {
    fileprivate func uniquedInOrder() -> [Element] {
        var seen = Set<Element>()
        return filter { seen.insert($0).inserted }
    }
}
