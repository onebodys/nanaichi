import { defineConfig } from "vite-plus";

/** 自前の Oxlint のプラグイン（nanaichi-plugin.ts）のルールを、RuleTester で確かめる */
export default defineConfig({
  test: {
    name: "lint",
    include: ["*.test.ts"],
  },
});
