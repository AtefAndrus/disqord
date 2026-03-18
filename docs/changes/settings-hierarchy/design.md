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

**変更対象**:

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

1. `/api/v1/models` APIレスポンスに含まれる`default_parameters`を使用
2. `ModelService`でキャッシュ時に保存
3. `chatService`がモデルのデフォルトパラメータを取得して適用

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

**参照**:

- [OpenRouter API Documentation](https://openrouter.ai/docs) - チャットパラメータ（temperature、top_pなど）は`/api/v1/chat/completions`のリクエストボディに含める
- [OpenRouter Models API](https://openrouter.ai/docs) - `/api/v1/models`エンドポイントで`default_parameters`と`supported_parameters`を取得

**設計メモ**:

- 優先順位: User > Channel > Guild > Model Default > OpenRouter Default
- NULL値は上位設定を継承
- 無効なパラメータはバリデーションで拒否

---

### カスタムシステムプロンプト

**変更対象**:

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
