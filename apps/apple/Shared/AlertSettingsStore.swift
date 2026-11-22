import Foundation
import NanaichiPresentation
import Observation

/// 知らせ方の設定（GLOSSARY）。端末ごとに UserDefaults に持ち、記録先には送らない。
/// フェーズが切り替わるたびに読むので、変えたらすぐ次の知らせから効く
@Observable
@MainActor
final class AlertSettingsStore {
    private(set) var settings: AlertSettings
    @ObservationIgnored private let defaults: UserDefaults
    private static let key = "alertSettings"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        settings = AlertSettings.parse(defaults.data(forKey: Self.key))
    }

    func change(_ next: AlertSettings) {
        settings = next
        // 文字列と真偽値だけの値なので、JSON にできないことはない
        defaults.set(try? JSONEncoder().encode(next), forKey: Self.key)
    }
}
