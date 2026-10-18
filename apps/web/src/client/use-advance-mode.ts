import { useCallback, useEffect, useState } from "react";
import { Result } from "@praha/byethrow";
import type { AdvanceMode } from "../domain/advance-mode.ts";
import { createApiClient } from "./api.ts";

const api = createApiClient();

/** フェーズの進め方の読み込みの様子 */
export type AdvanceModeView =
  | Readonly<{ kind: "Loading" }>
  | Readonly<{ kind: "LoadFailed" }>
  | Readonly<{ kind: "Loaded"; mode: AdvanceMode }>;

/**
 * フェーズの進め方（GLOSSARY、ADR 0016）。アカウントごとの設定なので、サーバーに置いて読み書きする。
 *
 * - 変えたら、押した見た目がすぐ変わるよう先に手元を替え、送れなければ元に戻す
 * - 変えるとセッションの状態が変わりうる（待っている切り替わりを自動にすると次のフェーズが始まる）ので、
 *   変えられたら `onChanged` でタイマーを読み込み直す
 * - 他の端末で変えたものは、同期メッセージで `receive` に届く
 */
export const useAdvanceMode = (
  onChanged: () => void,
): Readonly<{
  view: AdvanceModeView;
  /** 直前の変更の失敗 */
  errorMessage: string | undefined;
  change: (mode: AdvanceMode) => void;
  refresh: () => void;
  receive: (mode: AdvanceMode) => void;
}> => {
  const [view, setView] = useState<AdvanceModeView>({ kind: "Loading" });
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);

  const refresh = useCallback(() => {
    void api.getAdvanceMode().then((result) => {
      setView((current) =>
        Result.isSuccess(result)
          ? { kind: "Loaded", mode: result.value }
          : current.kind === "Loaded"
            ? current
            : { kind: "LoadFailed" },
      );
    });
  }, []);

  useEffect(refresh, [refresh]);

  const change = (mode: AdvanceMode) => {
    const before = view;
    setView({ kind: "Loaded", mode });
    setErrorMessage(undefined);
    void api.changeAdvanceMode(mode).then((result) => {
      if (Result.isSuccess(result)) {
        setView({ kind: "Loaded", mode: result.value });
        onChanged();
        return;
      }
      setView(before);
      setErrorMessage("変更できませんでした。もう一度お試しください。");
    });
  };

  return {
    view,
    errorMessage,
    change,
    refresh,
    receive: (mode) => setView({ kind: "Loaded", mode }),
  };
};

export type AdvanceModeState = ReturnType<typeof useAdvanceMode>;
