#!/bin/sh
# PR の本文（標準入力）に、AGENTS.md「1. 最優先: お互いが検証できる状態にする」の4つの見出しと Closes #N があるかを確かめる。
# 見出しの文言は .github/pull_request_template.md の「## 」の行を正とし、ここには書かない。
# CI（.github/workflows/pr-body.yml）が走らせる。手元では gh pr view <番号> --json body -q .body | sh scripts/check-pr-body.sh
set -eu
export LC_ALL=C
cd "$(dirname "$0")/.."

# Web の画面で直した本文は改行が CRLF になる
body=$(tr -d '\r')
missing=""

headings=$(sed -n 's/^## //p' .github/pull_request_template.md)
if [ -z "$headings" ]; then
  echo ".github/pull_request_template.md に「## 」の見出しがありません。" >&2
  exit 1
fi
newline='
'
while IFS= read -r heading; do
  # 見出しの深さ（# の数）は問わず、文言がそのまま一致する行を探す（文言を正規表現として読まない）
  if ! printf '%s\n' "$body" | sed -n 's/^#\{1,6\}[[:space:]]\{1,\}//p' | sed 's/[[:space:]]*$//' | grep -qxF "$heading"; then
    missing="$missing$newline- 見出し「$heading」"
  fi
done <<HEADINGS
$headings
HEADINGS

if ! printf '%s\n' "$body" | grep -qE '(^|[^[:alnum:]])Closes #[0-9]+'; then
  missing="$missing$newline- Closes #<Issue の番号>"
fi

[ -z "$missing" ] && exit 0
echo "PR の本文に、次のものがありません（AGENTS.md「1. 最優先: お互いが検証できる状態にする」、.github/pull_request_template.md）。$missing" >&2
exit 1
