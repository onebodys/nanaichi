import { Result } from "@praha/byethrow";
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { BackendError } from "../domain/backend.ts";
import type { SessionId } from "../domain/session.ts";
import { TAG_KINDS_MAX } from "../domain/tag.ts";
import type { DeviceImport, ImportableRecords } from "../device/index.ts";
import { redirectToLogin } from "./auth-client.ts";
import { useBackend } from "./backend.ts";
import {
  runImport,
  type ImportFailure,
  type ImportProgress,
  type ImportResult,
} from "./import-driver.ts";
import { createImportApi } from "./remote-backend.ts";

/** 最後に取り込んだときの結果。設定画面とログイン直後のダイアログの両方に出す */
export type LastImport =
  | Readonly<{ kind: "NotRun" }>
  | Readonly<{ kind: "Finished"; result: ImportResult; tagKindsOverLimit: boolean }>
  | Readonly<{ kind: "Failed"; failure: ImportFailure }>;

/** 取り込み（ADR 0020）の様子 */
export type ImportState =
  | Readonly<{ kind: "Checking" }>
  /** この端末の記録を読めなかった */
  | Readonly<{ kind: "Unreadable"; error: BackendError }>
  /** この端末に残っている記録。取り込んだあとは、時間が重なって残ったものと開いたままのもの */
  | Readonly<{ kind: "Idle"; records: ImportableRecords; last: LastImport }>
  | Readonly<{ kind: "Running"; progress: ImportProgress }>;

export type Imports = Readonly<{
  state: ImportState;
  /** 取り込む。取り込んでいる間は何もしない（二重に始めない） */
  start: () => void;
  /** この端末に残っているセッションを捨てる。捨てられなければ false */
  discard: (id: SessionId) => Promise<boolean>;
}>;

let opened: Promise<DeviceImport> | undefined;

/** この端末の記録の口は、読み込みごとに1つだけ開く。記録を読んだ版を口が覚えているので、読み直しが少なくて済む */
const deviceImport = (): Promise<DeviceImport> =>
  (opened ??= import("../device/index.ts").then(({ openBrowserDeviceImport }) =>
    openBrowserDeviceImport(),
  ));

const waitFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** この端末の記録を読み直した様子。`last` は直前の取り込みの結果で、そのまま持ち越す */
const loadedState = async (last: LastImport): Promise<ImportState> => {
  const loaded = await (await deviceImport()).load();
  return Result.isSuccess(loaded)
    ? { kind: "Idle", records: loaded.value, last }
    : { kind: "Unreadable", error: loaded.error };
};

const useImportState = (): Imports => {
  const backend = useBackend();
  const [state, setState] = useState<ImportState>({ kind: "Checking" });
  const running = useRef(false);
  const reload = async (last: LastImport) => setState(await loadedState(last));

  useEffect(() => {
    void loadedState({ kind: "NotRun" }).then(setState);
  }, []);

  // 取り込むと使っているタグが上限を超えうる（ADR 0020）。超えたら、使わないタグの削除を案内する
  const tagKindsOverLimit = async (): Promise<boolean> => {
    const usage = await backend.getTagUsage();
    return Result.isSuccess(usage) && usage.value.tags.length > TAG_KINDS_MAX;
  };

  const start = () => {
    if (running.current) {
      return;
    }
    running.current = true;
    void (async () => {
      const result = await runImport({
        device: await deviceImport(),
        send: createImportApi({ onSignedOut: redirectToLogin }).sendBatch,
        wait: waitFor,
        onProgress: (progress) => setState({ kind: "Running", progress }),
      });
      await reload(
        Result.isSuccess(result)
          ? { kind: "Finished", result: result.value, tagKindsOverLimit: await tagKindsOverLimit() }
          : { kind: "Failed", failure: result.error },
      );
      running.current = false;
    })();
  };

  const discard = async (id: SessionId): Promise<boolean> => {
    const removed = await (await deviceImport()).removeClosedSessions([id]);
    if (Result.isFailure(removed)) {
      return false;
    }
    await reload(state.kind === "Idle" ? state.last : { kind: "NotRun" });
    return true;
  };

  return { state, start, discard };
};

const ImportsContext = createContext<Imports | undefined>(undefined);

/** ログインしているときだけ置く。ログイン直後のダイアログと設定画面で、同じ取り込みの様子を見る */
export const ImportProvider = ({ children }: Readonly<{ children: ReactNode }>): ReactNode =>
  createElement(ImportsContext.Provider, { value: useImportState() }, children);

export const useImports = (): Imports => {
  const imports = useContext(ImportsContext);
  if (imports === undefined) {
    throw new Error("useImports は ImportProvider の中で使う");
  }
  return imports;
};
