/**
 * Bot UI プレビュー生成のエントリポイント。
 *
 *   bun run preview
 *
 * 実際の UI 生成関数（embedBuilder / statusMessage / buttonBuilder）が
 * 組み立てたペイロードを Discord 風に描画し、`.preview/` 配下へ
 * 各状態の PNG・ペイロード JSON・ギャラリー(index.md) を出力する。
 *
 * Claude はこの PNG を読んでデザインを視認し、UI 関数を refine できる。
 */

import { mkdir, rename } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { buildFixtures } from "./fixtures";
import { FONT_PATH, FONT_URL, OUT_DIR, PROJECT_ROOT } from "./paths";
import { type IRenderResult, renderFixtures } from "./render";

const MIN_FONT_BYTES = 50_000; // 正常な woff は ~1.4MB。これ未満は破損/切り詰めとみなす

async function ensureFont(): Promise<void> {
  const file = Bun.file(FONT_PATH);
  if ((await file.exists()) && file.size > MIN_FONT_BYTES) return;

  console.log("CJK フォント未取得/破損。ダウンロードします...");
  const res = await fetch(FONT_URL);
  if (!res.ok) throw new Error(`font download failed: ${res.status}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength < MIN_FONT_BYTES) {
    throw new Error(`font download too small: ${buf.byteLength} bytes`);
  }
  await mkdir(dirname(FONT_PATH), { recursive: true });
  // 一時ファイルへ書いてから rename（原子的に差し替え。中断/並行での破損を防ぐ）
  const tmp = `${FONT_PATH}.tmp-${process.pid}`;
  await Bun.write(tmp, buf);
  await rename(tmp, FONT_PATH);
}

async function writeGallery(
  fixtures: ReturnType<typeof buildFixtures>,
  results: IRenderResult[],
): Promise<void> {
  const lines: string[] = [
    "# Bot UI プレビュー",
    "",
    "`bun run preview` が自動生成。実際の UI 生成関数の出力を Discord 風に描画したもの。",
    "",
  ];
  for (const fx of fixtures) {
    const r = results.find((x) => x.id === fx.id && x.ok);
    if (!r) continue;
    const rel = relative(OUT_DIR, r.pngPath);
    lines.push(`## ${fx.title}`, "", `> ${fx.note}`, "", `![${fx.id}](${rel})`, "");
  }
  await Bun.write(join(OUT_DIR, "index.md"), lines.join("\n"));
}

async function main(): Promise<void> {
  await ensureFont();
  await mkdir(OUT_DIR, { recursive: true });

  const fixtures = buildFixtures();

  // ペイロード JSON を保存（構造の差分レビュー・回帰用）
  for (const fx of fixtures) {
    await Bun.write(
      join(OUT_DIR, `${fx.id}.payload.json`),
      `${JSON.stringify(fx.messages, null, 2)}\n`,
    );
  }

  console.log(`描画対象: ${fixtures.length} 状態`);
  const results = await renderFixtures(fixtures, OUT_DIR);
  await writeGallery(fixtures, results);

  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  console.log("\n生成物:");
  for (const r of ok) {
    console.log(`  ${relative(PROJECT_ROOT, r.pngPath)}`);
  }
  console.log(`\nギャラリー: ${relative(PROJECT_ROOT, join(OUT_DIR, "index.md"))}`);

  if (failed.length > 0) {
    console.error(`\n失敗 ${failed.length} 件:`);
    for (const r of failed) {
      console.error(`  ${r.id}: ${r.error}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
