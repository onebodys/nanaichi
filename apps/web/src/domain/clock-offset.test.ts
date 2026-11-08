import { goldenCases } from "../testing/golden.ts";
import { ClockOffset } from "./clock-offset.ts";

const T = Date.UTC(2026, 9, 17, 0, 0, 0);
const ms = (offset: number) => new Date(T + offset);

goldenCases(
  "ClockOffset.measure",
  (i: Readonly<{ requestedAt: Date; receivedAt: Date; serverTime: Date }>) =>
    ClockOffset.measure(i),
  [
    {
      // 端末で 0ms に送り 200ms に受け取った。サーバーは中間（端末の 100ms）に、5秒進んだ時計で読んだ
      name: "サーバーの時刻と、送ってから受け取るまでの端末の時刻の中間との差を測る",
      input: { requestedAt: ms(0), receivedAt: ms(200), serverTime: ms(5_100) },
      expected: { serverAheadMs: 5_000 },
    },
    {
      name: "端末の時計が進んでいれば、ずれは負になる",
      input: { requestedAt: ms(3_000), receivedAt: ms(3_000), serverTime: ms(0) },
      expected: { serverAheadMs: -3_000 },
    },
  ],
);

goldenCases(
  "ClockOffset.serverNow",
  (i: Readonly<{ offset: ClockOffset; deviceNow: Date; snapshotServerTime: Date }>) =>
    ClockOffset.serverNow(i.offset, i.deviceNow, i.snapshotServerTime),
  [
    {
      name: "端末の時刻にずれを足す",
      input: { offset: { serverAheadMs: 5_000 }, deviceNow: ms(10_000), snapshotServerTime: ms(0) },
      expected: ms(15_000),
    },
    {
      // 見積もりの誤差で、直前に記録した操作がまだ起きていないことにならないようにする
      name: "スナップショットのサーバー時刻より前には戻らない",
      input: {
        offset: { serverAheadMs: -50 },
        deviceNow: ms(1_000),
        snapshotServerTime: ms(1_000),
      },
      expected: ms(1_000),
    },
  ],
);
