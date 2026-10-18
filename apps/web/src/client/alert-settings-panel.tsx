import { useState } from "react";
import { useAlertSettings, VOLUMES, type Volume } from "./alert-settings.ts";
import { Button } from "./components/ui/button.tsx";
import {
  notificationPermission,
  requestNotificationPermission,
  type NotificationPermissionState,
  type PhaseAlert,
} from "./phase-alert.ts";

const volumeLabelOf = (volume: Volume): string => {
  switch (volume) {
    case "Low":
      return "小";
    case "Medium":
      return "中";
    case "High":
      return "大";
  }
};

/** 通知を出す設定なのに出せないときの説明。出せるとき・出さない設定のときは出さない */
const permissionNoteOf = (permission: NotificationPermissionState): string | undefined => {
  switch (permission) {
    case "granted":
    case "default":
      return undefined;
    case "denied":
      return "ブラウザで通知が拒否されています。ブラウザのサイトの設定から許可してください";
    case "unsupported":
      return "このブラウザは通知に対応していません";
  }
};

/**
 * 知らせ方の設定（GLOSSARY）。音を鳴らすか・音量・ブラウザ通知を出すかを端末ごとに選ぶ。
 * 普段は閉じておき、タイマーの邪魔をしない。
 */
export const AlertSettingsPanel = ({ phaseAlert }: Readonly<{ phaseAlert: PhaseAlert }>) => {
  const { settings, change } = useAlertSettings();
  const [permission, setPermission] = useState(notificationPermission);
  const { sound: soundOn, volume } = settings;

  const setSoundOn = (on: boolean) => {
    change({ ...settings, sound: on });
  };
  const setVolume = (next: Volume) => {
    change({ ...settings, volume: next });
    // 選んだ音量をすぐ聞けるようにする
    phaseAlert.preview(next);
  };
  const setNotification = async (on: boolean) => {
    change({ ...settings, notification: on });
    if (on) {
      setPermission(await requestNotificationPermission());
    }
  };

  const permissionNote = settings.notification ? permissionNoteOf(permission) : undefined;

  return (
    <details className="rounded-md border px-4 py-2 text-sm">
      <summary className="cursor-pointer text-muted-foreground">音と通知の設定</summary>
      <div className="flex flex-col gap-3 py-3">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={soundOn}
            onChange={(e) => setSoundOn(e.currentTarget.checked)}
          />
          フェーズの切り替わりで音を鳴らす
        </label>
        <fieldset className="flex flex-wrap items-center gap-3 pl-6" disabled={!soundOn}>
          <legend className="sr-only">音量</legend>
          <span aria-hidden className="text-muted-foreground">
            音量
          </span>
          {VOLUMES.map((v) => (
            <label key={v} className="flex items-center gap-1">
              <input
                type="radio"
                name="alert-volume"
                checked={volume === v}
                onChange={() => setVolume(v)}
              />
              {volumeLabelOf(v)}
            </label>
          ))}
          <Button variant="outline" size="sm" onClick={() => phaseAlert.preview(volume)}>
            試しに鳴らす
          </Button>
        </fieldset>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={settings.notification}
            onChange={(e) => void setNotification(e.currentTarget.checked)}
          />
          フェーズの切り替わりでブラウザ通知を出す
        </label>
        {permissionNote !== undefined && (
          <p className="pl-6 text-muted-foreground">{permissionNote}</p>
        )}
      </div>
    </details>
  );
};
