import { useSyncExternalStore } from "react";
import * as v from "valibot";

/**
 * 画面の明るさ（ライト・ダーク）。html に `.dark` を付け外しして切り替える（index.css）。
 *
 * 明るさの好み（端末に合わせる・ライト・ダーク）は設定画面で選び、端末ごとに localStorage に覚える。
 * 初回の描画でちらつかないよう、index.html でも同じ判断を先にしている（保存のキーと値を変えたら両方を直す）。
 */
const ThemePreferenceSchema = v.picklist(["System", "Light", "Dark"]);
export type ThemePreference = v.InferOutput<typeof ThemePreferenceSchema>;

export const THEME_PREFERENCES = [
  "System",
  "Light",
  "Dark",
] as const satisfies ReadonlyArray<ThemePreference>;

type Theme = "Light" | "Dark";

export const resolveTheme = (preference: ThemePreference, systemPrefersDark: boolean): Theme => {
  switch (preference) {
    case "System":
      return systemPrefersDark ? "Dark" : "Light";
    case "Light":
      return "Light";
    case "Dark":
      return "Dark";
  }
};

/** 保存しておいた好みを読み戻す。保存がない・知らない値なら端末に合わせる */
export const parseThemePreference = (stored: string | null): ThemePreference => {
  const parsed = v.safeParse(ThemePreferenceSchema, stored);
  return parsed.success ? parsed.output : "System";
};

const STORAGE_KEY = "nanaichi:theme";

const listeners = new Set<() => void>();
/** localStorage に書けなかったときも、開いている画面の中では選んだ好みを使う */
let fallback: ThemePreference = "System";

const read = (): ThemePreference => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === null ? fallback : parseThemePreference(stored);
  } catch {
    return fallback;
  }
};

/** 好みに合わせて明るさを当て、端末の設定が変わったら当て直す。戻り値で追うのをやめる */
const followTheme = (preference: ThemePreference): (() => void) => {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    document.documentElement.classList.toggle(
      "dark",
      resolveTheme(preference, media.matches) === "Dark",
    );
  };
  apply();
  media.addEventListener("change", apply);
  return () => media.removeEventListener("change", apply);
};

let unfollow: (() => void) | undefined;

/** 今の好みで明るさを当て直す。起動時と、好みが変わったときに呼ぶ */
const applyStoredTheme = () => {
  unfollow?.();
  unfollow = followTheme(read());
};

/** 起動時に呼ぶ。別のタブで好みを変えたときも当て直す */
export const startTheme = () => {
  applyStoredTheme();
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) {
      applyStoredTheme();
      for (const listener of listeners) listener();
    }
  });
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const write = (preference: ThemePreference) => {
  fallback = preference;
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // 覚えられなくても、この画面では fallback で選んだ好みを使う
  }
  applyStoredTheme();
  for (const listener of listeners) listener();
};

/** 設定画面の明るさの好み。選ぶとすぐに画面に当たる */
export const useThemePreference = (): readonly [
  ThemePreference,
  (preference: ThemePreference) => void,
] => [useSyncExternalStore(subscribe, read), write];
