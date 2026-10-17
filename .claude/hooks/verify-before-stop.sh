#!/usr/bin/env bash
# エージェントが作業を終える前に `vp check` と `vp test` を走らせる（AGENTS.md「1. 最優先」）。
# 落ちたら exit 2 で終了を止め、出力の末尾をエージェントに返して直させる。
set -uo pipefail

input=$(cat)
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

# 直前の Stop フックで止めたあとなら、無限ループを避けるため終了させる（ユーザーには警告を出す）
stop_hook_active=$(printf '%s' "$input" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).stop_hook_active===true))}catch{process.stdout.write("false")}})')

output=$( { pnpm exec vp check && pnpm exec vp test; } 2>&1 )
status=$?

if [ "$status" -eq 0 ]; then
  exit 0
fi

if [ "$stop_hook_active" = "true" ]; then
  printf '{"systemMessage":"vp check / vp test が通らないまま作業を終えました。完了とは扱わないでください。"}\n'
  exit 0
fi

{
  echo "vp check / vp test が通っていません。直してから作業を終えてください（AGENTS.md「1. 最優先」）。"
  echo
  printf '%s\n' "$output" | perl -pe 's/\e\[[0-9;]*m//g' | tail -n 60
} >&2
exit 2
