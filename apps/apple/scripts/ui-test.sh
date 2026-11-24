#!/bin/sh
# Apple のアプリの XCUITest を走らせ、撮った画面を書き出す（ADR 0028、ADR 0031）。
#
#   sh scripts/ui-test.sh          Mac のアプリ。.uitest/screenshots/<名前>.png に書き出す
#   sh scripts/ui-test.sh iphone   iPhone のアプリを iOS のシミュレーターで。.uitest-iphone/screenshots/<名前>.png に書き出す
#   sh scripts/ui-test.sh watch    Watch のアプリを watchOS のシミュレーターで。.uitest-watch/screenshots/<名前>.png に書き出す
#
# 2つ目の引数で流すテストを絞れる。3つ目の引数で、そのテストを続けて流す回数を選べる（1回でも落ちればそこで止めて失敗にする）
#
#   sh scripts/ui-test.sh iphone PhoneTimerTests/testOneRoundOnTheDeviceRecordStore   その1つのテストだけ
#   sh scripts/ui-test.sh mac TimerTests                                              そのクラスのテストだけ
#   sh scripts/ui-test.sh watch WatchTimerTests/testPhoneUnreachable 5                続けて5回
#
# 手元では関係するテストだけを流し、全部は CI（PR の ui-test のラベル）で確かめる（docs/E2E.md）。
# シミュレーターは、このスクリプトが起動したものだけを、通っても落ちても終わったあとに止める。前から起動していたものは止めない
#
# Xcode のプロジェクトは project.yml から作り直す。Xcode は DEVELOPER_DIR か xcode-select のものを使う。
# iPhone のシミュレーターは IPHONE_SIMULATOR（名前）で選べる。なければ入っている iPhone のうち、いちばん新しい OS のもの。
# Watch のシミュレーターも同じく WATCH_SIMULATOR で選べ、なければ名前が Apple Watch で始まるもののうち、いちばん新しい OS のもの
set -eu
cd "$(dirname "$0")/.."

usage() {
  echo "使い方: sh scripts/ui-test.sh [mac|iphone|watch] [<クラス>[/<メソッド>]] [<回数>]" >&2
  exit 2
}

platform=${1:-mac}
only=${2:-}
iterations=${3:-1}
case "$iterations" in
  '' | *[!0-9]* | 0) usage ;;
esac
if [ "$iterations" != 1 ] && [ -z "$only" ]; then
  echo "回数を選ぶときは流すテストも選ぶ" >&2
  usage
fi

# このスクリプトが起動したシミュレーター（起動している途中のものを含む）。終わったら（通っても落ちても、止められても）止める
booted=
cleanup() {
  if [ -n "$booted" ]; then
    xcrun simctl shutdown "$booted" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# シミュレーターを起動する。前から起動していたものは simctl boot が断るので、終わっても止めない。
# 状態を読んでから起動すると、その間に別の作業が起動したものまで止めてしまうので、simctl boot の結果で決める。
# 起動している途中で止められたときも止めるように、起動する前から記録しておき、断られたら消す
boot() {
  booted=$1
  xcrun simctl boot "$1" 2>/dev/null || booted=
  xcrun simctl bootstatus "$1" >/dev/null
}

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
    boot "$udid"
    # 新しいシミュレーターは英語のキーボードを初めて出すときに「なぞって入力」の説明を重ね、その間アプリの画面の
    # 要素を読めなくなる（CI でテストが止まった）。説明はもう見たことにしておく
    xcrun simctl spawn "$udid" defaults write com.apple.keyboard.preferences DidShowContinuousPathIntroduction -bool true
    destination="platform=iOS Simulator,id=$udid"
    ;;
  watch)
    out=.uitest-watch
    scheme=NanaichiWatch
    udid=$(xcrun simctl list devices available --json |
      jq -r --arg name "${WATCH_SIMULATOR:-}" '[.devices | to_entries[]
        | (.key | capture("watchOS-(?<major>[0-9]+)-(?<minor>[0-9]+)") | [(.major | tonumber), (.minor | tonumber)]) as $version
        | .value[] | select(if $name == "" then (.name | startswith("Apple Watch")) else .name == $name end)
        | {version: $version, udid}] | sort_by(.version) | last | .udid // empty')
    if [ -z "$udid" ]; then
      echo "Watch のシミュレーターがありません（xcodebuild -downloadPlatform watchOS で入れる）" >&2
      exit 1
    fi
    boot "$udid"
    destination="platform=watchOS Simulator,id=$udid"
    ;;
  *) usage ;;
esac
echo "$scheme を $destination で確かめる${only:+（$only を $iterations 回）}"

# 流すテストを絞るときは、テストのターゲット（スキームの test の targets）の中のクラスかメソッドを選ぶ
set --
if [ -n "$only" ]; then
  set -- "-only-testing:${scheme}UITests/$only"
fi
if [ "$iterations" != 1 ]; then
  set -- "$@" -test-iterations "$iterations" -run-tests-until-failure
fi

rm -rf "$out"
mkdir -p "$out/screenshots"

xcodegen generate --quiet
status=0
xcodebuild test \
  -project Nanaichi.xcodeproj \
  -scheme "$scheme" \
  -destination "$destination" \
  -resultBundlePath "$out/result.xcresult" \
  "$@" \
  -quiet || status=$?

# 名前を書き違えて1つも合わないと、xcodebuild はテストを流さずに通ってしまうので、落とす
if [ -n "$only" ] && [ "$status" = 0 ] &&
  [ "$(xcrun xcresulttool get test-results summary --path "$out/result.xcresult" | jq .totalTestCount)" = 0 ]; then
  echo "${scheme}UITests/$only に合うテストがない" >&2
  exit 1
fi

xcrun xcresulttool export attachments --path "$out/result.xcresult" --output-path "$out/attachments" >/dev/null
# 名前は「<テストで付けた名前>_<番号>_<UUID>.png」になるので、付けた名前だけに戻す
# 失敗したときの画面の階層や録画も添付されるので、テストで撮った PNG だけを写す
jq -r '.[].attachments[] | select(.exportedFileName | endswith(".png")) | [.exportedFileName, .suggestedHumanReadableName] | @tsv' "$out/attachments/manifest.json" |
  while IFS="$(printf '\t')" read -r file name; do
    cp "$out/attachments/$file" "$out/screenshots/${name%%_[0-9]*_*}.png"
  done
ls "$out/screenshots"

# -quiet ではどのテストがなぜ落ちたかが出ないので、落ちたら結果から失敗の理由を出す
# 回数を選んだときは、理由がテストの下の回（Repetition）の下に付く
if [ "$status" != 0 ]; then
  xcrun xcresulttool get test-results tests --path "$out/result.xcresult" |
    jq -r '.. | objects | select(.nodeType? == "Test Case" and .result? == "Failed") | "\(.name): \([.. | objects | select(.nodeType? == "Failure Message") | .name] | join(" / "))"' >&2
fi
exit "$status"
