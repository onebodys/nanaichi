#!/bin/bash
# デプロイのあとに本番を叩いて、このジョブでビルドしたコードが配られていることを確かめる（Issue #10）。
# CI の deploy ジョブの最後に呼ぶ。確かめるのは次の3つ:
#   1. <SITE_URL>/api/health が 200 と {"status":"ok"} を返す
#   2. <SITE_URL>/ の index.html が参照する assets/index-*.js が、ビルドした index.html と同じ
#   3. workers.dev が 308 で <SITE_URL>/ に転送する（ADR 0021）
# 配信が切り替わるまでの遅れを見込み、3つがそろって通るまで数回やり直してから失敗にする。
# 結果は $GITHUB_STEP_SUMMARY（なければ標準出力）に Markdown の表で出す。
#
# 使い方: scripts/verify-deploy.sh <ビルドした index.html>
# 環境変数で向き先を変えられる。わざと失敗させるときは HEALTH_PATH=/api/does-not-exist などにする
set -u

built_index=${1:?ビルドした index.html のパスを渡してください}
site_url=${SITE_URL:-https://nanaichi.app}
workers_dev_url=${WORKERS_DEV_URL:-https://nanaichi.onori-black1984.workers.dev}
health_path=${HEALTH_PATH:-/api/health}
attempts=${VERIFY_ATTEMPTS:-6}
interval=${VERIFY_INTERVAL_SECONDS:-10}
version_id=${VERSION_ID:-（取得できず）}
summary=${GITHUB_STEP_SUMMARY:-/dev/stdout}

# index.html が参照するエントリの JS（assets/index-<hash>.js）を取り出す
entry_script() {
  grep -o 'assets/index-[A-Za-z0-9_-]*\.js' | head -n 1
}

expected_script=$(entry_script < "$built_index")
if [ -z "$expected_script" ]; then
  echo "::error::$built_index に assets/index-*.js の参照がありません" >&2
  exit 1
fi

# 各検査は結果の説明を $detail に入れ、通れば 0 を返す
check_health() {
  local body status
  body=$(curl -sS --max-time 10 -H 'Cache-Control: no-cache' -w '\n%{http_code}' "$site_url$health_path" 2>&1)
  status=${body##*$'\n'}
  body=${body%$'\n'*}
  detail="HTTP $status, \`$(printf '%s' "$body" | tr -d '\n|' | cut -c1-100)\`"
  [ "$status" = 200 ] && [ "$(printf '%s' "$body" | jq -c . 2>/dev/null)" = '{"status":"ok"}' ]
}

check_assets() {
  local body status served
  body=$(curl -sS --max-time 10 -H 'Cache-Control: no-cache' -w '\n%{http_code}' "$site_url/" 2>/dev/null)
  status=${body##*$'\n'}
  # エラーの応答の本文に古い参照が残っていても、通ったことにしない
  served=$([ "$status" = 200 ] && printf '%s' "${body%$'\n'*}" | entry_script)
  detail="HTTP $status, 配信: \`${served:-（見つからず）}\` / ビルド: \`$expected_script\`"
  [ "$status" = 200 ] && [ "$served" = "$expected_script" ]
}

check_redirect() {
  local result status location
  result=$(curl -sS --max-time 10 -o /dev/null -w '%{http_code} %{redirect_url}' "$workers_dev_url/" 2>/dev/null)
  status=${result%% *}
  location=${result#* }
  detail="HTTP $status → \`${location:-（転送先なし）}\`"
  [ "$status" = 308 ] && [ "$location" = "$site_url/" ]
}

names=(health assets redirect)
labels=("\`$site_url$health_path\` が 200 と {\"status\":\"ok\"}" "\`$site_url/\` の index.html の JS がビルドと同じ" "workers.dev が 308 で \`$site_url/\` に転送")
results=()
details=()

for attempt in $(seq 1 "$attempts"); do
  failed=0
  for i in "${!names[@]}"; do
    if "check_${names[$i]}"; then results[i]=✅; else results[i]=❌; failed=1; fi
    details[i]=$detail
  done
  [ "$failed" = 0 ] && break
  echo "本番の確認に失敗（$attempt/$attempts 回目）: health=${details[0]} / assets=${details[1]} / redirect=${details[2]}" >&2
  [ "$attempt" -lt "$attempts" ] && sleep "$interval"
done

{
  echo "## 本番の確認"
  echo
  echo "- Version ID: \`$version_id\`"
  echo "- 試行: $attempt/$attempts 回目で$([ "$failed" = 0 ] && echo 成功 || echo 失敗)"
  echo
  echo "| | 確かめたこと | 結果 |"
  echo "|---|---|---|"
  for i in "${!names[@]}"; do
    echo "| ${results[i]} | ${labels[i]} | ${details[i]} |"
  done
} >> "$summary"

if [ "$failed" != 0 ]; then
  echo "::error title=本番の確認に失敗::$attempts 回試しても、本番が新しいコードを配っていることを確かめられませんでした" >&2
  exit 1
fi
