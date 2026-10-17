/**
 * 操作イベント（GLOSSARY の「操作イベント」）。
 *
 * 人がセッションに対して行った操作だけを、行った時刻とともに記録する。
 * フェーズの自動的な切り替わりは記録せず、`deriveTimerState` が時刻から計算する（ADR 0003）。
 */
type Start = Readonly<{ kind: "Start"; at: Date }>;
type Pause = Readonly<{ kind: "Pause"; at: Date }>;
type Resume = Readonly<{ kind: "Resume"; at: Date }>;
type Abort = Readonly<{ kind: "Abort"; at: Date }>;
type RestartFocus = Readonly<{ kind: "RestartFocus"; at: Date }>;
type SkipBreak = Readonly<{ kind: "SkipBreak"; at: Date }>;
type End = Readonly<{ kind: "End"; at: Date }>;

/** 開始の後にセッションへ行える操作 */
export type SessionOperation = Pause | Resume | Abort | RestartFocus | SkipBreak | End;

/**
 * 1つのセッションの操作イベントを時刻の順に並べたもの。
 *
 * セッションは必ず開始から始まり、開始はセッションに1回だけなので、先頭だけを開始にする型で表す。
 */
export type SessionEvents = readonly [Start, ...ReadonlyArray<SessionOperation>];
