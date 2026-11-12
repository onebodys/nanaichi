import Foundation
import NanaichiDomain

/// 音量
public enum Volume: String, CaseIterable, Codable, Sendable {
    case low = "Low"
    case medium = "Medium"
    case high = "High"
}

/// 音色（GLOSSARY）。フェーズの切り替わりで鳴らす音の種類。どれも合成する（`Chime.swift`）
public enum AlertTone: String, CaseIterable, Codable, Sendable {
    /// 鐘。倍音を重ねた、余韻の長い音
    case bell = "Bell"
    /// 木琴。短く、木を叩いたような音
    case marimba = "Marimba"
    /// 電子音。はっきりした短い音
    case electronic = "Electronic"
    /// やわらか。立ち上がりがゆるく、倍音の少ない音
    case soft = "Soft"
}

/// 切り替わった先のフェーズごとの音色。ジャーナルの終わりは集中にも休憩にも行くので、行き先で分ける
public struct AlertTones: Hashable, Codable, Sendable {
    public var focus: AlertTone
    public var journal: AlertTone
    public var breakTime: AlertTone

    enum CodingKeys: String, CodingKey {
        case focus = "Focus"
        case journal = "Journal"
        case breakTime = "Break"
    }

    public subscript(to: PhaseKind) -> AlertTone {
        switch to {
        case .focus: focus
        case .journal: journal
        case .breakTime: breakTime
        }
    }
}

/// 知らせ方の設定（GLOSSARY）。端末ごとに持ち、記録先には送らない。形は Web の localStorage と同じ JSON
public struct AlertSettings: Hashable, Codable, Sendable {
    public var sound: Bool
    public var volume: Volume
    public var tones: AlertTones
    /// 通知を出すか。システムの設定で許可していなければ、出すにしていても出ない
    public var notification: Bool

    /// 初めて開いた端末の設定。気づけることを優先して、音は大きく、通知も出す。音色はどのフェーズも鐘
    public static let defaults = AlertSettings(
        sound: true, volume: .high, tones: AlertTones(focus: .bell, journal: .bell, breakTime: .bell),
        notification: true)

    /// 保存しておいた JSON を設定に戻す。保存がない・壊れているときは初期の設定にする
    /// （設定が読めないだけでタイマーを使えなくはしない）
    public static func parse(_ stored: Data?) -> AlertSettings {
        guard let stored, let parsed = try? JSONDecoder().decode(AlertSettings.self, from: stored) else {
            return defaults
        }
        return parsed
    }
}
