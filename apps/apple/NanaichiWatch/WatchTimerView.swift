import NanaichiDomain
import NanaichiPresentation
import SwiftUI

/// Watch の画面（ADR 0031）。いちばん小さい Apple Watch SE 3（40mm）でスクロールせずに収まるよう、
/// フェーズと残り時間と何セット目かと、文言のない操作のボタンだけを置く（Issue #122）。
/// 要素の識別子は iPhone の画面とそろえる（XCUITest が同じ名前で読む）
struct WatchTimerView: View {
    let model: WatchModel

    var body: some View {
        let face = model.face
        VStack(spacing: 2) {
            switch face.screen {
            case .waitingForPhone:
                Unreachable(notice: face.phoneUnreachableNotice)
                Spacer(minLength: 0)
                ProgressView()
                Text("iPhone から読み込み中")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .accessibilityIdentifier("watch.waiting")
                Spacer(minLength: 0)
            case .outOfSession(let start):
                Unreachable(notice: face.phoneUnreachableNotice)
                Spacer(minLength: 0)
                Countdown(remainingSeconds: sessionRhythmOf().focusSeconds, dimmed: true)
                Spacer(minLength: 0)
                IconButton(
                    title: "開始", symbol: startSymbol, fill: PhaseStyle.focus.color, isEnabled: start.isEnabled,
                    identifier: "timer.start", action: model.start)
            case .inSession(let state, let operations, let control):
                InSession(state: state, unreachableNotice: face.phoneUnreachableNotice)
                Spacer(minLength: 0)
                HStack(spacing: 6) {
                    ForEach(operations, id: \.kind) { button in
                        IconButton(
                            title: operationTextOf(button.kind), symbol: operationSymbolOf(button.kind),
                            fill: fillOf(button.kind, state), role: button.kind == .abort ? .destructive : nil,
                            isEnabled: control.isEnabled, identifier: "operation.\(button.kind.rawValue)"
                        ) { model.operate(button.kind) }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        #if DEBUG
            // 振動はシミュレーターで感じられないので、XCUITest は知らせた回数を読む
            .overlay(alignment: .topLeading) {
                if ProcessInfo.processInfo.environment["NANAICHI_WATCH_SHOW_VIBRATIONS"] != nil {
                    Text("\(model.vibrator.played)")
                        .font(.footnote)
                        .accessibilityIdentifier("watch.vibrations")
                }
            }
        #endif
        // 失敗の文言は長いことがあり、画面に並べると収まらないので、重ねて出す
        .alert(
            model.errorMessage ?? "",
            isPresented: Binding(get: { model.errorMessage != nil }, set: { if !$0 { model.dismissError() } })
        ) {
            Button("OK", role: .cancel) {}
        }
    }
}

/// 時間を動かし始める操作のボタンだけ、そのフェーズの色で塗る（iPhone の主な操作の色と同じ）
private func fillOf(_ kind: SessionOperationKind, _ state: UnendedTimerState) -> Color? {
    switch kind {
    case .resume, .advance: PhaseStyle.of(state).color
    case .restartFocus: PhaseStyle.focus.color
    case .skipBreak: PhaseStyle.breakTime.color
    case .pause, .abort, .end: nil
    }
}

/// セッション中のフェーズと残り時間と位置
private struct InSession: View {
    let state: UnendedTimerState
    let unreachableNotice: String?

    private var isPaused: Bool {
        guard case .paused = state.inPhase?.clock else { return false }
        return true
    }

    var body: some View {
        let style = PhaseStyle.of(state)
        HStack(spacing: 4) {
            // 一時停止中は、フェーズの記号を止まっている記号に替える（iPhone のフェーズの札と同じ）
            if isPaused {
                Image(systemName: "pause.fill")
                    .accessibilityLabel("一時停止中")
                    .accessibilityIdentifier("timer.paused")
            } else {
                Image(systemName: style.symbol)
                    .accessibilityHidden(true)
            }
            Text(stateNameOf(state.kind))
                .accessibilityIdentifier("timer.phase")
            Unreachable(notice: unreachableNotice)
        }
        .font(.headline)
        .foregroundStyle(style.color)
        .lineLimit(1)
        .minimumScaleFactor(0.7)
        Spacer(minLength: 0)
        switch state {
        case .idle(let idle):
            Text(idleMessageOf(setNumber: idle.setNumber).title)
                .font(.footnote)
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .minimumScaleFactor(0.7)
                .accessibilityIdentifier("timer.idle")
            Text("集中の再開始は iPhone で")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        case .awaitingAdvance:
            Countdown(remainingSeconds: 0, dimmed: false)
        case .focus, .journal, .breakTime:
            if let inPhase = state.inPhase {
                Countdown(remainingSeconds: inPhase.remainingSeconds, dimmed: isPaused)
            }
        }
        Text(positionTextOf(state))
            .font(.footnote)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            .accessibilityIdentifier("timer.position")
    }
}

/// iPhone に届かないことを示す記号。文言は VoiceOver で読む
private struct Unreachable: View {
    let notice: String?

    var body: some View {
        if let notice {
            Image(systemName: "iphone.slash")
                .foregroundStyle(.orange)
                .accessibilityLabel(notice)
                .accessibilityIdentifier("watch.unreachable")
        }
    }
}

private struct Countdown: View {
    let remainingSeconds: Int
    let dimmed: Bool

    var body: some View {
        Text(countdownTextOf(remainingSeconds: remainingSeconds))
            .font(.system(size: 44, weight: .light, design: .rounded))
            .monospacedDigit()
            .foregroundStyle(dimmed ? .secondary : .primary)
            .lineLimit(1)
            .minimumScaleFactor(0.6)
            .contentTransition(.numericText(countsDown: true))
            .accessibilityLabel(countdownAccessibilityTextOf(remainingSeconds: remainingSeconds))
            .accessibilityIdentifier("timer.countdown")
    }
}

/// 文言のない操作のボタン。VoiceOver は `title`（GLOSSARY の用語）を読む。`fill` があればその色で塗る
private struct IconButton: View {
    let title: String
    let symbol: String
    let fill: Color?
    var role: ButtonRole?
    let isEnabled: Bool
    let identifier: String
    let action: () -> Void

    var body: some View {
        let button = Button(role: role, action: action) {
            Label(title, systemImage: symbol)
                .labelStyle(.iconOnly)
                .frame(maxWidth: .infinity)
        }
        .disabled(!isEnabled)
        .accessibilityIdentifier(identifier)
        if let fill {
            button.buttonStyle(.borderedProminent).tint(fill)
        } else {
            button.buttonStyle(.bordered)
        }
    }
}
