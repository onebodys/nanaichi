import Foundation
import NanaichiDomain
import Testing

@testable import NanaichiPresentation

// MARK: - 記入の本文の URL の自動リンク

@Test("URL のない本文は、そのままのテキスト1つ")
func linkifyPlain() {
    #expect(linkify("設計を書いた\n次はテスト") == [.text("設計を書いた\n次はテスト")])
}

@Test("http と https の URL だけをリンクにし、前後はテキストのまま")
func linkifyLinks() {
    #expect(
        linkify("参考 https://example.com/a?b=1#c と http://example.org") == [
            .text("参考 "), .link("https://example.com/a?b=1#c"), .text(" と "), .link("http://example.org"),
        ])
}

@Test("URL の末尾の句読点や閉じかっこは URL に含めない")
func linkifyTrailingPunctuation() {
    #expect(linkify("(https://example.com/x). 次へ") == [.text("("), .link("https://example.com/x"), .text("). 次へ")])
}

@Test("日本語の句読点で URL が終わる")
func linkifyJapanesePunctuation() {
    #expect(linkify("https://example.com/日本語、を見た") == [.link("https://example.com/日本語"), .text("、を見た")])
}

@Test("javascript: などの URL や記法はリンクにしない")
func linkifyIgnoresOtherSchemes() {
    #expect(linkify("javascript:alert(1) [x](https)") == [.text("javascript:alert(1) [x](https)")])
}

// MARK: - タグの入力欄の候補

private func tag(_ name: String) -> TagName { TagName(name)! }
private let known = [tag("読書"), tag("設計"), tag("book")]

@Test("何も入力していなければ、使っているタグを最近使った順に出す")
func tagOptionsEmptyQuery() {
    #expect(tagOptionsOf(query: "", known: known, attached: []).options == known.map(TagOption.existing))
}

@Test("# だけを入力したときも、使っているタグをすべて出す")
func tagOptionsHashOnly() {
    #expect(tagOptionsOf(query: "＃", known: known, attached: []).options.count == 3)
}

@Test("入力を含む使っているタグを優先し、一致するものがなければ最後に新しく作る候補を出す")
func tagOptionsNew() {
    #expect(
        tagOptionsOf(query: "#読", known: known, attached: []).options == [
            .existing(tag("読書")), .new(tag("読"), creatable: true),
        ])
}

@Test("大文字・全角で入力しても、使っているタグに寄せて探す")
func tagOptionsNormalized() {
    #expect(tagOptionsOf(query: "ＢＯＯＫ", known: known, attached: []).options == [.existing(tag("book"))])
}

@Test("入力欄でつけたまま、まだ書いていないタグも候補に出す")
func tagOptionsAttached() {
    #expect(tagOptionsOf(query: "", known: [], attached: [tag("新しい")]).options == [.existing(tag("新しい"))])
}

@Test("空白を含む入力には候補を出さず、名前の規則の案内を出す")
func tagOptionsInvalid() {
    #expect(tagOptionsOf(query: "読書 メモ", known: known, attached: []) == TagOptions(options: [], hint: .invalid))
}

@Test("20種類を使っていると、新しいタグは作れない候補として出す")
func tagOptionsLimit() {
    let twenty = (1...Tag.kindsMax).map { tag("tag\($0)") }
    let options = tagOptionsOf(query: "読書", known: twenty, attached: []).options
    #expect(options == [.new(tag("読書"), creatable: false)])
    #expect(options.map(tagOptionTextOf) == ["#読書 は作れません（タグは20種類まで）"])
    #expect(!options[0].attachable)
}

// MARK: - 入力欄でつけたままのタグ

private let sessionA = SessionId("0b7a2c4e-1f3d-4a5b-8c6d-7e8f9a0b1c2d")!
private let sessionB = SessionId("1c8b3d5f-2a4e-4b6c-9d7e-8f9a0b1c2d3e")!

@Test("セッションの外でつけたタグは準備したタグになり、次に始めたセッションでもつく")
func preparedTagsCarryIntoSession() {
    let prepared = AttachedTags.attaching([tag("読書")], in: nil)
    #expect(prepared == .prepared([tag("読書")]))
    #expect(prepared.attached(in: sessionA) == [tag("読書")])
    #expect(prepared.adopted(by: sessionA) == .inSession(sessionA, [tag("読書")]))
    #expect(prepared.adopted(by: nil) == nil)
}

@Test("セッションでつけたタグは、そのセッションが終わると外れる")
func sessionTagsDropAfterSession() {
    let attached = AttachedTags.attaching([tag("設計")], in: sessionA)
    #expect(attached.attached(in: sessionA) == [tag("設計")])
    #expect(attached.attached(in: sessionB) == [])
    #expect(attached.attached(in: nil) == [])
}

@Test("タグを削除すると、つけたままのタグからも外れ、付け替えたなら付け替え先になる")
func attachedTagsFollowDeletion() {
    let attached = AttachedTags.inSession(sessionA, [tag("読書"), tag("book")])
    #expect(
        attached.deletingTag(DeletedTag(name: tag("読書"), deletion: .detach)) == .inSession(sessionA, [tag("book")]))
    #expect(
        attached.deletingTag(DeletedTag(name: tag("読書"), deletion: .reassign(to: tag("book"))))
            == .inSession(sessionA, [tag("book")]))
}

@Test("つけたままのタグは Web と同じ JSON で覚え、読めなければ何もついていない")
func attachedTagsJson() throws {
    let attached = AttachedTags.inSession(sessionA, [tag("読書")])
    let object = try #require(try JSONSerialization.jsonObject(with: attached.serialized()) as? [String: Any])
    #expect(object["kind"] as? String == "InSession")
    #expect(object["sessionId"] as? String == sessionA.rawValue)
    #expect(object["tags"] as? [String] == ["読書"])
    #expect(AttachedTags.parse(attached.serialized()) == attached)
    #expect(AttachedTags.parse(Data(#"{"kind":"Prepared","tags":["設計"]}"#.utf8)) == .prepared([tag("設計")]))
    #expect(AttachedTags.parse(Data("壊れた".utf8)) == .none)
    #expect(AttachedTags.parse(nil) == .none)
}
