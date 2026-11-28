import { defineConfig } from "vite-plus";

/** リポジトリの検査スクリプト（check-*.sh）を、本文やファイルを与えて走らせて確かめる */
export default defineConfig({
  test: {
    name: "scripts",
    include: ["*.test.ts"],
  },
});
