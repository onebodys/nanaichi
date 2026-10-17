/**
 * 時計のずれ（GLOSSARY の「時計のずれ」）。サーバーの時刻 − 端末の時刻（ミリ秒）。
 *
 * 操作イベントの時刻はサーバーが受け付けた時刻で記録する（ADR 0007）ので、画面は端末の時刻に
 * このずれを足してサーバーの時刻を見積もり、`deriveTimerState` に渡す（ADR 0003）。
 */
export type ClockOffset = Readonly<{ serverAheadMs: number }>;

/** スナップショットを取りに行った1回のやり取り。時刻はどれも端末の時計で読んだもの（`serverTime` を除く） */
type RoundTrip = Readonly<{
  /** リクエストを送った端末の時刻 */
  requestedAt: Date;
  /** 応答を受け取った端末の時刻 */
  receivedAt: Date;
  /** 応答に含まれていたサーバーの時刻 */
  serverTime: Date;
}>;

// `new Date(ms)` は現在時刻を読まないので純粋（AGENTS.md の禁止は引数なしの `new Date()`）
export const ClockOffset = {
  /**
   * 1回のやり取りからずれを測る。サーバーが時刻を読んだのは、送ってから受け取るまでの
   * ちょうど中間だったとみなす（通信の行きと帰りにかかる時間は同じくらいと仮定する）。
   */
  measure: ({ requestedAt, receivedAt, serverTime }: RoundTrip): ClockOffset => ({
    serverAheadMs: serverTime.getTime() - (requestedAt.getTime() + receivedAt.getTime()) / 2,
  }),

  /**
   * 端末の時刻 `deviceNow` のときの、サーバーの時刻の見積もり。
   *
   * 見積もりの誤差で、スナップショットのサーバー時刻（記録済みのどの操作イベントよりも後）より
   * 前に戻らないようにする。戻ると、直前に記録した操作がまだ起きていないものとして計算されてしまう。
   */
  serverNow: (offset: ClockOffset, deviceNow: Date, snapshotServerTime: Date): Date =>
    new Date(Math.max(snapshotServerTime.getTime(), deviceNow.getTime() + offset.serverAheadMs)),
} as const;
