#!/bin/sh
# PR の本文（標準入力）に、AGENTS.md「1. 最優先: お互いが検証できる状態にする」の4つの見出しと Closes #N があるかを確かめる。
# 見出しの文言は .github/pull_request_template.md の「## 」の行を正とし、ここには書かない。
# 見出しはどれも、その下（同じか浅い深さの次の見出しか末尾まで）に、空行と HTML コメントのほかの行が要る。
# コードブロック（``` / ~~~）と HTML コメントの中は読まない。Closes はインラインコードの中も読まない。
# CI（.github/workflows/pr-body.yml）が走らせる。手元では gh pr view <番号> --json body -q .body | sh scripts/check-pr-body.sh
set -eu
export LC_ALL=C
cd "$(dirname "$0")/.."

template=.github/pull_request_template.md
if ! grep -q '^## ' "$template"; then
  echo "$template に「## 」の見出しがありません。" >&2
  exit 1
fi

# Web の画面で直した本文は改行が CRLF になる。
# awk は Ubuntu の mawk でも動くよう、正規表現の {n,m} を使わない
missing=$(tr -d '\r' | awk '
  # 1つ目のファイル: テンプレートの見出し
  FNR == NR {
    if (sub(/^## /, "")) { sub(/[ \t]+$/, ""); required[++count] = $0 }
    next
  }

  # ここから本文。HTML コメントを除く（行をまたぐものも）
  {
    line = $0
    if (inComment) {
      if (index(line, "-->") == 0) next
      line = substr(line, index(line, "-->") + 3)
      inComment = 0
    }
    while ((start = index(line, "<!--")) > 0) {
      rest = substr(line, start + 4)
      end = index(rest, "-->")
      if (end == 0) { line = substr(line, 1, start - 1); inComment = 1; break }
      line = substr(line, 1, start - 1) substr(rest, end + 3)
    }
  }

  # コードブロックを除く。閉じる行は開いた行と同じ記号
  !inFence && match(line, /^ ? ? ?(```|~~~)/) {
    inFence = 1; fence = substr(line, RLENGTH - 2, 3); next
  }
  inFence {
    if (line ~ ("^ ? ? ?" fence)) inFence = 0
    next
  }

  # 見出し
  match(line, /^#+/) && RLENGTH <= 6 && substr(line, RLENGTH + 1, 1) ~ /[ \t]/ {
    level = RLENGTH
    text = substr(line, level + 1)
    sub(/^[ \t]+/, "", text)
    sub(/[ \t]+$/, "", text)
    # 同じか浅い深さの見出しで、いま読んでいる必須の見出しの範囲を閉じる
    if (current != "" && level <= currentLevel) current = ""
    for (i = 1; i <= count; i++) {
      if (text == required[i]) { found[text] = 1; current = text; currentLevel = level }
    }
    if (current != "" && current != text) filled[current] = 1
    next
  }

  line ~ /[^ \t]/ {
    if (current != "") filled[current] = 1
    code = line
    gsub(/`[^`]*`/, "", code)
    if (tolower(code) ~ /(^|[^[:alnum:]])closes:?[ \t]+#[1-9][0-9]*([^[:alnum:]]|$)/) closes = 1
  }

  END {
    for (i = 1; i <= count; i++) {
      if (!found[required[i]]) print "- 見出し「" required[i] "」"
      else if (!filled[required[i]]) print "- 見出し「" required[i] "」の下の本文"
    }
    if (!closes) print "- Closes #<Issue の番号>"
  }
' "$template" -)

[ -z "$missing" ] && exit 0
echo "PR の本文に、次のものがありません（AGENTS.md「1. 最優先: お互いが検証できる状態にする」、$template）。" >&2
echo "$missing" >&2
exit 1
