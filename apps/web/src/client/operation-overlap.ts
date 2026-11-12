/** 読み込みを始めたときの操作の様子。読み込みが終わったら `OperationTracker.overlapped` に渡す */
type ReadToken = Readonly<{ busy: boolean; generation: number }>;

export type OperationTracker = Readonly<{
  /** 操作を送り始めた */
  begin: () => void;
  /** 操作の応答を受け取った（成功でも失敗でも） */
  end: () => void;
  /** 読み込みを送り始める */
  readStarted: () => ReadToken;
  /** 読み込みを送ってから受け取るまでに、操作と重なったか */
  overlapped: (token: ReadToken) => boolean;
}>;

/**
 * 自分の操作と重なった読み込みを見分ける。
 *
 * 画面は届いたスナップショットのサーバーの時刻で新旧を決め、同じ時刻なら同じ変更とみなす（ADR 0012）。
 * ところが Workers の時計は I/O のあいだ止まるので、開始と同時に届いた読み込み（同期の WebSocket が
 * 繋がったときの読み込み直しなど）は、開始より先に処理されても開始と同じ時刻になることがある。
 * その応答が開始の応答より後に届くと、開始を巻き戻してしまう。
 * 操作と重なった読み込みは、操作の応答のほうが新しいか同じなので、捨ててよい。
 */
export const createOperationTracker = (): OperationTracker => {
  let inFlight = 0;
  // 操作を送り始めるたびと受け取るたびに増える
  let generation = 0;
  return {
    begin: () => {
      inFlight += 1;
      generation += 1;
    },
    end: () => {
      inFlight -= 1;
      generation += 1;
    },
    readStarted: () => ({ busy: inFlight > 0, generation }),
    overlapped: (token) => token.busy || token.generation !== generation,
  };
};
