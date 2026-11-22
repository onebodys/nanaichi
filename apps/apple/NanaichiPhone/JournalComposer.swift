import NanaichiDomain
import NanaichiPresentation
import SwiftUI

/// ジャーナル記入の入力欄（docs/PRODUCT.md「画面」の中央）。
///
/// 送信ボタン（書いている間はキーボードの上）で送り、Return は改行にする（iPhone のキーボードには ⌘ がないので、送信キーは選ばせない）。
/// 送信すると空になり、続けて書ける。セッションの外では書けないので、入力欄を使えなくする。
/// ジャーナルのフェーズに入ったら、すぐ書けるようカーソルを置き、書く時間だとわかるよう枠をジャーナルの色にする。
/// タグはつけない（タグをつける欄は Web と Mac で使う。Issue #70）
///
/// 送れなかったとき、入力欄が空なら本文を戻す。送っている間に書き足していれば、送れなかった記入を
/// 入力欄の上の帯に残し、送り直す・入力欄に戻す・捨てるを選べるようにする（Issue #80、`JournalDraft`。Mac と同じ）
struct JournalComposer: View {
    let model: TimerModel
    @State private var draft = JournalDraft()
    @State private var sending = false
    @FocusState private var focused: Bool

    private var inSession: Bool { model.view.writableSession != nil }
    private var inJournalPhase: Bool { model.view.journalPhase != nil }
    private var canSend: Bool {
        inSession && !sending && !draft.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("ジャーナル記入")
                .font(.headline)
            if !draft.unsent.isEmpty {
                UnsentEntries(
                    entries: draft.unsent, inSession: inSession, onResend: resend,
                    onReturnToInput: { draft.returnToInput($0) }, onDiscard: { draft.discard($0) })
            }
            editor
            HStack {
                if let message = model.writeErrorMessage {
                    Text(message)
                        .font(.callout)
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("journal.error")
                }
                Spacer()
                Button("送信", action: submit)
                    .buttonStyle(.borderedProminent)
                    .tint(inJournalPhase ? PhaseStyle.journal.color : .accentColor)
                    .disabled(!canSend)
                    .accessibilityIdentifier("journal.send")
            }
        }
        .toolbar {
            // 入力欄の下の送信ボタンはキーボードに隠れるので、書いている間はキーボードの上で送る。
            // Return は改行なので、キーボードを閉じるボタンも並べる
            ToolbarItemGroup(placement: .keyboard) {
                Button("閉じる") { focused = false }
                    .accessibilityIdentifier("journal.dismissKeyboard")
                Spacer()
                Button("送信", action: submit)
                    .fontWeight(.semibold)
                    .disabled(!canSend)
                    .accessibilityIdentifier("journal.sendFromKeyboard")
            }
        }
        .onChange(of: model.view.journalPhase) { _, phase in
            if phase != nil { focused = true }
        }
        .onChange(of: inSession) { _, inSession in
            if !inSession { focused = false }
        }
    }

    private var editor: some View {
        TextEditor(text: $draft.body)
            .focused($focused)
            .disabled(!inSession)
            .scrollContentBackground(.hidden)
            .accessibilityLabel("ジャーナル記入の本文")
            .accessibilityIdentifier("journal.body")
            .overlay(alignment: .topLeading) {
                if draft.body.isEmpty {
                    Text(inSession ? "やったこと・次にやること・感想など" : "セッションを始めると書けます")
                        .foregroundStyle(.tertiary)
                        .padding(.top, 8)
                        .padding(.leading, 5)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
            .padding(8)
            .frame(minHeight: 140)
            .background(.background.secondary, in: RoundedRectangle(cornerRadius: 10))
            .overlay {
                RoundedRectangle(cornerRadius: 10)
                    .strokeBorder(
                        inJournalPhase ? AnyShapeStyle(PhaseStyle.journal.color) : AnyShapeStyle(.separator),
                        style: StrokeStyle(lineWidth: inJournalPhase ? 2 : 1, dash: inSession ? [] : [4, 3]))
            }
    }

    private func submit() {
        guard canSend else { return }
        sending = true
        // 送っている間も続けて書けるよう、先に空にする
        let submission = draft.submit(tags: [], newId: newEntryId)
        Task {
            if await !model.write(submission) { draft.failed(submission) }
            sending = false
        }
    }

    private func resend(_ id: JournalEntryId) {
        guard let submission = draft.resend(id) else { return }
        Task {
            if await model.write(submission) { draft.resent(id) } else { draft.resendFailed(id) }
        }
    }
}
