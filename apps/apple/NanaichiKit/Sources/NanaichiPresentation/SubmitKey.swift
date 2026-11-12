/// 送信キー（GLOSSARY）。端末ごとに覚える。値は Web の localStorage と同じ文字列
public enum SubmitKey: String, CaseIterable, Hashable, Sendable {
    /// Return で改行し、⌘Return で送る。既定
    case modifierEnter = "ModifierEnter"
    /// Return で送り、⇧Return で改行する
    case enter = "Enter"

    public static let defaultKey = SubmitKey.modifierEnter

    /// 選ぶ欄に出す、送り方
    public var label: String {
        switch self {
        case .modifierEnter: "⌘Return で送信"
        case .enter: "Return で送信"
        }
    }

    /// 入力欄のプレースホルダーに添える、送り方と改行のしかた
    public var hint: String {
        switch self {
        case .modifierEnter: "⌘Return で送信、Return で改行"
        case .enter: "Return で送信、⇧Return で改行"
        }
    }

    /// この Return キーの押し方で送るか。どちらの送信キーでも、日本語入力の変換を確定する Return では送らない。
    ///
    /// Web と同じく、⌘ と ⌃ のどちらでも送る（⌃Return を押した人が改行を期待することはまずない）
    public func shouldSubmit(_ press: ReturnKeyPress) -> Bool {
        if press.isComposing || press.shift { return false }
        switch self {
        case .modifierEnter: return press.command || press.control
        case .enter: return true
        }
    }
}

/// 入力欄で押された Return キー（テンキーの Enter を含む）と、そのときの修飾キー
public struct ReturnKeyPress: Hashable, Sendable {
    public let shift: Bool
    public let command: Bool
    public let control: Bool
    /// 日本語入力の変換中（確定していない文字がある）か
    public let isComposing: Bool

    public init(shift: Bool, command: Bool, control: Bool, isComposing: Bool) {
        self.shift = shift
        self.command = command
        self.control = control
        self.isComposing = isComposing
    }
}
