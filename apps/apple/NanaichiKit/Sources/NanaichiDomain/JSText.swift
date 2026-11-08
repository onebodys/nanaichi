import Foundation

/// 入力の文字列を TS のドメイン（valibot と JS の `String`）と同じ規則で扱うための部品。
///
/// Swift の `Character.isWhitespace` は Unicode の White_Space で、JS の空白とは違う
/// （U+0085 を空白とし、U+FEFF を空白としない）。前後の空白を落とす規則が TS とずれないよう、JS の空白をそのまま書く
extension Unicode.Scalar {
    /// JS の `String.prototype.trim` と正規表現の `\s` が空白とみなすもの（WhiteSpace と LineTerminator）
    var isJSWhitespace: Bool {
        switch value {
        case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0xFEFF, 0x2028, 0x2029: true
        default: properties.generalCategory == .spaceSeparator
        }
    }
}

extension String {
    /// JS の `trim()`。書記素ではなく符号位置で落とすので、結合文字の前の空白は残る（JS と同じ）
    var jsTrimmed: String {
        let scalars = unicodeScalars
        guard let first = scalars.firstIndex(where: { !$0.isJSWhitespace }),
            let last = scalars.lastIndex(where: { !$0.isJSWhitespace })
        else { return "" }
        return String(scalars[first...last])
    }

    /// JS の `length`（UTF-16 の符号単位の数）。valibot の `minLength` / `maxLength` はこれで数える
    var jsLength: Int { utf16.count }

    /// JS の `normalize("NFKC")`
    var nfkc: String { precomposedStringWithCompatibilityMapping }

    /// JS の `toLowerCase()`。ロケールに依らない大文字・小文字の対応で、語末のシグマ（Σ → ς）も JS と同じにする。
    /// Swift の `lowercased()` は語末のシグマを σ にするので使わない
    var jsLowercased: String { lowercased(with: Locale(identifier: "en")) }

    /// JS の `localeCompare`（Workers とブラウザの既定のロケール `en-US` の照合順）
    func jsLocaleCompare(_ other: String) -> ComparisonResult {
        compare(other, locale: Locale(identifier: "en"))
    }
}
