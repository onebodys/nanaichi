/**
 * 記録に使う時刻。時計 `clock` が記録済みのいちばん遅い時刻 `latest` より後ならそのまま、
 * そうでなければ `latest` の 1ms 後を使う（Issue #37）。
 *
 * 同じミリ秒の操作イベントと進め方の変更は、並べ方によって受け付けたときの判断と計算し直したときの判断が
 * 食い違いうる。記録の時刻をいつも前の記録より後にして、同じミリ秒の記録を作らない。
 * 時計が戻ったとき（この端末）と、時刻が要求の間に進まないとき（Workers）の両方に効く。
 */
export const recordTimeAfter = (clock: Date, latest: Date | undefined): Date =>
  latest !== undefined && latest.getTime() >= clock.getTime()
    ? new Date(latest.getTime() + 1)
    : clock;
