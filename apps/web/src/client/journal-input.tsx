import { useState, type Ref } from "react";
import * as v from "valibot";
import { JournalEntryId } from "../domain/journal-entry.ts";
import type { SessionId } from "../domain/session.ts";
import type { TagName } from "../domain/tag.ts";
import { Button } from "./components/ui/button.tsx";
import { cn } from "./lib/utils.ts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.tsx";
import {
  isSubmitKey,
  modifierLabelOf,
  SubmitKeySchema,
  submitKeyHintOf,
  submitKeyLabelOf,
} from "./submit-key.ts";
import { TagInput } from "./tag-input.tsx";
import { JournalDraft, type JournalSubmission, type UnsentEntry } from "./journal-draft.ts";
import type { AttachedTagsKey } from "./attached-tags.ts";
import { useAttachedTags } from "./use-attached-tags.ts";
import { useSubmitKey } from "./use-submit-key.ts";

// `crypto.randomUUID()` は必ず UUID を返すので、検証に失敗するのは実装の誤り（例外でよい）
const newEntryId = (): JournalEntryId => v.parse(JournalEntryId.schema, crypto.randomUUID());

const modifierLabel = modifierLabelOf(navigator.userAgent);

const submitKeyItems = SubmitKeySchema.options.map((option) => ({
  value: option,
  label: submitKeyLabelOf(option, modifierLabel),
}));

/**
 * ジャーナル記入の入力欄（docs/PRODUCT.md「画面」の中央）。
 *
 * 送るキーは送信キー（GLOSSARY.md）で選べ、送信ボタンの隣で切り替える。送信すると空になり、続けて書ける。
 * セッションの外では書けないので、入力欄を使えなくする（サーバーも受け付けない）。
 *
 * タグの欄でつけたタグは送信しても外れず、外すかセッションが終わるまで続けて書く記入につく（GLOSSARY の「タグ」）。
 * タグはセッションの外でもつけられ、これからやることとして準備しておくと、次に始めるセッションに持ち越す。
 * タグの欄で Enter を押しても送信しないよう、タグの欄は form の外に置く。
 * ジャーナルのフェーズのあいだは、書く時間だとわかるよう入力欄の枠をジャーナルの色にする（Issue #34 の A 案）。
 *
 * 送れなかったとき、入力欄が空なら本文を戻す。送っている間に書き足していれば、送れなかった記入を
 * 入力欄の上の帯に残し、送り直す・入力欄に戻す・捨てるを選べるようにする（Issue #80、`journal-draft.ts`）。
 */
export const JournalInput = ({
  attachedTagsKey,
  sessionId,
  knownTags,
  write,
  textareaRef,
  inJournalPhase,
}: Readonly<{
  attachedTagsKey: AttachedTagsKey;
  /** 進行中のセッション。なければ（終了したあとも）書けない */
  sessionId: SessionId | undefined;
  /** 使っているタグ（入力の候補） */
  knownTags: ReadonlyArray<TagName>;
  /** 送信する。成功したら true */
  write: (submission: JournalSubmission) => Promise<boolean>;
  /** ジャーナルのフェーズに入ったときにカーソルを置くため、ホーム画面が持つ */
  textareaRef: Ref<HTMLTextAreaElement>;
  /** ジャーナルのフェーズにいるか */
  inJournalPhase: boolean;
}>) => {
  const [draft, setDraft] = useState<JournalDraft>(JournalDraft.empty);
  const [submitKey, setSubmitKey] = useSubmitKey();
  const [attachedTags, setAttachedTags] = useAttachedTags(attachedTagsKey, sessionId);
  const inSession = sessionId !== undefined;
  // 送信と同時に空にするので、同じ本文を二重に送ることはない。前の記入の保存を待たずに、続けて送れる
  const canSend = inSession && draft.body.trim().length > 0;

  const submit = async () => {
    if (!canSend) {
      return;
    }
    // 送信中も続けて書けるよう、先に空にする
    const { draft: cleared, submission } = JournalDraft.submit(draft, attachedTags, newEntryId);
    setDraft(cleared);
    const written = await write(submission);
    if (!written) {
      setDraft((current) => JournalDraft.failed(current, submission));
    }
  };

  const resend = async (id: JournalEntryId) => {
    const started = JournalDraft.resend(draft, id);
    if (started === undefined) {
      return;
    }
    setDraft((current) => JournalDraft.resend(current, id)?.draft ?? current);
    const written = await write(started.submission);
    setDraft((current) =>
      written ? JournalDraft.resent(current, id) : JournalDraft.resendFailed(current, id),
    );
  };

  return (
    <div className="flex flex-col gap-2.5">
      {draft.unsent.length > 0 && (
        <UnsentEntries
          entries={draft.unsent}
          inSession={inSession}
          onResend={(id) => void resend(id)}
          onReturnToInput={(id) => setDraft((current) => JournalDraft.returnToInput(current, id))}
          onDiscard={(id) => setDraft((current) => JournalDraft.discard(current, id))}
        />
      )}
      <div
        className={cn(
          "flex flex-col gap-2.5 rounded-[14px] border bg-card px-4 py-3.5 shadow-xs transition-[border-color,box-shadow] focus-within:border-ring",
          !inSession && "border-dashed",
          inJournalPhase &&
            "border-journal-mark ring-4 ring-journal-mark/15 focus-within:border-journal-mark",
        )}
      >
        <TagInput
          known={knownTags}
          attached={attachedTags}
          onChange={setAttachedTags}
          className="min-h-0 border-0 bg-transparent px-0 py-0 shadow-none focus-within:ring-0 has-data-[slot=combobox-chip]:px-0 dark:bg-transparent"
        />
        <form
          aria-label="ジャーナル記入"
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <textarea
            ref={textareaRef}
            aria-label="ジャーナル記入の本文"
            className="min-h-20 w-full resize-none bg-transparent text-[15px] leading-[1.7] outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
            placeholder={
              inSession
                ? `やったこと・次にやること・感想など（${submitKeyHintOf(submitKey, modifierLabel)}）`
                : "セッションを始めると書けます"
            }
            value={draft.body}
            disabled={!inSession}
            onChange={(event) => {
              const body = event.target.value;
              setDraft((current) => JournalDraft.edit(current, body));
            }}
            onKeyDown={(event) => {
              if (isSubmitKey(submitKey, event)) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <div className="flex items-center justify-end gap-2">
            <Select
              value={submitKey}
              // Base UI の SelectValue は items がないと値そのもの（"modEnter" など）を表示するので、ラベルを渡す
              items={submitKeyItems}
              onValueChange={(value) => {
                const parsed = v.safeParse(SubmitKeySchema, value);
                if (parsed.success) setSubmitKey(parsed.output);
              }}
            >
              <SelectTrigger
                aria-label="送信キー"
                size="sm"
                className="border-0 text-xs text-muted-foreground shadow-none dark:bg-transparent"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {submitKeyItems.map((item) => (
                  <SelectItem key={item.value} value={item.value} className="text-xs">
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="submit"
              size="sm"
              disabled={!canSend}
              className={cn(
                "h-9 rounded-[10px] px-4",
                inJournalPhase && "bg-journal text-journal-foreground hover:bg-journal/85",
              )}
            >
              送信
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
};

/**
 * 入力欄の上の「送れなかった記入」の帯。開いている間だけ残す。
 * セッションの外では送り直せないが、本文は選んでコピーできる
 */
const UnsentEntries = ({
  entries,
  inSession,
  onResend,
  onReturnToInput,
  onDiscard,
}: Readonly<{
  entries: ReadonlyArray<UnsentEntry>;
  inSession: boolean;
  onResend: (id: JournalEntryId) => void;
  onReturnToInput: (id: JournalEntryId) => void;
  onDiscard: (id: JournalEntryId) => void;
}>) => (
  <section
    aria-label="送れなかった記入"
    className="flex flex-col gap-2 rounded-[14px] border border-destructive/40 bg-destructive/5 px-4 py-3"
  >
    <h2 className="text-xs font-medium text-destructive">送れなかった記入</h2>
    {!inSession && (
      <p className="text-xs text-muted-foreground">
        セッションの外では送り直せません。本文は選んでコピーできます。
      </p>
    )}
    <ul className="flex flex-col gap-2">
      {entries.map((entry) => {
        const { id, body, tags } = entry.submission;
        const resending = entry.kind === "Resending";
        return (
          <li key={id} className="flex flex-col gap-1.5">
            <p className="text-sm leading-[1.7] break-words whitespace-pre-wrap select-text">
              {body}
            </p>
            {tags.length > 0 && (
              <p className="text-xs text-muted-foreground">{tags.map((t) => `#${t}`).join(" ")}</p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={resending}
                onClick={() => onDiscard(id)}
              >
                捨てる
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={resending}
                onClick={() => onReturnToInput(id)}
              >
                入力欄に戻す
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!inSession || resending}
                onClick={() => onResend(id)}
              >
                {resending ? "送り直し中…" : "送り直す"}
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  </section>
);
