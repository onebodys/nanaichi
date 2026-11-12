import AppKit
import NanaichiDomain
import NanaichiPresentation
import SwiftUI

/// ジャーナル記入の入力欄（docs/PRODUCT.md「画面」の中央）。
///
/// 送るキーは送信キー（GLOSSARY）で選び、送信ボタンの隣で切り替える。送信すると空になり、続けて書ける。
/// 入力欄の上でつけたタグは、外すかセッションが終わるまで、続けて書く記入すべてにつく（GLOSSARY の「タグ」）。
/// セッションの外では書けないので、入力欄を使えなくする。ジャーナルのフェーズに入ったら、すぐ書けるよう
/// カーソルを置き、書く時間だとわかるよう枠をジャーナルの色にする
struct JournalInput: View {
    let model: TimerModel
    let tags: TagsModel
    @AppStorage(PreferenceKey.submitKey) private var submitKey = SubmitKey.defaultKey
    @State private var draft = ""
    @State private var sending = false
    /// 入力欄にカーソルを置く合図。増えるたびに置く
    @State private var focusSignal = 0

    private var attachedTags: [TagName] { tags.attached(in: model.view.writableSession) }

    private var inSession: Bool { model.view.writableSession != nil }
    private var inJournalPhase: Bool { model.view.journalPhase != nil }
    private var canSend: Bool {
        inSession && !sending && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("ジャーナル記入")
                .font(.headline)
            TagInput(
                known: tags.known, attached: attachedTags,
                onChange: { tags.attach($0, in: model.view.writableSession) })
            editor
            HStack(spacing: 8) {
                Spacer()
                Picker("送信キー", selection: $submitKey) {
                    ForEach(SubmitKey.allCases, id: \.self) { key in
                        Text(key.label).tag(key)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .fixedSize()
                .help("送信キー")
                .accessibilityIdentifier("journal.submitKey")
                Button("送信", action: submit)
                    .buttonStyle(.borderedProminent)
                    .tint(inJournalPhase ? PhaseStyle.journal.color : .accentColor)
                    .disabled(!canSend)
                    .accessibilityIdentifier("journal.send")
            }
        }
        .onChange(of: model.view.journalPhase) { _, phase in
            if phase != nil { focusSignal += 1 }
        }
        .onChange(of: model.journalFocusRequests) { focusSignal += 1 }
        .onChange(of: model.view.writableSession, initial: true) { _, session in tags.adopt(by: session) }
    }

    private var editor: some View {
        JournalTextEditor(
            text: $draft, isEnabled: inSession, focusSignal: focusSignal,
            onReturn: { press in
                guard submitKey.shouldSubmit(press) else { return false }
                submit()
                return true
            }
        )
        .overlay(alignment: .topLeading) {
            if draft.isEmpty {
                Text(inSession ? "やったこと・次にやること・感想など（\(submitKey.hint)）" : "セッションを始めると書けます")
                    .foregroundStyle(.tertiary)
                    .padding(.leading, 5)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
        .padding(10)
        .frame(minHeight: 140, maxHeight: 240)
        .background(.background, in: RoundedRectangle(cornerRadius: 10))
        .overlay {
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(
                    inJournalPhase ? AnyShapeStyle(PhaseStyle.journal.color) : AnyShapeStyle(.separator),
                    style: StrokeStyle(lineWidth: inJournalPhase ? 2 : 1, dash: inSession ? [] : [4, 3]))
        }
    }

    private func submit() {
        guard canSend else { return }
        let body = draft
        sending = true
        // 送っている間も続けて書けるよう、先に空にする。書けなかったら、その間に何も書いていなければ戻す
        draft = ""
        Task {
            if await !model.write(body, tags: attachedTags), draft.isEmpty { draft = body }
            sending = false
        }
    }
}

/// 送信キーで送るため、Return キーを先に受け取る NSTextView を包む。
///
/// SwiftUI の TextEditor では、日本語入力の変換を確定する Return と、送る Return を見分けられない。
/// NSTextView なら確定していない文字（`hasMarkedText`）があるかを、Return を渡す前に確かめられる
private struct JournalTextEditor: NSViewRepresentable {
    @Binding var text: String
    let isEnabled: Bool
    let focusSignal: Int
    /// Return キーが押されたとき。送ったら true を返し、改行させない
    let onReturn: (ReturnKeyPress) -> Bool

    func makeCoordinator() -> Coordinator { Coordinator(text: $text) }

    func makeNSView(context: Context) -> NSScrollView {
        let textView = ReturnInterceptingTextView()
        textView.delegate = context.coordinator
        textView.isRichText = false
        textView.allowsUndo = true
        textView.font = .preferredFont(forTextStyle: .body)
        textView.drawsBackground = false
        textView.textContainerInset = .zero
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        textView.setAccessibilityLabel("ジャーナル記入の本文")
        textView.setAccessibilityIdentifier("journal.body")

        let scrollView = NSScrollView()
        scrollView.documentView = textView
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.drawsBackground = false
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? ReturnInterceptingTextView else { return }
        context.coordinator.text = $text
        textView.onReturn = onReturn
        if textView.string != text { textView.string = text }
        textView.isEditable = isEnabled
        textView.isSelectable = isEnabled
        textView.textColor = isEnabled ? .labelColor : .secondaryLabelColor
        if context.coordinator.focusSignal != focusSignal {
            context.coordinator.focusSignal = focusSignal
            if isEnabled {
                // 描き終えてからでないとウィンドウにつながっていないことがある
                DispatchQueue.main.async { textView.window?.makeFirstResponder(textView) }
            }
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var text: Binding<String>
        var focusSignal = 0

        init(text: Binding<String>) {
            self.text = text
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            text.wrappedValue = textView.string
        }
    }
}

private final class ReturnInterceptingTextView: NSTextView {
    var onReturn: ((ReturnKeyPress) -> Bool)?

    override func keyDown(with event: NSEvent) {
        // 36 は Return、76 はテンキーの Enter
        if event.keyCode == 36 || event.keyCode == 76, let onReturn {
            let flags = event.modifierFlags
            let press = ReturnKeyPress(
                shift: flags.contains(.shift), command: flags.contains(.command), control: flags.contains(.control),
                isComposing: hasMarkedText())
            if onReturn(press) { return }
        }
        super.keyDown(with: event)
    }
}
