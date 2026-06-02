/**
 * fixture のメッセージ群を Chromium 上で Discord 風に描画し PNG 化する。
 *
 * フロー:
 *   1. @skyra/discord-components-core を Bun でブラウザ向けに 1 回だけバンドル
 *   2. Playwright で Chromium を起動
 *   3. fixture ごとに新規ページ: マークアップ設定 → バンドル注入 →
 *      カスタム要素の定義待ち → フォント/画像ロード待ち → 要素をスクショ
 *
 * 1 件の fixture が失敗しても run 全体は止めず、結果に error を載せて続行する。
 */

import { join } from "node:path";
import { chromium } from "playwright";
import type { IFixture } from "./fixtures";
import { FONT_PATH, PREVIEW_DIR } from "./paths";
import { messagesToMarkup } from "./payloadToMarkup";

function pageHtml(markup: string, fontBase64: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{
  font-family:'gg sans';
  src:url(data:font/woff;base64,${fontBase64}) format('woff');
  font-weight:100 900;font-display:block;
}
html,body{margin:0;background:#1e1f22;}
body{padding:24px;display:inline-block;}
discord-messages{display:block;width:560px;border-radius:8px;overflow:hidden;}
.dq-ts{background:rgba(88,101,242,0.3);border-radius:3px;padding:0 2px;}
.dq-emoji{height:1.25em;width:1.25em;vertical-align:bottom;margin:0 .05em;object-fit:contain;}
</style></head><body><div id="root">${markup}</div></body></html>`;
}

async function bundleComponents(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(PREVIEW_DIR, "glue.ts")],
    target: "browser",
    minify: true,
  });
  if (!result.success) {
    throw new Error(`component bundle failed: ${result.logs.join("\n")}`);
  }
  const entry = result.outputs.find((o) => o.kind === "entry-point") ?? result.outputs[0];
  if (!entry) throw new Error("component bundle produced no output");
  return await entry.text();
}

/** Shadow DOM を含む全 <img> のデコード完了を待つ（CDN 絵文字・アバターの取りこぼし防止） */
async function waitForImages(page: import("playwright").Page): Promise<void> {
  await page.evaluate(async () => {
    const imgs: HTMLImageElement[] = [];
    const walk = (root: Document | ShadowRoot): void => {
      for (const img of root.querySelectorAll("img")) imgs.push(img as HTMLImageElement);
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
    await Promise.all(
      imgs.map((img) => (img.complete ? Promise.resolve() : img.decode().catch(() => undefined))),
    );
  });
}

export interface IRenderResult {
  id: string;
  pngPath: string;
  ok: boolean;
  error?: string;
}

export async function renderFixtures(
  fixtures: IFixture[],
  outDir: string,
): Promise<IRenderResult[]> {
  const fontBase64 = Buffer.from(await Bun.file(FONT_PATH).arrayBuffer()).toString("base64");
  const bundleJs = await bundleComponents();

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const context = await browser.newContext({ deviceScaleFactor: 2 });
  const results: IRenderResult[] = [];

  try {
    for (const fixture of fixtures) {
      const pngPath = join(outDir, `${fixture.id}.png`);
      const page = await context.newPage();
      try {
        await page.setViewportSize({ width: 640, height: 200 });
        await page.setContent(pageHtml(messagesToMarkup(fixture.messages), fontBase64), {
          waitUntil: "load",
        });
        await page.addScriptTag({ content: bundleJs, type: "module" });
        await page.waitForFunction(
          () => Boolean(customElements.get("discord-message")),
          undefined,
          {
            timeout: 15000,
          },
        );
        await page.evaluate(async () => {
          await document.fonts.ready;
        });
        // networkidle は外部CDN(絵文字)依存のため bounded + 失敗は無視（オフラインでも続行）
        await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
        await waitForImages(page);

        await page.locator("discord-messages").screenshot({ path: pngPath });
        results.push({ id: fixture.id, pngPath, ok: true });
      } catch (err) {
        results.push({ id: fixture.id, pngPath, ok: false, error: String(err) });
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }

  return results;
}
