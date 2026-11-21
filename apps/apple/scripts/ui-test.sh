#!/bin/sh
# Apple のアプリの XCUITest を走らせ、撮った画面を書き出す（ADR 0028、ADR 0031）。
#
#   sh scripts/ui-test.sh          Mac のアプリ。.uitest/screenshots/<名前>.png に書き出す
#   sh scripts/ui-test.sh iphone   iPhone のアプリを iOS のシミュレーターで。.uitest-iphone/screenshots/<名前>.png に書き出す
#
# Xcode のプロジェクトは project.yml から作り直す。Xcode は DEVELOPER_DIR か xcode-select のものを使う。
# iPhone のシミュレーターは IPHONE_SIMULATOR（名前）で選べる。なければ入っている iPhone のうち、いちばん新しい OS のもの
set -eu
cd "$(dirname "$0")/.."

platform=${1:-mac}
case "$platform" in
  mac)
    out=.uitest
    scheme=Nanaichi
    destination='platform=macOS'
    ;;
  iphone)
    out=.uitest-iphone
    scheme=NanaichiPhone
    # 名前が IPHONE_SIMULATOR に合う（なければ名前が iPhone で始まる）もののうち、いちばん新しい OS のもの
    udid=$(xcrun simctl list devices available --json |
      jq -r --arg name "${IPHONE_SIMULATOR:-}" '[.devices | to_entries[]
        | (.key | capture("iOS-(?<major>[0-9]+)-(?<minor>[0-9]+)") | [(.major | tonumber), (.minor | tonumber)]) as $version
        | .value[] | select(if $name == "" then (.name | startswith("iPhone")) else .name == $name end)
        | {version: $version, udid}] | sort_by(.version) | last | .udid // empty')
    if [ -z "$udid" ]; then
      echo "iPhone のシミュレーターがありません（xcodebuild -downloadPlatform iOS で入れる）" >&2
      exit 1
    fi
    xcrun simctl boot "$udid" 2>/dev/null || true
    xcrun simctl bootstatus "$udid" >/dev/null
    # 新しいシミュレーターは英語のキーボードを初めて出すときに「なぞって入力」の説明を重ね、その間アプリの画面の
    # 要素を読めなくなる（CI でテストが止まった）。説明はもう見たことにしておく
    xcrun simctl spawn "$udid" defaults write com.apple.keyboard.preferences DidShowContinuousPathIntroduction -bool true
    destination="platform=iOS Simulator,id=$udid"
    ;;
  *)
    echo "使い方: sh scripts/ui-test.sh [mac|iphone]" >&2
    exit 2
    ;;
esac
echo "$scheme を $destination で確かめる"

rm -rf "$out"
mkdir -p "$out/screenshots"

xcodegen generate --quiet
status=0
xcodebuild test \
  -project Nanaichi.xcodeproj \
  -scheme "$scheme" \
  -destination "$destination" \
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
