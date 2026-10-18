import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router.tsx";
import { followTheme } from "./theme.ts";
import "./index.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("#root が index.html に存在しない");
}

// 明るさの好みを選べるようになるまでは、端末の設定に合わせる
followTheme("System");

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
