import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, lazyPlugins } from "vite-plus";

// lint / fmt の設定はルートの vite.config.ts に集約している（Vite+ の monorepo の仕様）。
export default defineConfig({
  plugins: lazyPlugins(() => [cloudflare(), react(), tailwindcss()]),
});
