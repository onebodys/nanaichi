import { useState, type Ref } from "react";
import * as v from "valibot";
import { Button } from "./components/ui/button.tsx";
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
import { useSubmitKey } from "./use-submit-key.ts";

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
 */
export const JournalInput = ({
  inSession,
  write,
  textareaRef,
}: Readonly<{
  inSession: boolean;
  /** 送信する。成功したら true */
  write: (body: string) => Promise<boolean>;
  /** ジャーナルのフェーズに入ったときにカーソルを置くため、ホーム画面が持つ */
  textareaRef: Ref<HTMLTextAreaElement>;
}>) => {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [submitKey, setSubmitKey] = useSubmitKey();
  const canSend = inSession && !sending && draft.trim().length > 0;

  const submit = async () => {
    if (!canSend) {
      return;
    }
    const body = draft;
    setSending(true);
    // 送信中も続けて書けるよう、先に空にする。失敗したら、その間に何も書いていなければ戻す
    setDraft("");
    const written = await write(body);
    if (!written) {
      setDraft((current) => (current === "" ? body : current));
    }
    setSending(false);
  };

  return (
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
        className="min-h-20 w-full resize-y rounded-md border bg-background px-3 py-2 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
        placeholder={
          inSession
            ? `やったこと・次にやること・感想など（${submitKeyHintOf(submitKey, modifierLabel)}）`
            : "セッション中に書けます"
        }
        value={draft}
        disabled={!inSession}
        onChange={(event) => setDraft(event.target.value)}
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
          <SelectTrigger aria-label="送信キー" size="sm" className="text-xs text-muted-foreground">
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
        <Button type="submit" size="sm" disabled={!canSend}>
          送信
        </Button>
      </div>
    </form>
  );
};
