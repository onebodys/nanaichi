import { useState } from "react";
import * as v from "valibot";

/**
 * 知らせ方の設定（GLOSSARY）。端末（ブラウザ）ごとに localStorage に持ち、サーバーには送らない。
 *
 * 3つは互いに独立した好み。音を消している間も音量は持っておき、鳴らすに戻したときにその音量で鳴らす。
 */
export type Volume = "Low" | "Medium" | "High";

export type AlertSettings = Readonly<{
  sound: boolean;
  volume: Volume;
  /** ブラウザ通知を出すか。ブラウザが許可していなければ、出すにしていても出ない */
  notification: boolean;
}>;

export const VOLUMES = ["Low", "Medium", "High"] as const satisfies ReadonlyArray<Volume>;

/** 初めて開いた端末の設定。気づけることを優先して、音は大きく、通知も出す */
export const DEFAULT_ALERT_SETTINGS = {
  sound: true,
  volume: "High",
  notification: true,
} as const satisfies AlertSettings;

const AlertSettingsJsonSchema: v.GenericSchema<unknown, AlertSettings> = v.object({
  sound: v.boolean(),
  volume: v.picklist(VOLUMES),
  notification: v.boolean(),
});

const STORAGE_KEY = "nanaichi:alert-settings";

/**
 * 保存しておいた文字列を設定に戻す。保存がない・壊れている・古い形のときは初期の設定にする
 * （設定が読めないだけでタイマーを使えなくはしない）
 */
export const parseAlertSettings = (stored: string | null): AlertSettings => {
  if (stored === null) {
    return DEFAULT_ALERT_SETTINGS;
  }
  try {
    const parsed = v.safeParse(AlertSettingsJsonSchema, JSON.parse(stored));
    return parsed.success ? parsed.output : DEFAULT_ALERT_SETTINGS;
  } catch {
    return DEFAULT_ALERT_SETTINGS;
  }
};

/** 今の設定を読む。フェーズが切り替わるたびに読むので、別のタブで変えた設定もそのまま効く */
export const loadAlertSettings = (): AlertSettings => {
  try {
    return parseAlertSettings(localStorage.getItem(STORAGE_KEY));
  } catch {
    // プライベートブラウズなどで localStorage を使えないときも、初期の設定で知らせる
    return DEFAULT_ALERT_SETTINGS;
  }
};

const saveAlertSettings = (settings: AlertSettings) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // 保存できない端末では、画面には選んだ設定が出るが、知らせるときは初期の設定のままになる
  }
};

/** 設定画面の state。変えるたびに保存する */
export const useAlertSettings = (): Readonly<{
  settings: AlertSettings;
  change: (settings: AlertSettings) => void;
}> => {
  const [settings, setSettings] = useState(loadAlertSettings);
  return {
    settings,
    change: (next) => {
      saveAlertSettings(next);
      setSettings(next);
    },
  };
};
