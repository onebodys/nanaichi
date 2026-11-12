import AVFoundation
import Foundation
import NanaichiDomain
import NanaichiPresentation
import UserNotifications
import os

/// フェーズの切り替わりの通知を、ローカル通知として前もって予約する（ADR 0003）。
///
/// 予約は OS が持つので、アプリを閉じていても、画面を開いていなくても届く。
/// 予約し直すときは、前の予約（ID の頭が `phaseNotificationIdentifierPrefix`）を消してから入れ直す
@MainActor
final class PhaseNotificationScheduler {
    private let center = UNUserNotificationCenter.current()
    private let clock: AppClock
    private let log = Logger(subsystem: "app.nanaichi.mac", category: "notifications")
    /// 予約し直しを1つずつ順に行う。前の予約し直しの途中で次が始まると、消したあとに古い予約が入りうる
    private var queue: Task<Void, Never>?

    init(clock: AppClock) {
        self.clock = clock
    }

    /// 通知の許可を求める。もう答えてあれば聞き直さない（OS が聞き直させない）。開始ボタンなど人の操作の中で呼ぶ
    func requestAuthorization() {
        Task {
            do {
                let granted = try await center.requestAuthorization(options: [.alert, .sound])
                log.info("通知の許可: \(granted, privacy: .public)")
            } catch {
                log.error("通知の許可を求められなかった: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    /// 予約を `plan` に置き換える。`sound` の知らせ方の音色と音量で鳴らす。nil なら鳴らさない（アプリが自分で鳴らすとき）
    func reschedule(_ plan: [PlannedPhaseNotification], sound: AlertSettings?) {
        let previous = queue
        queue = Task {
            await previous?.value
            await replace(with: plan, sound: sound)
        }
    }

    /// 予約し直しが終わるまで待つ。アプリを終了する前に、音を鳴らす予約に入れ替えるのを待つ
    func settle() async {
        await queue?.value
    }

    private func replace(with plan: [PlannedPhaseNotification], sound: AlertSettings?) async {
        let stale = await center.pendingNotificationRequests().map(\.identifier)
            .filter { $0.hasPrefix(phaseNotificationIdentifierPrefix) }
        center.removePendingNotificationRequests(withIdentifiers: stale)
        let now = Date()
        var added = 0
        for item in plan {
            // 秒より細かくは指定できないので、切り替わりより先に届かないよう秒を切り上げる
            let fireAt = Date(timeIntervalSince1970: clock.wallDate(item.at).timeIntervalSince1970.rounded(.up))
            guard fireAt > now else { continue }
            let content = UNMutableNotificationContent()
            content.title = item.title
            content.body = item.body
            content.threadIdentifier = "phase-change"
            content.sound = sound.map { soundOf(item.to.kind, settings: $0) }
            let trigger = UNCalendarNotificationTrigger(
                dateMatching: Calendar.current.dateComponents(
                    [.year, .month, .day, .hour, .minute, .second], from: fireAt),
                repeats: false)
            do {
                try await center.add(UNNotificationRequest(identifier: item.identifier, content: content, trigger: trigger))
                added += 1
            } catch {
                log.error("通知を予約できなかった: \(error.localizedDescription, privacy: .public)")
            }
        }
        let pending = await center.pendingNotificationRequests().count
        let status = await center.notificationSettings().authorizationStatus
        log.info(
            "通知を予約した: \(added, privacy: .public)件（保留中 \(pending, privacy: .public)件、音 \(sound != nil, privacy: .public)、許可 \(String(describing: status), privacy: .public)）"
        )
    }
}

/// 通知の音。アプリが鳴らすのと同じ音色と音量の音を、通知が読める Library/Sounds に書き出しておく
/// （アプリを終了している間に届く通知も、どのフェーズに移ったかを音で聞き分けられるように）。
/// 書き出せなければシステムの通知音にする
private func soundOf(_ to: PhaseKind, settings: AlertSettings) -> UNNotificationSound {
    let name = chimeSoundFileNameOf(to: to, settings: settings)
    let directory = URL.libraryDirectory.appending(path: "Sounds", directoryHint: .isDirectory)
    let url = directory.appending(path: name)
    if !FileManager.default.fileExists(atPath: url.path) {
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try writeChime(to: to, settings: settings, at: url)
        } catch {
            return .default
        }
    }
    return UNNotificationSound(named: UNNotificationSoundName(name))
}

/// 合成した音を 16 ビットの PCM の CAF に書く。書きかけのファイルを残さないよう、書き終えてから置く
private func writeChime(to: PhaseKind, settings: AlertSettings, at url: URL) throws {
    let buffer = renderChime(to: to, settings: settings)
    let partial = url.deletingLastPathComponent().appending(path: ".\(url.lastPathComponent).partial")
    try? FileManager.default.removeItem(at: partial)
    do {
        let file = try AVAudioFile(
            forWriting: partial,
            settings: [
                AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: buffer.format.sampleRate,
                AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false,
            ],
            commonFormat: .pcmFormatFloat32, interleaved: false)
        try file.write(from: buffer)
    }
    try FileManager.default.moveItem(at: partial, to: url)
}
