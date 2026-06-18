---
title: "設定階層化 + LLMパラメータ + カスタムプロンプト"
status: planned
priority: medium
summary: ""
---

# 設定階層化 + LLMパラメータ + カスタムプロンプト

## Why

現在の設定はGuild単位のみで、チャンネルやユーザごとの使い分けができない。例えば、技術チャンネルではコード特化モデル、雑談チャンネルでは汎用モデルを使いたいケースに対応できない。また、temperatureなどのLLMパラメータやシステムプロンプトのカスタマイズ手段がない。

## Goals / Non-Goals

**Goals:**

- Guild/Channel/User単位で設定を上書き可能にする
- LLMパラメータ（temperature, top_pなど）をモデルごとに最適化
- カスタムシステムプロンプトを各スコープで設定可能にする

**Non-Goals:**

- ロール単位の設定（複雑性が高すぎる）
- パラメータのプリセット機能
- プロンプトのバージョン管理

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 設定優先順位 | User > Channel > Guild > Model Default | 細粒度が粗粒度を上書き |
| パラメータ形式 | JSON文字列（SQLiteカラム） | 柔軟性が高く、スキーマ変更不要 |
| NULL値の扱い | 上位設定を継承 | 明示的な設定のみ上書き |

## Design

### 設定階層化

**変更対象ファイル**:

- `src/db/schema.ts` - `channel_settings`, `user_settings`テーブル追加、`llm_params`カラム追加
- `src/db/repositories/` - 新規Repository追加
- `src/services/settingsService.ts` - 階層解決ロジック
- `src/services/modelService.ts` - デフォルトパラメータ取得
- `src/llm/openrouter.ts` - パラメータ適用

**DBスキーマ変更**:

```sql
CREATE TABLE channel_settings (
    channel_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    model TEXT,
    system_prompt TEXT,
    llm_params TEXT,  -- JSON: {temperature, top_p, ...}
    FOREIGN KEY (guild_id) REFERENCES guild_settings(guild_id)
);

CREATE TABLE user_settings (
    user_id TEXT PRIMARY KEY,
    model TEXT,
    system_prompt TEXT,
    llm_params TEXT  -- JSON
);

ALTER TABLE guild_settings ADD COLUMN llm_params TEXT;
ALTER TABLE guild_settings ADD COLUMN system_prompt TEXT;
```

### LLMパラメータ

**Phase 1: モデルごとのデフォルトパラメータ**:

1. `/api/v1/models` APIレスポンスに含まれる`default_parameters`を使用（**型は `object | null`**。OpenRouter docs の例では `null` のモデルもあるため、取得側で `default_parameters ?? {}` の null ガードをしてからマージする。object の場合の中身は `temperature` / `top_p` / `top_k` / `frequency_penalty` / `presence_penalty` / `repetition_penalty`、いずれも nullable）
2. `ModelService`でキャッシュ時に保存
3. `chatService`がモデルのデフォルトパラメータを取得して適用
4. `supported_parameters`（enum 配列）でモデルが受け付けるパラメータを判定。現行 enum には `temperature` / `top_p` / `top_k` / `min_p` / `top_a` / `frequency_penalty` / `presence_penalty` / `repetition_penalty` / `max_tokens` / `logit_bias` / `logprobs` / `top_logprobs` / `seed` / `response_format` / `structured_outputs` / `stop` / `tools` / `tool_choice` / `parallel_tool_calls` / `reasoning` / `reasoning_effort` / `include_reasoning` / **`web_search_options`** / **`verbosity`** 等が含まれる（実装時に最新を確認）

**Phase 2: ユーザー設定可能パラメータ**:

- `/config params set <json>` - パラメータをJSON形式で設定
- `/config params reset` - デフォルトに戻す
- `/config params show` - 現在の設定を表示

**マージロジック**:

1. モデルのデフォルトパラメータを取得
2. Guild設定でマージ
3. Channel設定でマージ
4. User設定でマージ
5. `supported_parameters`でバリデーション

**JSON パラメータの zod バリデーション（実装方針）:**

- `llm_params TEXT`（JSON 文字列）の検証では、zod v4 の `z.json()`（**存在はするが「任意の JSON 値」用のバリデータで、文字列のパースはしない**）は使わない。`JSON.parse` を **transform 内で素のまま呼ぶと throw が Zod に捕捉されない**点に注意する（公式: "Transform functions should never throw"。`safeParse` でも `SyntaxError` が外に飛ぶ）。次のいずれかにする:
  - (a) catch して issue 化: `z.string().transform((s, ctx) => { try { return JSON.parse(s); } catch { ctx.addIssue({ code: "custom", message: "invalid JSON" }); return z.NEVER; } }).pipe(z.object({ temperature: z.number().min(0).max(2).optional(), top_p: z.number().optional(), /* ... */ }))`
  - (b) transform を使わず、先に `JSON.parse` を自前 try/catch してから `z.object({...}).safeParse(parsed)` で検証する（こちらの方が単純）。
- モデルが受け付けるキーの絞り込みは `z.literal([...supported_parameters])` 由来の許可リストで行うと型推論も union になり安全。
- zod v4 はパース性能が向上しており、階層マージ後の最終バリデーションを安価に行える。

**参照**:

- [OpenRouter Chat Completions](https://openrouter.ai/docs/api/api-reference) - チャットパラメータ（temperature、top_pなど）は`/api/v1/chat/completions`のリクエストボディに含める
- [OpenRouter Models API](https://openrouter.ai/docs/api/api-reference/models/get-models) - `/api/v1/models`で`default_parameters`（temperature/top_p/top_k/frequency_penalty/presence_penalty/repetition_penalty）と`supported_parameters`（enum 配列）を取得。`?supported_parameters=tools` でフィルタも可
- [Zod v4](https://zod.dev/v4) - JSON 文字列は素の `transform(JSON.parse)` だと throw が Zod に捕捉されないため、上記 (a)（catch して `ctx.addIssue` + `z.NEVER`）または (b)（事前 try/catch → `z.object().safeParse`）で検証する。`z.json()` は任意 JSON 値用で文字列パースはしない。`z.literal([...])` で許可キー集合を定義

**設計メモ**:

- 優先順位: User > Channel > Guild > Model Default > OpenRouter Default
- NULL値は上位設定を継承
- 無効なパラメータはバリデーションで拒否

---

### カスタムシステムプロンプト

**変更対象ファイル**:

- `src/bot/commands/prompt.ts` - `prompt`コマンド追加
- `src/bot/commands/handlers.ts` - promptハンドラー追加
- `src/services/settingsService.ts` - プロンプト取得・設定ロジック
- `src/services/chatService.ts` - システムプロンプトの適用

**コマンド設計**:

```text
/prompt set <scope> <prompt>
  - scope: guild | channel | user
  - prompt: システムプロンプト（最大2000文字）

/prompt show [scope]
  - scope省略時: 現在の有効なプロンプトを表示（優先順位適用後）
  - scope指定時: 指定スコープのプロンプトのみ表示

/prompt reset [scope]
  - scope省略時: ユーザー設定をリセット
  - scope指定時: 指定スコープの設定をリセット
```

**デフォルトシステムプロンプト**:

```text
You are a helpful AI assistant in a Discord server.
- Keep responses concise and clear
- Use Discord-supported markdown only (no H4+, tables, horizontal rules)
- Be respectful and informative
```

**設計メモ**:

- 優先順位: User > Channel > Guild > Default
- NULL値は上位プロンプトを継承
- プロンプトは全メッセージの先頭に追加（`role: "system"`）
- 最大長: 2000文字（Discord制限を考慮）

**参照**:

- [OpenRouter Chat API](https://openrouter.ai/docs/api-reference) - システムプロンプトは`messages`配列の最初に`{role: "system", content: "..."}`として送信

## Tasks

- [ ] `channel_settings`, `user_settings`テーブル追加
- [ ] 階層解決ロジック（settingsService）実装
- [ ] Phase 1: モデルデフォルトパラメータの取得・適用
- [ ] Phase 2: `/config params`サブコマンド実装
- [ ] `/prompt`コマンド実装（set/show/reset）
- [ ] システムプロンプトの適用ロジック
- [ ] `docs/changes/settings-hierarchy/` 削除（リリース完了時、git 履歴がアーカイブ）
