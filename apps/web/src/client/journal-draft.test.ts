import { describe, expect, test } from "vite-plus/test";
import * as v from "valibot";
import { JournalEntryId } from "../domain/journal-entry.ts";
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

/** 入力欄に書いて送る */
const writeAndSubmit = (
  draft: JournalDraft,
  body: string,
  newId: () => JournalEntryId,
  tags: ReadonlyArray<TagName> = [],
) => JournalDraft.submit(JournalDraft.edit(draft, body), tags, newId);

const bodiesOf = (draft: JournalDraft) => draft.unsent.map((e) => e.submission.body);

describe("送れなかった記入", () => {
  test("A を送っている間に B を書き、A が送れなかったら、入力欄には B が残り帯に A が出る", () => {
    const newId = ids();
    const a = writeAndSubmit(JournalDraft.empty, "A", newId);
    const writing = JournalDraft.edit(a.draft, "B");

    const failed = JournalDraft.failed(writing, a.submission);

    expect(failed.body).toBe("B");
    expect(failed.unsent).toEqual([{ kind: "Unsent", submission: a.submission }]);
  });

  test("帯の記入を送り直すと、最初に送ったときと同じ ID・本文・タグで送る", () => {
    const newId = ids();
    const a = writeAndSubmit(JournalDraft.empty, "A", newId, [reading]);
    const failed = JournalDraft.failed(JournalDraft.edit(a.draft, "B"), a.submission);

    const resending = JournalDraft.resend(failed, a.submission.id);

    expect(resending?.submission).toEqual<JournalSubmission>({
      id: idOf(1),
      body: "A",
      tags: [reading],
    });
    expect(resending?.draft.unsent).toEqual([{ kind: "Resending", submission: a.submission }]);
    // 送り直している間は、もう一度送り直せない
    expect(resending && JournalDraft.resend(resending.draft, a.submission.id)).toBeUndefined();
  });

  test("送り直して送れたら帯から消え、送れなかったら帯に残ってまた送り直せる", () => {
    const newId = ids();
    const a = writeAndSubmit(JournalDraft.empty, "A", newId);
    const failed = JournalDraft.failed(JournalDraft.edit(a.draft, "B"), a.submission);
    const resending = JournalDraft.resend(failed, a.submission.id)?.draft ?? failed;

    expect(JournalDraft.resent(resending, a.submission.id).unsent).toEqual([]);
    const stillUnsent = JournalDraft.resendFailed(resending, a.submission.id);
    expect(stillUnsent.unsent).toEqual([{ kind: "Unsent", submission: a.submission }]);
    expect(JournalDraft.resend(stillUnsent, a.submission.id)?.submission).toEqual(a.submission);
  });

  test("帯の記入を入力欄に戻すと、書き足した本文の前に改行をはさんでつながり、帯から消える", () => {
    const newId = ids();
    const a = writeAndSubmit(JournalDraft.empty, "A", newId);
    const failed = JournalDraft.failed(JournalDraft.edit(a.draft, "B"), a.submission);

    const returned = JournalDraft.returnToInput(failed, a.submission.id);

    expect(returned.body).toBe("A\nB");
    expect(returned.unsent).toEqual([]);
    // 本文が変わったので、次に送るときは新しい ID
    expect(JournalDraft.submit(returned, [], newId).submission.id).toBe(idOf(2));
  });

  test("入力欄が空のときに帯の記入を戻すと、そのまま入り、変えずに送ると同じ ID で送る", () => {
    const newId = ids();
    const a = writeAndSubmit(JournalDraft.empty, "A", newId);
    const failed = JournalDraft.failed(JournalDraft.edit(a.draft, "B"), a.submission);
    const cleared = JournalDraft.edit(failed, "");

    const returned = JournalDraft.returnToInput(cleared, a.submission.id);

    expect(returned.body).toBe("A");
    expect(JournalDraft.submit(returned, [], newId).submission.id).toBe(idOf(1));
  });

  test("帯の記入を捨てると帯から消え、入力欄は変わらない", () => {
    const newId = ids();
    const a = writeAndSubmit(JournalDraft.empty, "A", newId);
    const failed = JournalDraft.failed(JournalDraft.edit(a.draft, "B"), a.submission);

    const discarded = JournalDraft.discard(failed, a.submission.id);

    expect(discarded.unsent).toEqual([]);
    expect(discarded.body).toBe("B");
  });

  test("送り直している記入は、入力欄に戻すことも捨てることもしない", () => {
    const newId = ids();
    const a = writeAndSubmit(JournalDraft.empty, "A", newId);
    const failed = JournalDraft.failed(JournalDraft.edit(a.draft, "B"), a.submission);
    const resending = JournalDraft.resend(failed, a.submission.id)?.draft ?? failed;

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
    const failed = JournalDraft.failed(JournalDraft.failed(writing, a.submission), b.submission);

    expect(bodiesOf(failed)).toEqual(["A", "B"]);
    expect(failed.unsent.map((e) => e.submission.id)).toEqual([idOf(1), idOf(2)]);
    expect(failed.body).toBe("D");
    // 片方を送り直して送れても、もう片方は残る
    const resent = JournalDraft.resent(
      JournalDraft.resend(failed, idOf(2))?.draft ?? failed,
      idOf(2),
    );
    expect(bodiesOf(resent)).toEqual(["A"]);
  });

  test("帯に記入を残したまま次を送って送れず、書き足していれば帯に2件並ぶ", () => {
    const newId = ids();
    const a = writeAndSubmit(JournalDraft.empty, "A", newId);
    const afterA = JournalDraft.failed(JournalDraft.edit(a.draft, "B"), a.submission);
    const b = JournalDraft.submit(afterA, [], newId);

    const afterB = JournalDraft.failed(JournalDraft.edit(b.draft, "C"), b.submission);

    expect(bodiesOf(afterB)).toEqual(["A", "B"]);
    expect(afterB.body).toBe("C");
  });

  test("書き足していないときに送れなければ、今まで通り入力欄に戻って帯は出ず、変えずに送ると同じ ID で送る", () => {
    const newId = ids();
    const a = writeAndSubmit(JournalDraft.empty, "A", newId, [reading]);

    const failed = JournalDraft.failed(a.draft, a.submission);

    expect(failed.body).toBe("A");
    expect(failed.unsent).toEqual([]);
    expect(JournalDraft.submit(failed, [reading], newId).submission.id).toBe(idOf(1));
  });

  test("入力欄に戻った記入の本文かタグを変えて送ると、新しい ID で送る", () => {
    const newId = ids();
    const a = writeAndSubmit(JournalDraft.empty, "A", newId, [reading]);
    const failed = JournalDraft.failed(a.draft, a.submission);

    expect(JournalDraft.submit(failed, [], newId).submission.id).toBe(idOf(2));
    expect(
      JournalDraft.submit(JournalDraft.edit(failed, "A2"), [reading], newId).submission.id,
    ).toBe(idOf(3));
  });

  test("入力欄に戻った記入を送ったら、そのあとに同じ本文を書いても新しい ID で送る", () => {
    const newId = ids();
    const a = writeAndSubmit(JournalDraft.empty, "A", newId);
    const resent = JournalDraft.submit(JournalDraft.failed(a.draft, a.submission), [], newId);

    expect(resent.submission.id).toBe(idOf(1));
    expect(writeAndSubmit(resent.draft, "A", newId).submission.id).toBe(idOf(2));
  });
});
