import Foundation
import NanaichiDomain
import Testing

@testable import NanaichiPresentation

private func fundamentals(_ chime: [ChimePartial], tone: AlertTone = .bell) -> [Double] {
    let partialsPerNote = chimeOf(to: .journal, tone: tone).count / 4
    return stride(from: 0, to: chime.count, by: partialsPerNote).map { chime[$0].frequency }
}

@Test("フェーズごとに音の高さの並びが違い、同じ並びを2回くり返す")
func chimePitchesPerPhase() {
    #expect(fundamentals(chimeOf(to: .focus, tone: .bell)) == [784, 1175, 784, 1175])
    #expect(fundamentals(chimeOf(to: .journal, tone: .bell)) == [1047, 1047, 1047, 1047])
    #expect(fundamentals(chimeOf(to: .breakTime, tone: .bell)) == [1175, 880, 659, 1175, 880, 659])
}

@Test("音色を変えても音の高さの並びは変わらず、余韻の長さが変わる")
func tonesKeepPitches() {
    let marimba = chimeOf(to: .focus, tone: .marimba)
    #expect(marimba.first?.frequency == 784)
    let bellEnd = chimeOf(to: .focus, tone: .bell).map(\.endSeconds).max() ?? 0
    let marimbaEnd = marimba.map(\.endSeconds).max() ?? 0
    #expect(marimbaEnd < bellEnd)
    #expect(chimeOf(to: .focus, tone: .electronic).allSatisfy { $0.wave == .triangle })
}

@Test("音量が大きいほど山を高くし、大でも音割れする手前に収める")
func volumePeaks() {
    #expect(peakOf(.low) < peakOf(.medium))
    #expect(peakOf(.medium) < peakOf(.high))
    #expect(peakOf(.high) < 1)
}

@Test("知らせ方の設定は Web と同じ JSON で読み、読めなければ初期の設定にする")
func alertSettingsParse() {
    let json = #"{"sound":false,"volume":"Low","tones":{"Focus":"Marimba","Journal":"Soft","Break":"Bell"},"notification":true}"#
    let parsed = AlertSettings.parse(Data(json.utf8))
    #expect(parsed.sound == false)
    #expect(parsed.volume == .low)
    #expect(parsed.tones[.journal] == .soft)
    #expect(AlertSettings.parse(Data("壊れた".utf8)) == .defaults)
    #expect(AlertSettings.parse(nil) == .defaults)
}
