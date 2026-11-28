#!/bin/sh
# GLOSSARY.md の _Avoid_ で太字にした言い換えが、コードかドキュメントに出てきたら落とす。AGENTS.md「6. 用語とコードの対応」。
# 太字にするのは、ふつうの文章やほかの用語の一部に紛れない語だけ（「ログ」「完了」のような語は人とレビューで見る）。
# ドキュメントだけの変更でも走らせたいので、check-adr-numbers.sh と同じく単独のスクリプトにしている。
set -eu
# 日本語の語をバイト列のまま比べる（端末やランナーのロケールに左右されないように）
export LC_ALL=C
cd "$(dirname "$0")/.."

words=$(mktemp)
trap 'rm -f "$words"' EXIT
# 空の太字（****）は語として拾わない。空白を含む語（英字と日本語のあいだに空白がある語）は、空白を詰めて書いたものにも当たるようにする
sed -n 's/^_Avoid_: //p' GLOSSARY.md | grep -o '\*\*[^*][^*]*\*\*' | sed 's/\*\*//g' | sed 'p; s/ //g' | sort -u > "$words"
if [ ! -s "$words" ]; then
  echo "GLOSSARY.md の _Avoid_ に太字の語が見つかりません。書き方が変わったなら、このスクリプトを直してください。" >&2
  exit 1
fi

# 検査しないもの:
# - GLOSSARY.md: 言い換えを定義している
# - docs/adr/: 決めたときの記録で、言い換えを引用することがある
# - 外から取り込んだスキル: このプロジェクトの文章ではない。skills-lock.json のスキルを足したり外したりしたら、下の除外もそろえる
# 行から消してから探す言い回し:
# - ポモドーロ・テクニック、ポモドーロタイマー: 下敷きにした手法と、オーナーがもともと使っていたタイマーの名前。
#   集中やセットをその名で呼ぶのではない
hits=$(git grep -n -I -F -f "$words" -- . \
  ':!GLOSSARY.md' \
  ':!docs/adr/' \
  ':!.agents/skills/design-taste-frontend/' \
  ':!.agents/skills/e2e/' \
  ':!.agents/skills/kamae/' |
  sed -e 's/ポモドーロ・テクニック//g' -e 's/ポモドーロテクニック//g' -e 's/ポモドーロタイマー//g' |
  grep -F -f "$words" || true)
[ -z "$hits" ] && exit 0

echo "GLOSSARY.md の _Avoid_ にある言い換えを使っています。GLOSSARY.md の用語に直してください。" >&2
echo "$hits" >&2
exit 1
