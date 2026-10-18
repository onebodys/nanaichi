# 分岐の網羅性は lint で検査し、パターンマッチのライブラリは入れない

判別可能な union の分岐は TypeScript の `switch` で書き、すべての `kind` を `case` に並べる。分岐の抜け漏れは Oxlint の型を使うルール `typescript/switch-exhaustiveness-check` で検査し、`vp check` で落とす。ts-pattern などのパターンマッチのライブラリは入れない（Issue #63）。

`switch` の抜け漏れは、これまで型チェックで見つかるものと見つからないものがあった。値を返す関数の `switch` は、ケースが足りないと strict の型チェックが「すべての経路で値を返していない」としてエラーにする。一方、値を返さない `switch`（`client/sync-connection.ts` の `check` / `close`、`client/use-sync.ts` など）は、ケースが足りなくても何も言われない。接続の状態に `Suspended` を足す実験では、これまでの `vp check` は通り、ルールを有効にすると 2 箇所とも `Cases not matched: "Suspended"` で落ちた。

ts-pattern の `.exhaustive()` でも同じことは検査できる。しかし、このルールで検査できる範囲を超えて得られるものがこのコードベースにはない。一方で、書き方が `switch` と混ざる、ブラウザにも配る `domain/` のバンドルが増える、型エラーが長く読みにくい、という代償がある。コードを書くのはエージェントなので書き換えの手間は問題にならないが、オーナーがユースケースを読むときの書き方は 1 通りに保ちたい。

## Consequences

- すべての `kind` を `case` に並べ、同じ扱いのものは `case` を続けて書く。`default` は書かない。このルールは `default` があっても足りないケースを報告する（`default` を網羅とみなす設定は既定で無効で、そのまま使う）ので、`default` は検査を逃れる手段にもならず、読む量が増えるだけになる。
- 網羅性は「すべての `kind` に分岐がある」ことまでしか保証しない。どの状態でどの操作を受け付けるか（`domain/timer-state.ts`）のような判断そのものの正しさは、これまでどおり日本語の場面名のテストで確かめる。

## Considered Options

- ts-pattern を入れ、`match(...).exhaustive()` で分岐する: 上の理由で不採用。入れ子の値の形で分岐したい場面が増えたら見直す
- 値を返さない `switch` の `default` に `assertNever` を書く: 書き忘れれば検査されず、機械的に保証できないため不採用
