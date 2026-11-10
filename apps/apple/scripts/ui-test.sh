#!/bin/sh
# Mac アプリの XCUITest を走らせ、撮った画面を .uitest/screenshots/<名前>.png に書き出す（ADR 0028）。
# Xcode のプロジェクトは project.yml から作り直す。Xcode は DEVELOPER_DIR か xcode-select のものを使う
set -eu
cd "$(dirname "$0")/.."

out=.uitest
rm -rf "$out"
mkdir -p "$out/screenshots"

xcodegen generate --quiet
xcodebuild test \
  -project Nanaichi.xcodeproj \
  -scheme Nanaichi \
  -destination 'platform=macOS' \
  -resultBundlePath "$out/result.xcresult" \
  -quiet

xcrun xcresulttool export attachments --path "$out/result.xcresult" --output-path "$out/attachments" >/dev/null
# 名前は「<テストで付けた名前>_<番号>_<UUID>.png」になるので、付けた名前だけに戻す
jq -r '.[].attachments[] | [.exportedFileName, .suggestedHumanReadableName] | @tsv' "$out/attachments/manifest.json" |
  while IFS="$(printf '\t')" read -r file name; do
    cp "$out/attachments/$file" "$out/screenshots/${name%%_[0-9]*_*}.png"
  done
ls "$out/screenshots"
