import { Hono } from "hono";

export const app = new Hono<{ Bindings: Env }>().basePath("/api");

app.get("/health", (c) => c.json({ status: "ok" }));
