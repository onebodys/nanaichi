import { expect, test } from "vite-plus/test";
import previewWorker from "./preview-worker.ts";

const ORIGIN = "https://pr-1-nanaichi-preview.example.workers.dev";

test("プレビューではセッションの確認に未ログインと答え、記録先がこの端末になる", async () => {
  const res = previewWorker.fetch(new Request(`${ORIGIN}/api/auth/get-session`));

  expect(res.status).toBe(200);
  await expect(res.json()).resolves.toBeNull();
});

test.each(["/api/me", "/api/session/current", "/api/auth/sign-in/social", "/api/test/sign-in"])(
  "プレビューには %s がなく 404 を返す",
  (path) => {
    expect(previewWorker.fetch(new Request(`${ORIGIN}${path}`)).status).toBe(404);
  },
);
