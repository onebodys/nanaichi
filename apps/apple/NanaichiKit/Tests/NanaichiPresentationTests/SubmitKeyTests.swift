import Testing

@testable import NanaichiPresentation

private func press(shift: Bool = false, command: Bool = false, control: Bool = false, composing: Bool = false)
    -> ReturnKeyPress
{
    ReturnKeyPress(shift: shift, command: command, control: control, isComposing: composing)
}

@Test("既定の送信キーは Return で改行する方")
func defaultSubmitKey() {
    #expect(SubmitKey.defaultKey == .modifierEnter)
}

@Test("⌘Return で送る送信キーでは、Return と ⇧Return で改行し、⌘Return と ⌃Return で送る")
func modifierEnterSubmitKey() {
    #expect(!SubmitKey.modifierEnter.shouldSubmit(press()))
    #expect(!SubmitKey.modifierEnter.shouldSubmit(press(shift: true)))
    #expect(SubmitKey.modifierEnter.shouldSubmit(press(command: true)))
    #expect(SubmitKey.modifierEnter.shouldSubmit(press(control: true)))
}

@Test("Return で送る送信キーでは、Return で送り、⇧Return で改行する")
func enterSubmitKey() {
    #expect(SubmitKey.enter.shouldSubmit(press()))
    #expect(!SubmitKey.enter.shouldSubmit(press(shift: true)))
}

@Test("どちらの送信キーでも、変換を確定する Return では送らない")
func composingNeverSubmits() {
    #expect(!SubmitKey.enter.shouldSubmit(press(composing: true)))
    #expect(!SubmitKey.modifierEnter.shouldSubmit(press(command: true, composing: true)))
}

@Test("送信キーの選択肢と入力欄の案内に送り方を出し、Web と同じ値で覚える")
func submitKeyTexts() {
    #expect(SubmitKey.allCases.map(\.label) == ["⌘Return で送信", "Return で送信"])
    #expect(SubmitKey.modifierEnter.hint == "⌘Return で送信、Return で改行")
    #expect(SubmitKey.allCases.map(\.rawValue) == ["ModifierEnter", "Enter"])
}

@Test("日本語入力で変換している間は、画面が描き直されても入力欄の本文を書き換えない")
func keepsComposingText() {
    // 「あいう」と書いたあとに「え」を変換している。画面が持っている本文には、まだ「え」が入っていない
    #expect(!shouldReplaceEditorText(current: "あいうえ", incoming: "あいう", isComposing: true))
}

@Test("変換していなければ、送ったあとに空にするなど、画面の本文で入力欄を書き換える")
func replacesWhenNotComposing() {
    #expect(shouldReplaceEditorText(current: "送った記入", incoming: "", isComposing: false))
    #expect(!shouldReplaceEditorText(current: "同じ", incoming: "同じ", isComposing: false))
}
