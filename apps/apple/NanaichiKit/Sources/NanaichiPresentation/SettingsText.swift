import NanaichiDomain

// 設定の文言。判断はせず、設定の値を言葉にするだけ（Web の settings-text.ts）

public struct LabelAndDescription: Hashable, Sendable {
    public let label: String
    public let description: String
}

/// フェーズの進め方の行の見出しと補足（GLOSSARY の「フェーズの進め方」）
public func transitionTextOf(_ transition: PhaseTransition) -> LabelAndDescription {
    switch transition {
    case .focusToJournal: LabelAndDescription(label: "集中 → ジャーナル", description: "集中の7分が終わったとき")
    case .journalToFocus: LabelAndDescription(label: "ジャーナル → 集中", description: "次のセットの集中に進むとき")
    case .journalToBreak: LabelAndDescription(label: "ジャーナル → 休憩", description: "3セット目のジャーナルのあと")
    case .breakToFocus: LabelAndDescription(label: "休憩 → 集中", description: "次のラウンドの集中に進むとき")
    }
}

public func advanceChoiceTextOf(_ choice: AdvanceChoice) -> String {
    switch choice {
    case .auto: "自動"
    case .manual: "手動"
    }
}

public let advanceChoices: [AdvanceChoice] = [.auto, .manual]

public func volumeTextOf(_ volume: Volume) -> String {
    switch volume {
    case .low: "小"
    case .medium: "中"
    case .high: "大"
    }
}

public func toneTextOf(_ tone: AlertTone) -> String {
    switch tone {
    case .bell: "鐘"
    case .marimba: "木琴"
    case .electronic: "電子音"
    case .soft: "やわらか"
    }
}

/// 音色を選ぶ行の見出しと補足。行き先のフェーズで分ける
/// （ジャーナルの終わりは集中にも休憩にも行くので、「何が終わったとき」では分けられない）
public func toneTargetOf(_ to: PhaseKind) -> LabelAndDescription {
    switch to {
    case .journal: LabelAndDescription(label: "ジャーナルに入るとき", description: "集中が終わり、書く時間になる合図")
    case .focus: LabelAndDescription(label: "集中に入るとき", description: "ジャーナルや休憩が終わり、次の集中が始まる合図")
    case .breakTime: LabelAndDescription(label: "休憩に入るとき", description: "ラウンドの最後のジャーナルが終わった合図")
    }
}

/// 音色を選ぶ行の並び。1セットの流れの順にする
public let toneTargets: [PhaseKind] = [.journal, .focus, .breakTime]

extension AlertSettings {
    /// 切り替わった先のフェーズの音色だけを選び直した設定
    public func withTone(_ tone: AlertTone, to: PhaseKind) -> AlertSettings {
        var next = self
        switch to {
        case .focus: next.tones.focus = tone
        case .journal: next.tones.journal = tone
        case .breakTime: next.tones.breakTime = tone
        }
        return next
    }
}

/// 画面の明るさの好み。端末ごとに覚える。値は Web の localStorage と同じ文字列
public enum ThemePreference: String, CaseIterable, Hashable, Sendable {
    case system = "System"
    case light = "Light"
    case dark = "Dark"
}

public func themeTextOf(_ preference: ThemePreference) -> String {
    switch preference {
    case .system: "Mac に合わせる"
    case .light: "ライト"
    case .dark: "ダーク"
    }
}

/// タグの一覧の前に出す、使っているタグの種類と上限
public func tagKindsNoteOf(inUse: Int) -> String {
    "使えるタグは\(Tag.kindsMax)種類までで、いま\(inUse)種類を使っています。"
}

/// タグの行の補足。ついている記入の数
public func taggedEntryCountTextOf(_ count: Int) -> String { "\(count)件の記入" }

/// タグを削除するボタンの文言。付け替えるなら付け替え先も書く（押すと何が起きるかを示す）
public func tagDeletionActionOf(_ deletion: TagDeletion) -> String {
    switch deletion {
    case .detach: "外して削除"
    case .reassign(let to): "\(tagTextOf(to)) に付け替えて削除"
    }
}

/// タグの削除の確かめの文（`#読書 を削除します。ついている3件の記入は消えず、タグだけを外します。`）
public func tagDeletionMessageOf(_ usage: TagUsage, _ deletion: TagDeletion) -> String {
    let what: String =
        switch deletion {
        case .detach: "外します。"
        case .reassign: "付け替えます。"
        }
    return "\(tagTextOf(usage.name)) を削除します。ついている\(taggedEntryCountTextOf(usage.entryCount))は消えず、タグだけを\(what)"
}
