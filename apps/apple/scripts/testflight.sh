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
# Xcode は DEVELOPER_DIR か xcode-select のものを使う。アーカイブは project.yml の Release の設定（チームの自動署名）で、
# 書き出しはこの Mac のキーチェーンの Apple Distribution の証明書で署名する（docs/SETUP.md の6章）
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
# -allowProvisioningUpdates と API キーで、開発用のプロビジョニングプロファイルを Xcode に作らせる（Xcode にログインしなくてよい）
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

# App Store 向けのプロビジョニングプロファイルを API で用意する。Xcode の自動署名は、API キーで認証すると
# クラウド管理の配布用の証明書しか探さず、App Manager のキーはそれを使えない（ADR 0032）。そのため書き出しは、
# このキーチェーンにある Apple Distribution の証明書と、ここで用意したプロファイルで手動で署名する
api=https://api.appstoreconnect.apple.com/v1
jwt=$(xcrun altool --generate-jwt --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID" 2>&1 | grep -oE 'eyJ[A-Za-z0-9._-]+' | head -1)
if [ -z "$jwt" ]; then
  echo "API キーから JWT を作れませんでした" >&2
  exit 1
fi
asc() {
  curl -sS --fail-with-body -H "Authorization: Bearer $jwt" -H 'Content-Type: application/json' "$@"
}
profiles_dir="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
mkdir -p "$profiles_dir"
# App Store 向けのプロファイルに入れる配布用の証明書は1枚。チームの証明書のうち、このキーチェーンに秘密鍵のある
# （署名に使える）ものを、SHA-1 のフィンガープリントで選ぶ
identities=$(security find-identity -v -p codesigning)
certificate=""
for entry in $(asc "$api/certificates?filter%5BcertificateType%5D=DISTRIBUTION&limit=200" |
  jq -r '.data | sort_by(.attributes.expirationDate) | reverse | .[] | "\(.id):\(.attributes.certificateContent)"'); do
  fingerprint=$(printf '%s' "${entry#*:}" | base64 -d | shasum -a 1 | cut -d' ' -f1 | tr '[:lower:]' '[:upper:]')
  if printf '%s' "$identities" | grep -q "$fingerprint"; then
    certificate=${entry%%:*}
    break
  fi
done
if [ -z "$certificate" ]; then
  echo "このキーチェーンに、チームの Apple Distribution の証明書（と秘密鍵）がありません（docs/SETUP.md の6章）" >&2
  exit 1
fi
profile_entries=""
for bundle in app.nanaichi.ios app.nanaichi.ios.watchkitapp; do
  name="nanaichi App Store $bundle"
  profile=$(asc "$api/profiles?filter%5Bname%5D=$(printf '%s' "$name" | jq -sRr @uri)&filter%5BprofileState%5D=ACTIVE" |
    jq -r --arg name "$name" '[.data[] | select(.attributes.name == $name)] | first | .attributes.profileContent // empty')
  if [ -z "$profile" ]; then
    echo "$bundle の App Store 向けのプロファイルを作る"
    bundle_id=$(asc "$api/bundleIds?filter%5Bidentifier%5D=$bundle" |
      jq -r --arg bundle "$bundle" '[.data[] | select(.attributes.identifier == $bundle)] | first | .id // empty')
    if [ -z "$bundle_id" ]; then
      # Watch のアプリの ID は、開発用の署名ではワイルドカードで済むので、App Store 向けに初めて上げるときに登録する
      echo "バンドル ID $bundle を登録する"
      bundle_id=$(jq -n --arg bundle "$bundle" '{data: {type: "bundleIds", attributes: {identifier: $bundle, name: "nanaichi", platform: "IOS"}}}' |
        asc -X POST --data @- "$api/bundleIds" | jq -r .data.id)
    fi
    profile=$(jq -n --arg name "$name" --arg bundle_id "$bundle_id" --arg certificate "$certificate" \
      '{data: {type: "profiles", attributes: {name: $name, profileType: "IOS_APP_STORE"},
        relationships: {bundleId: {data: {type: "bundleIds", id: $bundle_id}},
          certificates: {data: [{type: "certificates", id: $certificate}]}}}}' |
      asc -X POST --data @- "$api/profiles" | jq -r .data.attributes.profileContent)
  fi
  printf '%s' "$profile" | base64 -d >"$out/profile.mobileprovision"
  uuid=$(security cms -D -i "$out/profile.mobileprovision" | plutil -extract UUID raw -)
  mv "$out/profile.mobileprovision" "$profiles_dir/$uuid.mobileprovision"
  profile_entries="$profile_entries		<key>$bundle</key>
		<string>$name</string>
"
done

# App Store Connect 向けに書き出す
cat >"$out/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>app-store-connect</string>
	<key>destination</key>
	<string>export</string>
	<key>signingStyle</key>
	<string>manual</string>
	<key>signingCertificate</key>
	<string>Apple Distribution</string>
	<key>teamID</key>
	<string>SBJFQKQZVC</string>
	<key>provisioningProfiles</key>
	<dict>
$profile_entries	</dict>
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
  -quiet

set -- "$out"/export/*.ipa
echo "$1 を App Store Connect に上げる"
xcrun altool --upload-app --type ios --file "$1" \
  --api-key "$ASC_KEY_ID" --api-issuer "$ASC_ISSUER_ID" \
  --output-format json >"$out/upload.json"
delivery=$(jq -r '.details["delivery-uuid"] // empty' "$out/upload.json")
if [ -z "$delivery" ]; then
  echo "上げた結果から delivery ID を読めませんでした（$out/upload.json）" >&2
  cat "$out/upload.json" >&2
  exit 1
fi

echo "App Store Connect の処理を待つ（delivery ${delivery}）"
xcrun altool --build-status --delivery-id "$delivery" --wait \
  --api-key "$ASC_KEY_ID" --api-issuer "$ASC_ISSUER_ID"
echo "ビルド $build を上げました。iPhone の TestFlight アプリから入れられます"
