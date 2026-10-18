import { describe, expect, test } from "vite-plus/test";
import {
  DEFAULT_ALERT_SETTINGS,
  parseAlertSettings,
  toneFor,
  withTone,
  type AlertSettings,
} from "./alert-settings.ts";

/** どのフェーズも鐘（以前からの鳴り方） */
const BELLS = { Focus: "Bell", Journal: "Bell", Break: "Bell" } as const;

describe("知らせ方の設定の読み込み", () => {
  test("保存したことのない端末では、音を大きく鳴らし、ブラウザ通知も出す", () => {
    expect(parseAlertSettings(null)).toEqual({
      sound: true,
      volume: "High",
      tones: BELLS,
      notification: true,
    });
  });

  test.each<[string, AlertSettings]>([
    ["音を小さく・通知なし", { sound: true, volume: "Low", tones: BELLS, notification: false }],
    [
      "音なし（音量と音色は覚えておく）・通知あり",
      {
        sound: false,
        volume: "Medium",
        tones: { Focus: "Marimba", Journal: "Soft", Break: "Electronic" },
        notification: true,
      },
    ],
  ])("保存した設定（%s）をそのまま読み戻す", (_, settings) => {
    expect(parseAlertSettings(JSON.stringify(settings))).toEqual(settings);
  });

  test.each([
    ["JSON でない", "{"],
    ["知らない音量", JSON.stringify({ sound: true, volume: "Max", notification: true })],
    [
      "知らない音色",
      JSON.stringify({
        sound: true,
        volume: "Low",
        tones: { Focus: "Gong", Journal: "Bell", Break: "Bell" },
        notification: true,
      }),
    ],
    ["項目が足りない", JSON.stringify({ notification: false })],
    ["以前の形", JSON.stringify({ sound: { kind: "SoundOn", volume: "Low" }, notification: true })],
  ])("壊れた保存（%s）は初期の設定として読む", (_, stored) => {
    expect(parseAlertSettings(stored)).toEqual(DEFAULT_ALERT_SETTINGS);
  });
});

describe("フェーズごとの音色", () => {
  test("音色を選べるようになる前に保存した設定は、音量と通知はそのままに、どのフェーズも鐘で読む", () => {
    expect(
      parseAlertSettings(JSON.stringify({ sound: true, volume: "Low", notification: false })),
    ).toEqual({ sound: true, volume: "Low", tones: BELLS, notification: false });
  });

  test("ジャーナルに入るときの音色だけを選び直すと、集中と休憩に入るときの音色は変わらない", () => {
    const settings = withTone(DEFAULT_ALERT_SETTINGS, "Journal", "Marimba");
    expect(toneFor(settings, "Journal")).toBe("Marimba");
    expect(toneFor(settings, "Focus")).toBe("Bell");
    expect(toneFor(settings, "Break")).toBe("Bell");
  });
});
