# Web Search

## Why

LLMの学習データには時間的な限界があり、最新のニュースやリアルタイムの情報を回答できない。Web検索機能を付与することで、最新情報に基づいた回答が可能になる。

## Goals / Non-Goals

**Goals:**

- LLMにWeb検索機能を付与し、最新情報を取得可能にする
- サーバー単位でWeb検索のON/OFFを設定可能にする

**Non-Goals:**

- 独自の検索エンジン実装（OpenRouterの`:online`サフィックスを利用）
- 検索結果のキャッシュ
- 検索クエリのカスタマイズ

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 検索実装方式 | OpenRouter `:online`サフィックス | 追加実装不要、OpenRouter側で処理 |
| デフォルト設定 | OFF | 追加費用が発生するため明示的な有効化が必要 |
| 設定スコープ | Guild単位 | チャンネル/ユーザ単位は設定階層化で対応 |

## Design

**変更対象**:

- `src/db/schema.ts` - guild_settings拡張
- `src/services/chatService.ts` - モデルIDに`:online`サフィックス付与
- `src/bot/commands/config.ts` - `web-search`サブコマンド追加

**DBスキーマ変更**:

```sql
ALTER TABLE guild_settings ADD COLUMN web_search_enabled INTEGER NOT NULL DEFAULT 0;
```

**コマンド設計**:

```text
/config web-search <on|off>
  - ON: モデルIDに`:online`サフィックスを自動付与
  - OFF: 通常のモデルIDを使用（デフォルト）
```

**実装内容**:

1. **Web Search有効化**:
   - 設定ONの場合、LLMリクエスト時にモデルIDに`:online`を追加
   - 例: `provider/model-id` → `provider/model-id:online`

2. **費用警告**:
   - Web Search有効化時に警告メッセージを表示
   - 「Web検索は追加費用が発生します。詳細はOpenRouter料金ページを参照してください。」

3. **ステータス表示**:
   - `/status`にWeb Search設定状態を追加

**設計メモ**:

- 追加費用: モデルによって異なる（通常+$0.01〜$0.05/リクエスト）
- 対応モデル: `:online`サフィックスに対応しているモデルのみ

**参照**:

- [OpenRouter Chat Completions API](https://openrouter.ai/docs) - Web検索有効化: モデルIDに`:online`サフィックス追加（例: `model:online`）、またはリクエストに`plugins: [{id: "web"}]`を含める

## Tasks

- [ ] guild_settingsにweb_search_enabledカラム追加
- [ ] `/config web-search`サブコマンド実装
- [ ] chatServiceでモデルIDに`:online`サフィックス付与
- [ ] `/status`にWeb Search状態表示追加
- [ ] 費用警告メッセージ実装
