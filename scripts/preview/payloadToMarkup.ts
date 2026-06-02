/**
 * Discord メッセージペイロード（builder の .toJSON() 出力）を
 * @skyra/discord-components-core のマークアップ文字列へ変換する。
 *
 * 目的: 実際の Bot UI 生成関数が組み立てたペイロードを、ブラウザ上で
 * Discord 風に描画してスクリーンショットするための中間表現を作ること。
 *
 * 注意: これは Discord 本体の描画の「近似」であり完全互換ではない。
 *
 * 設計: マークダウン変換は「インライン要素（コード・リンク・メンション・
 * タイムスタンプ・絵文字・見出し）を先に HTML へ変換してプレースホルダへ退避し、
 * 残ったプレーンテキストにだけ太字/斜体/箇条書きを適用 → 最後に復元」する。
 * これにより、後段の装飾正規表現が前段で挿入した HTML タグ（特に URL の href）を
 * 壊すことを防ぐ。
 */

import type { APIActionRowComponent, APIEmbed, APIMessageActionRowComponent } from "discord.js";
import { ButtonStyle, ComponentType } from "discord.js";

export interface IRenderMessage {
  content?: string;
  embeds: APIEmbed[];
  components: APIActionRowComponent<APIMessageActionRowComponent>[];
}

// ButtonStyle → discord-button の type 属性（Link はボタン type ではなく url で表現）
const BUTTON_TYPE: Partial<Record<ButtonStyle, string>> = {
  [ButtonStyle.Primary]: "primary",
  [ButtonStyle.Secondary]: "secondary",
  [ButtonStyle.Success]: "success",
  [ButtonStyle.Danger]: "destructive",
};

// 退避プレースホルダ境界（本文に出現しない私用領域文字。衝突安全）
const SENTINEL = "\uE000";

// 絵文字: 国旗(Regional Indicator 2連) / キーキャップ / 肌色修飾子・ZWJ 連結を含む基本絵文字
const EMOJI_RE =
  /\p{Regional_Indicator}\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3|\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?(?:\u200D\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?)*/gu;

// Bot アバター（ネットワーク非依存の inline SVG data URI）
const BOT_AVATAR =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80">' +
      '<circle cx="40" cy="40" r="40" fill="#5865f2"/>' +
      '<text x="40" y="54" font-size="44" font-family="sans-serif" fill="#fff" text-anchor="middle">D</text>' +
      "</svg>",
  );

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

function numberToHexColor(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

/** unicode 絵文字 → Twemoji 画像 URL（Discord と同系統の絵文字画像。バージョン固定） */
function twemojiUrl(name: string): string {
  const code = [...name]
    .map((ch) => ch.codePointAt(0) ?? 0)
    .filter((cp) => cp !== 0xfe0f)
    .map((cp) => cp.toString(16))
    .join("-");
  return `https://cdn.jsdelivr.net/gh/jdecked/twemoji@16.0.1/assets/72x72/${code}.png`;
}

/** Date から YYYY/M/D と H:MM（分ゼロ埋め）を生成（日時整形の単一ソース） */
function dateTimeParts(d: Date): { date: string; time: string } {
  return {
    date: `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`,
    time: `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`,
  };
}

/** Embed footer の timestamp(ISO) を Discord 風表記へ（今日 HH:MM / 昨日 HH:MM / YYYY/M/D HH:MM） */
function formatFooterTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso; // 不正値はそのまま（属性側で escapeAttr）
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const { date, time } = dateTimeParts(d);
  if (d.toDateString() === now.toDateString()) return `今日 ${time}`;
  if (d.toDateString() === yesterday.toDateString()) return `昨日 ${time}`;
  return `${date} ${time}`;
}

/**
 * <t:unix:style> の整形。R は相対表記、それ以外（既定 f を含む）は絶対日時。
 * Discord の既定（スタイル省略時）は短い日時表記であり、相対ではない。
 */
function formatTimestamp(unixSeconds: number, style: string | undefined): string {
  if (style === "R") {
    const diffSec = Math.round((unixSeconds * 1000 - Date.now()) / 1000);
    const abs = Math.abs(diffSec);
    const suffix = diffSec < 0 ? "前" : "後";
    if (abs < 60) return `${abs}秒${suffix}`;
    if (abs < 3600) return `${Math.round(abs / 60)}分${suffix}`;
    if (abs < 86400) return `${Math.round(abs / 3600)}時間${suffix}`;
    return `${Math.round(abs / 86400)}日${suffix}`;
  }
  const d = new Date(unixSeconds * 1000);
  if (Number.isNaN(d.getTime())) return `t:${unixSeconds}`; // Date 範囲外
  const { date, time } = dateTimeParts(d);
  if (style === "d" || style === "D") return date;
  if (style === "t" || style === "T") return time;
  return `${date} ${time}`; // f / F / 既定
}

/** escapeHtml 済み URL から安全な <discord-link> を生成（href は " も無効化） */
function linkMarkup(escapedUrl: string): string {
  const href = escapedUrl.replace(/"/g, "&quot;");
  return `<discord-link href="${href}">${escapedUrl}</discord-link>`;
}

/**
 * Discord マークダウン（Bot が使う範囲）を discord-components のマークアップへ。
 * @param opts.headings - 見出し(# )を描画するか。Discord は embed description でのみ
 *   見出しを描画し field value / footer では描画しないため、呼び出し側で制御する。
 */
function markdownToHtml(input: string, opts: { headings?: boolean } = {}): string {
  const stash: string[] = [];
  const hold = (html: string): string => `${SENTINEL}${stash.push(html) - 1}${SENTINEL}`;

  let text = input;

  // 1. コードブロック / インラインコード → 退避
  text = text.replace(/```(?:[a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g, (_m, code: string) =>
    hold(`<discord-code multiline embed>${escapeHtml(code.replace(/\n$/, ""))}</discord-code>`),
  );
  text = text.replace(/`([^`\n]+)`/g, (_m, code: string) =>
    hold(`<discord-code embed>${escapeHtml(code)}</discord-code>`),
  );

  // 2. エスケープ（以降 < > & は実体参照。" は escapeAttr 側で処理）
  text = escapeHtml(text);

  // 3. メンション / タイムスタンプ / 絵文字 → 退避（URL 検出より先に行い、URL に飲まれないようにする）
  text = text.replace(/&lt;#(\d+)&gt;/g, () =>
    hold('<discord-mention type="channel">channel</discord-mention>'),
  );
  text = text.replace(/&lt;@!?(\d+)&gt;/g, () =>
    hold('<discord-mention type="user">user</discord-mention>'),
  );
  text = text.replace(/&lt;@&amp;(\d+)&gt;/g, () =>
    hold('<discord-mention type="role">role</discord-mention>'),
  );
  text = text.replace(/&lt;t:(\d+)(?::([tTdDfFR]))?&gt;/g, (_m, unix: string, style: string) =>
    hold(`<span class="dq-ts">${formatTimestamp(Number(unix), style)}</span>`),
  );
  text = text.replace(EMOJI_RE, (m) =>
    hold(`<img class="dq-emoji" src="${escapeAttr(twemojiUrl(m))}" alt="${escapeAttr(m)}">`),
  );

  // 4. リンク → 退避（抑制リンク <url> + 素の URL の自動リンク。SENTINEL/空白で停止）
  text = text.replace(/&lt;(https?:\/\/[^\s|]+?)&gt;/g, (_m, url: string) =>
    hold(linkMarkup(url)),
  );
  text = text.replace(/https?:\/\/[^\s]+/g, (m: string) => {
    // 末尾の句読点・閉じ括弧はリンクから除外
    const trail = m.match(/[.,;:!?)）。、！？]+$/);
    const url = trail ? m.slice(0, m.length - trail[0].length) : m;
    const rest = trail ? trail[0] : "";
    return hold(linkMarkup(url)) + rest;
  });

  // 5. 見出し（description のみ。H1-H3）→ 退避
  if (opts.headings) {
    text = text.replace(
      /(^|\n)(#{1,3}) +([^\n]*)/g,
      (_m, br: string, hashes: string, body: string) =>
        `${br}${hold(`<discord-header level="${hashes.length}">${body}</discord-header>`)}`,
    );
  }

  // 6. 太字 / 斜体（退避済みタグには SENTINEL しか残っていないため安全）
  text = text.replace(/\*\*([^*]+)\*\*/g, "<discord-bold>$1</discord-bold>");
  text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<discord-italic>$1</discord-italic>");
  text = text.replace(
    /(?<![A-Za-z0-9])_([^_\n]+)_(?![A-Za-z0-9])/g,
    "<discord-italic>$1</discord-italic>",
  );

  // 7. 行頭 "- " 箇条書き → 中黒、改行
  text = text.replace(/(^|\n)- /g, "$1• ");
  text = text.replace(/\n/g, "<br>");

  // 8. 退避を復元（退避内容に SENTINEL は含まれないため一括で可）
  text = text.replace(/\uE000(\d+)\uE000/g, (_m, i: string) => stash[Number(i)] ?? "");
  return text;
}

function embedToMarkup(embed: APIEmbed): string {
  const attrs: string[] = ['slot="embeds"'];
  if (embed.color !== undefined) attrs.push(`color="${numberToHexColor(embed.color)}"`);
  if (embed.title) attrs.push(`embed-title="${escapeAttr(embed.title)}"`);
  if (embed.url) attrs.push(`url="${escapeAttr(embed.url)}"`);
  if (embed.author?.name) attrs.push(`author-name="${escapeAttr(embed.author.name)}"`);
  if (embed.author?.icon_url) attrs.push(`author-image="${escapeAttr(embed.author.icon_url)}"`);
  if (embed.author?.url) attrs.push(`author-url="${escapeAttr(embed.author.url)}"`);
  if (embed.thumbnail?.url) attrs.push(`thumbnail="${escapeAttr(embed.thumbnail.url)}"`);
  if (embed.image?.url) attrs.push(`image="${escapeAttr(embed.image.url)}"`);

  const parts: string[] = [];
  if (embed.description) {
    // description は見出しを描画する
    parts.push(
      `<discord-embed-description slot="description">${markdownToHtml(embed.description, { headings: true })}</discord-embed-description>`,
    );
  }
  if (embed.fields && embed.fields.length > 0) {
    // Discord の 3 列レイアウトを再現。連続する inline フィールドへ
    // inline-index 1→2→3 を循環付与し、非 inline で行をリセットする。
    let column = 0;
    const fields = embed.fields
      .map((f) => {
        let inlineAttr = "";
        if (f.inline) {
          column = (column % 3) + 1;
          inlineAttr = ` inline inline-index="${column}"`;
        } else {
          column = 0;
        }
        // field value では見出しを描画しない（Discord は field では未対応）
        return `<discord-embed-field field-title="${escapeAttr(f.name)}"${inlineAttr}>${markdownToHtml(f.value)}</discord-embed-field>`;
      })
      .join("");
    parts.push(`<discord-embed-fields slot="fields">${fields}</discord-embed-fields>`);
  }
  if (embed.footer?.text || embed.timestamp) {
    const footerAttrs: string[] = [];
    if (embed.footer?.icon_url) {
      footerAttrs.push(`footer-image="${escapeAttr(embed.footer.icon_url)}"`);
    }
    if (embed.timestamp) {
      footerAttrs.push(`timestamp="${escapeAttr(formatFooterTimestamp(embed.timestamp))}"`);
    }
    const footerText = embed.footer?.text ? markdownToHtml(embed.footer.text) : "";
    parts.push(
      `<discord-embed-footer slot="footer" ${footerAttrs.join(" ")}>${footerText}</discord-embed-footer>`,
    );
  }
  return `<discord-embed ${attrs.join(" ")}>${parts.join("")}</discord-embed>`;
}

function componentsToMarkup(rows: APIActionRowComponent<APIMessageActionRowComponent>[]): string {
  return rows
    .map((row) => {
      const inner = (row.components ?? [])
        .map((c) => {
          if (c.type === ComponentType.Button) {
            const isLink = c.style === ButtonStyle.Link;
            const typeAttr = isLink ? "" : ` type="${BUTTON_TYPE[c.style] ?? "secondary"}"`;
            const urlAttr = isLink && "url" in c && c.url ? ` url="${escapeAttr(c.url)}"` : "";
            const disabled = c.disabled ? " disabled" : "";
            // unicode 絵文字（id 無し）は Twemoji 画像 URL を emoji 属性へ
            const emojiAttr =
              c.emoji && !c.emoji.id && c.emoji.name
                ? ` emoji="${escapeAttr(twemojiUrl(c.emoji.name))}" emoji-name="${escapeAttr(c.emoji.name)}"`
                : "";
            const label = c.label ? escapeHtml(c.label) : "";
            return `<discord-button${typeAttr}${urlAttr}${disabled}${emojiAttr}>${label}</discord-button>`;
          }
          if (c.type === ComponentType.StringSelect) {
            const opts = (c.options ?? [])
              .map(
                (o) =>
                  `<discord-string-select-menu-option label="${escapeAttr(o.label)}"></discord-string-select-menu-option>`,
              )
              .join("");
            const placeholder = c.placeholder ? ` placeholder="${escapeAttr(c.placeholder)}"` : "";
            return `<discord-string-select-menu${placeholder}>${opts}</discord-string-select-menu>`;
          }
          return "";
        })
        .join("");
      return `<discord-action-row slot="components">${inner}</discord-action-row>`;
    })
    .join("");
}

/** 1件以上のメッセージを 1つの <discord-messages> ブロックへ */
export function messagesToMarkup(messages: IRenderMessage[]): string {
  const body = messages
    .map((msg) => {
      const content = msg.content ? markdownToHtml(msg.content, { headings: true }) : "";
      const embeds = (msg.embeds ?? []).map(embedToMarkup).join("");
      const components = componentsToMarkup(msg.components ?? []);
      return `<discord-message bot author="DisQord" role-color="#5865f2" avatar="${BOT_AVATAR}">${content}${embeds}${components}</discord-message>`;
    })
    .join("");
  return `<discord-messages>${body}</discord-messages>`;
}
