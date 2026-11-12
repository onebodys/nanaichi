import AppKit
import NanaichiDomain
import NanaichiPresentation
import SwiftUI

/// メニューバーに常に出す表示（ADR 0015「メニューバー常駐」）。フェーズの記号と残り時間だけ。
/// `TimerModel.menuBarLabel` だけを読むので、描き直すのは表示が変わったとき（1秒に1回まで）
struct MenuBarLabelView: View {
    let app: AppModel

    var body: some View {
        let label = app.services.timer.menuBarLabel
        Group {
            switch label {
            case .symbolOnly(let symbol, _):
                Image(systemName: symbolNameOf(symbol))
            case .countdown(let symbol, let text, _):
                HStack(spacing: 4) {
                    Image(systemName: symbolNameOf(symbol))
                    Text(text).monospacedDigit()
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label.spoken)
    }

    private func symbolNameOf(_ symbol: MenuBarSymbol) -> String {
        switch symbol {
        case .outOfSession: "timer"
        case .idle: PhaseStyle.idle.symbol
        case .paused: "pause.fill"
        case .phase(let kind): PhaseStyle.of(kind).symbol
        }
    }
}

/// メニューバーの表示を押すと開くパネル。ウィンドウを閉じていても、フェーズと残り時間を見て、
/// その状態でできる操作をメインのウィンドウと同じ並び（`operationButtonsOf`）でできる
struct MenuBarPanel: View {
    let app: AppModel
    @Environment(\.openWindow) private var openWindow

    private var model: TimerModel { app.services.timer }

    var body: some View {
        VStack(spacing: 14) {
            content
            if let message = model.errorMessage {
                Text(message)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("menubar.error")
            }
            Divider()
            HStack {
                Button("nanaichi を開く", action: openMain)
                    .accessibilityIdentifier("menubar.open")
                Spacer()
                Button("終了") { NSApp.terminate(nil) }
                    .accessibilityIdentifier("menubar.quit")
            }
            .buttonStyle(.borderless)
        }
        .padding(16)
        .frame(width: 300)
    }

    @ViewBuilder
    private var content: some View {
        switch model.view {
        case .loading:
            ProgressView().controlSize(.small)
        case .loadFailed:
            Text("タイマーを読み込めませんでした").foregroundStyle(.secondary)
            Button("読み込み直す", action: model.reload)
        case .noSession:
            startButton
        case .ended(_, let ended):
            Text(endedMessageOf(ended.endedBy))
                .font(.callout)
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("menubar.ended")
            Text(completedSetsAndFocusTimeOf(ended.completedSets))
                .font(.callout)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("menubar.summary")
            startButton
        case .inSession(_, let state, let operations):
            InSessionPanel(model: model, state: state, operations: operations, writeJournal: writeJournal)
        }
    }

    private var startButton: some View {
        Button(action: model.start) {
            Text("セッションを開始").frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .tint(PhaseStyle.focus.color)
        .disabled(!model.canStart)
        .accessibilityIdentifier("menubar.start")
    }

    private func openMain() {
        openWindow(id: mainWindowId)
        NSApp.activate()
    }

    private func writeJournal() {
        openMain()
        model.focusJournal()
    }
}

private struct InSessionPanel: View {
    let model: TimerModel
    let state: UnendedTimerState
    let operations: [SessionOperationKind]
    let writeJournal: () -> Void

    var body: some View {
        let style = PhaseStyle.of(state)
        VStack(spacing: 4) {
            HStack(spacing: 6) {
                Text(stateNameOf(state.kind))
                    .accessibilityIdentifier("menubar.phase")
                if case .paused = state.inPhase?.clock {
                    Text("· 一時停止中")
                        .accessibilityIdentifier("menubar.paused")
                }
            }
            .font(.headline)
            .foregroundStyle(style.color)
            Text(positionTextOf(state))
                .font(.callout)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("menubar.position")
        }
        remaining
        RoundBar(progress: roundProgressOf(state))
            .accessibilityIdentifier("menubar.round")
        OperationButtons(model: model, state: state, operations: operations, identifierPrefix: "menubar.")
        if state.kind == .journal {
            Button("ジャーナル記入を書く…", action: writeJournal)
                .buttonStyle(.link)
                .accessibilityIdentifier("menubar.writeJournal")
        }
    }

    @ViewBuilder
    private var remaining: some View {
        switch state {
        case .idle(let idle):
            Text(idleMessageOf(setNumber: idle.setNumber).title)
                .font(.callout)
                .accessibilityIdentifier("menubar.idle")
        case .awaitingAdvance(let awaiting):
            Text(awaitingTextOf(finished: awaiting.finished, since: awaiting.since, now: model.serverNow))
                .font(.callout)
                .monospacedDigit()
                .accessibilityIdentifier("menubar.caption")
        case .focus, .journal, .breakTime:
            if let inPhase = state.inPhase {
                Text(countdownTextOf(remainingSeconds: inPhase.remainingSeconds))
                    .font(.system(size: 44, weight: .light, design: .rounded))
                    .monospacedDigit()
                    .contentTransition(.numericText(countsDown: true))
                    .accessibilityLabel(countdownAccessibilityTextOf(remainingSeconds: inPhase.remainingSeconds))
                    .accessibilityIdentifier("menubar.countdown")
                Text(upcomingTextOf(upcomingPhaseOf(inPhase)))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("menubar.caption")
            }
        }
    }
}
