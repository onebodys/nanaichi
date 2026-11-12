/// 記入の本文を表示するときの断片（docs/PRODUCT.md「ジャーナル記入」、Web の linkify.ts）。
///
/// 本文はプレーンテキストとして表示し、`http://` と `https://` で始まる URL だけをリンクにする。
/// Markdown などの記法は解釈しない
public enum TextSegment: Hashable, Sendable {
    case text(String)
    case link(String)
}

/// 空白・改行と、URL の外側にあることの多い全角の文字までを URL とみなす
nonisolated(unsafe) private let urlPattern = /https?:\/\/[^\s<>"'`、。「」『』（）]+/

/// URL の末尾に付いた句読点や閉じかっこは、文の一部として URL から外す
private let trailingPunctuation: Set<Character> = [".", ",", ";", ":", "!", "?", ")", "]", "}"]

public func linkify(_ text: String) -> [TextSegment] {
    var segments: [TextSegment] = []
    var rest = text.startIndex
    for match in text.matches(of: urlPattern) {
        var end = match.range.upperBound
        while end > match.range.lowerBound, trailingPunctuation.contains(text[text.index(before: end)]) {
            end = text.index(before: end)
        }
        if match.range.lowerBound > rest { segments.append(.text(String(text[rest..<match.range.lowerBound]))) }
        segments.append(.link(String(text[match.range.lowerBound..<end])))
        rest = end
    }
    if rest < text.endIndex { segments.append(.text(String(text[rest...]))) }
    return segments
}
