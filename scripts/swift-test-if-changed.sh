#!/bin/sh
# Swift のコード（apps/apple/）かゴールデンケース（fixtures/golden/）が main から変わっていれば swift test を走らせる。
# push 時のフックとエージェントの Stop フックから呼ぶ（Issue #22）。CI の apple ジョブと同じ条件にしている。
# Swift の入っていない環境（Linux など）では飛ばす。Mac アプリを触らない人の push を止めないため
set -eu
cd "$(dirname "$0")/.."

# main と比べられないとき（origin/main がない clone など）は、変わったかを判定せず走らせる
if base=$(git merge-base HEAD origin/main 2>/dev/null); then
  # コミットしたものと、まだコミットしていないもの（Stop フックのとき）の両方を見る
  changed=$({
    git diff --name-only "$base"
    git ls-files --others --exclude-standard
  } | grep -E '^(apps/apple/|fixtures/golden/)' || true)
  [ -z "$changed" ] && exit 0
fi

# Package は macOS 26 の SDK を要るので、Command Line Tools ではなく Xcode を使う。
# DEVELOPER_DIR があればそれを、なければ xcode-select が Xcode を指していればそれを、
# Command Line Tools を指していれば /Applications のいちばん新しい Xcode を使う（CI の apple ジョブと同じ選び方）
if [ -z "${DEVELOPER_DIR:-}" ] && command -v xcode-select >/dev/null 2>&1; then
  case "$(xcode-select -p 2>/dev/null)" in
    */CommandLineTools | "")
      xcode=$(ls -d /Applications/Xcode*.app 2>/dev/null | sort -V | tail -n 1)
      [ -n "$xcode" ] && export DEVELOPER_DIR="$xcode/Contents/Developer"
      ;;
  esac
fi

if ! command -v swift >/dev/null 2>&1; then
  echo "Swift が見つからないので swift test を飛ばします（apps/apple/ かゴールデンケースが変わっています。CI の apple ジョブで確かめます）" >&2
  exit 0
fi

cd apps/apple/NanaichiKit
# 通ったときの全件の一覧は長いので、落ちたときだけ出す
log=$(mktemp)
if swift test >"$log" 2>&1; then
  rm -f "$log"
  exit 0
fi
grep -E '^(✘|.*error:)' "$log" | head -n 80 >&2
echo "swift test が落ちました（全体のログ: ${log}）" >&2
exit 1
