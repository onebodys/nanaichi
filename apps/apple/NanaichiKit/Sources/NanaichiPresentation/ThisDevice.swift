/// 画面で「この端末」（GLOSSARY）をどう呼ぶか。ネイティブアプリでは、端末の種類で呼ぶ（`この Mac`）
public enum ThisDevice: Sendable {
    case mac, iPhone, iPad

    /// `この Mac`
    public var name: String {
        switch self {
        case .mac: "この Mac"
        case .iPhone: "この iPhone"
        case .iPad: "この iPad"
        }
    }

    /// タグを削除できる画面。iPhone と iPad には設定の画面がない（ADR 0031）
    var tagSettings: String {
        switch self {
        case .mac: "設定の「タグ」"
        case .iPhone, .iPad: "Web か Mac の設定の「タグ」"
        }
    }
}
