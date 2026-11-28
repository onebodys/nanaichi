import Foundation
import NanaichiDomain
import SwiftUI

/// Watch のアプリ（ADR 0031）。iPhone のアプリに同梱し、WatchConnectivity でペアの iPhone につなぐ。
/// 記録先は持たず、操作は iPhone に頼む。iPhone に届かないあいだは操作を受け付けない
@main
struct NanaichiWatchApp: App {
    @State private var model = WatchModel(link: phoneLink(), clock: systemClock)
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            WatchTimerView(model: model)
                .task { await model.run() }
        }
        .onChange(of: scenePhase, initial: true) { _, phase in model.activeChanged(phase == .active) }
    }
}

private let systemClock: @Sendable () -> Instant = {
    Instant(milliseconds: Int64((Date().timeIntervalSince1970 * 1000).rounded(.down)))
}

private func phoneLink() -> any PhoneLink {
    #if DEBUG
        if let stub = StubPhoneLink(ProcessInfo.processInfo.environment, clock: systemClock) { return stub }
    #endif
    return WatchConnectivityPhoneLink()
}
