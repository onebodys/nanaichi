import { useCallback, useEffect, useRef, useState } from "react";
import { Result } from "@praha/byethrow";
import type { DeletedTag, TagDeletion, TagName, TagUsage } from "../domain/tag.ts";
import type { BackendError } from "../domain/backend.ts";
import { useBackend } from "./backend.ts";

/** 設定画面のタグの一覧の読み込みの様子 */
export type TagUsageView =
  | Readonly<{ kind: "Loading" }>
  | Readonly<{ kind: "LoadFailed" }>
  | Readonly<{ kind: "Loaded"; tags: ReadonlyArray<TagUsage> }>;

/** 画面に出す削除の失敗の文言。サーバーの文言はそのまま出さない */
const messageOf = (error: BackendError): string => {
  switch (error.kind) {
    case "Unreachable":
      return "通信できませんでした。もう一度お試しください。";
    case "Rejected":
      return error.code === "TAG_NOT_FOUND"
        ? "そのタグはもう使われていません。一覧を読み込み直しました。"
        : "削除できませんでした。";
    case "StorageFailed":
      return "この端末に記録を保存できませんでした。";
    case "Broken":
      return "削除できませんでした。";
  }
};

/**
 * 設定画面のタグの一覧（使っているタグとその記入の数）と、タグの削除（GLOSSARY の「タグの削除」、ADR 0017）。
 *
 * - 一覧は設定画面を開いている間だけ読む（`open`）。記入やタグが変わったら `refresh` で読み込み直す
 *   （他のタブ・端末での変更は同期メッセージを受け取ったときに）
 * - 削除できたら、`onDeleted` で読み込んだ記入とつけたままのタグにも同じ削除を当てる
 */
export const useTagUsage = (
  open: boolean,
  onDeleted: (deleted: DeletedTag) => void,
): Readonly<{
  view: TagUsageView;
  /** 直前の削除の失敗 */
  errorMessage: string | undefined;
  refresh: () => void;
  /** タグを削除する。成功したら true */
  remove: (name: TagName, deletion: TagDeletion) => Promise<boolean>;
}> => {
  const backend = useBackend();
  const [view, setView] = useState<TagUsageView>({ kind: "Loading" });
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const isOpen = useRef(open);

  const refresh = useCallback(() => {
    if (!isOpen.current) {
      return;
    }
    void backend.getTagUsage().then((result) => {
      setView((current) =>
        Result.isSuccess(result)
          ? { kind: "Loaded", tags: result.value.tags }
          : current.kind === "Loaded"
            ? current
            : { kind: "LoadFailed" },
      );
    });
  }, [backend]);

  useEffect(() => {
    isOpen.current = open;
    setErrorMessage(undefined);
    refresh();
  }, [open, refresh]);

  const remove = async (name: TagName, deletion: TagDeletion): Promise<boolean> => {
    setErrorMessage(undefined);
    const result = await backend.deleteTag(name, deletion);
    refresh();
    if (Result.isFailure(result)) {
      setErrorMessage(messageOf(result.error));
      return false;
    }
    onDeleted(result.value);
    return true;
  };

  return { view, errorMessage, refresh, remove };
};

export type TagUsageState = ReturnType<typeof useTagUsage>;
