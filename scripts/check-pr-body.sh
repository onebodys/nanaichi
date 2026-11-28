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
  # 行を左から読み、HTML コメントを除き、インラインコードを (code) に置き換える。先に始まったほうが勝つ（CommonMark）ので、
  # コメントの中のバッククォートはコードとして読まず、コードの中の <!-- はコメントとして読まない。
  # インラインコードは同じ数のバッククォートで閉じたところまでで、閉じていなければ文字のまま残す。
  # コードの中身は Closes として読まないが、本文が書いてあることには数える。閉じていないコメントは inComment を立てる
  function readInline(text,    out, comment, tick, ticks, rest, tail, offset, closeAt) {
    out = ""
    while (1) {
      comment = index(text, "<!--")
      tick = match(text, /`+/) ? RSTART : 0
      ticks = RLENGTH
      if (comment == 0 && tick == 0) break
      if (comment > 0 && (tick == 0 || comment < tick)) {
        out = out substr(text, 1, comment - 1)
        rest = substr(text, comment + 4)
        if (index(rest, "-->") == 0) { inComment = 1; return out }
        text = substr(rest, index(rest, "-->") + 3)
        continue
      }
      rest = substr(text, tick + ticks)
      tail = rest
      offset = 0
      closeAt = 0
      while (match(tail, /`+/)) {
        if (RLENGTH == ticks) { closeAt = offset + RSTART; break }
        offset += RSTART + RLENGTH - 1
        tail = substr(tail, RSTART + RLENGTH)
      }
      if (closeAt == 0) { out = out substr(text, 1, tick + ticks - 1); text = rest; continue }
      out = out substr(text, 1, tick - 1) "(code)"
      text = substr(rest, closeAt + ticks)
    }
    return out text
  }

  # 1つ目のファイル: テンプレートの見出し
  FNR == NR {
    if (sub(/^## /, "")) { sub(/[ \t]+$/, ""); required[++count] = $0 }
    next
  }

  # ここから本文。コードブロック（``` / ~~~）の中は、HTML コメントの始まりも含めてそのまま読み飛ばす。
  # 閉じる行は、開いた行と同じ記号が同じ数以上並び、あとは空白だけの行
  !inComment && inFence {
    if (match($0, /^ ? ? ?(`+|~+)[ \t]*$/)) {
      run = $0
      sub(/^ */, "", run)
      sub(/[ \t]*$/, "", run)
      if (substr(run, 1, 1) == fenceChar && length(run) >= fenceLength) inFence = 0
    }
    next
  }
  !inComment && match($0, /^ ? ? ?(```+|~~~+)/) {
    run = substr($0, 1, RLENGTH)
    sub(/^ */, "", run)
    inFence = 1
    fenceChar = substr(run, 1, 1)
    fenceLength = length(run)
    next
  }

  # HTML コメント（行をまたぐものも）とインラインコードを読む
  {
    line = $0
    if (inComment) {
      if (index(line, "-->") == 0) next
      line = substr(line, index(line, "-->") + 3)
      inComment = 0
    }
    line = readInline(line)
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
    if (tolower(line) ~ /(^|[^[:alnum:]])closes:?[ \t]+#[1-9][0-9]*([^[:alnum:]]|$)/) closes = 1
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
