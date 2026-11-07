import { experimental_readRawConfig, unstable_readConfig } from "wrangler";
import { expect, test } from "vite-plus/test";

/**
 * デプロイの設定のうち、miniflare のテストでは確かめられないもの（ADR 0021）。
 */
const config = unstable_readConfig({ config: `${import.meta.dirname}/../../wrangler.jsonc` });

test("nanaichi.app をカスタムドメインにしたまま workers.dev も開いておき、古い URL を転送できる", () => {
  expect(config.routes).toEqual([{ pattern: "nanaichi.app", custom_domain: true }]);
  // wrangler は routes があると workers.dev を既定で止める。止まると転送が届かない
  expect(config.workers_dev).toBe(true);
});

test("プレビューの Worker はバインディングを持たず、本番の D1 と UserDO に届かない", () => {
  const { rawConfig } = experimental_readRawConfig({
    config: `${import.meta.dirname}/../../wrangler.preview.jsonc`,
  });

  // バインディングの種類を列挙すると、新しい種類を見落とす。許可した項目だけを持つことを確かめる
  expect(Object.keys(rawConfig).toSorted()).toEqual([
    "$schema",
    "assets",
    "compatibility_date",
    "main",
    "name",
    "observability",
    "preview_urls",
    "workers_dev",
  ]);
  expect(rawConfig.name).toBe("nanaichi-preview");
  expect(rawConfig.assets).not.toHaveProperty("binding");
});
