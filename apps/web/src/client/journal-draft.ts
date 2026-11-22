import type { JournalEntryId } from "../domain/journal-entry.ts";
import type { SessionId } from "../domain/session.ts";
import type { TagName } from "../domain/tag.ts";

/** 送る記入。ID は送る側が発行し、同じ記入を送り直すときは変えない（ADR 0010） */
export type JournalSubmission = Readonly<{
  id: JournalEntryId;
  body: string;
  tags: ReadonlyArray<TagName>;
}>;

/**
 * 送れなかった記入（GLOSSARY）。送ろうとしたときのセッションを持つ。送り直している間は、帯のボタンを押せなくする
 */
export type UnsentEntry =
  | Readonly<{ kind: "Unsent"; submission: JournalSubmission; sessionId: SessionId }>
  | Readonly<{ kind: "Resending"; submission: JournalSubmission; sessionId: SessionId }>;

/**
 * 帯の記入が今どう扱えるか（Issue #88）。
 *
 * - `Resending`: 送り直している。どのボタンも押せない
 * - `CurrentSession`: 今のセッションで送ろうとした。送り直す・入力欄に戻す・捨てるを選べる
 * - `PreviousSession`: 前のセッションで送ろうとした。送り直すと今のセッションの記入になる（紐付きはサーバーが
 *   受け付けた時刻で決まる。ADR 0010）ので、送り直せない。入力欄に戻して、今のセッションの新しい記入として書ける
 * - `OutsideSession`: セッションの外。送り直すことも入力欄に戻すこともできない
 *
 * どれでも本文はコピーでき、送り直している間のほかは捨てられる
 */
export type UnsentEntryStanding =
  | Readonly<{ kind: "Resending" }>
  | Readonly<{ kind: "CurrentSession" }>
  | Readonly<{ kind: "PreviousSession" }>
  | Readonly<{ kind: "OutsideSession" }>;

/**
 * 入力欄の本文がどこから来たか。送れなかった記入を入力欄に戻したもの（`Returned`）なら、
 * 送ろうとしたのと同じセッションで、本文とタグを変えずに送るとその記入の ID で送り、二重に書かない
 */
type DraftOrigin =
  | Readonly<{ kind: "Typed" }>
  | Readonly<{ kind: "Returned"; submission: JournalSubmission; sessionId: SessionId }>;

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

/** 入力欄に戻した記入を、送ろうとしたのと同じセッションで本文もタグも変えずに送るなら、その記入の ID */
const reusableIdOf = (
  draft: JournalDraft,
  tags: ReadonlyArray<TagName>,
  sessionId: SessionId,
): JournalEntryId | undefined => {
  const { origin } = draft;
  switch (origin.kind) {
    case "Typed":
      return undefined;
    case "Returned":
      return origin.sessionId === sessionId && isSameContent(origin.submission, draft.body, tags)
        ? origin.submission.id
        : undefined;
  }
};

const idOf = (entry: UnsentEntry): JournalEntryId => entry.submission.id;

/** 帯の記入のうち、送り直していないもの。送り直している間は戻すことも捨てることもしない */
const findUnsent = (draft: JournalDraft, id: JournalEntryId): UnsentEntry | undefined => {
  const entry = draft.unsent.find((e) => idOf(e) === id);
  if (entry === undefined) {
    return undefined;
  }
  switch (entry.kind) {
    case "Unsent":
      return entry;
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
  unsent: draft.unsent.map((e) => (idOf(e) === id ? { ...e, kind } : e)),
});

/**
 * 入力欄の本文と送れなかった記入の扱い（Issue #80）。
 *
 * - 送るとすぐ入力欄を空にし、送っている間も続けて書ける
 * - 送れなかったとき、入力欄が空なら本文を戻す。書き足していれば、送れなかった記入を帯に残す
 * - 帯の記入は、それぞれの ID のまま送り直す・入力欄に戻す・捨てる。ほかの記入を送れても消えない
 * - 送り直せるのは、送ろうとしたのと同じセッションの間だけ（Issue #88）。前のセッションの記入は、入力欄に戻すと
 *   今のセッションの新しい記入（新しい ID）として送る
 */
export const JournalDraft = {
  empty: { body: "", origin: typed, unsent: [] } as const satisfies JournalDraft,

  /** 入力欄に書いた */
  edit: (draft: JournalDraft, body: string): JournalDraft => ({ ...draft, body }),

  /**
   * 入力欄の本文を `sessionId` のセッションに送る記入にし、入力欄を空にする。
   * 入力欄に戻した記入を、送ろうとしたのと同じセッションで本文もタグも変えずに送るなら、その ID を使う
   */
  submit: (
    draft: JournalDraft,
    tags: ReadonlyArray<TagName>,
    sessionId: SessionId,
    newId: () => JournalEntryId,
  ): Readonly<{ draft: JournalDraft; submission: JournalSubmission }> => {
    const id = reusableIdOf(draft, tags, sessionId) ?? newId();
    return {
      draft: { ...draft, body: "", origin: typed },
      submission: { id, body: draft.body, tags },
    };
  },

  /** `sessionId` のセッションに入力欄から送った記入が送れなかった */
  failed: (
    draft: JournalDraft,
    submission: JournalSubmission,
    sessionId: SessionId,
  ): JournalDraft =>
    draft.body === ""
      ? { ...draft, body: submission.body, origin: { kind: "Returned", submission, sessionId } }
      : { ...draft, unsent: [...draft.unsent, { kind: "Unsent", submission, sessionId }] },

  /** 帯の記入が、今のセッション（`undefined` ならセッションの外）でどう扱えるか */
  standingOf: (entry: UnsentEntry, sessionId: SessionId | undefined): UnsentEntryStanding => {
    switch (entry.kind) {
      case "Resending":
        return { kind: "Resending" };
      case "Unsent":
        if (sessionId === undefined) {
          return { kind: "OutsideSession" };
        }
        return entry.sessionId === sessionId
          ? { kind: "CurrentSession" }
          : { kind: "PreviousSession" };
    }
  },

  /** 帯の記入のボタン（送り直す・入力欄に戻す・捨てる）を押せるか */
  actionsOf: (
    standing: UnsentEntryStanding,
  ): Readonly<{ canResend: boolean; canReturnToInput: boolean; canDiscard: boolean }> => {
    switch (standing.kind) {
      case "Resending":
        return { canResend: false, canReturnToInput: false, canDiscard: false };
      case "CurrentSession":
        return { canResend: true, canReturnToInput: true, canDiscard: true };
      case "PreviousSession":
        return { canResend: false, canReturnToInput: true, canDiscard: true };
      case "OutsideSession":
        // 入力欄を使えず、戻すと本文を選んでコピーできなくなるので、帯に残す
        return { canResend: false, canReturnToInput: false, canDiscard: true };
    }
  },

  /**
   * 帯の記入を今のセッション（`sessionId`）で送り直し始める。送る記入（最初に送ったときの ID・本文・タグのまま）を返す。
   * 帯にないか、もう送り直しているか、前のセッションの記入なら返さない
   */
  resend: (
    draft: JournalDraft,
    id: JournalEntryId,
    sessionId: SessionId,
  ): Readonly<{ draft: JournalDraft; submission: JournalSubmission }> | undefined => {
    const entry = findUnsent(draft, id);
    return entry === undefined || entry.sessionId !== sessionId
      ? undefined
      : { draft: markEntry(draft, id, "Resending"), submission: entry.submission };
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
   * つなげると本文が変わるので、次に送るときは新しい ID になる。前のセッションの記入を戻したときも、
   * 次に送るときは新しい ID になる（`submit`）
   */
  returnToInput: (draft: JournalDraft, id: JournalEntryId): JournalDraft => {
    const entry = findUnsent(draft, id);
    if (entry === undefined) {
      return draft;
    }
    const { submission, sessionId } = entry;
    const unsent = withoutEntry(draft, id);
    return draft.body === ""
      ? { body: submission.body, origin: { kind: "Returned", submission, sessionId }, unsent }
      : { body: `${submission.body}\n${draft.body}`, origin: typed, unsent };
  },

  /** 帯の記入を捨てる（実は保存できていたときのため） */
  discard: (draft: JournalDraft, id: JournalEntryId): JournalDraft =>
    findUnsent(draft, id) === undefined ? draft : { ...draft, unsent: withoutEntry(draft, id) },
};
