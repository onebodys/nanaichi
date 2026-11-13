import Testing

@testable import NanaichiDomain

private struct Text: Decodable { let value: String }
private struct Texts: Decodable { let value: [String] }

private struct WithinLimit: Decodable {
    let inUse: [TagName]
    let kept: [TagName]
    let tags: [TagName]
}

private struct CanAdd: Decodable {
    let inUse: [TagName]
    let attached: [TagName]
    let name: TagName
}

private struct Deletable: Decodable {
    let inUse: [TagName]
    let deleted: DeletedTag
}

private struct ApplyTo: Decodable {
    let tags: [TagName]
    let deleted: DeletedTag
}

@Test("TagName.parse", arguments: Golden.cases("TagName.parse"))
func tagNameParseCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, Text.self) { GoldenResult(parsed: TagName($0.value)) }
}

@Test("Tags.parse", arguments: Golden.cases("Tags.parse"))
func tagsParseCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, Texts.self) { GoldenResult(parsed: Tags.parse($0.value)) }
}

@Test("Tag.ensureWithinLimit", arguments: Golden.cases("Tag.ensureWithinLimit"))
func ensureWithinLimitCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, WithinLimit.self) {
        GoldenResult(Tag.ensureWithinLimit(inUse: $0.inUse, kept: $0.kept, tags: $0.tags))
    }
}

@Test("Tag.canAdd", arguments: Golden.cases("Tag.canAdd"))
func canAddCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, CanAdd.self) {
        Tag.canAdd(inUse: $0.inUse, attached: $0.attached, name: $0.name)
    }
}

@Test("DeletedTag.ensureDeletable", arguments: Golden.cases("DeletedTag.ensureDeletable"))
func ensureDeletableCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, Deletable.self) { GoldenResult($0.deleted.ensureDeletable(inUse: $0.inUse)) }
}

@Test("DeletedTag.applyTo", arguments: Golden.cases("DeletedTag.applyTo"))
func applyToCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, ApplyTo.self) { $0.deleted.apply(to: $0.tags) }
}

@Test(
    "タグの名前は JS と同じ規則で寄せる（語末のシグマ、JS だけが空白とみなす U+FEFF、JS が空白とみなさない U+0085）",
    arguments: [
        ("ΟΔΟΣ", "οδος"),
        ("\u{FEFF}#Tag\u{FEFF}", "tag"),
        ("Ⅻ", "xii"),
    ])
func tagNameMatchesJS(_ input: String, _ expected: String) {
    #expect(TagName(input)?.rawValue == expected)
}

@Test("JS が空白とみなさない U+0085 は名前に残る（Swift の isWhitespace では空白）")
func tagNameKeepsNextLine() {
    #expect(TagName("a\u{85}")?.rawValue == "a\u{85}")
}
