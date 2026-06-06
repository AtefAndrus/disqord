# Default Model 定数の SSOT 化

## Why

デフォルトモデル ID (`deepseek/deepseek-v4-flash:free`) が現状 6 箇所に散在しており、変更の度に同期事故のリスクがある。直前の `r1-0528 → v4-flash` 切替で 6 ファイル編集が発生し、`embedBuilder.ts` の docstring 例や `db/schema.ts` の SQL DEFAULT 句のようなアプリ設定値を持つべきでない場所にもリテラルが混入していることが顕在化した。

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
| zod fallback | 削除（`.default(...)` を消して `z.string().min(1)` のみ） | envVars.ts が必ず default を埋めるので fallback は同期事故源にしかならない。zod v4 では `.default()` は input が `undefined` のとき output 型のデフォルトを short-circuit で返す挙動（v3 の input パース挙動は `.prefault()` に移動）だが、本ケースは `undefined` が来ない経路のため `.default()` は dead code であり削除が正しい（v4 と整合） |
| DB DEFAULT 句 (新 schema 定義) | 撤廃 (`default_model TEXT NOT NULL` のみ) | アプリ設定値を SQL リテラルに埋める設計が悪い。Repository の `create()` 経路で `config.defaultModel` を明示 INSERT |
| **既存デプロイの DB DEFAULT** | **そのまま残置 (実害なし)** | SQLite は `ALTER TABLE` で DROP DEFAULT を直接サポートしない。table 再作成 migration を打つ手もあるが、Repository が常に `default_model` を明示 INSERT する以上、既存テーブルに残った DEFAULT 句は **dead code** で実害ゼロ。再作成 migration のリスク (downtime、ロックタイミング) を取る価値なし |
| 既存 DB 行 | 触らない | ユーザが `/config model` で意図的に設定した値かもしれない。一斉書き換えは UX 上のサプライズ |
| マイグレーション順序 | (1) Repository 経路を `config.defaultModel` 明示 INSERT に変更 → (2) `db/schema.ts` の新規 `CREATE TABLE` 句から DEFAULT 削除 → (3) 既存テーブルは触らない | 順序を守れば既存 production DB に対しても安全 (Repository が常に値を渡すので、SQL DEFAULT が発火しない) |
| CLAUDE.md AUTO 化 | 既存 `scripts/generate-readme.ts` を拡張、リネームは行わず | スクリプト名が誤解を招くが、リネームすると lefthook 設定 + git 履歴 + 既存テストへの波及が出る。スコープ拡大を避ける |
| AUTO マーカー粒度 | "Default model" の 1 行だけマーカー化 (`<!-- AUTO:DEFAULT_MODEL:START/END -->`) | Notes セクション全体を AUTO 化すると編集自由度が落ちる。最小マーカー |
| docstring 例 | `"provider/model-id"` のような **明らかにプレースホルダと判別できる文字列** | `openai/gpt-4o:free` は OpenRouter 実在モデルと混同される。`provider/model-id` ならドキュメント例だと一目で分かる |
| テスト fixture | `messageCreate.test.ts` の `getGuildSettings` モック fixture (現状 2 箇所) の値を `"test-model:fixture"` に変更 | コード読解で確認した結果、`defaultModel` の値は assert されておらず `getGuildSettings` モックの返り値の "形" を埋める fixture でしかない。production constants 連動は不要で、明示的テスト値に変えるべき。**ハードコード行番号は記載しない** (test 名 / fixture 名で位置特定する方が将来安定) |

## Design

### 変更対象ファイル

**修正:**

- `.env.example` — 元々 envVars.ts と独立に手書き同期されており、今回の `v4-flash` 切替でも漏れて単独 commit (35c9cc8) で追従が必要だった。`scripts/generate-readme.ts` を `envVarDefinitions` から `.env.example` を生成する責務も追加 (`name=<default>` 形式で出力)、手書き同期を撤廃する。Required な変数 (DISCORD_TOKEN 等、default なし) は空値 `NAME=` で出す
- `src/config/index.ts` — `defaultModel: z.string().default(...)` → `z.string().min(1)`
- `src/db/schema.ts` — 新規 `CREATE TABLE guild_settings (...)` の `default_model TEXT NOT NULL DEFAULT '...'` から DEFAULT 句のみ削除 (`default_model TEXT NOT NULL`)
- `src/db/repositories/guildSettingsRepository.ts`(実装位置を grep で確認) — INSERT 経路で `config.defaultModel` を明示渡し
- `src/utils/embedBuilder.ts` の `getColorForModel` docstring — 例を `"provider/model-id"` に置換
- `tests/unit/bot/events/messageCreate.test.ts` の `getGuildSettings` モック fixture (`defaultModel:` フィールド) を `"test-model:fixture"` に置換 (該当行は実装時に grep)
- `CLAUDE.md` — Default model 行を AUTO マーカーで囲む
- `scripts/generate-readme.ts` — CLAUDE.md も対象に追加 (リネームしない)
- `lefthook.yml` の generate-readme command で `git add CLAUDE.md` 追加
- 関連 unit test — `tests/unit/scripts/generate-readme.test.ts` 等に CLAUDE.md AUTO セクションのテスト追加

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

現状の `lefthook.yml` は `bun scripts/generate-readme.ts && git add README.md` になっているので、`git add CLAUDE.md` を追加する必要あり。

```yml
pre-commit:
  commands:
    generate-readme:
      run: bun scripts/generate-readme.ts && git add README.md CLAUDE.md
```

### Repository 層の修正

`guildSettingsRepository` の `create()` を grep して、現在 INSERT 文がどう書かれているか確認のうえ、`config.defaultModel` を明示渡しに変える。具体的なコード変更は実装時に確定。

### 移行手順

1. zod fallback 削除（必ず envVars から値が来ることを test で担保）
2. embedBuilder docstring 修正（即実行可、低リスク）
3. テスト fixture 修正（test の意図と一致しているか再確認）
4. CLAUDE.md にマーカー追加 + `generate-readme.ts` 拡張 + lefthook 修正
5. Repository 層の修正（既存 INSERT 経路を grep → `config.defaultModel` 渡しに）
6. `db/schema.ts` の DEFAULT 句撤廃（既存テーブルへの影響なし）

## Tasks

- [ ] `src/config/index.ts` の zod fallback `.default(...)` 削除
- [ ] `src/utils/embedBuilder.ts` の `getColorForModel` docstring を `"provider/model-id"` に置換
- [ ] `tests/unit/bot/events/messageCreate.test.ts` の `getGuildSettings` モック fixture (`defaultModel` フィールド) を `"test-model:fixture"` に変更 (該当行は実装時に grep で特定)
- [ ] CLAUDE.md に `<!-- AUTO:DEFAULT_MODEL:START/END -->` マーカー追加
- [ ] `scripts/generate-readme.ts` を CLAUDE.md 対応に拡張
- [ ] `scripts/generate-readme.test.ts` に CLAUDE.md AUTO セクションのテスト追加
- [ ] `lefthook.yml` の generate-readme command で `git add CLAUDE.md .env.example` 追加
- [ ] `scripts/generate-readme.ts` に `.env.example` 生成ロジック追加 (envVarDefinitions ベース、required → 空値、default あり → `NAME=<default>`)
- [ ] `guildSettingsRepository` (実装位置を grep で確認) の INSERT で `config.defaultModel` を明示渡し
- [ ] `src/db/schema.ts` の新規 `CREATE TABLE` 句から DEFAULT 句削除 (既存テーブルは触らない)
- [ ] `bun typecheck && bun test` クリーン確認
- [ ] pre-commit hook で CLAUDE.md が正しく自動更新されることを手動確認
- [ ] docs/changes/default-model-ssot/ 削除（リリース完了時）

## Open Questions / Risks

- **Repository 層の現状確認が未実施**: `guildSettingsRepository` で `create()` 時にどう INSERT しているか実装時に grep が必要。`INSERT ... (guild_id) VALUES (?)` のように default_model を渡していない可能性があり、その場合は DEFAULT 句撤廃で既存挙動が壊れる。先に呼出経路を確認してから DEFAULT 撤廃の順序を確定する。
- **`scripts/generate-readme.ts` のリネーム回避**: スクリプト名が "readme" のままで実際は CLAUDE.md も触るのは紛らわしい。将来的に `generate-docs.ts` にリネームしたくなるが、本 change ではスコープ外（リネームは lefthook 設定 + 既存テスト + git mv が伴うため、本 change が肥大化する）。リネームしたくなったら別 change。
- **既存 DB 行の扱い**: 旧 default (`deepseek-r1-0528:free`) を持つ guild_settings 行が残るが、ユーザが意図的に設定した可能性があるため触らない。問題が出たら別 change で対応。

## 参照

- 元議論: code-execution 設計時のデフォルトモデル切替で 6 ファイル編集が発生し、SSOT 化の必要性が顕在化
- 関連 change: [code-execution](../code-execution/design.md) — 同時期にデフォルトモデルを参照する箇所が増える見込み
