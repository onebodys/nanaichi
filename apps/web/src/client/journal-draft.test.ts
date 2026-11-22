import { describe, expect, test } from "vite-plus/test";
import * as v from "valibot";
import { JournalEntryId } from "../domain/journal-entry.ts";
import { SessionId } from "../domain/session.ts";
import { TagName } from "../domain/tag.ts";
import { JournalDraft, type JournalSubmission } from "./journal-draft.ts";

const idOf = (n: number): JournalEntryId =>
  v.parse(JournalEntryId.schema, `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`);

/** 呼ぶたびに 1, 2, 3… の ID を発行する */
const ids = () => {
  let n = 0;
  return () => {
    n += 1;
    return idOf(n);
  };
};

const reading = v.parse(TagName.schema, "読書");

/** 記入を送ろうとしたセッション（S1）と、そのあとに始めたセッション（S2） */
const s1 = v.parse(SessionId.schema, "00000000-0000-4000-8000-0000000000a1");
const s2 = v.parse(SessionId.schema, "00000000-0000-4000-8000-0000000000a2");

/** 入力欄に書いて送る */
const writeAndSubmit = (
  draft: JournalDraft,
  body: string,
  newId: () => JournalEntryId,
  tags: ReadonlyArray<TagName> = [],
  sessionId: SessionId = s1,
) => JournalDraft.submit(JournalDraft.edit(draft, body), tags, sessionId, newId);

const bodiesOf = (draft: JournalDraft) => draft.unsent.map((e) => e.submission.body);

describe("送れなかった記入", () => {
  test("A を送っている間に B を書き、A が送れなかったら、入力欄には B が残り帯に A が出る", () => {
    const newId = ids();
    const a = writeAndSubmit(JournalDraft.empty, "A", newId);
    const writing = JournalDraft.edit(a.draft, "B");

    const failed = JournalDraft.failed(writing, a.submission, s1);

    expect(failed.body).toBe("B");
    expect(failed.unsent).toEqual([{ kind: "Unsent", submission: a.submission, sessionId: s1 }]);
  });

  test("帯の記入を送り直すと、最初に送ったときと同じ ID・本文・タグで送る", () => {
    const newId = ids();
    const a = writeAndSubmit(JournalDraft.empty, "A", newId, [reading]);
    const failed = JournalDraft.failed(JournalDraft.edit(a.draft, "B"), a.submission, s1);

    const resending = JournalDraft.resend(failed, a.submission.id, s1);

    expect(resending?.submission).toEqual<JournalSubmission>({
      id: idOf(1),
      body: "A",
      tags: [reading],
    });
    expect(resending?.draft.unsent).toEqual([
      { kind: "Resending", submission: a.submission, sessionId: s1 },
    ]);
    // 送り直している間は、もう一度送り直せない
    expect(resending && JournalDraft.resend(resending.draft, a.submission.id, s1)).toBeUndefined();
  });

  test("送り直して送れたら帯から消え、送れなかったら帯に残ってまた送り直せる", () => {
    const newId = ids();
    const a = writeAndSubmit(JournalDraft.empty, "A", newId);
    const failed = JournalDraft.failed(JournalDraft.edit(a.draft, "B"), a.submission, s1);
    const resending = JournalDraft.resend(failed, a.submission.id, s1)?.draft ?? failed;

    expect(JournalDraft.resent(resending, a.submission.id).unsent).toEqual([]);
    const stillUnsent = JournalDraft.resendFailed(resending, a.submission.id);
    expect(stillUnsent.unsent).toEqual([
      { kind: "Unsent", submission: a.submission, sessionId: s1 },
    ]);
    expect(JournalDraft.resend(stillUnsent, a.submission.id, s1)?.submission).toEqual(a.submission);
  });

  test("帯の記入を入力欄に戻すと、書き足した本文の前に改行をはさんでつながり、帯から消える", () => {
    const newId = ids();
    const a = writeAndSubmit(JournalDraft.empty, "A", newId);
    const failed = JournalDraft.failed(JournalDraft.edit(a.draft, "B"), a.submission, s1);

    const returned = JournalDraft.returnToInput(failed, a.submission.id);

    expect(returned.body).toBe("A\nB");
    expect(returned.unsent).toEqual([]);
    // 本文が変わったので、次に送るときは新しい ID
    expect(JournalDraft.submit(returned, [], s1, newId).submission.id).toBe(idOf(2));
  });

  test("入力欄が空のときに帯の記入を戻すと、そのまま入り、変えずに送ると同じ ID で送る", () => {
    const newId = ids();
    const a = writeAndSubmit(JournalDraft.empty, "A", newId);
    const failed = JournalDraft.failed(JournalDraft.edit(a.draft, "B"), a.submission, s1);
    const cleared = JournalDraft.edit(failed, "");

    const returned = JournalDraft.returnToInput(cleared, a.submission.id);

    expect(returned.body).toBe("A");
    expect(JournalDraft.submit(returned, [], s1, newId).submission.id).toBe(idOf(1));
  });

  test("帯の記入を捨てると帯から消え、入力欄は変わらない", () => {
    const newId = ids();
    const a = writeAndSubmit(JournalDraft.empty, "A", newId);
    const failed = JournalDraft.failed(JournalDraft.edit(a.draft, "B"), a.submission, s1);

    const discarded = JournalDraft.discard(failed, a.submission.id);

    expect(discarded.unsent).toEqual([]);
    expect(discarded.body).toBe("B");
  });

  test("送り直している記入は、入力欄に戻すことも捨てることもしない", () => {
    const newId = ids();
    const a = writeAndSubmit(JournalDraft.empty, "A", newId);
    const failed = JournalDraft.failed(JournalDraft.edit(a.draft, "B"), a.submission, s1);
    const resending = JournalDraft.resend(failed, a.submission.id, s1)?.draft ?? failed;

    expect(JournalDraft.returnToInput(resending, a.submission.id)).toEqual(resending);
    expect(JournalDraft.discard(resending, a.submission.id)).toEqual(resending);
  });

  test("続けて送った2件が送れないと帯に2件並び、それぞれ自分の ID を持ち、別の記入を送れても消えない", () => {
    const newId = ids();
    const a = writeAndSubmit(JournalDraft.empty, "A", newId);
    const b = writeAndSubmit(a.draft, "B", newId);
    const c = writeAndSubmit(b.draft, "C", newId);
    const writing = JournalDraft.edit(c.draft, "D");

    // A と B は送れず、C は送れた（送れた記入では帯を変えない）
    const failed = JournalDraft.failed(
      JournalDraft.failed(writing, a.submission, s1),
      b.submission,
      s1,
    );

    expect(bodiesOf(failed)).toEqual(["A", "B"]);
    expect(failed.unsent.map((e) => e.submission.id)).toEqual([idOf(1), idOf(2)]);
    expect(failed.body).toBe("D");
    // 片方を送り直して送れても、もう片方は残る
    const resent = JournalDraft.resent(
      JournalDraft.resend(failed, idOf(2), s1)?.draft ?? failed,
      idOf(2),
    );
    expect(bodiesOf(resent)).toEqual(["A"]);
  });

  test("帯に記入を残したまま次を送って送れず、書き足していれば帯に2件並ぶ", () => {
    const newId = ids();
    const a = writeAndSubmit(JournalDraft.empty, "A", newId);
    const afterA = JournalDraft.failed(JournalDraft.edit(a.draft, "B"), a.submission, s1);
    const b = JournalDraft.submit(afterA, [], s1, newId);

    const afterB = JournalDraft.failed(JournalDraft.edit(b.draft, "C"), b.submission, s1);

    expect(bodiesOf(afterB)).toEqual(["A", "B"]);
    expect(afterB.body).toBe("C");
  });

  test("書き足していないときに送れなければ、今まで通り入力欄に戻って帯は出ず、変えずに送ると同じ ID で送る", () => {
    const newId = ids();
    const a = writeAndSubmit(JournalDraft.empty, "A", newId, [reading]);

    const failed = JournalDraft.failed(a.draft, a.submission, s1);

    expect(failed.body).toBe("A");
    expect(failed.unsent).toEqual([]);
    expect(JournalDraft.submit(failed, [reading], s1, newId).submission.id).toBe(idOf(1));
  });

  test("入力欄に戻った記入の本文かタグを変えて送ると、新しい ID で送る", () => {
    const newId = ids();
    const a = writeAndSubmit(JournalDraft.empty, "A", newId, [reading]);
    const failed = JournalDraft.failed(a.draft, a.submission, s1);

    expect(JournalDraft.submit(failed, [], s1, newId).submission.id).toBe(idOf(2));
    expect(
      JournalDraft.submit(JournalDraft.edit(failed, "A2"), [reading], s1, newId).submission.id,
    ).toBe(idOf(3));
  });

  test("入力欄に戻った記入を送ったら、そのあとに同じ本文を書いても新しい ID で送る", () => {
    const newId = ids();
    const a = writeAndSubmit(JournalDraft.empty, "A", newId);
    const resent = JournalDraft.submit(
      JournalDraft.failed(a.draft, a.submission, s1),
      [],
      s1,
      newId,
    );

    expect(resent.submission.id).toBe(idOf(1));
    expect(writeAndSubmit(resent.draft, "A", newId).submission.id).toBe(idOf(2));
  });
});

describe("前のセッションの送れなかった記入（Issue #88）", () => {
  /** S1 で A を送っている間に B を書き、A が送れず帯に残った */
  const failedInS1 = () => {
    const newId = ids();
    const a = writeAndSubmit(JournalDraft.empty, "A", newId);
    const draft = JournalDraft.failed(JournalDraft.edit(a.draft, "B"), a.submission, s1);
    return { newId, a, draft };
  };

  const standingOfAll = (draft: JournalDraft, sessionId: SessionId | undefined) =>
    draft.unsent.map((e) => JournalDraft.standingOf(e, sessionId).kind);

  test("S1 で送れなかった記入は、S1 の間は送り直せ、S1 を終えると送り直せず、S2 を始めても送り直せない", () => {
    const { a, draft } = failedInS1();

    expect(standingOfAll(draft, s1)).toEqual(["CurrentSession"]);
    expect(standingOfAll(draft, undefined)).toEqual(["OutsideSession"]);
    expect(standingOfAll(draft, s2)).toEqual(["PreviousSession"]);
    expect(JournalDraft.resend(draft, a.submission.id, s2)).toBeUndefined();
    expect(JournalDraft.actionsOf({ kind: "PreviousSession" }).canResend).toBe(false);
    expect(JournalDraft.actionsOf({ kind: "OutsideSession" }).canResend).toBe(false);
  });

  test("S2 では前のセッションの記入を入力欄に戻せ、本文が入り、送ると S1 の ID ではなく新しい ID で今のセッションに送る", () => {
    const { newId, a, draft } = failedInS1();
    const cleared = JournalDraft.edit(draft, "");

    expect(JournalDraft.actionsOf({ kind: "PreviousSession" }).canReturnToInput).toBe(true);
    const returned = JournalDraft.returnToInput(cleared, a.submission.id);

    expect(returned.body).toBe("A");
    expect(returned.unsent).toEqual([]);
    expect(JournalDraft.submit(returned, [], s2, newId).submission.id).toBe(idOf(2));
  });

  test("S1 で入力欄に戻った記入を変えずに S2 で送っても、新しい ID で送る", () => {
    const newId = ids();
    const a = writeAndSubmit(JournalDraft.empty, "A", newId);
    const failed = JournalDraft.failed(a.draft, a.submission, s1);

    expect(failed.body).toBe("A");
    expect(JournalDraft.submit(failed, [], s2, newId).submission.id).toBe(idOf(2));
  });

  test("前のセッションの記入はいつでも捨てられ、帯から消える", () => {
    const { a, draft } = failedInS1();

    expect(JournalDraft.actionsOf({ kind: "PreviousSession" }).canDiscard).toBe(true);
    expect(JournalDraft.actionsOf({ kind: "OutsideSession" }).canDiscard).toBe(true);
    expect(JournalDraft.discard(draft, a.submission.id).unsent).toEqual([]);
  });

  test("S2 で送れなかった記入は、同じ帯に S1 の記入があっても送り直せる", () => {
    const { newId, a, draft } = failedInS1();
    const b = JournalDraft.submit(draft, [], s2, newId);
    const afterB = JournalDraft.failed(JournalDraft.edit(b.draft, "C"), b.submission, s2);

    expect(standingOfAll(afterB, s2)).toEqual(["PreviousSession", "CurrentSession"]);
    const resending = JournalDraft.resend(afterB, b.submission.id, s2);
    expect(resending?.submission).toEqual(b.submission);
    expect(resending && standingOfAll(resending.draft, s2)).toEqual([
      "PreviousSession",
      "Resending",
    ]);
    expect(JournalDraft.resend(afterB, a.submission.id, s2)).toBeUndefined();
  });

  test("送り直しているあいだは、どのボタンも押せない", () => {
    expect(JournalDraft.actionsOf({ kind: "Resending" })).toEqual({
      canResend: false,
      canReturnToInput: false,
      canDiscard: false,
    });
    expect(JournalDraft.actionsOf({ kind: "CurrentSession" })).toEqual({
      canResend: true,
      canReturnToInput: true,
      canDiscard: true,
    });
    expect(JournalDraft.actionsOf({ kind: "OutsideSession" }).canReturnToInput).toBe(false);
  });

  test("送り直して送れなかった記入は、送ろうとしたセッションを保ったまま帯に残る", () => {
    const { a, draft } = failedInS1();
    const resending = JournalDraft.resend(draft, a.submission.id, s1)?.draft ?? draft;

    const stillUnsent = JournalDraft.resendFailed(resending, a.submission.id);

    expect(stillUnsent.unsent).toEqual([
      { kind: "Unsent", submission: a.submission, sessionId: s1 },
    ]);
    expect(standingOfAll(stillUnsent, s2)).toEqual(["PreviousSession"]);
  });
});
