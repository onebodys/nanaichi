import AVFoundation
import NanaichiDomain
import NanaichiPresentation

/// フェーズの切り替わりの音を鳴らす（docs/PRODUCT.md「タイマー」）。
///
/// 音源のファイルは持たず、`chimeOf` の楽譜から波形をその場で合成して AVAudioEngine で鳴らす。
/// Web の Web Audio と同じ音の高さと音色の作り方なので、Web と同じ音で聞き分けられる。
/// システムの通知音では、どのフェーズに移ったかを音だけで聞き分けられない
@MainActor
final class PhaseAlertPlayer {
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let format: AVAudioFormat

    init() {
        // 44.1kHz・モノラルの float は必ず作れる形式
        format = AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 1)!
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
    }

    /// `to` のフェーズに切り替わったことを、知らせ方の設定 `settings` の音色と音量で知らせる
    func play(to: PhaseKind, settings: AlertSettings) {
        guard settings.sound else { return }
        let buffer = render(chimeOf(to: to, tone: settings.tones[to]), peak: peakOf(settings.volume))
        do {
            if !engine.isRunning { try engine.start() }
        } catch {
            // 音の出力先がない（CI のマシンなど）。通知では知らせられるので続ける
            return
        }
        player.scheduleBuffer(buffer, at: nil, options: .interrupts)
        player.play()
    }

    /// 楽譜の倍音を足し合わせた波形。山を `peak` にそろえ、音量を変えても音割れさせない
    private func render(_ chime: [ChimePartial], peak: Double) -> AVAudioPCMBuffer {
        let sampleRate = format.sampleRate
        let seconds = (chime.map(\.endSeconds).max() ?? 0) + 0.05
        let frames = AVAudioFrameCount(seconds * sampleRate)
        // 形式と長さが決まっているので作れる
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)!
        buffer.frameLength = frames
        let samples = buffer.floatChannelData![0]
        var mixed = [Double](repeating: 0, count: Int(frames))
        for partial in chime {
            let first = Int(partial.startSeconds * sampleRate)
            let last = min(Int(partial.endSeconds * sampleRate), mixed.count - 1)
            guard first < last else { continue }
            for frame in first...last {
                let t = Double(frame) / sampleRate - partial.startSeconds
                mixed[frame] += envelope(partial, at: t) * wave(partial, at: t)
            }
        }
        let loudest = mixed.map(abs).max() ?? 0
        let gain = loudest > 0 ? peak / loudest : 0
        for (frame, value) in mixed.enumerated() { samples[frame] = Float(value * gain) }
        return buffer
    }
}

/// Web Audio の `exponentialRampToValueAtTime` と同じ形: ごく小さい音から `attackSeconds` で `level` へ上がり、
/// `endSeconds` へ向けてごく小さい音へ下がる。立ち上がりをつけるので、ぷつっという音を出さない
private func envelope(_ partial: ChimePartial, at t: Double) -> Double {
    let silent = 0.0001
    func ramp(_ from: Double, _ to: Double, _ progress: Double) -> Double {
        from * pow(to / from, min(max(progress, 0), 1))
    }
    if t < partial.attackSeconds { return ramp(silent, partial.level, t / partial.attackSeconds) }
    let decaySeconds = partial.endSeconds - partial.startSeconds - partial.attackSeconds
    return ramp(partial.level, silent, (t - partial.attackSeconds) / decaySeconds)
}

private func wave(_ partial: ChimePartial, at t: Double) -> Double {
    let phase = 2 * Double.pi * partial.frequency * t
    switch partial.wave {
    case .sine: return sin(phase)
    case .triangle: return 2 / Double.pi * asin(sin(phase))
    }
}
