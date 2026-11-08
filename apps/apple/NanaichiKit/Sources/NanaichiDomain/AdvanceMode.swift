/// フェーズの進め方の4つの切り替わり（GLOSSARY の「フェーズの進め方」、ADR 0016）
public enum PhaseTransition: String, CaseIterable, Codable, Sendable {
    case focusToJournal = "FocusToJournal"
    case journalToFocus = "JournalToFocus"
    case journalToBreak = "JournalToBreak"
    case breakToFocus = "BreakToFocus"

    /// `from` のフェーズの時間が過ぎて `to` に移るときの切り替わり
    init(from: PhaseKind, to: PhaseKind) {
        switch from {
        case .focus: self = .focusToJournal
        case .journal: self = to == .breakTime ? .journalToBreak : .journalToFocus
        case .breakTime: self = .breakToFocus
        }
    }
}

public enum AdvanceChoice: String, Codable, Sendable {
    case auto = "Auto"
    case manual = "Manual"
}

/// フェーズの進め方。切り替わりごとに、時間が過ぎたら自動で次のフェーズに移るか、
/// 切り替え待ちで止まって人が進めるまで待つかを選ぶ。アカウントごとに1つ持つ
public struct AdvanceMode: Hashable, Codable, Sendable {
    public var focusToJournal: AdvanceChoice
    public var journalToFocus: AdvanceChoice
    public var journalToBreak: AdvanceChoice
    public var breakToFocus: AdvanceChoice

    enum CodingKeys: String, CodingKey {
        case focusToJournal = "FocusToJournal"
        case journalToFocus = "JournalToFocus"
        case journalToBreak = "JournalToBreak"
        case breakToFocus = "BreakToFocus"
    }

    public init(
        focusToJournal: AdvanceChoice, journalToFocus: AdvanceChoice,
        journalToBreak: AdvanceChoice, breakToFocus: AdvanceChoice
    ) {
        self.focusToJournal = focusToJournal
        self.journalToFocus = journalToFocus
        self.journalToBreak = journalToBreak
        self.breakToFocus = breakToFocus
    }

    /// 既定はすべて自動（Issue #42。これまでと同じ動き）
    public static let allAuto = AdvanceMode(
        focusToJournal: .auto, journalToFocus: .auto, journalToBreak: .auto, breakToFocus: .auto)

    public subscript(transition: PhaseTransition) -> AdvanceChoice {
        get {
            switch transition {
            case .focusToJournal: focusToJournal
            case .journalToFocus: journalToFocus
            case .journalToBreak: journalToBreak
            case .breakToFocus: breakToFocus
            }
        }
        set {
            switch transition {
            case .focusToJournal: focusToJournal = newValue
            case .journalToFocus: journalToFocus = newValue
            case .journalToBreak: journalToBreak = newValue
            case .breakToFocus: breakToFocus = newValue
            }
        }
    }

    /// `from` のフェーズの時間が過ぎて `to` に移るとき、進め方は手動か
    public func isManual(from: PhaseKind, to: PhaseKind) -> Bool {
        self[PhaseTransition(from: from, to: to)] == .manual
    }
}

/// 進め方を変えた時刻と、変えたあとの進め方
public struct AdvanceModeChange: Hashable, Codable, Sendable {
    public let at: Instant
    public let mode: AdvanceMode

    public init(at: Instant, mode: AdvanceMode) {
        self.at = at
        self.mode = mode
    }

    /// 変更履歴 `changes`（時刻の順）のうち、時刻 `time` に効いている進め方。変更がなければ既定
    public static func modeAt(_ changes: [AdvanceModeChange], _ time: Instant) -> AdvanceMode {
        changes.last { $0.at <= time }?.mode ?? .allAuto
    }

    /// 時刻 `startedAt` に始めたセッションの計算に要る変更（ADR 0016）。
    /// 始めた時刻に効いていた変更（始める前の最後の変更）と、それより後の変更。
    /// 閉じたセッションでは、応答を小さくするため呼び出し側が閉じた時刻までに絞る
    public static func relevantSince(_ changes: [AdvanceModeChange], _ startedAt: Instant)
        -> [AdvanceModeChange]
    {
        let after = changes.firstIndex { $0.at > startedAt } ?? changes.endIndex
        return Array(changes[max(0, after - 1)...])
    }
}
