---
title: "デフォルトモデル定数の SSOT 化"
status: implemented
priority: medium
summary: "envVars.ts を DEFAULT_MODEL の単一ソース化"
---

# Default Model 定数の SSOT 化

## Why

デフォルトモデル ID (`deepseek/deepseek-v4-flash:free`) が現状 **実測 11 箇所**に散在しており、変更の度に同期事故のリスクがある。直前の `r1-0528 → v4-flash` 切替で複数ファイル編集が発生し、`embedBuilder.ts` の docstring 例や `db/schema.ts` の SQL DEFAULT 句のようなアプリ設定値を持つべきでない場所にもリテラルが混入していることが顕在化した。さらに survey で、`tests/helpers/mockFactories.ts` の 5 箇所には **更に古い `google/gemini-2.0-flash-exp:free` が残っている** ことも判明（v4-flash 切替時にも、その前の切替時にも同期漏れしていた）。SSOT 化の必要性は当初想定より深刻。

`src/config/envVars.ts` を SSOT として確立し、SQL DEFAULT 句と docstring 例を撤廃、CLAUDE.md と README.md は既存の AUTO 生成基盤に乗せて環境変数定義から自動反映する。

## Goals / Non-Goals

**Goals:**

- デフォルトモデル ID のリテラルは `src/config/envVars.ts` の `DEFAULT_MODEL.default` 一箇所のみに存在する
- runtime では `config.defaultModel` を import して参照
- DB schema からモデル名リテラルを排除（DEFAULT 句撤廃 + Repository 層で明示 INSERT）
- CLAUDE.md の "Default model" 行は AUTO マーカー化し、`scripts/generate-readme.ts` を拡張して自動更新
- `src/config/index.ts` の zod fallback `.default(...)` を削除（envVars から必ず値が来るので冗長）
- `src/utils/embedBuilder.ts:28` の docstring 例を架空モデル ID に置換（連動不要化）
- テスト fixture は意図を確認のうえ、production constants 非依存のリテラルに置換

**Non-Goals:**

- 他の設定値（PORT、DATABASE_PATH 等）の SSOT 化（今回は default model のみ）
- ユーザが `/config model` で設定した値（`guild_settings.default_model` の per-row 値）の扱い変更
- 既存 DB 行の default_model 値の一斉マイグレーション（ユーザの明示選択を尊重）
- `generate-readme.ts` の責務の **大幅** 拡大（フォーマット変更、新セクション追加、リネーム等）。CLAUDE.md 対応の追加は最小拡張として実施するが、その他の役割追加はスコープ外

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| SSOT の場所 | `src/config/envVars.ts` の `EnvVarDefinition.default` フィールド | 既存 generate-readme.ts が `envVarDefinitions` を import して README に反映する基盤と一致。新規 `constants.ts` を切るより既存構造に乗る方が責務が一貫する |
| **default モデル ID 選定** | **`deepseek/deepseek-v4-flash:free` を維持**（`openrouter/free` ルータは却下） | OpenRouter `openrouter/free` は free モデルから "ランダム" 選択する Free Models Router（公式仕様）。採用すると (a) chat bot で呼び出しごとに文体・指示遵守・refusal がぶれる、(b) `embedBuilder.getColorForModel` がモデル ID をハッシュして色を決める前提が崩れる（応答時に実モデル ID を取り出すロジック追加が必要）、(c) `:free` レート制限 (20 RPM / 50–1000 RPD) はルータでも変わらない、(d) context window が routed model ごとに変動して `conversation-context` の truncation 設計と噛み合わない、(e) 公式が "free models are usually not suitable for production use" と明示。SSOT 化が完了すれば envVars.ts 1 行差し替えで切替可能なので将来判断を保留しても本 change の価値は維持される |
| zod fallback | 削除（`.default(...)` を消して `z.string().min(1)` のみ） | envVars.ts が必ず default を埋めるので fallback は同期事故源にしかならない。zod v4 では `.default()` は input が `undefined` のとき output 型のデフォルトを short-circuit で返す挙動（v3 の input パース挙動は `.prefault()` に移動）だが、本ケースは `undefined` が来ない経路のため `.default()` は dead code であり削除が正しい（v4 と整合） |
| DB DEFAULT 句 (新 schema 定義) | 撤廃 (`default_model TEXT NOT NULL` のみ) | アプリ設定値を SQL リテラルに埋める設計が悪い。Repository の `upsert()` 経路で `config.defaultModel` を明示 INSERT（survey で実装済み確認） |
| **既存デプロイの DB DEFAULT** | **そのまま残置 (実害なし)** | SQLite は `ALTER TABLE` で DROP DEFAULT を直接サポートしない。table 再作成 migration を打つ手もあるが、`src/db/repositories/guildSettings.ts:76+` の `upsert` が `config.defaultModel` を明示 INSERT することを **survey で実コード確認済み**。既存テーブルに残った DEFAULT 句は **dead code** で実害ゼロ。再作成 migration のリスク (downtime、ロックタイミング) を取る価値なし |
| 既存 DB 行 | 触らない | ユーザが `/config model` で意図的に設定した値かもしれない。一斉書き換えは UX 上のサプライズ |
| マイグレーション順序 | (1) Repository 経路は既に `config.defaultModel` 明示 INSERT 済み（survey 確認） → (2) `db/schema.ts` の新規 `CREATE TABLE` 句から DEFAULT 削除 → (3) 既存テーブルは触らない | 順序を守れば既存 production DB に対しても安全 (Repository が常に値を渡すので、SQL DEFAULT が発火しない) |
| CLAUDE.md AUTO 化 | 既存 `scripts/generate-readme.ts` を拡張、リネームは行わず | スクリプト名が誤解を招くが、リネームすると lefthook 設定 + git 履歴 + 既存テストへの波及が出る。スコープ拡大を避ける |
| AUTO マーカー粒度 | "Default model" の 1 行だけマーカー化 (`<!-- AUTO:DEFAULT_MODEL:START/END -->`) | Notes セクション全体を AUTO 化すると編集自由度が落ちる。最小マーカー |
| docstring 例 | `"provider/model-id"` のような **明らかにプレースホルダと判別できる文字列** | `openai/gpt-4o:free` は OpenRouter 実在モデルと混同される。`provider/model-id` ならドキュメント例だと一目で分かる |
| テスト fixture | `messageCreate.test.ts` (2 箇所) と `mockFactories.ts` (5 箇所) の `defaultModel` 値を `"test-model:fixture"` に統一。`scripts/preview/fixtures.ts` の `DEMO_MODEL` も `"demo/preview-model:placeholder"` に固定 | survey の結果、`defaultModel` 値は assert されておらず fixture 形を埋めるだけ。`mockFactories.ts` は更に古い `google/gemini-2.0-flash-exp:free` のまま放置されており、production constants との連動を切るのが目的に適う |
| **`mockFactories.ts` の旧 Gemini ID** | **本 change で同時に置換**（survey で発覚した同期漏れ） | 元設計書は `mockFactories.ts` を列挙していなかったが、SSOT 化の目的 (実モデル ID リテラルの散在排除) の対象として漏れていた。`messageCreate.test.ts` の修正と同時に処理する |

## Design

### 変更対象ファイル

**修正:**

- `.env.example` — 元々 envVars.ts と独立に手書き同期されており、今回の `v4-flash` 切替でも漏れて単独 commit (35c9cc8) で追従が必要だった。`scripts/generate-readme.ts` を `envVarDefinitions` から `.env.example` を生成する責務も追加 (`name=<default>` 形式で出力)、手書き同期を撤廃する。Required な変数 (DISCORD_TOKEN 等、default なし) は空値 `NAME=` で出す
- `src/config/index.ts` — `defaultModel: z.string().default(...)` (line 56) → `z.string().min(1)`
- `src/db/schema.ts` — 新規 `CREATE TABLE guild_settings (...)` (line 7) の `default_model TEXT NOT NULL DEFAULT '...'` から DEFAULT 句のみ削除 (`default_model TEXT NOT NULL`)
- ~~`src/db/repositories/guildSettings.ts` — INSERT 経路で `config.defaultModel` を明示渡し~~ **✓ 既完了**（`upsert()` line 76+ で `defaults.defaultModel` を明示 INSERT 済み、survey 確認）
- `src/utils/embedBuilder.ts:28` の `getColorForModel` docstring — 例を `"provider/model-id"` に置換
- `tests/unit/bot/events/messageCreate.test.ts:77, 330` の `getGuildSettings` モック fixture (`defaultModel:` フィールド) を `"test-model:fixture"` に置換
- `tests/helpers/mockFactories.ts:14, 84, 108, 120, 140` の 5 箇所の `google/gemini-2.0-flash-exp:free` を `"test-model:fixture"` に置換（survey で発覚した同期漏れ）
- `scripts/preview/fixtures.ts:40` の `DEMO_MODEL` 定数値を `"demo/preview-model:placeholder"` に固定（preview 専用なので production constants 依存は不要）
- `CLAUDE.md` — Default model 行を AUTO マーカーで囲む
- `scripts/generate-readme.ts` — CLAUDE.md と `.env.example` も対象に追加 (リネームしない)
- `lefthook.yml` の generate-readme command で `git add CLAUDE.md .env.example` 追加
- 関連 unit test — `tests/unit/scripts/generateReadme.test.ts` に CLAUDE.md AUTO セクション / `.env.example` 生成のテスト追加

### CLAUDE.md AUTO 化の実装

CLAUDE.md 該当箇所を以下のように変更:

```markdown
## Notes

- Discord message limit: 2000 characters (split required)
<!-- AUTO:DEFAULT_MODEL:START -->
- Default model: `deepseek/deepseek-v4-flash:free`
<!-- AUTO:DEFAULT_MODEL:END -->
- SQLite WAL mode enabled
```

`scripts/generate-readme.ts` を以下のように拡張（main 関数のみ抜粋）:

```ts
function main(): void {
  const rootDir = resolve(import.meta.dir, "..");

  // README.md (existing)
  const readmePath = resolve(rootDir, "README.md");
  let readme = readFileSync(readmePath, "utf-8");
  readme = replaceMarkerSection(readme, "COMMANDS", generateCommandTable(commands));
  readme = replaceMarkerSection(readme, "ENV_VARS", generateEnvVarsTable(envVarDefinitions));
  writeFileSync(readmePath, readme);

  // CLAUDE.md (new)
  const claudeMdPath = resolve(rootDir, "CLAUDE.md");
  let claudeMd = readFileSync(claudeMdPath, "utf-8");
  const defaultModelDef = envVarDefinitions.find((v) => v.name === "DEFAULT_MODEL");
  if (!defaultModelDef?.default) throw new Error("DEFAULT_MODEL definition missing");
  claudeMd = replaceMarkerSection(
    claudeMd,
    "DEFAULT_MODEL",
    `- Default model: \`${defaultModelDef.default}\``,
  );
  writeFileSync(claudeMdPath, claudeMd);

  console.log("README.md and CLAUDE.md updated.");
}
```

### lefthook 設定の確認

現状の `lefthook.yml` は `bun scripts/generate-readme.ts && git add README.md` になっているので、`git add CLAUDE.md .env.example` を追加する必要あり。

```yml
pre-commit:
  commands:
    generate-readme:
      run: bun scripts/generate-readme.ts && git add README.md CLAUDE.md .env.example
```

### Repository 層の現状（確認済み）

`src/db/repositories/guildSettings.ts:76+` の `upsert()` は既に `config.defaultModel` を `defaults.defaultModel` 経由で受け取り、INSERT で明示渡ししている（`src/index.ts:40` で DI 注入）。SQL DEFAULT 句は事実上 dead code。本 change での追加対応は不要。

### 移行手順

1. **(既完了)** envVars.ts SSOT 定義 / Repository DI 経路 — survey で確認のみ
2. zod fallback 削除（`src/config/index.ts:56`、必ず envVars から値が来ることを test で担保）
3. embedBuilder docstring 修正（即実行可、低リスク）
4. テスト fixture 同期: `messageCreate.test.ts:77, 330` と `mockFactories.ts:14, 84, 108, 120, 140` を `"test-model:fixture"` に統一、`scripts/preview/fixtures.ts:40` を `"demo/preview-model:placeholder"` に固定
5. CLAUDE.md にマーカー追加 + `scripts/generate-readme.ts` を CLAUDE.md / `.env.example` 対応に拡張 + lefthook に `git add CLAUDE.md .env.example` 追加
6. `tests/unit/scripts/generateReadme.test.ts` に CLAUDE.md AUTO セクション / `.env.example` 生成のテスト追加
7. `src/db/schema.ts:7` の `CREATE TABLE` 句から DEFAULT 句撤廃（既存テーブルへの影響なし）

## Tasks

- [x] **(既完了)** `src/config/envVars.ts` に SSOT として `DEFAULT_MODEL` エントリ定義（survey で確認）
- [x] **(既完了)** `src/db/repositories/guildSettings.ts:76+` の `upsert()` で `config.defaultModel` を明示 INSERT（survey で確認、DI 経路 `src/index.ts:40` 経由）
- [x] `src/config/index.ts:56` の zod fallback `.default("deepseek/deepseek-v4-flash:free")` 削除（`z.string().min(1)` に）
- [x] `src/utils/embedBuilder.ts:28` の `getColorForModel` docstring を `"provider/model-id"` に置換
- [x] `tests/unit/bot/events/messageCreate.test.ts:77, 330` の `getGuildSettings` モック fixture (`defaultModel` フィールド) を `"test-model:fixture"` に変更
- [x] `tests/helpers/mockFactories.ts:14, 84, 108, 120, 140` の 5 箇所の `google/gemini-2.0-flash-exp:free` を `"test-model:fixture"` に置換
- [x] `scripts/preview/fixtures.ts:40` の `DEMO_MODEL` を `"demo/preview-model:placeholder"` に固定
- [x] `CLAUDE.md` の Default model 行に `<!-- AUTO:DEFAULT_MODEL:START/END -->` マーカー追加
- [x] `scripts/generate-readme.ts` を CLAUDE.md 対応に拡張
- [x] `scripts/generate-readme.ts` に `.env.example` 生成ロジック追加 (envVarDefinitions ベース、required → 空値、default あり → `NAME=<default>`)
- [x] `tests/unit/scripts/generateReadme.test.ts` に CLAUDE.md AUTO セクション / `.env.example` 生成のテスト追加
- [x] `lefthook.yml` の generate-readme command で `git add CLAUDE.md .env.example` 追加
- [x] `src/db/schema.ts:7` の新規 `CREATE TABLE` 句から DEFAULT 句削除 (既存テーブルは触らない)
- [x] `bun typecheck && bun test` クリーン確認
- [x] pre-commit hook で CLAUDE.md / `.env.example` が正しく自動更新されることを手動確認
- [ ] docs/changes/default-model-ssot/ 削除（リリース完了時）

## Open Questions / Risks

- **`scripts/generate-readme.ts` のリネーム回避**: スクリプト名が "readme" のままで実際は CLAUDE.md / `.env.example` も触るのは紛らわしい。将来的に `generate-docs.ts` にリネームしたくなるが、本 change ではスコープ外（リネームは lefthook 設定 + 既存テスト + git mv が伴うため、本 change が肥大化する）。リネームしたくなったら別 change。
- **既存 DB 行の扱い**: 旧 default (`deepseek-r1-0528:free` 等) を持つ guild_settings 行が残るが、ユーザが意図的に設定した可能性があるため触らない。問題が出たら別 change で対応。
- **モデル churn 耐性は別 change**: `openrouter/free` ルータ採用はモデル deprecation 耐性の点で魅力的だが、UX 一貫性・色マッピング・context window 変動の懸念から本 change では却下（Decisions 参照）。将来 churn 耐性が必要になったら別 change（仮称 `model-fallback-chain`）で `FALLBACK_MODELS` 優先順位リスト or 動的 fallback chain を検討する。SSOT 化完了後は `envVars.ts` 1 行差し替えで切替できるため、判断を将来に保留しても本 change の価値は維持される。

## 参照

- 元議論: code-execution 設計時のデフォルトモデル切替で複数ファイル編集が発生し、SSOT 化の必要性が顕在化
- 関連 change: [code-execution](../code-execution/design.md) — 同時期にデフォルトモデルを参照する箇所が増える見込み
- OpenRouter Free Models Router 公式: <https://openrouter.ai/openrouter/free>（`openrouter/free` がランダム選択である根拠）
- OpenRouter `:free` variant ドキュメント: <https://openrouter.ai/docs/guides/routing/model-variants/free>（free モデルが production 非推奨である根拠）
