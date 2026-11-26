# iPhone と Watch は TestFlight の内部テストで入れ、アーカイブだけチームで署名して手元のスクリプトから上げる

ADR 0031 は、iPhone と Watch の配布の方法を後回しにしていた。Watch の振動（#73）のように、シミュレーターで確かめられないことを実機で確かめるため、オーナーの iPhone と Watch に入れる道を決める（Issue #109）。App Store への公開ではない。

## TestFlight の内部テストで入れる

- オーナーは Apple Developer Program（個人、チーム ID `SBJFQKQZVC`）に登録した（2026-11-24）。
- iPhone のアプリ（Watch のアプリを同梱）を App Store Connect に上げ、TestFlight の内部テストで、オーナーの iPhone の TestFlight アプリから入れる。iPhone のアプリを入れると、ペアの Watch にも Watch のアプリが入る。
- Xcode から実機の Watch に直接入れる道は、いまは使えない。Xcode 27 + watchOS 27.2 では、実機の Watch を Device Hub でペアリングしても Mac につながらない（https://developer.apple.com/forums/thread/848740 、FB24924229）。TestFlight なら Xcode と Watch のペアリングが要らない。
- 配るのはオーナーだけ（内部テスト）。外部テスター、App Store の審査、Sign in with Apple・Universal Links は、App Store に出すときに決める（ADR 0028）。

## アーカイブ（Release）だけチームで自動署名する

- `apps/apple/project.yml` の iPhone と Watch のアプリに、Release の設定だけ `DEVELOPMENT_TEAM: SBJFQKQZVC` と自動署名（`CODE_SIGN_STYLE: Automatic`）を書く。Release でビルドするのはアーカイブのときだけである。
- Debug（シミュレーターのビルドと XCUITest、CI の `apple-ui`）は、これまでどおりチームのないローカルの署名のままにする。CI の macOS のランナーにはチームの証明書がなく、署名を要らないままにしておけば、鍵を CI に渡さずに済む。
- Mac のアプリは変えない（ADR 0028 のローカルの署名）。
- チーム ID は秘密ではないのでリポジトリに書く。App Store Connect の API キー（`.p8`）、Key ID、Issuer ID はリポジトリに入れない。

## 手元のスクリプト1つで上げる

- `apps/apple/scripts/testflight.sh` が、XcodeGen でプロジェクトを作り直し、アーカイブし、App Store Connect 向けに書き出し、`altool` で上げ、App Store Connect の処理が終わるまで待つ。
- 認証は App Store Connect の API キー（App Manager）で行う。`.p8` は `~/.appstoreconnect/private_keys/AuthKey_<Key ID>.p8`（`altool` が探す場所）に置き、Key ID はファイル名から読む。Issuer ID は環境変数 `ASC_ISSUER_ID` か `~/.appstoreconnect/issuer_id` から読む。Xcode にアカウントでログインしなくてよい。
- アーカイブは `-allowProvisioningUpdates` で、開発用のプロファイルを Xcode に API キーで作らせる。
- 書き出し（App Store 向けの署名）は手動の署名にする。Xcode の自動署名は、API キーで認証するとクラウド管理の配布用の証明書しか探さず、App Manager のキーはそれを使えない（`You haven't been given access to cloud-managed distribution certificates`）。そこで、この Mac のキーチェーンに Apple Distribution の証明書を置き、App Store 向けのプロファイルはスクリプトが App Store Connect API で用意する（なければ作る。Watch のバンドル ID が未登録なら登録する）。
- ビルド番号（`CFBundleVersion`）は上げた時刻（UTC の `yyyyMMddHHmm`）にする。上げるたびに増え、同じコミットから上げ直しても重ならない。git のコミット数は、同じコミットから上げ直すと重なるので使わない。iPhone と Watch のアプリは同じ番号になる。
- CI からは上げない。上げるのはオーナーが実機で確かめたいときだけで、頻度が低い。CI で上げるには、配布用の証明書の鍵と API キーを secrets に置くことになる。

## 輸出規制の宣言

- Info.plist に `ITSAppUsesNonExemptEncryption = NO` を入れ、上げるたびに輸出規制の質問に答えずに済むようにする。
- アプリが使う暗号は、OS の URLSession の HTTPS・WSS、ログインの PKCE の SHA256（ハッシュ）、OS の Keychain だけで、独自の暗号の実装も暗号のライブラリもない（GRDB は SQLCipher なしで使う）。これは免除の範囲である。暗号を足すときは、この宣言を見直す。

## Consequences

- 実機の iPhone と Watch で確かめられるのは、TestFlight に上げたビルドだけになる。デバッグのビルドにある起動の環境変数（`NANAICHI_TIME_SCALE` など）は使えない。
- 上げるには、この Mac に API キーと配布用の証明書（の秘密鍵）が要る。別の Mac から上げるときは、どちらも用意し直す。証明書は1年で切れるので、作り直してプロファイルも作り直す。
- CI はチームの署名を確かめない。Release の署名の設定が壊れても、気づくのはスクリプトを走らせたときになる。
- App Store Connect に上げるにはアプリのアイコンが要るので、iPhone と Watch のアプリにアイコン（Web の maskable のアイコンを 1024px にしたもの）を入れた。

## Considered Options

- **Xcode から実機に直接入れる（開発用の署名）**: TestFlight の処理を待たずに入る。しかし Watch は上の不具合で Mac につながらず、Watch の振動を確かめるという目的を果たせない。
- **API キーを Admin にして、クラウド管理の配布用の証明書で自動署名する**: 手元に配布用の証明書の鍵を置かずに済む。しかし API キーにチームのすべての権限を持たせることになる。
- **CI から上げる**: 手元の Mac に依存しない。しかし配布用の証明書の鍵と API キーを CI に置くことになり、上げる頻度に見合わない。
- **すべての設定でチームの署名にする**: 設定は単純になる。しかし CI のシミュレーターのビルドにもチームの証明書が要るか、署名を外す上書きが要る。
- **ビルド番号を project.yml に書いて手で増やす**: 上げるたびにコミットが要り、上げ忘れや重なりが起きる。
