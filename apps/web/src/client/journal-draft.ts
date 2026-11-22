import type { JournalEntryId } from "../domain/journal-entry.ts";
import type { TagName } from "../domain/tag.ts";

/** 送る記入。ID は送る側が発行し、同じ記入を送り直すときは変えない（ADR 0010） */
export type JournalSubmission = Readonly<{
  id: JournalEntryId;
  body: string;
  tags: ReadonlyArray<TagName>;
}>;

/** 送れなかった記入（GLOSSARY）。送り直している間は、帯のボタンを押せなくする */
export type UnsentEntry =
  | Readonly<{ kind: "Unsent"; submission: JournalSubmission }>
  | Readonly<{ kind: "Resending"; submission: JournalSubmission }>;

/**
 * 入力欄の本文がどこから来たか。送れなかった記入を入力欄に戻したもの（`Returned`）なら、
 * 本文とタグを変えずに送るとその記入の ID で送り、二重に書かない
 */
type DraftOrigin =
  | Readonly<{ kind: "Typed" }>
  | Readonly<{ kind: "Returned"; submission: JournalSubmission }>;

/** ジャーナル記入の入力欄の本文と、その上の帯に並べた送れなかった記入 */
export type JournalDraft = Readonly<{
  body: string;
  origin: DraftOrigin;
  unsent: ReadonlyArray<UnsentEntry>;
}>;

const typed = { kind: "Typed" } as const satisfies DraftOrigin;

const isSameContent = (
  submission: JournalSubmission,
  body: string,
  tags: ReadonlyArray<TagName>,
): boolean =>
  submission.body === body &&
  submission.tags.length === tags.length &&
  submission.tags.every((tag, i) => tag === tags[i]);

const idOf = (entry: UnsentEntry): JournalEntryId => entry.submission.id;

/** 帯の記入のうち、送り直していないもの。送り直している間は戻すことも捨てることもしない */
const findUnsent = (draft: JournalDraft, id: JournalEntryId): JournalSubmission | undefined => {
  const entry = draft.unsent.find((e) => idOf(e) === id);
  if (entry === undefined) {
    return undefined;
  }
  switch (entry.kind) {
    case "Unsent":
      return entry.submission;
    case "Resending":
      return undefined;
  }
};

const withoutEntry = (draft: JournalDraft, id: JournalEntryId): ReadonlyArray<UnsentEntry> =>
  draft.unsent.filter((e) => idOf(e) !== id);

const markEntry = (
  draft: JournalDraft,
  id: JournalEntryId,
  kind: UnsentEntry["kind"],
): JournalDraft => ({
  ...draft,
  unsent: draft.unsent.map((e) => (idOf(e) === id ? { kind, submission: e.submission } : e)),
});

/**
 * 入力欄の本文と送れなかった記入の扱い（Issue #80）。
 *
 * - 送るとすぐ入力欄を空にし、送っている間も続けて書ける
 * - 送れなかったとき、入力欄が空なら本文を戻す。書き足していれば、送れなかった記入を帯に残す
 * - 帯の記入は、それぞれの ID のまま送り直す・入力欄に戻す・捨てる。ほかの記入を送れても消えない
 */
export const JournalDraft = {
  empty: { body: "", origin: typed, unsent: [] } as const satisfies JournalDraft,

  /** 入力欄に書いた */
  edit: (draft: JournalDraft, body: string): JournalDraft => ({ ...draft, body }),

  /**
   * 入力欄の本文を送る記入にし、入力欄を空にする。入力欄に戻した記入を本文もタグも変えずに送るなら、その ID を使う
   */
  submit: (
    draft: JournalDraft,
    tags: ReadonlyArray<TagName>,
    newId: () => JournalEntryId,
  ): Readonly<{ draft: JournalDraft; submission: JournalSubmission }> => {
    const id =
      draft.origin.kind === "Returned" && isSameContent(draft.origin.submission, draft.body, tags)
        ? draft.origin.submission.id
        : newId();
    return {
      draft: { ...draft, body: "", origin: typed },
      submission: { id, body: draft.body, tags },
    };
  },

  /** 入力欄から送った記入が送れなかった */
  failed: (draft: JournalDraft, submission: JournalSubmission): JournalDraft =>
    draft.body === ""
      ? { ...draft, body: submission.body, origin: { kind: "Returned", submission } }
      : { ...draft, unsent: [...draft.unsent, { kind: "Unsent", submission }] },

  /**
   * 帯の記入を送り直し始める。送る記入（最初に送ったときの ID・本文・タグのまま）を返す。
   * 帯にないか、もう送り直しているなら返さない
   */
  resend: (
    draft: JournalDraft,
    id: JournalEntryId,
  ): Readonly<{ draft: JournalDraft; submission: JournalSubmission }> | undefined => {
    const submission = findUnsent(draft, id);
    return submission === undefined
      ? undefined
      : { draft: markEntry(draft, id, "Resending"), submission };
  },

  /** 送り直した記入を送れたので、帯から消す */
  resent: (draft: JournalDraft, id: JournalEntryId): JournalDraft => ({
    ...draft,
    unsent: withoutEntry(draft, id),
  }),

  /** 送り直しても送れなかったので、帯に残す */
  resendFailed: (draft: JournalDraft, id: JournalEntryId): JournalDraft =>
    markEntry(draft, id, "Unsent"),

  /**
   * 帯の記入を入力欄に戻す。入力欄が空ならそのまま入れ、空でなければ今の本文の前に改行をはさんでつなげる。
   * つなげると本文が変わるので、次に送るときは新しい ID になる
   */
  returnToInput: (draft: JournalDraft, id: JournalEntryId): JournalDraft => {
    const submission = findUnsent(draft, id);
    if (submission === undefined) {
      return draft;
    }
    const unsent = withoutEntry(draft, id);
    return draft.body === ""
      ? { body: submission.body, origin: { kind: "Returned", submission }, unsent }
      : { body: `${submission.body}\n${draft.body}`, origin: typed, unsent };
  },

  /** 帯の記入を捨てる（実は保存できていたときのため） */
  discard: (draft: JournalDraft, id: JournalEntryId): JournalDraft =>
    findUnsent(draft, id) === undefined ? draft : { ...draft, unsent: withoutEntry(draft, id) },
};
