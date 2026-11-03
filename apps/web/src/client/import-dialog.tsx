import { useEffect, useState } from "react";
import { Import } from "../domain/import.ts";
import { Button } from "./components/ui/button.tsx";
import {
  Dialog,
  DialogContent as DialogPopup,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog.tsx";
import {
  deviceRecordsLabelOf,
  importFailureMessageOf,
  importProgressLabelOf,
  importResultLinesOf,
  openSessionLinesOf,
} from "./import-text.ts";
import type { ImportableRecords } from "../device/index.ts";
import type { ImportProgress } from "./import-driver.ts";
import { useImports, type ImportState, type LastImport } from "./use-import.ts";

type DialogContent =
  | Readonly<{ kind: "Ready"; records: ImportableRecords }>
  | Readonly<{ kind: "Running"; progress: ImportProgress }>
  | Readonly<{ kind: "Finished"; last: Extract<LastImport, { kind: "Finished" }> }>
  | Readonly<{ kind: "Failed"; last: Extract<LastImport, { kind: "Failed" }> }>;

/** ダイアログに出す中身。取り込める記録がなく、取り込んでもいなければ出さない */
const contentOf = (state: ImportState): DialogContent | undefined => {
  switch (state.kind) {
    case "Checking":
    case "Unreadable":
      return undefined;
    case "Running":
      return { kind: "Running", progress: state.progress };
    case "Idle":
      switch (state.last.kind) {
        case "NotRun":
          return state.records.sessions.length === 0
            ? undefined
            : { kind: "Ready", records: state.records };
        case "Finished":
          return { kind: "Finished", last: state.last };
        case "Failed":
          return { kind: "Failed", last: state.last };
      }
  }
};

const Lines = ({ lines }: Readonly<{ lines: ReadonlyArray<string> }>) =>
  lines.map((line) => <p key={line}>{line}</p>);

const Body = ({ content }: Readonly<{ content: DialogContent }>) => {
  switch (content.kind) {
    case "Ready":
      return (
        <>
          <p>
            ログインする前にこの端末で記録した
            {deviceRecordsLabelOf(Import.summaryOf(content.records.sessions))}
            があります。アカウントに取り込むと、ほかの端末からも見られます。
          </p>
          <Lines lines={openSessionLinesOf(content.records.open)} />
        </>
      );
    case "Running":
      return (
        <p role="status">{importProgressLabelOf(content.progress.done, content.progress.total)}</p>
      );
    case "Finished":
      return (
        <Lines lines={importResultLinesOf(content.last.result, content.last.tagKindsOverLimit)} />
      );
    case "Failed":
      return <p role="alert">{importFailureMessageOf(content.last.failure)}</p>;
  }
};

const Actions = ({
  content,
  start,
  close,
}: Readonly<{ content: DialogContent; start: () => void; close: () => void }>) => {
  switch (content.kind) {
    case "Ready":
    case "Failed":
      return (
        <>
          <Button variant="outline" onClick={close}>
            あとで
          </Button>
          <Button onClick={start}>{content.kind === "Ready" ? "取り込む" : "やり直す"}</Button>
        </>
      );
    case "Running":
      return <Button disabled>取り込んでいます…</Button>;
    case "Finished":
      return <Button onClick={close}>閉じる</Button>;
  }
};

/**
 * ログインした直後（`/?from=login`）に、この端末の記録を取り込むかを尋ねる（ADR 0020）。
 * URL の印は開いたらすぐ消し、読み込み直しても出し直さない。あとでにしても、設定画面から取り込める
 */
export const ImportDialog = ({
  fromLogin,
  forgetFromLogin,
}: Readonly<{ fromLogin: boolean; forgetFromLogin: () => void }>) => {
  const imports = useImports();
  // ログイン直後に開いたこの画面でだけ尋ねる。印を URL から消しても、閉じるまでは出し続ける
  const [asked] = useState(fromLogin);
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    if (fromLogin) {
      forgetFromLogin();
    }
  }, [fromLogin, forgetFromLogin]);

  const content = contentOf(imports.state);
  const running = content?.kind === "Running";
  const close = () => setClosed(true);

  return (
    <Dialog
      open={asked && !closed && content !== undefined}
      onOpenChange={(open) => {
        if (!open && !running) {
          close();
        }
      }}
    >
      <DialogPopup showCloseButton={false}>
        {content !== undefined && (
          <>
            <DialogHeader>
              <DialogTitle>
                {content.kind === "Finished"
                  ? "取り込みました"
                  : "この端末の記録を取り込みますか？"}
              </DialogTitle>
              <DialogDescription render={<div />} className="flex flex-col gap-2">
                <Body content={content} />
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Actions content={content} start={imports.start} close={close} />
            </DialogFooter>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
};
