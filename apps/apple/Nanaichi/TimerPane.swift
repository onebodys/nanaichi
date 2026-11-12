import NanaichiDomain
import NanaichiPresentation
import SwiftUI

/// タイマー（docs/PRODUCT.md「画面」）。カウントダウン、フェーズ、何ラウンド目・何セット目か、
/// ラウンドの進み具合、その状態でできる操作を出す。状態の計算と判断は `TimerModel` とドメインにある
struct TimerPane: View {
    let model: TimerModel

    var body: some View {
        VStack(spacing: 20) {
            switch model.view {
            case .loading:
                ProgressView("読み込み中…")
            case .loadFailed:
                LoadFailedView(reload: model.reload)
            case .noSession:
                NoSessionView(model: model)
            case .inSession(let session, let state, let operations):
                InSessionView(model: model, session: session, state: state, operations: operations)
            case .ended(let session, let ended):
                SessionSummaryView(
                    model: model,
                    summary: SessionSummary.of(
                        session: session, ended: ended, now: model.serverNow, entries: model.endedEntries))
            }
            if let message = model.errorMessage {
                Text(message)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("timer.error")
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct LoadFailedView: View {
    let reload: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label("タイマーを読み込めませんでした", systemImage: "exclamationmark.triangle")
        } actions: {
            Button("読み込み直す", action: reload)
        }
    }
}

// MARK: - 開始前

private struct NoSessionView: View {
    let model: TimerModel

    var body: some View {
        let rhythm = sessionRhythmOf()
        Text("セッションを始める")
            .font(.title3)
            .foregroundStyle(.secondary)
        Dial(ratio: 0, color: PhaseStyle.focus.color, dimmed: true) {
            Countdown(remainingSeconds: rhythm.focusSeconds, dimmed: true)
            Caption(rhythm.set)
        }
        StartButton(title: "開始", model: model)
        Text(rhythm.round)
            .font(.callout)
            .foregroundStyle(.secondary)
    }
}

struct StartButton: View {
    let title: String
    let model: TimerModel

    var body: some View {
        Button(action: model.start) {
            Text(title).frame(minWidth: 160)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.extraLarge)
        .tint(PhaseStyle.focus.color)
        .disabled(!model.canStart)
        .help("セッションを開始（⌘N）")
        .accessibilityIdentifier("timer.start")
    }
}

// MARK: - セッション中

private struct InSessionView: View {
    let model: TimerModel
    let session: Session
    let state: UnendedTimerState
    let operations: [SessionOperationKind]

    var body: some View {
        VStack(spacing: 8) {
            PhasePill(state: state)
            Text(positionTextOf(state))
                .font(.callout)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("timer.position")
        }
        body(of: state)
        RoundBar(progress: roundProgressOf(state))
            .accessibilityIdentifier("timer.round")
        OperationButtons(model: model, state: state, operations: operations, identifierPrefix: "")
        Text(
            currentSessionTextOf(
                startedAt: session.events.start.event.at, completedSets: state.completedSets,
                timeZone: deviceTimeZone())
        )
        .font(.callout)
        .foregroundStyle(.secondary)
        .monospacedDigit()
        .accessibilityIdentifier("timer.session")
    }

    @ViewBuilder
    private func body(of state: UnendedTimerState) -> some View {
        let style = PhaseStyle.of(state)
        switch state {
        case .idle(let idle):
            let message = idleMessageOf(setNumber: idle.setNumber)
            Dial(ratio: 0, color: style.color, dimmed: true, dashed: true) {
                VStack(spacing: 8) {
                    Text(message.title)
                        .font(.headline)
                        .accessibilityIdentifier("timer.idle")
                    Text(message.body)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding(.horizontal, 36)
            }
        case .awaitingAdvance(let awaiting):
            Dial(ratio: 1, color: style.color, dimmed: true) {
                Countdown(remainingSeconds: 0, dimmed: false)
                Caption(awaitingTextOf(finished: awaiting.finished, since: awaiting.since, now: model.serverNow))
            }
        case .focus, .journal, .breakTime:
            if let inPhase = state.inPhase {
                let paused: Instant? =
                    switch inPhase.clock {
                    case .paused(let pausedAt): pausedAt
                    case .running: nil
                    }
                Dial(ratio: remainingRatioOf(inPhase), color: style.color, dimmed: paused != nil) {
                    Countdown(remainingSeconds: inPhase.remainingSeconds, dimmed: paused != nil)
                    Caption(
                        paused.map { pausedForTextOf(pausedAt: $0, now: model.serverNow) }
                            ?? upcomingTextOf(upcomingPhaseOf(inPhase)))
                }
            }
        }
    }
}

/// フェーズの名前の札。一時停止中と切り替え待ちは、止まっていることを中抜きの記号で示す
private struct PhasePill: View {
    let state: UnendedTimerState

    private var isPaused: Bool {
        guard case .paused = state.inPhase?.clock else { return false }
        return true
    }

    var body: some View {
        let style = PhaseStyle.of(state)
        HStack(spacing: 6) {
            Image(systemName: isPaused ? "pause.fill" : style.symbol)
                .accessibilityHidden(true)
            Text(stateNameOf(state.kind))
                .accessibilityIdentifier("timer.phase")
            if isPaused {
                Text("· 一時停止中")
                    .accessibilityIdentifier("timer.paused")
            }
        }
        .font(.headline)
        .foregroundStyle(style.color)
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .background(style.color.opacity(0.14), in: Capsule())
        .accessibilityElement(children: .contain)
    }
}

/// 残り時間の円。円の中にカウントダウンと説明を重ねる
private struct Dial<Content: View>: View {
    let ratio: Double
    let color: Color
    let dimmed: Bool
    var dashed = false
    @ViewBuilder let content: Content
    @ScaledMetric(relativeTo: .largeTitle) private var size = 300

    var body: some View {
        ZStack {
            Circle()
                .stroke(
                    .quaternary,
                    style: dashed
                        ? StrokeStyle(lineWidth: 4, lineCap: .round, dash: [2, 12]) : StrokeStyle(lineWidth: 8))
            Circle()
                .trim(from: 0, to: ratio)
                .stroke(color.opacity(dimmed ? 0.4 : 1), style: StrokeStyle(lineWidth: 8, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .animation(.linear(duration: 0.25), value: ratio)
            VStack(spacing: 6) { content }
        }
        .frame(width: size, height: size)
        .accessibilityElement(children: .contain)
    }
}

/// カウントダウン。数字の幅をそろえ、秒が変わっても字がずれないようにする
private struct Countdown: View {
    let remainingSeconds: Int
    let dimmed: Bool

    var body: some View {
        Text(countdownTextOf(remainingSeconds: remainingSeconds))
            .font(.system(size: 76, weight: .light, design: .rounded))
            .monospacedDigit()
            .foregroundStyle(dimmed ? .secondary : .primary)
            .contentTransition(.numericText(countsDown: true))
            .accessibilityLabel(countdownAccessibilityTextOf(remainingSeconds: remainingSeconds))
            .accessibilityIdentifier("timer.countdown")
    }
}

private struct Caption: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(.callout)
            .foregroundStyle(.secondary)
            .monospacedDigit()
            .accessibilityIdentifier("timer.caption")
    }
}

/// ラウンドの進み具合（3つのセットと休憩）
struct RoundBar: View {
    let progress: RoundProgress

    var body: some View {
        HStack(spacing: 6) {
            ForEach(progress.sets.indices, id: \.self) { index in
                SegmentBar(segment: progress.sets[index], color: PhaseStyle.focus.color)
                    .frame(width: 44)
            }
            SegmentBar(segment: progress.breakTime, color: PhaseStyle.breakTime.color)
                .frame(width: 22)
                .padding(.leading, 4)
            if let untilBreak = untilBreakTextOf(progress) {
                Text(untilBreak)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.leading, 8)
            }
        }
        .frame(height: 6)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(untilBreakTextOf(progress) ?? "休憩中")
    }
}

private struct SegmentBar: View {
    let segment: Segment
    let color: Color

    var body: some View {
        let filled: Double =
            switch segment {
            case .done: 1
            case .current(let elapsedRatio): elapsedRatio
            case .pending: 0
            }
        Capsule()
            .fill(.quaternary)
            .overlay(alignment: .leading) {
                GeometryReader { geometry in
                    Capsule().fill(color).frame(width: geometry.size.width * filled)
                }
            }
            .clipShape(Capsule())
    }
}

/// その状態でできる操作のボタン。主な操作を目立たせ、終了は文字だけで最後に置く（`operationButtonsOf`）。
/// メニューバーのパネルにも同じ並びで出す。識別子の頭に `identifierPrefix` を付け、メインのウィンドウのボタンと見分ける
struct OperationButtons: View {
    let model: TimerModel
    let state: UnendedTimerState
    let operations: [SessionOperationKind]
    let identifierPrefix: String

    var body: some View {
        HStack(spacing: 10) {
            ForEach(operationButtonsOf(operations), id: \.kind) { button in
                OperationButtonView(model: model, state: state, button: button, identifierPrefix: identifierPrefix)
            }
        }
        .controlSize(.large)
    }
}

private struct OperationButtonView: View {
    let model: TimerModel
    let state: UnendedTimerState
    let button: OperationButton
    let identifierPrefix: String

    var body: some View {
        let title = operationButtonTextOf(button.kind, state)
        let action = { model.operate(button.kind) }
        Group {
            switch button.emphasis {
            case .primary:
                switch primaryColorOf(button.kind) {
                case .phase(let color):
                    Button(action: action) { Text(title).frame(minWidth: 120) }
                        .buttonStyle(.borderedProminent)
                        .tint(color)
                case .neutral:
                    Button(action: action) { Text(title).frame(minWidth: 120) }
                        .buttonStyle(.bordered)
                }
            case .secondary:
                Button(title, action: action)
                    .buttonStyle(.bordered)
            case .quiet:
                Button(title, action: action)
                    .buttonStyle(.borderless)
                    .foregroundStyle(.secondary)
            }
        }
        .disabled(model.pending)
        .help("\(title)（\(shortcutTextOf(button.kind))）")
        .accessibilityIdentifier("\(identifierPrefix)operation.\(button.kind.rawValue)")
    }

    /// 主な操作の色。集中の再開始は集中、休憩スキップは休憩の色、それ以外はいまのフェーズ（切り替え待ちなら、
    /// これから始まるフェーズ）の色。一時停止などを主にするときは色をつけず、塗りつぶさないボタンにする
    /// （`.primary` で塗ると、地と文字が同じ色になって読めない）
    private func primaryColorOf(_ kind: SessionOperationKind) -> PrimaryColor {
        switch kind {
        case .restartFocus: .phase(PhaseStyle.focus.color)
        case .skipBreak: .phase(PhaseStyle.breakTime.color)
        case .resume, .advance: .phase(PhaseStyle.of(state).color)
        case .pause, .abort, .end: .neutral
        }
    }

    private enum PrimaryColor {
        case phase(Color)
        case neutral
    }
}

/// ボタンの説明に添えるショートカットの表記
private func shortcutTextOf(_ kind: SessionOperationKind) -> String {
    let shortcut = shortcutOf(kind)
    let shift = shortcut.modifiers.contains(.shift) ? "⇧" : ""
    return "\(shift)⌘\(shortcut.key.character.uppercased())"
}
