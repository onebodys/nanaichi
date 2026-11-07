import * as v from "valibot";
import { JournalEntryBody, JournalEntryId, type JournalEntry } from "../domain/journal-entry.ts";
import { SessionId } from "../domain/session.ts";
import { TagName } from "../domain/tag.ts";
import type { Plain, Settled } from "./golden.ts";

const pad = (value: number, length: number) => String(value).padStart(length, "0");

/** ゴールデンケースの JSON が実行のたびに変わらないよう、番号から決まる UUID を作る */
export const uuid = (n: number) => `00000000-0000-4000-8000-${pad(n, 12)}`;

/** 端末のタイムゾーンでの日付。`key` は手で組み立てる（実装の `Calendar` に頼らない） */
export const localDate = (year: number, month: number, day: number) => ({
  key: `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`,
  year,
  month,
  day,
});

/**
 * 値を検証する関数（`v.parse` する関数）を、通ったか通らなかったかの形にそろえる。
 * 失敗の理由は検証ライブラリのものなので持ち込まず、何が悪かったかは入力で読めるようにする
 */
export type Parsed<T> = Settled<T, Readonly<{ kind: "Invalid" }>>;

export const parsedBy =
  <T>(schema: v.GenericSchema<unknown, T>) =>
  (input: Readonly<{ value: unknown }>): Parsed<T> => {
    const parsed = v.safeParse(schema, input.value);
    return parsed.success
      ? { kind: "Success", value: parsed.output }
      : { kind: "Failure", error: { kind: "Invalid" } };
  };

/** ジャーナル記入を、期待する出力に書く素の値で表したもの */
export type JournalEntryFields = Plain<JournalEntry>;

/** 素の値のジャーナル記入から、ワークフローに渡す型（ブランドと `Sensitive`）のジャーナル記入を作る */
export const journalEntryOf = (fields: JournalEntryFields): JournalEntry => ({
  id: v.parse(JournalEntryId.schema, fields.id),
  sessionId: v.parse(SessionId.schema, fields.sessionId),
  body: v.parse(JournalEntryBody.schema, fields.body),
  tags: fields.tags.map((name) => v.parse(TagName.schema, name)),
  writtenAt: fields.writtenAt,
  updatedAt: fields.updatedAt,
  writtenDuring: fields.writtenDuring,
});
