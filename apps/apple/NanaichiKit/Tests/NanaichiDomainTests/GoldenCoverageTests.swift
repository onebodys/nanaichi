import Testing

/// まだ Swift に移していない関数。TS にゴールデンケースのある関数を足したら、Swift に移すまでここに書く
private let notYetPorted: Set<String> = []

@Test("ゴールデンケースのどの関数も、Swift のテストで通すか、まだ移していないと書いてある")
func everyGoldenFunctionIsCovered() {
    let all = Set(Golden.allFunctions)
    #expect(!all.isEmpty, "ゴールデンケースが見つからない: \(goldenDirectory.path)")
    #expect(all.subtracting(Golden.loaded).subtracting(notYetPorted).sorted() == [])
    #expect(notYetPorted.intersection(Golden.loaded).sorted() == [], "移したのにまだ書いてある")
    #expect(notYetPorted.subtracting(all).sorted() == [], "ゴールデンケースにない関数")
}
