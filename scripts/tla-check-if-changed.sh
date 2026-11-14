#!/bin/sh
# 自動終了の alarm の TLA+ モデル（specs/auto-end-alarm/）か、それが写しているコードが main から変わっていれば TLC で検査する。
# push 時のフックとエージェントの Stop フックから呼ぶ（Issue #35、.agents/skills/auto-end-alarm）。CI の check ジョブは毎回走らせる。
# Java の入っていない環境では飛ばす。モデルを触らない人の push を止めないため
set -eu
cd "$(dirname "$0")/.."

# main と比べられないとき（origin/main がない clone など）は、変わったかを判定せず走らせる
if base=$(git merge-base HEAD origin/main 2>/dev/null); then
  # コミットしたものと、まだコミットしていないもの（Stop フックのとき）の両方を見る
  changed=$({
    git diff --name-only "$base"
    git ls-files --others --exclude-standard
  } | grep -E '^(specs/auto-end-alarm/|apps/web/src/server/user-do\.ts$|apps/web/src/workflows/auto-end-session\.ts$|apps/web/src/server/auto-end-trace\.workers\.test\.ts$)' || true)
  [ -z "$changed" ] && exit 0
fi

status=0
node specs/auto-end-alarm/check.mjs || status=$?
if [ "$status" -eq 3 ]; then
  echo "Java が見つからないので TLA+ の検査を飛ばします（自動終了のモデルか写しているコードが変わっています。CI の check ジョブで確かめます）" >&2
  exit 0
fi
exit "$status"
