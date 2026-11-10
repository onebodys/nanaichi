/// 集中時間（GLOSSARY の「集中時間」）。完了セットの集中の長さを足したもので、ミリ秒で持つ。
public enum FocusTime {
    public static func ofCompletedSets(_ completedSets: Int) -> Int64 {
        Int64(completedSets) * 7 * 60_000
    }
}
