import { describe, expect, test } from "vite-plus/test";
import {
  DEFAULT_ALERT_SETTINGS,
  parseAlertSettings,
  type AlertSettings,
} from "./alert-settings.ts";

describe("知らせ方の設定の読み込み", () => {
  test("保存したことのない端末では、音を大きく鳴らし、ブラウザ通知も出す", () => {
    expect(parseAlertSettings(null)).toEqual({ sound: true, volume: "High", notification: true });
  });

  test.each<[string, AlertSettings]>([
    ["音を小さく・通知なし", { sound: true, volume: "Low", notification: false }],
    [
      "音なし（音量は中のまま覚えておく）・通知あり",
      { sound: false, volume: "Medium", notification: true },
    ],
  ])("保存した設定（%s）をそのまま読み戻す", (_, settings) => {
    expect(parseAlertSettings(JSON.stringify(settings))).toEqual(settings);
  });

  test.each([
    ["JSON でない", "{"],
    ["知らない音量", JSON.stringify({ sound: true, volume: "Max", notification: true })],
    ["項目が足りない", JSON.stringify({ notification: false })],
    ["以前の形", JSON.stringify({ sound: { kind: "SoundOn", volume: "Low" }, notification: true })],
  ])("壊れた保存（%s）は初期の設定として読む", (_, stored) => {
    expect(parseAlertSettings(stored)).toEqual(DEFAULT_ALERT_SETTINGS);
  });
});
