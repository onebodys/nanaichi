#!/bin/sh
# docs/adr/ に同じ番号の ADR があれば落とす。番号の取り方は AGENTS.md「7. ツールと作業の進め方」。
# vp check には独自の検査を足せず、ドキュメントだけの変更では CI が vp test を飛ばすので、単独のスクリプトにしている。
set -eu
cd "$(dirname "$0")/.."

duplicates=$(ls docs/adr | sed -n 's/^\([0-9]*\)-.*/\1/p' | sort | uniq -d)
[ -z "$duplicates" ] && exit 0

echo "同じ番号の ADR があります。後からマージする側を、main の最大番号の次へ振り直してください。" >&2
for number in $duplicates; do
  ls docs/adr/"$number"-* >&2
done
exit 1
