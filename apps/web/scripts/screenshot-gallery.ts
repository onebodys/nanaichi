import { readdir, readFile, writeFile } from "node:fs/promises";

/**
 * tests/screenshots.e2e.ts が撮った画面を、画像を埋め込んだ1枚の HTML にまとめる（docs/E2E.md「スクリーンショットを残す」）。
 * zip にしない artifact は1ファイルしか上げられないので、画像も HTML の中に入れる。
 * 引数で、ほかのディレクトリの画面（Mac アプリの XCUITest、apps/apple/scripts/ui-test.sh）もまとめられる。
 */
const [
  SCREENSHOT_DIR = ".e2e/screenshots",
  OUTPUT = ".e2e/screenshots.html",
  TITLE = "nanaichi の画面",
] = process.argv.slice(2);

const files = (await readdir(SCREENSHOT_DIR)).filter((file) => file.endsWith(".png")).toSorted();

const figures = await Promise.all(
  files.map(async (file) => {
    const image = await readFile(`${SCREENSHOT_DIR}/${file}`, "base64");
    const caption = file.replace(/^\d+-/, "").replace(/\.png$/, "");
    return `<figure><figcaption>${caption}</figcaption><img src="data:image/png;base64,${image}" alt="${caption}"></figure>`;
  }),
);

await writeFile(
  OUTPUT,
  `<!doctype html>
<html lang="ja">
<meta charset="utf-8">
<title>${TITLE}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 16px; background: #f4f4f5; color: #18181b; }
  main { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
  figure { margin: 0; max-width: 100%; }
  figcaption { font-weight: 600; margin-bottom: 4px; }
  img { display: block; max-width: 100%; max-height: 90vh; border: 1px solid #d4d4d8; }
</style>
<h1>${TITLE}</h1>
<main>${figures.join("\n")}</main>
</html>
`,
);
