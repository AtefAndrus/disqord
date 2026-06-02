/**
 * プレビューツールで共有するパス・URL 定数（重複定義の回避）。
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const PREVIEW_DIR = HERE;
export const PROJECT_ROOT = join(HERE, "..", "..");
export const OUT_DIR = join(PROJECT_ROOT, ".preview");
export const FONT_PATH = join(HERE, "fonts", "NotoSansJP-Regular.woff");
export const FONT_URL =
  "https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-jp@5/files/noto-sans-jp-japanese-400-normal.woff";
