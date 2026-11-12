import NanaichiDomain

// フェーズの切り替わりで鳴らす音の楽譜。Web の phase-alert.ts と同じ音の高さと音色の作り方。
// 音源のファイルは持たず、アプリがこの楽譜から波形を合成する（docs/PRODUCT.md「タイマー」）

/// フェーズごとの音の高さ（Hz）の並び。どのフェーズに移ったかを音だけでも聞き分けられるようにする
private func pitchesOf(_ to: PhaseKind) -> [Double] {
    switch to {
    // 上がる2音: 集中を始める
    case .focus: [784, 1175]
    // 高い1音を2回: 書く時間
    case .journal: [1047, 1047]
    // 下がる3音: 休む
    case .breakTime: [1175, 880, 659]
    }
}

public enum Waveform: Hashable, Sendable {
    case sine
    case triangle
}

/// 1音を作る倍音の1つ（基音に対する周波数の比と大きさ）
private struct Overtone {
    let ratio: Double
    let level: Double
}

/// 音色ごとの1音の作り方。`decaySeconds` は基音が消えるまでの秒数で、高い倍音ほど早く消える。
/// 純音（sine 1つ）はノートパソコンのスピーカーでは小さく聞こえて気づきにくいので、どの音色も倍音を重ねる
private struct ToneShape {
    let wave: Waveform
    let partials: [Overtone]
    let attackSeconds: Double
    let decaySeconds: Double
}

private func shapeOf(_ tone: AlertTone) -> ToneShape {
    switch tone {
    case .bell:
        ToneShape(
            wave: .sine,
            partials: [.init(ratio: 1, level: 1), .init(ratio: 2, level: 0.5), .init(ratio: 3, level: 0.3), .init(ratio: 4.2, level: 0.15)],
            attackSeconds: 0.005, decaySeconds: 1.1)
    case .marimba:
        ToneShape(
            wave: .sine,
            partials: [.init(ratio: 1, level: 1), .init(ratio: 3.9, level: 0.35), .init(ratio: 9.2, level: 0.1)],
            attackSeconds: 0.003, decaySeconds: 0.45)
    case .electronic:
        ToneShape(
            wave: .triangle, partials: [.init(ratio: 1, level: 0.9), .init(ratio: 2, level: 0.2)],
            attackSeconds: 0.004, decaySeconds: 0.3)
    case .soft:
        ToneShape(
            wave: .sine, partials: [.init(ratio: 1, level: 1), .init(ratio: 2, level: 0.15)],
            attackSeconds: 0.06, decaySeconds: 1.6)
    }
}

/// 音を鳴らし始めてから次の音までの秒数。前の音の余韻に重ねる
private let noteSpacingSeconds = 0.22
/// 画面から離れていても気づけるよう、同じ並びを繰り返す回数と、その間の秒数
private let repeats = 2
private let repeatGapSeconds = 0.5

/// 楽譜の1つの倍音。`startSeconds` から `attackSeconds` で `level` まで指数的に上がり、`endSeconds` で消える
public struct ChimePartial: Hashable, Sendable {
    public let frequency: Double
    public let level: Double
    public let wave: Waveform
    public let startSeconds: Double
    public let attackSeconds: Double
    public let endSeconds: Double
}

/// `to` のフェーズに切り替わったときに鳴らす楽譜
public func chimeOf(to: PhaseKind, tone: AlertTone) -> [ChimePartial] {
    let shape = shapeOf(tone)
    let pitches = pitchesOf(to)
    let patternSeconds = Double(pitches.count - 1) * noteSpacingSeconds + repeatGapSeconds
    return (0..<repeats).flatMap { repeatIndex in
        pitches.enumerated().flatMap { index, frequency in
            let startsAt = Double(repeatIndex) * patternSeconds + Double(index) * noteSpacingSeconds
            return shape.partials.map { overtone in
                ChimePartial(
                    frequency: frequency * overtone.ratio, level: overtone.level, wave: shape.wave,
                    startSeconds: startsAt, attackSeconds: shape.attackSeconds,
                    // 高い倍音ほど早く消えると鐘らしく聞こえる
                    endSeconds: startsAt + shape.decaySeconds / overtone.ratio.squareRoot())
            }
        }
    }
}

/// 合成した波形の山をそろえる大きさ（1 で音割れする手前）。
/// Web はコンプレッサーで山を抑えてから音量をかけるが、ここでは一度に合成するので、山をこの値に合わせる
public func peakOf(_ volume: Volume) -> Double {
    switch volume {
    case .low: 0.3
    case .medium: 0.6
    case .high: 0.95
    }
}
