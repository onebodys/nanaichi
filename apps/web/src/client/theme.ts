/**
 * 画面の明るさ（ライト・ダーク）。html に `.dark` を付け外しして切り替える（index.css）。
 *
 * いまは常に端末の設定（prefers-color-scheme）に合わせる。設定画面で「端末に合わせる・ライト・ダーク」を
 * 選べるようにするまでの土台（Issue #34）。初回の描画でちらつかないよう、index.html でも同じ判断を先にしている。
 */
type ThemePreference = "System" | "Light" | "Dark";

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

/** 好みに合わせて明るさを当て、端末の設定が変わったら当て直す。戻り値で追うのをやめる */
export const followTheme = (preference: ThemePreference): (() => void) => {
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
