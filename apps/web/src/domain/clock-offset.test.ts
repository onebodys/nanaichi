import { describe, expect, test } from "vite-plus/test";
import { ClockOffset } from "./clock-offset.ts";

const T = Date.UTC(2026, 9, 17, 0, 0, 0);
const ms = (offset: number) => new Date(T + offset);

describe("時計のずれの測定", () => {
  test("サーバーの時刻と、送ってから受け取るまでの端末の時刻の中間との差を測る", () => {
    // 端末で 0ms に送り 200ms に受け取った。サーバーは中間（端末の 100ms）に、5秒進んだ時計で読んだ
    const offset = ClockOffset.measure({
      requestedAt: ms(0),
      receivedAt: ms(200),
      serverTime: ms(5_100),
    });

    expect(offset).toEqual({ serverAheadMs: 5_000 });
  });

  test("端末の時計が進んでいれば、ずれは負になる", () => {
    const offset = ClockOffset.measure({
      requestedAt: ms(3_000),
      receivedAt: ms(3_000),
      serverTime: ms(0),
    });

    expect(offset).toEqual({ serverAheadMs: -3_000 });
  });
});

describe("サーバーの時刻の見積もり", () => {
  test("端末の時刻にずれを足す", () => {
    expect(ClockOffset.serverNow({ serverAheadMs: 5_000 }, ms(10_000), ms(0))).toEqual(ms(15_000));
  });

  test("スナップショットのサーバー時刻より前には戻らない", () => {
    // 見積もりの誤差で、直前に記録した操作がまだ起きていないことにならないようにする
    expect(ClockOffset.serverNow({ serverAheadMs: -50 }, ms(1_000), ms(1_000))).toEqual(ms(1_000));
  });
});
