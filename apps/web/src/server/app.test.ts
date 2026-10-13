import { describe, expect, test } from "vite-plus/test";
import { app } from "./app.ts";

describe("GET /api/health", () => {
  test("Worker が起動していれば status: ok を返す", async () => {
    const res = await app.request("/api/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
