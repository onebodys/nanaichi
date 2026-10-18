import { useCallback, useEffect, useState } from "react";
import { Result } from "@praha/byethrow";
import type { TagName } from "../domain/tag.ts";
import { createApiClient } from "./api.ts";

const api = createApiClient();

/**
 * 入力の候補に出す、使っているタグ（最近使った順、ADR 0013）。
 *
 * 記入を書く・編集する・削除するとタグの使われ方が変わるので、そのたびに `refresh` で読み込み直す
 * （他のタブ・端末での変更は同期メッセージを受け取ったときに）。読み込めなければ前の一覧のまま使う。
 * 候補は入力を助けるだけで、上限の判断はサーバーがするため、古くても困らない。
 */
export const useTags = (): Readonly<{
  known: ReadonlyArray<TagName>;
  refresh: () => void;
}> => {
  const [known, setKnown] = useState<ReadonlyArray<TagName>>([]);

  const refresh = useCallback(() => {
    void api.getTags().then((result) => {
      if (Result.isSuccess(result)) {
        setKnown(result.value.tags);
      }
    });
  }, []);

  useEffect(refresh, [refresh]);

  return { known, refresh };
};

export type TagsState = ReturnType<typeof useTags>;
