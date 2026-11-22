import NanaichiDomain
import NanaichiPresentation
import SwiftUI

/// Watch の画面（ADR 0031）。いまのフェーズと残り時間と何セット目かを出し、開始と中断だけを置く。
/// 要素の識別子は iPhone の画面とそろえる（XCUITest が同じ名前で読む）
struct WatchTimerView: View {
    let model: WatchModel

    var body: some View {
        let face = model.face
        ScrollView {
            VStack(spacing: 6) {
                switch face.screen {
                case .waitingForPhone:
                    ProgressView()
                    Text("iPhone の nanaichi から読み込んでいます")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .accessibilityIdentifier("watch.waiting")
                case .outOfSession(let start):
                    Text(countdownTextOf(remainingSeconds: sessionRhythmOf().focusSeconds))
                        .font(.system(size: 44, weight: .light, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                    Button("開始", action: model.start)
                        .buttonStyle(.borderedProminent)
                        .tint(PhaseStyle.focus.color)
                        .disabled(!start.isEnabled)
                        .accessibilityIdentifier("timer.start")
                case .inSession(let state, let abort):
                    InSession(state: state)
                    if let abort {
                        Button("中断", role: .destructive, action: model.abort)
                            .disabled(!abort.isEnabled)
                            .accessibilityIdentifier("operation.Abort")
                    }
                }
                if let notice = face.phoneUnreachableNotice {
                    Label(notice, systemImage: "iphone.slash")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                        .accessibilityIdentifier("watch.unreachable")
                }
                if let error = model.errorMessage {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("timer.error")
                }
            }
            .frame(maxWidth: .infinity)
        }
    }
}

/// セッション中のフェーズと残り時間と位置
private struct InSession: View {
    let state: UnendedTimerState

    var body: some View {
        let style = PhaseStyle.of(state)
        Label {
            Text(stateNameOf(state.kind))
                .accessibilityIdentifier("timer.phase")
        } icon: {
            Image(systemName: style.symbol)
        }
        .font(.headline)
        .foregroundStyle(style.color)
        switch state {
        case .idle(let idle):
            Text(idleMessageOf(setNumber: idle.setNumber).title)
                .font(.footnote)
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("timer.idle")
            Text("集中の再開始は iPhone で")
                .font(.footnote)
                .foregroundStyle(.secondary)
        case .awaitingAdvance:
            Countdown(remainingSeconds: 0)
        case .focus, .journal, .breakTime:
            if let inPhase = state.inPhase {
                Countdown(remainingSeconds: inPhase.remainingSeconds)
            }
        }
        Text(positionTextOf(state))
            .font(.footnote)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("timer.position")
    }
}

private struct Countdown: View {
    let remainingSeconds: Int

    var body: some View {
        Text(countdownTextOf(remainingSeconds: remainingSeconds))
            .font(.system(size: 44, weight: .light, design: .rounded))
            .monospacedDigit()
            .contentTransition(.numericText(countsDown: true))
            .accessibilityLabel(countdownAccessibilityTextOf(remainingSeconds: remainingSeconds))
            .accessibilityIdentifier("timer.countdown")
    }
}
