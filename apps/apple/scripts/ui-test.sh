#!/bin/sh
# Mac アプリの XCUITest を走らせ、撮った画面を .uitest/screenshots/<名前>.png に書き出す（ADR 0028）。
# Xcode のプロジェクトは project.yml から作り直す。Xcode は DEVELOPER_DIR か xcode-select のものを使う
set -eu
cd "$(dirname "$0")/.."

out=.uitest
rm -rf "$out"
mkdir -p "$out/screenshots"

xcodegen generate --quiet
status=0
xcodebuild test \
  -project Nanaichi.xcodeproj \
  -scheme Nanaichi \
  -destination 'platform=macOS' \
  -resultBundlePath "$out/result.xcresult" \
  -quiet || status=$?

xcrun xcresulttool export attachments --path "$out/result.xcresult" --output-path "$out/attachments" >/dev/null
# 名前は「<テストで付けた名前>_<番号>_<UUID>.png」になるので、付けた名前だけに戻す
# 失敗したときの画面の階層や録画も添付されるので、テストで撮った PNG だけを写す
jq -r '.[].attachments[] | select(.exportedFileName | endswith(".png")) | [.exportedFileName, .suggestedHumanReadableName] | @tsv' "$out/attachments/manifest.json" |
  while IFS="$(printf '\t')" read -r file name; do
    cp "$out/attachments/$file" "$out/screenshots/${name%%_[0-9]*_*}.png"
  done
ls "$out/screenshots"

# -quiet ではどのテストがなぜ落ちたかが出ないので、落ちたら結果から失敗の理由を出す
if [ "$status" != 0 ]; then
  xcrun xcresulttool get test-results tests --path "$out/result.xcresult" |
    jq -r '.. | objects | select(.nodeType? == "Test Case" and .result? == "Failed") | "\(.name): \([.children[]? | select(.nodeType == "Failure Message") | .name] | join(" / "))"' >&2
fi
exit "$status"
