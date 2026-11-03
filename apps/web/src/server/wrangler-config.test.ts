import { unstable_readConfig } from "wrangler";
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
