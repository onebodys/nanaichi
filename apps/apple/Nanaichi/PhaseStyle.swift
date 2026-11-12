import NanaichiDomain
import SwiftUI

/// フェーズの色と記号。Web と同じ色相（集中は青、ジャーナルは琥珀、休憩は緑）を、ライトとダークで
/// 見え方を合わせてくれるシステムの色で出す
struct PhaseStyle {
    let color: Color
    let symbol: String

    static let focus = PhaseStyle(color: .blue, symbol: "scope")
    static let journal = PhaseStyle(color: .orange, symbol: "square.and.pencil")
    static let breakTime = PhaseStyle(color: .green, symbol: "cup.and.saucer")
    static let idle = PhaseStyle(color: .secondary, symbol: "pause.circle")
    static let ended = PhaseStyle(color: .secondary, symbol: "flag.checkered")

    static func of(_ phase: PhaseKind) -> PhaseStyle {
        switch phase {
        case .focus: .focus
        case .journal: .journal
        case .breakTime: .breakTime
        }
    }

    /// 状態の色。切り替え待ちは、これから始まるフェーズの色
    static func of(_ state: UnendedTimerState) -> PhaseStyle {
        switch state {
        case .focus: .focus
        case .journal: .journal
        case .breakTime: .breakTime
        case .idle: .idle
        case .awaitingAdvance(let awaiting): .of(awaiting.finished.next.kind)
        }
    }
}
