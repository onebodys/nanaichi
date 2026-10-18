import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router.tsx";
import { registerServiceWorker } from "./phase-notification.ts";
import { startTheme } from "./theme.ts";
import "./index.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("#root が index.html に存在しない");
}

// 端末に覚えた明るさの好み（設定画面で選ぶ）を当てる
startTheme();

// フェーズの切り替わりの通知を Service Worker から出せるようにする（phase-notification.ts）
registerServiceWorker();

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
