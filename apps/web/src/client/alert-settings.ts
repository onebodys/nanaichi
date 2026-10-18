import { useState } from "react";
import * as v from "valibot";
import type { InPhase } from "../domain/phase-change.ts";

/**
 * 知らせ方の設定（GLOSSARY）。端末（ブラウザ）ごとに localStorage に持ち、サーバーには送らない。
 *
 * どれも互いに独立した好み。音を消している間も音量と音色は持っておき、鳴らすに戻したときにそのまま鳴らす。
 */
export type Volume = "Low" | "Medium" | "High";

/**
 * 音色（GLOSSARY）。フェーズの切り替わりで鳴らす音の種類。どれも Web Audio で合成する（phase-alert.ts）。
 *
 * - `Bell`: 鐘。倍音を重ねた、余韻の長い音。以前からの音
 * - `Marimba`: 木琴。短く、木を叩いたような音
 * - `Electronic`: 電子音。はっきりした短い音
 * - `Soft`: やわらか。立ち上がりがゆるく、倍音の少ない音
 */
export type AlertTone = "Bell" | "Marimba" | "Electronic" | "Soft";

export const ALERT_TONES = [
  "Bell",
  "Marimba",
  "Electronic",
  "Soft",
] as const satisfies ReadonlyArray<AlertTone>;

/** 音色を選ぶ単位。切り替わった先のフェーズ（ジャーナルの終わりは集中にも休憩にも行くので、行き先で分ける） */
type PhaseKind = InPhase["kind"];

export type AlertSettings = Readonly<{
  sound: boolean;
  volume: Volume;
  /** 切り替わった先のフェーズごとの音色 */
  tones: Readonly<Record<PhaseKind, AlertTone>>;
  /** ブラウザ通知を出すか。ブラウザが許可していなければ、出すにしていても出ない */
  notification: boolean;
}>;

export const VOLUMES = ["Low", "Medium", "High"] as const satisfies ReadonlyArray<Volume>;

/** 音色を選んだことのない端末の音色。以前からの鳴り方（どのフェーズも鐘）のまま */
const DEFAULT_TONES = {
  Focus: "Bell",
  Journal: "Bell",
  Break: "Bell",
} as const satisfies AlertSettings["tones"];

/** 初めて開いた端末の設定。気づけることを優先して、音は大きく、通知も出す */
export const DEFAULT_ALERT_SETTINGS = {
  sound: true,
  volume: "High",
  tones: DEFAULT_TONES,
  notification: true,
} as const satisfies AlertSettings;

const AlertToneSchema = v.picklist(ALERT_TONES);

const AlertSettingsJsonSchema: v.GenericSchema<unknown, AlertSettings> = v.object({
  sound: v.boolean(),
  volume: v.picklist(VOLUMES),
  // 音色を選べるようになる前に保存した設定には無いので、無ければ以前の鳴り方にする
  tones: v.optional(
    v.object({ Focus: AlertToneSchema, Journal: AlertToneSchema, Break: AlertToneSchema }),
    DEFAULT_TONES,
  ),
  notification: v.boolean(),
});

/** 切り替わった先のフェーズで鳴らす音色 */
export const toneFor = (settings: AlertSettings, to: PhaseKind): AlertTone => settings.tones[to];

/** 切り替わった先のフェーズの音色だけを選び直した設定 */
export const withTone = (
  settings: AlertSettings,
  to: PhaseKind,
  tone: AlertTone,
): AlertSettings => ({
  ...settings,
  tones: { ...settings.tones, [to]: tone },
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
