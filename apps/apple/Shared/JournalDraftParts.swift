import NanaichiDomain
import NanaichiPresentation
import SwiftUI

// ジャーナル記入の入力欄（Mac の JournalInput、iPhone の JournalComposer）が同じに使う部品（Issue #80）

/// 新しい記入の ID。UUID の文字列は必ず記入の ID の形なので、読めないのは実装の誤り
func newEntryId() -> JournalEntryId { JournalEntryId(UUID().uuidString.lowercased())! }

/// 入力欄の上の「送れなかった記入」の帯。開いている間だけ残す。本文はいつでも選んで（iPhone では長押しで）コピーできる。
/// セッションの外では送り直すことも入力欄に戻すこともできない。前のセッションの記入は、送り直すと今のセッションの
/// 記入になってしまうので送り直せないが、入力欄に戻して今のセッションの記入として書ける（Issue #88）
struct UnsentEntries: View {
    let entries: [UnsentEntry]
    /// 今のセッション。セッションの外なら nil
    let session: SessionId?
    let onResend: (JournalEntryId) -> Void
    let onReturnToInput: (JournalEntryId) -> Void
    let onDiscard: (JournalEntryId) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("送れなかった記入")
                .font(.caption.weight(.medium))
                .foregroundStyle(.red)
            if session == nil {
                Text("セッションの外では送り直すことも入力欄に戻すこともできません。\(copyHint)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ForEach(entries) { entry in
                row(entry)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.red.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
        .overlay { RoundedRectangle(cornerRadius: 10).strokeBorder(.red.opacity(0.4)) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("journal.unsent")
    }

    #if os(iOS)
        private let copyHint = "本文は長押しでコピーできます。"
    #else
        private let copyHint = "本文は選んでコピーできます。"
    #endif

    private func row(_ entry: UnsentEntry) -> some View {
        let submission = entry.submission
        let standing = entry.standing(in: session)
        return VStack(alignment: .leading, spacing: 6) {
            if standing == .previousSession {
                Text("前のセッションの記入です。送り直すと今のセッションの記入になるので、送り直せません。入力欄に戻すと、今のセッションの記入として書けます。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("journal.unsent.previousSession")
            }
            Text(submission.body)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("journal.unsent.body")
            if !submission.tags.isEmpty {
                Text(submission.tags.map { "#\($0.rawValue)" }.joined(separator: " "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            HStack(spacing: 8) {
                Spacer()
                Button("捨てる") { onDiscard(submission.id) }
                    .disabled(!standing.canDiscard)
                    .accessibilityIdentifier("journal.unsent.discard")
                Button("入力欄に戻す") { onReturnToInput(submission.id) }
                    .disabled(!standing.canReturnToInput)
                    .accessibilityIdentifier("journal.unsent.returnToInput")
                Button(standing == .resending ? "送り直し中…" : "送り直す") { onResend(submission.id) }
                    .buttonStyle(.borderedProminent)
                    .disabled(!standing.canResend)
                    .accessibilityIdentifier("journal.unsent.resend")
            }
            .controlSize(.small)
        }
    }
}
