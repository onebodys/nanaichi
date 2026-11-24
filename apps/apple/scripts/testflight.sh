#!/bin/sh
# iPhone のアプリ（Watch のアプリを同梱）をアーカイブし、App Store Connect に上げて TestFlight で入れられるようにする（ADR 0032）。
#
#   ASC_ISSUER_ID=<Issuer ID> sh scripts/testflight.sh
#
# App Store Connect の API キーの .p8 は ~/.appstoreconnect/private_keys/AuthKey_<Key ID>.p8 に置く（リポジトリには入れない）。
# Key ID はそのファイル名から読む。キーが複数あるときは ASC_KEY_ID で選ぶ。
# Issuer ID は ASC_ISSUER_ID か、~/.appstoreconnect/issuer_id（中身が Issuer ID だけのファイル）から読む。
# ビルド番号は上げた時刻（UTC、yyyyMMddHHmm）にする。上げるたびに増え、同じコミットから上げ直しても重ならない。
# BUILD_NUMBER で上書きできる。
# 上げたあと、App Store Connect の処理が終わるまで待つ。終わったら iPhone の TestFlight アプリから入れられる。
# Xcode は DEVELOPER_DIR か xcode-select のものを使う。署名は project.yml の Release の設定（チームの自動署名）
set -eu
cd "$(dirname "$0")/.."

keys_dir="$HOME/.appstoreconnect/private_keys"
if [ -z "${ASC_KEY_ID:-}" ]; then
  # ls の出力ではなく glob で探す（キーのファイル名は英数字だけ）
  set -- "$keys_dir"/AuthKey_*.p8
  if [ "$#" != 1 ] || [ ! -f "$1" ]; then
    echo "API キーが $keys_dir に1つだけ置かれていません。複数あるなら ASC_KEY_ID で選ぶ" >&2
    exit 1
  fi
  ASC_KEY_ID=$(basename "$1" .p8)
  ASC_KEY_ID=${ASC_KEY_ID#AuthKey_}
fi
key_path="$keys_dir/AuthKey_$ASC_KEY_ID.p8"
if [ ! -f "$key_path" ]; then
  echo "$key_path がありません" >&2
  exit 1
fi
if [ -z "${ASC_ISSUER_ID:-}" ] && [ -f "$HOME/.appstoreconnect/issuer_id" ]; then
  ASC_ISSUER_ID=$(tr -d '[:space:]' <"$HOME/.appstoreconnect/issuer_id")
fi
if [ -z "${ASC_ISSUER_ID:-}" ]; then
  echo "Issuer ID がありません。ASC_ISSUER_ID か ~/.appstoreconnect/issuer_id に置く" >&2
  exit 1
fi

build=${BUILD_NUMBER:-$(date -u +%Y%m%d%H%M)}
out=.testflight
rm -rf "$out"
mkdir -p "$out"
echo "ビルド $build をアーカイブする"

xcodegen generate --quiet
# -allowProvisioningUpdates と API キーで、証明書とプロビジョニングプロファイルを Xcode に作らせる（Xcode にログインしなくてよい）
xcodebuild archive \
  -project Nanaichi.xcodeproj \
  -scheme NanaichiPhone \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$out/nanaichi.xcarchive" \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$key_path" \
  -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID" \
  CURRENT_PROJECT_VERSION="$build" \
  -quiet

# App Store Connect 向けに書き出す。チームは project.yml の Release の設定（アーカイブに残る）から決まる
cat >"$out/ExportOptions.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>app-store-connect</string>
	<key>destination</key>
	<string>export</string>
	<key>signingStyle</key>
	<string>automatic</string>
	<key>manageAppVersionAndBuildNumber</key>
	<false/>
	<key>uploadSymbols</key>
	<true/>
</dict>
</plist>
PLIST
xcodebuild -exportArchive \
  -archivePath "$out/nanaichi.xcarchive" \
  -exportPath "$out/export" \
  -exportOptionsPlist "$out/ExportOptions.plist" \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$key_path" \
  -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID" \
  -quiet

set -- "$out"/export/*.ipa
echo "$1 を App Store Connect に上げる"
xcrun altool --upload-app --type ios --file "$1" \
  --api-key "$ASC_KEY_ID" --api-issuer "$ASC_ISSUER_ID" \
  --output-format json >"$out/upload.json"
delivery=$(jq -r '.["delivery-uuid"] // .["Delivery UUID"] // empty' "$out/upload.json")
if [ -z "$delivery" ]; then
  echo "上げた結果から delivery ID を読めませんでした（$out/upload.json）" >&2
  cat "$out/upload.json" >&2
  exit 1
fi

echo "App Store Connect の処理を待つ（delivery $delivery）"
xcrun altool --build-status --delivery-id "$delivery" --wait \
  --api-key "$ASC_KEY_ID" --api-issuer "$ASC_ISSUER_ID"
echo "ビルド $build を上げました。iPhone の TestFlight アプリから入れられます"
