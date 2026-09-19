import { describe, expect, test } from "bun:test";
import { ButtonStyle, ComponentType, SeparatorSpacingSize } from "discord.js";
import { type IRenderMessage, messagesToMarkup } from "../../../scripts/preview/payloadToMarkup";

// payloadToMarkup が退避に使う私用領域文字。復元漏れの検出と、入力に混ざった場合の挙動確認に使う。
const SENTINEL = "";

/** TextDisplay 1 個だけを持つ Container の message を描画する（プレビューのチャット返信と同じ形） */
function renderTextDisplay(content: string): string {
  const message: IRenderMessage = {
    embeds: [],
    components: [
      {
        type: ComponentType.Container,
        components: [{ type: ComponentType.TextDisplay, content }],
      },
    ],
  };
  return messagesToMarkup([message]);
}

describe("messagesToMarkup のマークダウン変換", () => {
  test("連続する見出しを両方とも描画する", () => {
    const markup = renderTextDisplay("## A\n## B\ntext");

    expect(markup).toContain('<discord-header level="2">A</discord-header>');
    expect(markup).toContain('<discord-header level="2">B</discord-header>');
    expect(markup).not.toContain("## B");
  });

  test("見出し直後の箇条書きを中黒に変換する", () => {
    const markup = renderTextDisplay("## A\n\n- item\n- next");

    expect(markup).toContain("• item");
    expect(markup).toContain("• next");
    expect(markup).not.toContain("- item");
  });

  test("見出し直後に余分な改行を残さない", () => {
    // <discord-header> はブロック要素として自前の上下マージンを持つため、
    // 見出しを終端する改行と続く空行が <br> として残ると実機より間延びする。
    const markup = renderTextDisplay("## A\n\n本文");

    expect(markup).toContain("</discord-header>本文");
  });

  test("見出しに含まれる絵文字を画像へ復元する（退避の入れ子）", () => {
    const markup = renderTextDisplay("## ⚠️ エラー\n\n本文");

    expect(markup).toContain('<discord-header level="2">');
    expect(markup).toContain('class="dq-emoji"');
    // 入れ子の退避が復元されずに残ると、プレースホルダが本文に漏れる
    expect(markup).not.toContain(SENTINEL);
  });

  test("入力に退避用の私用領域文字が含まれても終了し、プレースホルダを残さない", () => {
    // 入力由来の SENTINEL をそのまま通すと、自分自身を指す退避ができて復元が終わらなくなる
    const markup = renderTextDisplay(`\`${SENTINEL}0${SENTINEL}\` と ## 見出し`);

    expect(markup).not.toContain(SENTINEL);
    expect(markup).toContain("<discord-code embed>0</discord-code>");
  }, 5000);
});

describe("messagesToMarkup の Components V2 変換", () => {
  test("Container のアクセントカラー・Separator・Section を描画する", () => {
    const message: IRenderMessage = {
      embeds: [],
      components: [
        {
          type: ComponentType.Container,
          accent_color: 0x5865f2,
          components: [
            { type: ComponentType.TextDisplay, content: "本文" },
            { type: ComponentType.Separator, divider: false, spacing: SeparatorSpacingSize.Small },
            {
              type: ComponentType.Section,
              components: [{ type: ComponentType.TextDisplay, content: "生成中..." }],
              accessory: {
                type: ComponentType.Button,
                style: ButtonStyle.Danger,
                label: "停止",
                custom_id: "stop_response_1",
              },
            },
          ],
        },
      ],
    };

    const markup = messagesToMarkup([message]);

    expect(markup).toContain('style="border-left-color:#5865f2"');
    // divider: false は区切り線を出さず、余白だけを入れる
    expect(markup).toContain('<div class="dq-separator"></div>');
    // <discord-button> は直接の親が <discord-action-row> でないと実行時に throw する
    expect(markup).toContain(
      '<div class="dq-section-accessory"><discord-action-row><discord-button type="destructive">停止</discord-button></discord-action-row></div>',
    );
  });

  test("Separator の divider 省略時は区切り線を描画する", () => {
    const message: IRenderMessage = {
      embeds: [],
      components: [
        {
          type: ComponentType.Container,
          components: [{ type: ComponentType.Separator }],
        },
      ],
    };

    expect(messagesToMarkup([message])).toContain("dq-separator-divider");
  });
});
