import { describe, expect, test } from "bun:test";
import { ComponentType } from "discord.js";
import { buildFixtures, type IFixture } from "../../../scripts/preview/fixtures";
import { messagesToMarkup } from "../../../scripts/preview/payloadToMarkup";

const fixtures = buildFixtures();

function findFixture(id: string): IFixture {
  const fixture = fixtures.find((f) => f.id === id);
  if (!fixture) throw new Error(`fixture not found: ${id}`);
  return fixture;
}

/** Container の TextDisplay の文言を上から順に取り出す（Section 内の TextDisplay も含む） */
function textsOf(fixture: IFixture, messageIndex: number): string[] {
  const component = fixture.messages[messageIndex].components[0];
  if (component.type !== ComponentType.Container) {
    throw new Error(`message ${messageIndex} is not a Container`);
  }
  const texts: string[] = [];
  for (const child of component.components) {
    if (child.type === ComponentType.TextDisplay) texts.push(child.content);
    if (child.type === ComponentType.Section) {
      for (const inner of child.components) texts.push(inner.content);
    }
  }
  return texts;
}

describe("プレビュー fixture", () => {
  test("すべての fixture が message 数ぶん描画され、退避プレースホルダを残さない", () => {
    expect(fixtures.length).toBeGreaterThan(0);
    for (const fixture of fixtures) {
      const markup = messagesToMarkup(fixture.messages);
      const rendered = markup.split("<discord-message ").length - 1;
      expect(rendered).toBe(fixture.messages.length);
      expect(markup).not.toContain("");

      // message の個数だけでは、中身の描画が丸ごと空になる回帰を検出できない。
      // payload にある Embed / Container の個数ぶん、対応する要素が出ていることまで見る。
      const embeds = fixture.messages.reduce((n, m) => n + (m.embeds?.length ?? 0), 0);
      const containers = fixture.messages.reduce(
        (n, m) => n + m.components.filter((c) => c.type === ComponentType.Container).length,
        0,
      );
      expect(markup.split("<discord-embed ").length - 1).toBe(embeds);
      expect(markup.split('class="dq-container"').length - 1).toBe(containers);
      expect(embeds + containers).toBeGreaterThan(0);
    }
  });

  // 本文の段落数は 1 message の本文予算に対する相対値でしか意味を持たない。予算が変わって
  // 1 message に収まるようになると、ページ番号フッターが描画されない fixture に退化する。
  test("chat-final-long が複数 message へ分割され、ページ番号フッターを持つ", () => {
    const fixture = findFixture("chat-final-long");

    expect(fixture.messages.length).toBeGreaterThan(1);

    const total = fixture.messages.length;
    const firstTexts = textsOf(fixture, 0);
    const lastTexts = textsOf(fixture, total - 1);

    expect(firstTexts[0]).toStartWith("**Model:**");
    expect(firstTexts.at(-1)).toBe(`ページ 1/${total}`);
    // LLM 詳細情報は末尾 message のフッターにだけ載る
    expect(lastTexts.at(-1)).toContain(`ページ ${total}/${total} | Tokens:`);
    expect(firstTexts.at(-1)).not.toContain("Tokens:");

    // payload だけでなく、描画されたマークアップにも本文とフッターが出ていること
    const markup = messagesToMarkup(fixture.messages);
    expect(markup).toContain(`ページ 1/${total}`);
    expect(markup).toContain(`ページ ${total}/${total}`);
    expect(markup).toContain('<discord-header level="2">長文応答の分割プレビュー</discord-header>');
  });

  test("chat-streaming の末尾 message が Section の停止ボタンを持つ", () => {
    const fixture = findFixture("chat-streaming");
    const last = fixture.messages.at(-1)?.components[0];

    if (last?.type !== ComponentType.Container) throw new Error("not a Container");
    const section = last.components.find((c) => c.type === ComponentType.Section);
    expect(section).toBeDefined();
    if (section?.type !== ComponentType.Section) throw new Error("not a Section");
    expect(section.accessory.type).toBe(ComponentType.Button);
  });

  test("/status が V2 Container と設定ボタンを描画する", () => {
    const fixture = findFixture("status-guild");
    const component = fixture.messages[0]?.components[0];
    if (component?.type !== ComponentType.Container) throw new Error("not a Container");
    const sections = component.components.filter((child) => child.type === ComponentType.Section);

    expect(textsOf(fixture, 0)[0]).toContain("## ステータス");
    expect(sections).toHaveLength(5);
    expect(
      sections.some(
        (section) =>
          section.accessory.type === ComponentType.Button &&
          "custom_id" in section.accessory &&
          section.accessory.custom_id === "status_set:web_search:off",
      ),
    ).toBe(true);
  });

  test("/help と /model list の TextDisplay は4,000文字以内で描画される", () => {
    for (const id of ["help", "model-list"]) {
      const fixture = findFixture(id);
      const text = textsOf(fixture, 0)[0];
      expect(text?.length).toBeLessThanOrEqual(4000);
      expect(messagesToMarkup(fixture.messages)).toContain('class="dq-container"');
    }
  });

  test("model details のタイトルリンクと全フィールドを描画する", () => {
    const fixture = findFixture("model-set");
    const text = textsOf(fixture, 0)[0] ?? "";
    const markup = messagesToMarkup(fixture.messages);

    expect(text).toContain(
      "## [モデル変更](https://openrouter.ai/demo/preview-model%3Aplaceholder)",
    );
    expect(text).toContain("**モデル名** Demo Preview Model");
    expect(text).toContain("**対応モダリティ** 入力: text, image / 出力: text");
    expect(markup).toContain(
      '<discord-link href="https://openrouter.ai/demo/preview-model%3Aplaceholder">モデル変更</discord-link>',
    );
  });

  test("error and success notices use Containers with their expected content", () => {
    const errorMarkup = messagesToMarkup(findFixture("error").messages);
    const successMarkup = messagesToMarkup(findFixture("config-confirm").messages);

    expect(errorMarkup).toContain('<discord-header level="2">');
    expect(errorMarkup).toContain("エラー</discord-header>");
    expect(errorMarkup).toContain("OpenRouter API がタイムアウトしました。");
    expect(successMarkup).toContain(
      '<discord-header level="2">無料モデル限定設定</discord-header>',
    );
    expect(successMarkup).toContain(
      "無料モデル限定を <discord-bold>有効</discord-bold> にしました。",
    );
  });
});
