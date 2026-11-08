/// ToDo の設定（GLOSSARY の「ToDo の設定」、ADR 0027）。ToDo とジャーナルからの完了を使うかどうか。
/// アカウントごとに1つ持ち、既定は無効
public enum TaskSetting: Hashable, Sendable {
    case enabled
    case disabled

    public static let `default` = TaskSetting.disabled
}

/// JSON では `{ "kind": "Enabled" }` のように `kind` だけを持つオブジェクトにする（TS の `TaskSetting`）
extension TaskSetting: Codable {
    private enum Kind: String, Codable {
        case enabled = "Enabled"
        case disabled = "Disabled"
    }

    public init(from decoder: any Decoder) throws {
        switch try decoder.kind(Kind.self) {
        case .enabled: self = .enabled
        case .disabled: self = .disabled
        }
    }

    public func encode(to encoder: any Encoder) throws {
        switch self {
        case .enabled: try encoder.encode(kind: Kind.enabled) { _ in }
        case .disabled: try encoder.encode(kind: Kind.disabled) { _ in }
        }
    }
}
