# ゴールデンケース

TS と Swift のドメインが同じ振る舞いをすることを確かめるための場面（ADR 0015）。TS のドメインのテスト（`apps/web/src/domain/*.test.ts`）が `goldenCases`（`apps/web/src/testing/golden.ts`）で場面を TS の実装に通し、同じ場面をここに書き出す。Swift のドメインのテストは、ここの JSON をそのまま読んで通す。

## 直し方

ここの JSON は手で直さない。TS のテストの場面を直してから、`vp test -u <テストのファイル>` で書き出し直す。書き出し直し忘れると、TS のテストの「ゴールデンケースの JSON が場面と一致する」が落ちる。

## 形

1つのファイルが1つの関数にあたる。ファイル名と `function` は TS の関数の名前で、Swift はこの名前で、どの関数に通すかを決める。

```json
{
  "function": "deriveTimerState",
  "cases": [
    { "name": "場面の名前（日本語）", "input": { "引数の名前": "値" }, "expected": "期待する出力" }
  ]
}
```

- `input` は、引数を名前で並べた1つのオブジェクトにする。
- 時刻は ISO 8601 の UTC の文字列（`2026-10-17T00:07:00.000Z`）にする。
- byethrow の Result を返す関数の `expected` は、`{ "kind": "Success", "value": … }` か `{ "kind": "Failure", "error": … }` にする。
- `undefined` のフィールドは書かない。
- ジャーナル記入の本文（`Sensitive`）は、ふつうの文字列にする（場面のために作った文で、PII ではない）。
- 出力は、JSON にした形どうしで比べる。小数（`remainingRatioOf` や `roundProgressOf` の割合など）は2進の浮動小数点の値なので、Swift の側では誤差を許して比べる。
